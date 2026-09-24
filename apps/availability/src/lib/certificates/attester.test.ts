import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attesterListInForce, attesterRefusal, configuredAttesters, mayAttest } from "@/lib/certificates/attester";
import { driveAllowedEmails, permissionProblems } from "@/lib/certificates/access";

// Three permissions that sit near each other and must stay apart.
//
//   reading a certificate   the ADMIN role, no list anywhere
//   attesting one           ADMIN, narrowed by an optional allowlist
//   who may hold the FILE   Google accounts on the Drive permission list
//
// The failure this guards against is the tidy-looking one: a single "certificate admins"
// list that ends up deciding all three, so that leaving somebody off it silently stops
// them opening documents they are entitled to read.
//
// All data invented — this repo is public.

const ATTEST = process.env.CERTIFICATE_ATTESTER_EMAILS;
const DRIVE = process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS;
afterEach(() => {
  if (ATTEST === undefined) delete process.env.CERTIFICATE_ATTESTER_EMAILS;
  else process.env.CERTIFICATE_ATTESTER_EMAILS = ATTEST;
  if (DRIVE === undefined) delete process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS;
  else process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS = DRIVE;
});

describe("with no allowlist, nothing changes for anybody", () => {
  it("any admin may attest — merging must not stop a working feature", () => {
    delete process.env.CERTIFICATE_ATTESTER_EMAILS;
    expect(attesterListInForce()).toBe(false);
    expect(mayAttest({ role: "ADMIN", email: "someone@example.test" })).toBe(true);
    expect(mayAttest({ role: "ADMIN", email: null })).toBe(true);
    expect(attesterRefusal({ role: "ADMIN", email: null })).toBeNull();
  });

  it("a non-admin still may not, list or no list", () => {
    delete process.env.CERTIFICATE_ATTESTER_EMAILS;
    for (const role of ["OPERATOR", "ACCOUNTANT", "GUIDE", null]) {
      expect(mayAttest({ role, email: "someone@example.test" }), `${role}`).toBe(false);
    }
  });
});

describe("with an allowlist, it narrows ADMIN and nothing else", () => {
  it("only the listed admins may attest", () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = "hathaiwan@example.test";
    expect(mayAttest({ role: "ADMIN", email: "hathaiwan@example.test" })).toBe(true);
    expect(mayAttest({ role: "ADMIN", email: "another-admin@example.test" })).toBe(false);
  });

  it("being on the list is not a way around the role", () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = "hathaiwan@example.test";
    expect(mayAttest({ role: "OPERATOR", email: "hathaiwan@example.test" })).toBe(false);
    expect(attesterRefusal({ role: "OPERATOR", email: "hathaiwan@example.test" })).toContain("Only an admin");
  });

  it("an admin with no address on the session cannot slip past the list", () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = "hathaiwan@example.test";
    expect(mayAttest({ role: "ADMIN", email: null })).toBe(false);
    expect(mayAttest({ role: "ADMIN", email: "  " })).toBe(false);
  });

  it("addresses are read case- and separator-insensitively", () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = " Hathaiwan@Example.Test ; second@example.test\nthird@example.test ";
    expect(configuredAttesters()).toEqual(["hathaiwan@example.test", "second@example.test", "third@example.test"]);
    expect(mayAttest({ role: "ADMIN", email: "HATHAIWAN@EXAMPLE.TEST" })).toBe(true);
  });

  it("the refusal tells an excluded admin that reading is unaffected", () => {
    process.env.CERTIFICATE_ATTESTER_EMAILS = "hathaiwan@example.test";
    expect(attesterRefusal({ role: "ADMIN", email: "another-admin@example.test" })).toContain("Reading certificates is unaffected");
  });
});

