import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  certificateFolder, configuredAdminEmails, folderPathOf, folderPathString,
  folderPermissionProblems, legacyCertificateFolder, namesCertificate, NON_ADMIN_STATUS_TH,
  permissionProblems, redactForNonAdmin, redactMessagesForNonAdmin, redactRowsForNonAdmin,
  SIGNATURE_FOLDER, type DrivePermission,
} from "@/lib/certificates/access";

// A certificate in lieu of a receipt names a guide, an amount, an admin who took
// responsibility, and now that admin's handwriting. Only an admin may see any of it.
//
// These tests are about the three ways that sentence is usually false in practice: the
// file is private but the folder above it is not, the endpoint is closed but the field
// travels in somebody else's response, and the check passes because it could not run.
//
// All data invented — this repo is public.

const ACCOUNT = "folkpaths-drive@example.test";
const ADMIN = "accounts-admin@example.test";
const ALLOWED = [ACCOUNT, ADMIN];

const perm = (over: Partial<DrivePermission> = {}): DrivePermission =>
  ({ id: "p1", type: "user", role: "owner", emailAddress: ACCOUNT, ...over });

/** A file with its comments removed, so a rule about CODE is not tripped by prose. */
const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── where these files live ───────────────────────────────────────────────────

describe("the folder is not one the guides were given", () => {
  it("certificates are filed in the private finance tree, not beside the job sheets", () => {
    const path = certificateFolder("2099-04-01");
    expect(path).toEqual(["Folkpaths Finance", "Private Expense Certificates", "2099-04"]);
    expect(path).not.toContain("Folkpaths Job Sheets");
  });

  it("signatures are filed apart from the certificates", () => {
    expect(SIGNATURE_FOLDER).toEqual(["Folkpaths Finance", "Private Attester Signatures"]);
    expect(folderPathString(SIGNATURE_FOLDER)).not.toBe(folderPathString(certificateFolder("2099-04-01")));
    expect(SIGNATURE_FOLDER).not.toContain("Folkpaths Job Sheets");
  });

  it("a document filed before this rule is still looked for where it actually is", () => {
    expect(folderPathOf({ tourDate: "2099-04-01", driveFileId: "old-file", driveFolderPath: null }))
      .toEqual(legacyCertificateFolder("2099-04-01"));
    expect(folderPathOf({ tourDate: "2099-04-01", driveFileId: null, driveFolderPath: null }))
      .toEqual(certificateFolder("2099-04-01"));
    expect(folderPathOf({ tourDate: "2099-04-01", driveFileId: "f", driveFolderPath: "A/B/C" }))
      .toEqual(["A", "B", "C"]);
  });

  it("nothing in the certificate code writes to the job sheet tree", () => {
    for (const f of ["src/lib/certificates/service.ts", "src/lib/certificates/pdf.ts", "src/lib/certificates/drive.ts"]) {
      expect(code(f)).not.toContain("Folkpaths Job Sheets");
    }
  });
});

// ── who can see the file ─────────────────────────────────────────────────────

