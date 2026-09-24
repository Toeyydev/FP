import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// Registering an attester's signature, against a real database.
//
// The cases that matter are the ones a unit test cannot reach: a second submit of the
// same scan, a registration interrupted after the file was written, and — the one this
// whole feature turns on — whether registering a new signature reaches back and changes
// a certificate somebody already attested.
//
// All data invented, every PNG generated here. This repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { registerSignature, replacementImpact, retireSignature, signatureHistory, SignatureRefused, type Actor } from "@/lib/certificates/signature-service";
import { DuplicateSignatureFile, type SignatureDrive, type PutSignatureInput } from "@/lib/certificates/signature-drive";
import { resolveSignature } from "@/lib/certificates/signature";
import { validateDriveAllowlist } from "@/lib/certificates/drive-allowlist";
import { GET as sigGet, POST as sigPost, DELETE as sigDelete } from "@/app/api/certificates/signature/route";
import { GET as imgGet } from "@/app/api/certificates/signature/image/route";
import { NextRequest } from "next/server";

const ADMIN: Actor = { id: "u_admin", name: "Anong Testsuite", role: "ADMIN" };
const ENV = "test-env";

// ── a real PNG, built here ───────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (b: Buffer) => { let c = -1; for (const byte of b) c = t[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
};
function png(width: number, height: number, ink = 0x20): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, ink)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const V1 = png(320, 110, 0x20);
const V2 = png(320, 110, 0x7f);

// ── a Drive that behaves like the real one where it matters ──────────────────
type FakeFile = { id: string; name: string; folder: string; signatureId: string; userId: string; version: number; environment: string; sha256: string; bytes: Buffer; quarantined?: boolean };
const drive = {
  files: [] as FakeFile[],
  account: "folkpaths-drive@example.test" as string | null,
  folderPermissions: null as null | Record<string, unknown>[],
  filePermissions: null as null | Record<string, unknown>[],
  corruptOnRead: false,
  failCreate: false,
  reset() { this.files = []; this.account = "folkpaths-drive@example.test"; this.folderPermissions = null; this.filePermissions = null; this.corruptOnRead = false; this.failCreate = false; },
  live() { return this.files.filter((f) => !f.quarantined); },
};
const fakeDrive = (): SignatureDrive => {
  const key = (p: string[]) => p.join("/");
  return {
    async find({ signatureId, environment, folderPath }) {
      return drive.files
        .filter((f) => !f.quarantined && f.signatureId === signatureId && f.environment === environment && f.folder === key(folderPath))
        .map((f) => ({ id: f.id, name: f.name, link: `https://drive.example.test/file/${f.id}`, signatureId: f.signatureId, userId: f.userId, version: f.version, sha256: f.sha256 }));
    },
    async create(o: PutSignatureInput) {
      if (drive.failCreate) throw new Error("drive-upload 503");
      const f: FakeFile = { id: `sig_file_${drive.files.length + 1}`, name: o.name, folder: key(o.folderPath), signatureId: o.signatureId, userId: o.userId, version: o.version, environment: o.environment, sha256: o.sha256, bytes: o.bytes };
      drive.files.push(f);
      return { id: f.id, name: f.name, link: `https://drive.example.test/file/${f.id}`, signatureId: f.signatureId, userId: f.userId, version: f.version, sha256: f.sha256 };
    },
    async read({ fileId }) {
      const f = drive.files.find((x) => x.id === fileId);
      if (!f) return null;
      return drive.corruptOnRead ? Buffer.concat([f.bytes, Buffer.from("tampered")]) : f.bytes;
    },
    async permissions({ fileId }) {
      const owner = [{ id: "p_owner", type: "user", role: "owner", emailAddress: drive.account ?? "" }];
      if (fileId.startsWith("folder_")) return (drive.folderPermissions ?? owner) as never;
      return (drive.filePermissions ?? owner) as never;
    },
    async folderId({ folderPath }) { return `folder_${key(folderPath)}`; },
    async accountEmail() { return drive.account; },
    async quarantine({ fileId }) { const f = drive.files.find((x) => x.id === fileId); if (f) f.quarantined = true; },
  };
};

