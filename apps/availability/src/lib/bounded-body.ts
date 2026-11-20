// Read an unauthenticated request body without ever holding more than `max` bytes of it.
//
// Content-Length is only a hint: it can be missing (chunked) or lie. So the stream itself is read
// chunk by chunk, counted, and cancelled the moment it passes the limit — nothing beyond `max`
// bytes is kept. The text must be valid UTF-8 and valid JSON.

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: "TOO_LARGE" | "BAD_ENCODING" | "BAD_JSON" | "EMPTY" };

export async function readJsonBounded(req: Request, max: number): Promise<BodyResult> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel().catch(() => {});
    return { ok: false, status: 413, error: "TOO_LARGE" };
  }
  if (!req.body) return { ok: false, status: 400, error: "EMPTY" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413, error: "TOO_LARGE" };
    }
    chunks.push(value);
  }
  if (!size) return { ok: false, status: 400, error: "EMPTY" };
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, status: 400, error: "BAD_ENCODING" }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, status: 400, error: "BAD_JSON" }; }
}