describe("who can see it is asked of Drive, and every unclear answer is a no", () => {
  it("the filing account alone is fine", () => {
    expect(permissionProblems([perm()], ALLOWED)).toEqual([]);
  });

  it("a configured admin is fine; anyone else is not", () => {
    expect(permissionProblems([perm(), perm({ id: "p2", role: "writer", emailAddress: ADMIN })], ALLOWED)).toEqual([]);
    const outsider = permissionProblems([perm(), perm({ id: "p3", role: "reader", emailAddress: "guide@example.test" })], ALLOWED);
    expect(outsider).toHaveLength(1);
    expect(outsider[0]).toContain("guide@example.test");
  });

  it("anyone with the link is refused, which is the rule this is named after", () => {
    const p = permissionProblems([perm(), perm({ id: "p4", type: "anyone", role: "reader", emailAddress: undefined })], ALLOWED);
    expect(p[0]).toContain("anyone who has the link");
    expect(permissionProblems([perm({ id: "p5", type: "anyone", role: "reader", allowFileDiscovery: true, emailAddress: undefined })], ALLOWED)[0])
      .toContain("found in search");
  });

  it("a whole domain is refused even though everyone in it works here", () => {
    expect(permissionProblems([perm(), perm({ id: "p6", type: "domain", role: "reader", domain: "folkpaths.example", emailAddress: undefined })], ALLOWED)[0])
      .toContain("folkpaths.example");
  });

  it("a group is refused, because who is in it cannot be checked from here", () => {
    expect(permissionProblems([perm({ id: "p7", type: "group", role: "reader", emailAddress: "finance@example.test" })], ALLOWED)[0])
      .toContain("cannot be checked from here");
  });

  it("a kind of sharing this does not recognise is refused, not ignored", () => {
    expect(permissionProblems([perm({ id: "p8", type: "somethingNew", emailAddress: undefined })], ALLOWED)[0])
      .toContain("does not recognise");
  });

  it("an unreadable permission list is a refusal — not an empty one", () => {
    expect(permissionProblems(null, ALLOWED)).toHaveLength(1);
    expect(permissionProblems(undefined, ALLOWED)[0]).toContain("could not be read");
    // The distinction that matters: nothing shared, versus nothing known.
    expect(permissionProblems([], ALLOWED)).toEqual([]);
  });

  it("a removed grant does not count against the file", () => {
    expect(permissionProblems([perm(), perm({ id: "p9", type: "anyone", deleted: true, emailAddress: undefined })], ALLOWED)).toEqual([]);
  });

  it("with no allow-list at all, only the filing account passes", () => {
    expect(permissionProblems([perm()], [ACCOUNT])).toEqual([]);
    expect(permissionProblems([perm({ id: "pa", emailAddress: ADMIN })], [ACCOUNT])).toHaveLength(1);
  });

  it("the allow-list is read from configuration and is case-insensitive", () => {
    const before = process.env.CERTIFICATE_ADMIN_EMAILS;
    process.env.CERTIFICATE_ADMIN_EMAILS = " Accounts-Admin@Example.Test , second@example.test ";
    try {
      expect(configuredAdminEmails()).toEqual(["accounts-admin@example.test", "second@example.test"]);
      expect(permissionProblems([perm({ emailAddress: "ACCOUNTS-ADMIN@EXAMPLE.TEST" })], [ACCOUNT, ...configuredAdminEmails()])).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.CERTIFICATE_ADMIN_EMAILS;
      else process.env.CERTIFICATE_ADMIN_EMAILS = before;
    }
  });

  it("the same question about the folder says which folder", () => {
    const path = certificateFolder("2099-04-01");
    const p = folderPermissionProblems([perm({ type: "anyone", emailAddress: undefined })], ALLOWED, path);
    expect(p[0]).toContain("Folkpaths Finance/Private Expense Certificates/2099-04");
    expect(p[0]).not.toContain("This file");
    expect(folderPermissionProblems(null, ALLOWED, path)[0]).toContain("nothing is filed there");
  });
});

// ── what a non-admin is sent ─────────────────────────────────────────────────

const waivedRow = () => ({
  description: "Ferry",
  price: 11,
  pax: 4,
  paidBy: "guide",
  evidenceWaiver: {
    by: "u_admin_test", at: "2099-04-03T04:00:00.000Z",
    reason: "ใบรับรองแทนใบเสร็จเลขที่ CERT-FOLK-TEST-20990401-01-01 — ผู้ให้บริการเป็นผู้ประกอบการรายย่อย",
    certificateId: "cert_test_1", certificateNo: "CERT-FOLK-TEST-20990401-01-01",
  },
});

