// Preloaded into the app server by the browser test (node --require).
//
// Records every request the SERVER makes to anything that is not itself. The test then
// asserts that using the historical evidence page made none to PEAK or Google — the
// browser's own requests are watched separately, in the test.
const { appendFileSync } = require("node:fs");
const log = process.env.OUTBOUND_LOG;
const orig = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input);
  if (log && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
    try { appendFileSync(log, `${new Date().toISOString()} ${url}\n`); } catch {}
  }
  return orig.call(this, input, init);
};
