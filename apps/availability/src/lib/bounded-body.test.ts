import { describe, expect, it } from "vitest";
import { readJsonBounded } from "./bounded-body";

const MAX = 2048;
/** A request whose body arrives in chunks, with whatever Content-Length the caller claims (or none). */
function streamed(chunks: Uint8Array[], contentLength?: string) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (pulled < chunks.length) c.enqueue(chunks[pulled++]); else c.close(); },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const req = new Request("http://localhost/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { req, pulled: () => pulled };
}
const enc = (s: string) => new TextEncoder().encode(s);

describe("readJsonBounded", () => {
  it("a small normal body passes", async () => {
    expect(await readJsonBounded(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ guests: 2 }) }), MAX)).toEqual({ ok: true, value: { guests: 2 } });
  });

  it("an oversized chunked body with no Content-Length is cut off as soon as it passes the limit", async () => {
    const chunk = enc("x".repeat(1024));
    const s = streamed(Array.from({ length: 100 }, () => chunk));
    expect(await readJsonBounded(s.req, MAX)).toEqual({ ok: false, status: 413, error: "TOO_LARGE" });
    expect(s.pulled()).toBeLessThan(10); // stopped, not drained (100 KB never read)
  });

  it("a spoofed small Content-Length does not let a large body through", async () => {
    const s = streamed(Array.from({ length: 50 }, () => enc("y".repeat(1024))), "10");
    expect(await readJsonBounded(s.req, MAX)).toMatchObject({ ok: false, status: 413 });
    expect(s.pulled()).toBeLessThan(10);
  });

  it("a declared Content-Length over the limit is refused unread", async () => {
    const s = streamed([enc("{}")], String(MAX + 1));
    expect(await readJsonBounded(s.req, MAX)).toEqual({ ok: false, status: 413, error: "TOO_LARGE" });
    expect(s.pulled()).toBe(0);
  });

  it("exactly the limit passes; invalid UTF-8, invalid JSON and an empty body are 400", async () => {
    const pad = JSON.stringify({ a: "z".repeat(MAX - 10) });
    expect((await readJsonBounded(streamed([enc(pad)]).req, MAX)).ok).toBe(true);
    expect(await readJsonBounded(streamed([new Uint8Array([0x7b, 0xff, 0x7d])]).req, MAX)).toMatchObject({ status: 400, error: "BAD_ENCODING" });
    expect(await readJsonBounded(streamed([enc("{not json")]).req, MAX)).toMatchObject({ status: 400, error: "BAD_JSON" });
    expect(await readJsonBounded(streamed([]).req, MAX)).toMatchObject({ status: 400, error: "EMPTY" });
  });
});
