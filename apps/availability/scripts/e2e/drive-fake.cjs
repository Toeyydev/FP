// Preloaded into the app server by the slip-correction browser test (node --require),
// AFTER outbound-guard.cjs. Test-only: stands in for Google's token endpoint and the
// Drive v3 files endpoint, so the page can be driven end to end without a real Drive.
// Production code has no switch for this — it only ever sees an ordinary fetch.
//
// FAKE_DRIVE_FILES   JSON { fileId: { name, md5Checksum } }
// FAKE_DRIVE_FAIL    how many PATCHes to fail first (to exercise the retry)
// FAKE_DRIVE_LOG     every Drive call is appended here: "METHOD fileId name?"
const { appendFileSync } = require("node:fs");
const files = JSON.parse(process.env.FAKE_DRIVE_FILES || "{}");
let fail = Number(process.env.FAKE_DRIVE_FAIL || 0);
const log = (line) => { try { appendFileSync(process.env.FAKE_DRIVE_LOG, `${line}\n`); } catch {} };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const inner = globalThis.fetch;
globalThis.fetch = async function fakeGoogle(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input);
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "e2e-access-token" });
  const m = url.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const method = (init?.method || "GET").toUpperCase();
    const f = files[id];
    if (!f) { log(`${method} ${id} 404`); return json({ error: "not found" }, 404); }
    if (method === "PATCH") {
      if (fail > 0) { fail--; log(`PATCH ${id} FAILED`); return json({ error: "backend" }, 500); }
      const b = JSON.parse(String(init.body || "{}"));
      f.name = b.name; f.description = b.description;
      log(`PATCH ${id} ${b.name}`);
    } else log(`${method} ${id}`);
    return json({ id, name: f.name, md5Checksum: f.md5Checksum, trashed: false });
  }
  return inner.call(this, input, init);
};