describe("the three permissions do not touch each other", () => {
  it("the attester list has nothing to do with who may read a certificate", () => {
    // Reading is `isAdmin` and only `isAdmin`. If an email list ever appears in one of
    // these files beside a read check, this is the test that should have stopped it.
    const strip = (rel: string) =>
      readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const route of [
      "src/app/api/jobsheet/certificate/route.ts",
      "src/app/api/jobsheet/certificate/[id]/route.ts",
      "src/app/api/certificates/renderer/route.ts",
    ]) {
      const src = strip(route);
      expect(src, `${route} gates reading on an email list`).not.toContain("CERTIFICATE_ATTESTER_EMAILS");
      expect(src, `${route} gates reading on an email list`).not.toContain("configuredAttesters");
      expect(src, `${route} gates reading on the Drive list`).not.toContain("driveAllowedEmails");
    }
  });

  it("the Drive list is about Google accounts on a file, not about app roles", () => {
    process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS = "folkpaths-drive@example.test";
    process.env.CERTIFICATE_ATTESTER_EMAILS = "hathaiwan@example.test";
    // An attester who is not on the Drive list is still not expected on the file …
    expect(permissionProblems([{ type: "user", role: "reader", emailAddress: "hathaiwan@example.test" }], driveAllowedEmails())).toHaveLength(1);
    // … and the Drive list grants nothing in the app.
    expect(mayAttest({ role: "ADMIN", email: "folkpaths-drive@example.test" })).toBe(false);
  });

  it("an empty Drive list still lets the filing account hold the file", () => {
    delete process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS;
    expect(driveAllowedEmails()).toEqual([]);
    const account = "folkpaths-drive@example.test";
    expect(permissionProblems([{ type: "user", role: "owner", emailAddress: account }], [account, ...driveAllowedEmails()])).toEqual([]);
  });

  it("the old conflated name is gone", () => {
    const strip = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    for (const f of ["src/lib/certificates/access.ts", "src/lib/certificates/service.ts", "src/lib/certificates/signature-service.ts", "src/lib/certificates/signature.ts"]) {
      expect(strip(f), `${f} still uses CERTIFICATE_ADMIN_EMAILS`).not.toContain("CERTIFICATE_ADMIN_EMAILS");
    }
  });
});

describe("the signature image response promises only what it can keep", () => {
  const src = () => readFileSync(join(process.cwd(), "src/app/api/certificates/signature/image/route.ts"), "utf8");

  it("is never cached, anywhere", () => {
    expect(src()).toContain('"cache-control": "private, no-store"');
  });

  it("does not claim a response cannot be forwarded", () => {
    // It can. The bytes are in a browser. Saying otherwise in a comment is how a wrong
    // idea about what is protected gets built on later.
    expect(src()).not.toContain("a response cannot");
    expect(src()).toContain("saved, forwarded, screenshotted");
  });

  it("hands back bytes, not a Drive link or a file id", () => {
    const s = src();
    expect(s).toContain("image/png");
    expect(s).not.toContain("driveUrl");
    expect(s).not.toContain("driveFileId");
    expect(s).not.toContain("drive.google.com");
  });
});

describe("configuration never reaches a place that is not admin-only", () => {
  const strip = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the health endpoint prints no address and no Drive identity", () => {
    const src = strip("src/app/api/health/route.ts");
    for (const forbidden of ["ALLOWED_EMAILS", "ATTESTER_EMAILS", "driveAllowedEmails", "configuredAttesters", "driveFileId", "driveUrl", "accountEmail"]) {
      expect(src, `health leaks ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the allowlist validator reads configuration and the database, never a request", () => {
    const src = strip("src/lib/certificates/drive-allowlist.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ["req", "request", "session", "body", "searchParams", "headers"]) {
      expect(src, `the validator takes ${forbidden} from somewhere it should not`).not.toContain(forbidden);
    }
    // And it asks isAdmin rather than inventing its own idea of one.
    expect(src).toContain("isAdmin(");
  });

  it("an audit of a bad configuration carries counts, never addresses", () => {
    const src = strip("src/lib/certificates/drive-allowlist.ts");
    const shape = src.slice(src.indexOf("sanitisedConfigAudit"));
    expect(shape).toContain("invalidEntries");
    const fields = shape.split("note:")[0];
    for (const leak of ["detail", "verified", "allowed"]) {
      expect(fields, `the audit shape includes ${leak}`).not.toContain(`${leak}:`);
    }
  });
});