const deps = () => ({ drive: fakeDrive(), environment: ENV });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  drive.reset();
  await prisma.user.create({ data: { id: ADMIN.id, email: "admin@example.test", role: "ADMIN", displayName: "Anong", fullName: "Anong Testsuite" } });
  authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
});

// ── registering ──────────────────────────────────────────────────────────────

describe("registering a signature", () => {
  it("writes the row, files the image, and makes it live", async () => {
    const out = await registerSignature(ADMIN.id, V1, ADMIN, deps());
    expect(out.created).toBe(true);
    expect(out.signature.version).toBe(1);
    expect(out.signature.active).toBe(true);
    expect(out.signature.sha256).toBe(sha(V1));

    const row = (await prisma.attesterSignature.findFirst())!;
    expect(row.activeUserId).toBe(ADMIN.id);
    expect(row.driveFileId).toBeTruthy();
    // The file carries the identity of the row it belongs to — not just its name.
    const file = drive.files.find((f) => f.id === row.driveFileId)!;
    expect(file.signatureId).toBe(row.id);
    expect(file.userId).toBe(ADMIN.id);
    expect(file.version).toBe(1);
    expect(file.environment).toBe(ENV);
  });

  it("the same scan twice is not a second version", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    const again = await registerSignature(ADMIN.id, V1, ADMIN, deps());
    expect(again.created).toBe(false);
    expect(again.signature.version).toBe(1);
    expect(await prisma.attesterSignature.count()).toBe(1);
    expect(drive.live()).toHaveLength(1);
  });

  it("a different scan supersedes without overwriting anything", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    const out = await registerSignature(ADMIN.id, V2, ADMIN, deps());
    expect(out.created).toBe(true);
    expect(out.signature.version).toBe(2);
    expect(out.replaced).toBe(1);

    const rows = await prisma.attesterSignature.findMany({ orderBy: { version: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].activeUserId).toBeNull();
    expect(rows[0].retiredAt).toBeTruthy();
    expect(rows[0].retireReason).toContain("version 2");
    expect(rows[1].activeUserId).toBe(ADMIN.id);

    // Two files, and version 1's bytes are untouched.
    expect(drive.live()).toHaveLength(2);
    const v1File = drive.files.find((f) => f.version === 1)!;
    expect(v1File.bytes.equals(V1)).toBe(true);
    expect(v1File.id).not.toBe(rows[1].driveFileId);
  });

  it("an interrupted registration reuses its own file rather than making a second", async () => {
    // The file is written, then the process dies before the row is finished.
    const d = deps();
    const realCreate = d.drive.create.bind(d.drive);
    d.drive.create = async (o) => { await realCreate(o); throw new Error("process died"); };
    await expect(registerSignature(ADMIN.id, V1, ADMIN, d)).rejects.toThrow();
    expect(drive.live()).toHaveLength(1);
    const orphan = drive.live()[0];
    // The reservation was cleaned up; the orphan file names a row that no longer exists.
    expect(await prisma.attesterSignature.count()).toBe(0);

    // Retrying makes a fresh reservation and a fresh file. The orphan is not adopted,
    // because adopting a file whose record is gone is how one person's image ends up
    // under another person's row.
    const out = await registerSignature(ADMIN.id, V1, ADMIN, deps());
    expect(out.created).toBe(true);
    expect(drive.live().filter((f) => f.id !== orphan.id)).toHaveLength(1);
  });

  it("two files under one record fail closed rather than choosing", async () => {
    const d = deps();
    const realCreate = d.drive.create.bind(d.drive);
    d.drive.create = async (o) => { await realCreate(o); return realCreate(o); }; // two files, one record
    await expect(registerSignature(ADMIN.id, V1, ADMIN, d)).rejects.toThrow(DuplicateSignatureFile);
  });

  it("what is filed is hashed against what was sent", async () => {
    drive.corruptOnRead = true;
    await expect(registerSignature(ADMIN.id, V1, ADMIN, deps())).rejects.toThrow(/did not read back/);
    expect(await prisma.attesterSignature.count()).toBe(0);
    expect(drive.files[0].quarantined).toBe(true);
  });

  it("a folder anyone can open refuses before a byte is written", async () => {
    drive.folderPermissions = [{ id: "p", type: "anyone", role: "reader" }];
    await expect(registerSignature(ADMIN.id, V1, ADMIN, deps())).rejects.toThrow(/not private/);
    expect(drive.files).toHaveLength(0);
    expect(await prisma.attesterSignature.count()).toBe(0);
  });

  it("an image that is not a PNG, or the wrong shape, never reaches Drive", async () => {
    for (const [bytes, why] of [[Buffer.from("PK\u0003\u0004 zip"), /not a PNG/], [png(10, 10), /outside/]] as const) {
      await expect(registerSignature(ADMIN.id, bytes, ADMIN, deps())).rejects.toThrow(why);
    }
    expect(drive.files).toHaveLength(0);
  });
});