describe("a non-admin is told there is a check, not what the document says", () => {
  it("the row keeps its money and loses everything about the certificate", () => {
    const [row] = redactRowsForNonAdmin([waivedRow()]);
    expect(row.description).toBe("Ferry");
    expect(row.price).toBe(11);
    expect(JSON.stringify(row)).not.toContain("CERT-");
    expect(JSON.stringify(row)).not.toContain("cert_test_1");
    expect(JSON.stringify(row)).not.toContain("ใบรับรองแทนใบเสร็จ");
    expect(JSON.stringify(row)).not.toContain("u_admin_test");
  });

  it("it still says a waiver exists, so a guide is not left guessing", () => {
    const [row] = redactRowsForNonAdmin([waivedRow()]);
    expect(row.evidenceWaiver).toEqual({ waived: true, status: "being checked by accounts", statusTh: NON_ADMIN_STATUS_TH });
  });

  it("a row with no waiver is untouched", () => {
    const plain = { description: "Water", price: 20, pax: 4 };
    expect(redactRowsForNonAdmin([plain])[0]).toEqual(plain);
    expect(redactRowsForNonAdmin(null)).toEqual([]);
  });

  it("every field that names a certificate goes, wherever it sits", () => {
    const payment = redactForNonAdmin({
      id: "pay_1", amount: 609,
      certificateId: "cert_test_1", certificateNo: "CERT-X-01", pdfHash: "a".repeat(64), payloadHash: "b".repeat(64),
      driveUrl: "https://drive.example.test/file/xyz", driveFileId: "xyz", driveFolderPath: "A/B",
      attestedByName: "Anong Testsuite", attestedAt: "2099-04-03T04:00:00.000Z",
      signatureUserId: "u_attester_a", signatureVersion: 1, signatureSha256: "c".repeat(64),
      auditRef: "cert_test_1",
      expenses: [waivedRow()],
    });
    expect(payment).toMatchObject({ id: "pay_1", amount: 609 });
    const json = JSON.stringify(payment);
    for (const leak of ["cert_test_1", "CERT-X-01", "drive.example.test", "xyz", "Anong Testsuite", "u_attester_a", "a".repeat(64), "c".repeat(64)]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain("Ferry"); // the guide's own expense survives
  });

  it("a sentence that names a certificate is certificate metadata too", () => {
    expect(namesCertificate('"Ferry" is being reimbursed against CERT-FOLK-TEST-20990401-01-01, and it was withdrawn')).toBe(true);
    expect(namesCertificate("ใบรับรองแทนใบเสร็จเลขที่ ...")).toBe(true);
    expect(namesCertificate("certificate in lieu of a receipt")).toBe(true);
    expect(namesCertificate('"Ferry" has no receipt attached')).toBe(false);
    expect(namesCertificate(undefined)).toBe(false);
  });

  it("messages that name one are replaced by the status, once, keeping the rest", () => {
    const out = redactMessagesForNonAdmin([
      '"Water" has no receipt attached',
      '"Ferry" is being reimbursed against CERT-A-01, and CERT-A-01 was withdrawn',
      '"Bus" is being reimbursed against CERT-A-01, and it could not be checked',
      "The guide has not filed an expense report yet",
    ]);
    expect(out).toEqual([
      '"Water" has no receipt attached',
      NON_ADMIN_STATUS_TH,
      "The guide has not filed an expense report yet",
    ]);
    expect(JSON.stringify(out)).not.toContain("CERT-");
  });
});

// ── the denial itself ────────────────────────────────────────────────────────

describe("being turned away is written down without writing down the document", () => {
  it("the denial audit carries no certificate, file or signature field", () => {
    const src = code("src/lib/certificates/denied.ts");
    // It names them in order to drop them; what it must not do is put one in `detail`.
    const detail = src.slice(src.indexOf("detail:"));
    for (const field of ["certificateNo", "driveUrl", "driveFileId", "pdfHash", "signatureSha256", "attestedByName"]) {
      expect(detail).not.toContain(field);
    }
  });

  it("it records no entity id, so the row does not name the document either", () => {
    expect(code("src/lib/certificates/denied.ts")).not.toContain("entityId");
  });
});

// ── the four places, as the repository ───────────────────────────────────────
//
// Scanning source is a blunt instrument, and these are here for one reason: the leak
// that happened was not a rule anybody disagreed with. It was a response somebody added
// without thinking about certificates at all. A rule that only lives in a review is a
// rule until the next hurried afternoon.

describe("every place the rule has to hold, holds", () => {
  it("every certificate endpoint checks ADMIN on the server", () => {
    for (const route of [
      "src/app/api/jobsheet/certificate/route.ts",
      "src/app/api/jobsheet/certificate/[id]/route.ts",
      "src/app/api/certificates/renderer/route.ts",
    ]) {
      const src = code(route);
      expect(src, `${route} does not check isAdmin`).toContain("isAdmin(session?.user?.role)");
      // canViewFinance lets an operator and an accountant through. It was the hole.
      expect(src, `${route} still uses canViewFinance`).not.toContain("canViewFinance");
      expect(src, `${route} does not audit refusals`).toContain("denied(session");
    }
  });

  it("every response that carries expense rows to a non-admin redacts them", () => {
    for (const route of ["src/app/api/jobsheet/route.ts", "src/app/api/jobsheet/receipt/route.ts"]) {
      expect(code(route), `${route} returns rows unredacted`).toContain("redactRowsForNonAdmin");
    }
    for (const route of [
      "src/app/api/pay/peak-document/route.ts",
      "src/app/api/pay/peak-document/preview/route.ts",
      "src/app/api/pay/peak-document/pay/route.ts",
    ]) {
      const src = code(route);
      expect(src, `${route} does not filter its body`).toContain("redactBodyForNonAdmin");
      // Every answer goes through the filter, not a chosen few. The only response these
      // handlers are allowed to build directly is the 403 that decides who is reading.
      const direct = src.slice(src.indexOf("export async function")).match(/NextResponse\.json\([^\n]*/g) ?? [];
      for (const call of direct) {
        expect(call, `${route} answers directly: ${call.trim()}`).toContain('{ error: "forbidden" }');
      }
    }
  });

  it("the panel draws nothing at all for a non-admin", () => {
    const src = code("src/components/ExpenseCertificatePanel.tsx");
    expect(src).toContain("if (!isAdmin) return null;");
    expect(code("src/components/JobSheetEditor.tsx")).toContain("{isAdmin && sheet.ref && (");
  });

  it("nothing sent to a guide is built from a certificate", () => {
    // The senders. If a certificate number ever reaches a guide, it comes through one of
    // these, and none of them may so much as import the certificate code.
    for (const sender of [
      "src/lib/jobsheet-send.ts", "src/lib/expense-reminders.ts", "src/lib/tour-reminders.ts",
      "src/lib/offers.ts", "src/lib/jobsheet-drive.ts",
    ]) {
      const src = code(sender);
      expect(src, `${sender} imports certificate code`).not.toContain("lib/certificates");
      for (const field of ["certificateNo", "certificateId", "evidenceWaiver", "CERT-"]) {
        expect(src, `${sender} mentions ${field}`).not.toContain(field);
      }
    }
  });
});
