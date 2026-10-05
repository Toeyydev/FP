import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// Whose signature goes on an advance voucher — against a real database. The registered
// signature is the one certificates use; the image itself comes from an injected reader
// (Drive in production). All data invented — this repo is public.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { sha256 } from "@/lib/certificates/signature";
import { voucherApprover } from "@/lib/advances/voucher-approver";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAL0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL4GYcIAAaZq8jcAAAAASUVORK5CYII=", "base64");
const deps = { fetchAsset: async () => PNG, privacy: async () => [] as string[] };
const saved = process.env.CERTIFICATE_ATTESTER_EMAILS;

beforeAll(requireTestDatabase);
beforeEach(async () => { await resetDatabase(); delete process.env.CERTIFICATE_ATTESTER_EMAILS; });
afterEach(() => { if (saved === undefined) delete process.env.CERTIFICATE_ATTESTER_EMAILS; else process.env.CERTIFICATE_ATTESTER_EMAILS = saved; });

const person = (role: "ADMIN" | "OPERATOR", email: string, state: "ACTIVE" | "SUSPENDED" = "ACTIVE") =>
  prisma.user.create({ data: { email, displayName: "Display Example", fullName: "Malee Testsuite", role, state } });
const register = (userId: string, bytes = PNG) =>
  prisma.attesterSignature.create({ data: { userId, version: 1, activeUserId: userId, driveFileId: `file-${userId}`, sha256: sha256(bytes), bytes: bytes.length, width: 100, height: 50 } });

describe("whose signature goes on an advance voucher", () => {
  it("the admin who recorded it, with their registered signature and full name", async () => {
    const admin = await person("ADMIN", "admin@example.test");
    await register(admin.id);
    const a = await voucherApprover(admin.id, deps);
    expect(a).toEqual({ name: "Malee Testsuite", signatureDataUri: `data:image/png;base64,${PNG.toString("base64")}` });
  });

  it("nobody: recorded by an operator, by an admin with no signature, by an admin not on the signer list, or by a suspended one", async () => {
    const op = await person("OPERATOR", "op@example.test");
    await register(op.id);
    expect(await voucherApprover(op.id, deps)).toBeNull();
    const bare = await person("ADMIN", "bare@example.test");
    expect(await voucherApprover(bare.id, deps)).toBeNull();
    const other = await person("ADMIN", "other@example.test");
    await register(other.id);
    process.env.CERTIFICATE_ATTESTER_EMAILS = "admin@example.test";
    expect(await voucherApprover(other.id, deps)).toBeNull();
    delete process.env.CERTIFICATE_ATTESTER_EMAILS;
    const gone = await person("ADMIN", "gone@example.test", "SUSPENDED");
    await register(gone.id);
    expect(await voucherApprover(gone.id, deps)).toBeNull();
    expect(await voucherApprover(null, deps)).toBeNull();
  });

  it("an image that is no longer the registered one, or that others can open, is not used", async () => {
    const admin = await person("ADMIN", "admin@example.test");
    await register(admin.id);
    expect(await voucherApprover(admin.id, { ...deps, fetchAsset: async () => Buffer.concat([PNG, Buffer.from([0])]) })).toBeNull();
    expect(await voucherApprover(admin.id, { ...deps, privacy: async () => ["shared with anyone with the link"] })).toBeNull();
  });
});