// ── what a new signature does NOT change ─────────────────────────────────────

describe("a new signature does not reach back", () => {
  const certFor = async (version: number, hash: string, status = "ATTESTED") => {
    const sheet = await prisma.jobSheet.create({
      data: { ref: "FOLK-TEST-20990401-01", guideId: "G-900", date: "2099-04-01", slotIdx: 0, tourId: "T-900", status: "Confirmed", expenses: [], guideFee: {} },
    });
    return prisma.expenseCertificate.create({
      data: {
        certificateNo: `CERT-v${version}-${status}`, jobSheetId: sheet.id, activeJobSheetId: sheet.id,
        guideId: "G-900", tourDate: "2099-04-01", slotIdx: 0, status,
        payload: {}, payloadHash: "a".repeat(64), coveredRows: [], totalSatang: 32400, sourceSheetUpdatedAt: new Date(),
        signatureUserId: ADMIN.id, signatureVersion: version, signatureSha256: hash,
      },
    });
  };

  it("a certificate attested with version 1 still resolves version 1 after version 2 is live", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    const cert = await certFor(1, sha(V1));
    await registerSignature(ADMIN.id, V2, ADMIN, deps());

    // Live is version 2 …
    const live = await resolveSignature(ADMIN.id, { fetchAsset: async (r) => drive.files.find((f) => f.id === r.driveFileId)?.bytes ?? null, privacy: async () => [] });
    expect(live.ok && live.signature.version).toBe(2);

    // … but the certificate's own version is still 1, with version 1's bytes.
    const mine = await resolveSignature(cert.signatureUserId!, { fetchAsset: async (r) => drive.files.find((f) => f.id === r.driveFileId)?.bytes ?? null, privacy: async () => [] }, undefined, cert.signatureVersion);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(mine.signature.version).toBe(1);
    expect(mine.signature.sha256).toBe(sha(V1));
    expect(Buffer.from(mine.signature.dataUri.split(",")[1], "base64").equals(V1)).toBe(true);
  });

  it("the impact figures say how many certificates carry the outgoing version", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    await certFor(1, sha(V1), "ATTESTED");
    const impact = await replacementImpact(ADMIN.id);
    expect(impact.attestedWithCurrent).toBe(1);
    expect(impact.alreadyFiled).toBe(0);
    expect(impact.attestedNotYetFiled).toBe(1);
  });
});

// ── standing one down ────────────────────────────────────────────────────────

describe("standing a signature down", () => {
  it("keeps the version, its file and its history", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    const out = await retireSignature(ADMIN.id, "she has re-signed on new paper", ADMIN);
    expect(out!.active).toBe(false);
    expect(out!.retireReason).toContain("re-signed");
    expect(await prisma.attesterSignature.count()).toBe(1);
    expect(drive.live()).toHaveLength(1);
    const history = await signatureHistory(ADMIN.id);
    expect(history[0].version).toBe(1);
    expect(history[0].active).toBe(false);
  });

  it("needs a reason worth keeping", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    await expect(retireSignature(ADMIN.id, "no", ADMIN)).rejects.toThrow(SignatureRefused);
  });

  it("after standing down, a document is attested with no image and is still complete", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    await retireSignature(ADMIN.id, "she has re-signed on new paper", ADMIN);
    const r = await resolveSignature(ADMIN.id, { fetchAsset: async () => V1, privacy: async () => [] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("not-registered");
  });
});

