import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttesterSignature } from "@prisma/client";
import {
  blocksDocument, MAX_DIMENSION, MAX_SIGNATURE_BYTES, MIN_DIMENSION,
  pngDimensions, registeredSignature, resolveSignature, sha256, stampOf,
} from "@/lib/certificates/signature";
import { buildPayload, canonicalString, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";

// The signature image is the one part of a certificate a reader recognises without
// reading anything, which makes it the one part worth forging. So these tests are mostly
// about what CANNOT happen: one person's signature under another's name, an image that
// arrived in a request, or bytes that changed after somebody approved them.
//
// Every PNG here is generated in this file. Nothing real is committed — no image, no
// hash taken from a real one, no Drive id. This repo is public.

/** A file with its comments removed, so a rule about CODE is not tripped by prose. */
const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── a real PNG, built here ───────────────────────────────────────────────────

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (b: Buffer) => {
    let c = -1;
    for (const byte of b) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
};

/** A genuine greyscale PNG of the given size — a stand-in for a scan of a name. */
function png(width: number, height: number, ink = 0x20): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, ink)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAMPLE = png(320, 110);

/** A registered row. `driveFileId` is invented — never a real one. */
const registered = (over: Partial<AttesterSignature> = {}): AttesterSignature =>
  ({
    id: "sig_test_1", userId: "u_attester_a", version: 1, activeUserId: "u_attester_a",
    driveFileId: "test-drive-file-id-aaaa", driveUrl: "https://drive.example.test/file/test-drive-file-id-aaaa",
    sha256: sha256(SAMPLE), bytes: SAMPLE.length, width: 320, height: 110,
    uploadedById: "u_admin_test", uploadedAt: new Date("2099-01-01T00:00:00.000Z"),
    retiredAt: null, retiredById: null, retireReason: null, ...over,
  } as AttesterSignature);

/** A database holding whichever rows a test wants, keyed the way the code keys it. */
const dbOf = (...rows: AttesterSignature[]) =>
  ({
    attesterSignature: {
      findUnique: async ({ where }: { where: { activeUserId?: string } }) =>
        rows.find((r) => r.activeUserId && r.activeUserId === where.activeUserId) ?? null,
    },
  }) as never;

const deps = (rows: AttesterSignature[], bytes: Buffer | null) =>
  ({ db: dbOf(...rows), fetchAsset: async () => bytes });

// ── reading the image itself ─────────────────────────────────────────────────