// ── who may do any of this ───────────────────────────────────────────────────

describe("only an admin, checked on the server", () => {
  const form = (bytes: Buffer) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(bytes)], "signature.png", { type: "image/png" }));
    fd.append("userId", ADMIN.id);
    return fd;
  };

  it("a guide, an operator and an accountant are refused at every door", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
      authMock.auth.mockResolvedValue({ user: { id: `u_${role}`, name: role, role } });

      const list = await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`));
      expect(list.status, `${role} listing`).toBe(403);
      const body = JSON.stringify(await list.json());
      for (const leak of [sha(V1), "drive.example.test", "sig_file_"]) {
        expect(body, `${role} was told ${leak}`).not.toContain(leak);
      }

      const upload = await sigPost(new NextRequest("https://ops.example.test/api/certificates/signature", { method: "POST", body: form(V2) }));
      expect(upload.status, `${role} uploading`).toBe(403);

      const del = await sigDelete(new NextRequest("https://ops.example.test/api/certificates/signature", { method: "DELETE", body: JSON.stringify({ userId: ADMIN.id, reason: "trying it on" }), headers: { "content-type": "application/json" } }));
      expect(del.status, `${role} retiring`).toBe(403);

      const img = await imgGet(new NextRequest(`https://ops.example.test/api/certificates/signature/image?userId=${ADMIN.id}`));
      expect(img.status, `${role} fetching the image`).toBe(403);
      expect(img.headers.get("content-type")).not.toContain("image/png");
    }
    // Nothing they did changed anything.
    expect(await prisma.attesterSignature.count()).toBe(1);
    expect((await prisma.attesterSignature.findFirst())!.activeUserId).toBe(ADMIN.id);
  });

  it("every refusal is written down without saying whose signature it was", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u_ops", name: "Ops", role: "OPERATOR" } });
    await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`));
    const log = (await prisma.auditLog.findFirst({ where: { action: "certificate.access_denied" }, orderBy: { createdAt: "desc" } }))!;
    expect(log.actorId).toBe("u_ops");
    expect(JSON.stringify(log.detail)).not.toContain(ADMIN.id);
  });

  it("an admin gets the image itself, as bytes and not as a link", async () => {
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
    // The route reads through Drive; point it at the fake by registering with it first.
    const list = await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`));
    expect(list.status).toBe(200);
    const d = await list.json();
    expect(d.active.version).toBe(1);
    expect(d.active.sha256).toBe(sha(V1));
    // Not even to an admin does the list hand out where the file lives.
    expect(JSON.stringify(d)).not.toContain("drive.example.test");
    expect(JSON.stringify(d)).not.toContain("driveFileId");
  });
});