describe("what the bytes say they are", () => {
  it("width and height come out of the PNG's own header, not out of the row", () => {
    expect(pngDimensions(png(240, 90))).toEqual({ width: 240, height: 90 });
  });

  it("anything that is not a PNG reads as nothing", () => {
    expect(pngDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(pngDimensions(Buffer.from("not an image at all, just text"))).toBeNull();
    expect(pngDimensions(SAMPLE.subarray(0, 20))).toBeNull();
    expect(pngDimensions(Buffer.alloc(0))).toBeNull();
  });

  it("a PNG magic number with a different chunk first is not taken as an IHDR", () => {
    const lying = Buffer.concat([SAMPLE.subarray(0, 8), chunk("tEXt", Buffer.alloc(13, 7))]);
    expect(pngDimensions(lying)).toBeNull();
  });
});

// ── whose signature it is ────────────────────────────────────────────────────

describe("a signature belongs to one person", () => {
  it("a person with none registered gets none — never the one that does exist", async () => {
    const mine = registered();
    const other = await registeredSignature("u_attester_b", { db: dbOf(mine) });
    expect(other).toBeNull();

    const r = await resolveSignature("u_attester_b", deps([mine], SAMPLE));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("not-registered");
  });

  it("a retired version is not picked up, even though the row is still there", async () => {
    const retired = registered({ activeUserId: null, retiredAt: new Date("2099-02-01T00:00:00.000Z"), retireReason: "replaced" });
    expect(await registeredSignature("u_attester_a", { db: dbOf(retired) })).toBeNull();
  });

  it("an empty user id resolves to nothing rather than to whatever is first", async () => {
    expect(await registeredSignature("", { db: dbOf(registered()) })).toBeNull();
    expect(await registeredSignature("   ", { db: dbOf(registered()) })).toBeNull();
  });

  it("nothing on this path takes an image, a file id or a user id out of a request", () => {
    // It BUILDS a data URI, which is the point. What it must never do is accept one, or
    // anything else that decides whose signature this is, from something a caller sent.
    const src = code("src/lib/certificates/signature.ts");
    for (const forbidden of ["req.", "Request", "searchParams", "formData", "await req", ".json()", "headers"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// ── the checks on the way ────────────────────────────────────────────────────

describe("every refusal is a refusal", () => {
  it("having none registered is the one case that is not an error", () => {
    expect(blocksDocument("not-registered")).toBe(false);
    for (const code of ["unreadable", "not-a-png", "too-large", "bad-dimensions", "hash-mismatch"] as const) {
      expect(blocksDocument(code)).toBe(true);
    }
  });

  it("Drive not giving it back stops the document", async () => {
    const r = await resolveSignature("u_attester_a", deps([registered()], null));
    expect(r.ok === false && r.code).toBe("unreadable");
    expect(r.ok === false && r.reasons[0]).toContain("could not be read");
  });

  it("a fetch that throws is a refusal, not a crash", async () => {
    const r = await resolveSignature("u_attester_a", {
      db: dbOf(registered()),
      fetchAsset: async () => { throw new Error("drive is having a day"); },
    });
    expect(r.ok === false && r.code).toBe("unreadable");
  });

  it("something that is not a PNG stops the document", async () => {
    const junk = Buffer.from("PK\u0003\u0004 this is a zip file");
    const r = await resolveSignature("u_attester_a", deps([registered({ sha256: sha256(junk) })], junk));
    expect(r.ok === false && r.code).toBe("not-a-png");
  });

  it("an image far larger than a scanned name stops the document", async () => {
    const huge = Buffer.alloc(MAX_SIGNATURE_BYTES + 1, 0x89);
    const r = await resolveSignature("u_attester_a", deps([registered({ sha256: sha256(huge) })], huge));
    expect(r.ok === false && r.code).toBe("too-large");
  });

  it("the size check comes before the PNG check, so a huge file is never parsed", async () => {
    const huge = Buffer.concat([png(4, 4), Buffer.alloc(MAX_SIGNATURE_BYTES, 0)]);
    const r = await resolveSignature("u_attester_a", deps([registered({ sha256: sha256(huge) })], huge));
    expect(r.ok === false && r.code).toBe("too-large");
  });

  it("an image the wrong shape stops the document at either end", async () => {
    for (const [w, h] of [[MIN_DIMENSION - 1, 100], [100, MIN_DIMENSION - 1], [MAX_DIMENSION + 1, 100]] as const) {
      const odd = png(w, h);
      const r = await resolveSignature("u_attester_a", deps([registered({ sha256: sha256(odd) })], odd));
      expect(r.ok === false && r.code).toBe("bad-dimensions");
    }
  });

  it("bytes that changed after they were registered stop the document", async () => {
    const swapped = png(320, 110, 0x7f); // same size, different ink — a different signature
    const r = await resolveSignature("u_attester_a", deps([registered()], swapped));
    expect(r.ok === false && r.code).toBe("hash-mismatch");
    expect(r.ok === false && r.reasons[0]).toContain("not the one that was registered");
  });

  it("the hash is taken from the bytes that came back, not from the row", async () => {
    const r = await resolveSignature("u_attester_a", deps([registered({ sha256: "0".repeat(64) })], SAMPLE));
    expect(r.ok === false && r.code).toBe("hash-mismatch");
  });
});

describe("when it all lines up", () => {
  it("the image comes back inline, so nothing is fetched while the page renders", async () => {
    const r = await resolveSignature("u_attester_a", deps([registered()], SAMPLE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signature.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(r.signature.dataUri.split(",")[1], "base64").equals(SAMPLE)).toBe(true);
    expect(r.signature).toMatchObject({ userId: "u_attester_a", version: 1, width: 320, height: 110 });
    expect(r.signature.sha256).toBe(createHash("sha256").update(SAMPLE).digest("hex"));
  });

  it("what is kept afterwards is an identity, never the picture", async () => {
    const r = await resolveSignature("u_attester_a", deps([registered()], SAMPLE));
    if (!r.ok) throw new Error("expected a signature");
    const stamp = stampOf(r.signature);
    expect(Object.keys(stamp).sort()).toEqual(["sha256", "userId", "version"]);
    expect(JSON.stringify(stamp)).not.toContain("data:image");
  });
});

// ── what the fingerprint covers ──────────────────────────────────────────────

const FACTS: SheetFacts = {
  jobRef: "FOLK-TEST-20990401-01", tourDate: "2099-04-01", slotIdx: 0,
  guideId: "G-900", guideName: "Somchai Testsuite",
  guideReportedAt: new Date("2099-04-02T06:30:00.000Z"),
};
const ROWS = [{ index: 0, identity: "ferry|1100|4|transport|guide", description: "Ferry", pax: 4, price: 11, amountSatang: 4400, category: "transport" }];
const STAMP = { userId: "u_attester_a", version: 1, sha256: sha256(SAMPLE) };

describe("the certificate's fingerprint covers which signature was on it", () => {
  it("the identity is in the canonical string; the image is not", () => {
    const s = canonicalString(buildPayload(FACTS, ROWS, STAMP));
    expect(s).toContain(`sig=u_attester_a:1:${STAMP.sha256}`);
    expect(s).not.toContain("data:image");
    expect(s.length).toBeLessThan(2000);
  });

  it("swapping the image changes the hash", () => {
    const a = payloadHash(buildPayload(FACTS, ROWS, STAMP));
    const b = payloadHash(buildPayload(FACTS, ROWS, { ...STAMP, sha256: sha256(png(320, 110, 0x7f)) }));
    expect(b).not.toBe(a);
  });

  it("a new version of the same image changes the hash", () => {
    const a = payloadHash(buildPayload(FACTS, ROWS, STAMP));
    expect(payloadHash(buildPayload(FACTS, ROWS, { ...STAMP, version: 2 }))).not.toBe(a);
  });

  it("someone else's signature on the same rows is a different document", () => {
    const a = payloadHash(buildPayload(FACTS, ROWS, STAMP));
    expect(payloadHash(buildPayload(FACTS, ROWS, { ...STAMP, userId: "u_attester_b" }))).not.toBe(a);
  });

  it("no signature and a signature are told apart, and no signature still hashes", () => {
    const none = buildPayload(FACTS, ROWS);
    expect(none.signature).toBeNull();
    expect(canonicalString(none)).toMatch(/;sig=$/); // the field is there and empty, not absent
    expect(payloadHash(none)).toHaveLength(64);
    expect(payloadHash(none)).not.toBe(payloadHash(buildPayload(FACTS, ROWS, STAMP)));
  });

  it("the same payload hashes the same way twice", () => {
    expect(payloadHash(buildPayload(FACTS, ROWS, STAMP))).toBe(payloadHash(buildPayload(FACTS, ROWS, { ...STAMP })));
  });
});

// ── what the document shows ──────────────────────────────────────────────────

const view = (over: Record<string, unknown> = {}) => ({
  certificateNo: "CERT-FOLK-TEST-20990401-01-01",
  payload: buildPayload(FACTS, ROWS, STAMP),
  payloadHash: payloadHash(buildPayload(FACTS, ROWS, STAMP)),
  attestedByName: "Anong Testsuite", attestedByRole: "ADMIN",
  attestedAt: "2099-04-03T04:00:00.000Z", auditRef: "cert_test_1",
  ...over,
});

describe("the signature on the page", () => {
  it("shows the image under the attester's name, with what it is", () => {
    const html = renderCertificateHtml(view({ signatureDataUri: `data:image/png;base64,${SAMPLE.toString("base64")}`, signatureVersion: 1 }) as never);
    expect(html).toContain("ภาพลายมือชื่อประกอบการรับรองทางอิเล็กทรอนิกส์");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("ภาพลายมือชื่อของ Anong Testsuite");
    expect(html).toContain("(ฉบับที่ 1)");
    expect(html.indexOf("Anong Testsuite")).toBeLessThan(html.indexOf("ภาพลายมือชื่อประกอบการรับรอง"));
  });

  it("without one, the document still says who attested it and shows no empty frame", () => {
    const html = renderCertificateHtml(view() as never);
    expect(html).not.toContain("data:image");
    expect(html).not.toContain('class="sig"');
    expect(html).not.toContain("ภาพลายมือชื่อประกอบ");
    expect(html).toContain("Anong Testsuite");
    expect(html).toContain("cert_test_1");
  });

  it("it never calls the image a digital signature", () => {
    const html = renderCertificateHtml(view({ signatureDataUri: `data:image/png;base64,${SAMPLE.toString("base64")}`, signatureVersion: 3 }) as never);
    expect(html).not.toContain("ลายเซ็นดิจิทัล");
    expect(html.toLowerCase()).not.toContain("digital signature");
  });

  it("the page fetches nothing while it renders", () => {
    const html = renderCertificateHtml(view({ signatureDataUri: `data:image/png;base64,${SAMPLE.toString("base64")}`, signatureVersion: 1 }) as never);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<script/i);
  });
});