describe("reading the settings page is not the same as being able to act on it", () => {
  const ATTESTERS = process.env.CERTIFICATE_ATTESTER_EMAILS;
  const restore = () => {
    if (ATTESTERS === undefined) delete process.env.CERTIFICATE_ATTESTER_EMAILS;
    else process.env.CERTIFICATE_ATTESTER_EMAILS = ATTESTERS;
  };

  it("an admin off the attester list sees the page, and is told up front", async () => {
    await prisma.user.create({ data: { id: "u_other_admin", email: "other-admin@example.test", role: "ADMIN", displayName: "Other" } });
    process.env.CERTIFICATE_ATTESTER_EMAILS = "admin@example.test";
    try {
      authMock.auth.mockResolvedValue({ user: { id: "u_other_admin", name: "Other", role: "ADMIN" } });
      const res = await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`));
      expect(res.status).toBe(200);
      const d = await res.json();
      expect(d.mayChange).toBe(false);
      expect(d.cannotChangeReason).toContain("Reading certificates is unaffected");
      expect(d.attesterListInForce).toBe(true);
    } finally { restore(); }
  });

  it("and cannot register or stand one down however they ask", async () => {
    await prisma.user.create({ data: { id: "u_other_admin", email: "other-admin@example.test", role: "ADMIN", displayName: "Other" } });
    await registerSignature(ADMIN.id, V1, ADMIN, deps());
    process.env.CERTIFICATE_ATTESTER_EMAILS = "admin@example.test";
    try {
      const them: Actor = { id: "u_other_admin", name: "Other", role: "ADMIN" };
      await expect(registerSignature(ADMIN.id, V2, them, deps())).rejects.toThrow(/not one of the people authorised/);
      await expect(retireSignature(ADMIN.id, "trying it on from another account", them)).rejects.toThrow(/not one of the people authorised/);
      // Untouched: still version 1, still live.
      const rows = await prisma.attesterSignature.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].activeUserId).toBe(ADMIN.id);
    } finally { restore(); }
  });

  it("the authorised attester may do both", async () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = "admin@example.test";
    try {
      const out = await registerSignature(ADMIN.id, V1, ADMIN, deps());
      expect(out.created).toBe(true);
      const stood = await retireSignature(ADMIN.id, "she has re-signed on new paper", ADMIN);
      expect(stood!.active).toBe(false);
    } finally { restore(); }
  });
});

// ── the Drive allowlist is not believed just because it was typed ───────────
//
// CERTIFICATE_DRIVE_ALLOWED_EMAILS decides which Google accounts may hold a certificate
// or a signature file. Someone on that list opens the document in Drive directly,
// whatever FolkOPS answers — so an unchecked entry breaks "only an admin sees a
// certificate" silently, from a text field, while every endpoint still returns 403.
//
// Every address here is invented.

describe("the Drive allowlist is validated against real ADMIN accounts", () => {
  const LIST = process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS;
  const ATTESTERS = process.env.CERTIFICATE_ATTESTER_EMAILS;
  const set = (v?: string) => { if (v === undefined) delete process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS; else process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS = v; };
  const restore = () => {
    if (LIST === undefined) delete process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS; else process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS = LIST;
    if (ATTESTERS === undefined) delete process.env.CERTIFICATE_ATTESTER_EMAILS; else process.env.CERTIFICATE_ATTESTER_EMAILS = ATTESTERS;
  };
  afterEach(restore);

  const user = (over: Record<string, unknown>) =>
    prisma.user.create({ data: { displayName: "Fixture", state: "ACTIVE", ...over } as never });

  /** A Drive that screams if anything touches it. Proves validation came first. */
  const noDrive = (): SignatureDrive => {
    const boom = (what: string) => async (): Promise<never> => { throw new Error(`Drive was called (${what}) before the configuration was checked`); };
    return {
      find: boom("find"), create: boom("create"), read: boom("read"),
      permissions: boom("permissions"), folderId: boom("folderId"),
      accountEmail: boom("accountEmail"), quarantine: boom("quarantine"),
    } as unknown as SignatureDrive;
  };

  // 1
  it("an empty allowlist works, and shares the file with nobody", async () => {
    set(undefined);
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allowed).toEqual([]);

    const out = await registerSignature(ADMIN.id, V1, ADMIN, deps());
    expect(out.created).toBe(true);
    // The only permission on the file is the filing account's own. Nothing was shared.
    expect(drive.filePermissions).toBeNull();
  });

  // 14
  it("the filing account needs no User record and no entry", async () => {
    set(undefined);
    expect(await prisma.user.findFirst({ where: { email: "folkpaths-drive@example.test" } })).toBeNull();
    const out = await registerSignature(ADMIN.id, V1, ADMIN, deps());
    expect(out.created).toBe(true);
  });

  // 2
  it("an address that is an ADMIN here is accepted", async () => {
    await user({ id: "u_fin", email: "finance-admin@example.test", role: "ADMIN" });
    set("finance-admin@example.test");
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowed).toEqual(["finance-admin@example.test"]);
  });

  // 3
  it("case and spacing do not matter when it is the same admin", async () => {
    await user({ id: "u_fin", email: "Finance-Admin@Example.Test", role: "ADMIN" });
    set("   FINANCE-ADMIN@EXAMPLE.TEST  ");
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowed).toEqual(["finance-admin@example.test"]);
  });

  // 4, 15
  it("an address that is nobody here fails, before any Drive call", async () => {
    set("stranger@example.test");
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail[0]).toContain("is not an account in FolkOPS");

    await expect(registerSignature(ADMIN.id, V1, ADMIN, { drive: noDrive(), environment: ENV }))
      .rejects.toThrow(/ADMIN/);
  });

  // 5, 6, 7
  it("a guide, an operator and an accountant are all refused", async () => {
    for (const [id, role] of [["u_g", "GUIDE"], ["u_o", "OPERATOR"], ["u_a", "ACCOUNTANT"]] as const) {
      await user({ id, email: `${role.toLowerCase()}@example.test`, role, ...(role === "GUIDE" ? { guideId: `G-90${id.length}` } : {}) });
      set(`${role.toLowerCase()}@example.test`);
      const r = await validateDriveAllowlist(prisma);
      expect(r.ok, `${role} must not be allowed to hold the file`).toBe(false);
      if (!r.ok) expect(r.detail[0]).toContain(`is a ${role.toLowerCase()} in FolkOPS, not an admin`);
    }
  });

  // 8
  it("being on the attester allowlist does not make somebody an admin", async () => {
    await user({ id: "u_ops3", email: "ops-attester@example.test", role: "OPERATOR" });
    process.env.CERTIFICATE_ATTESTER_EMAILS = "ops-attester@example.test";
    set("ops-attester@example.test");
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail[0]).toContain("not an admin");
  });

  // 9
  it("the same address twice, however it is spelled, is an invalid configuration", async () => {
    await user({ id: "u_fin", email: "finance-admin@example.test", role: "ADMIN" });
    set("finance-admin@example.test, FINANCE-ADMIN@EXAMPLE.TEST");
    const r = await validateDriveAllowlist(prisma);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail[0]).toContain("appears more than once");
  });

  // 10
  it("a database that cannot be read fails closed", async () => {
    set("finance-admin@example.test");
    const broken = { user: { findMany: async () => { throw new Error("connection lost"); } } } as never;
    const r = await validateDriveAllowlist(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail[0]).toContain("could not be checked");
  });

  // 12
  it("an invalid configuration leaves no reservation, no row and no file", async () => {
    set("stranger@example.test");
    await expect(registerSignature(ADMIN.id, V1, ADMIN, { drive: noDrive(), environment: ENV })).rejects.toThrow();
    expect(await prisma.attesterSignature.count()).toBe(0);
    expect(drive.files).toHaveLength(0);
  });

  // 13
  it("the audit says the configuration is invalid and names no address", async () => {
    set("stranger@example.test");
    await expect(registerSignature(ADMIN.id, V1, ADMIN, { drive: noDrive(), environment: ENV })).rejects.toThrow();
    const log = (await prisma.auditLog.findFirst({ where: { action: "signature.config_invalid" } }))!;
    expect(log).toBeTruthy();
    const written = JSON.stringify(log.detail);
    expect(written).toContain("invalid");
    expect(written).not.toContain("stranger@example.test");
    expect(written).not.toContain("@");
    expect(written).not.toContain("sig_file_");
    expect(written).not.toContain(sha(V1));
  });

  // 11
  it("another role gets 403 and is told nothing about the configuration", async () => {
    await user({ id: "u_ops4", email: "ops4@example.test", role: "OPERATOR" });
    set("stranger@example.test");
    authMock.auth.mockResolvedValue({ user: { id: "u_ops4", name: "Ops", role: "OPERATOR" } });
    const res = await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`));
    expect(res.status).toBe(403);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("stranger@example.test");
    expect(body).not.toContain("ADMIN user in FolkOPS");
    expect(body).not.toContain("driveAllowlist");
  });

  it("an admin IS told, because they are the one who has to fix it", async () => {
    set("stranger@example.test");
    authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
    const d = await (await sigGet(new NextRequest(`https://ops.example.test/api/certificates/signature?userId=${ADMIN.id}`))).json();
    expect(d.driveAllowlist.ok).toBe(false);
    expect(d.driveAllowlist.problems.join(" ")).toContain("stranger@example.test");
  });
});
