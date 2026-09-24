import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACH_STATES, attachEnabled, classifyPeakReply, DEFINITIVE_REFUSALS,
  isAttached, needsLooking, type PeakReply,
} from "@/lib/certificates/peak-attach";

// Reading PEAK's answer about a file it may or may not be holding.
//
// PEAK has no endpoint that lists or reads back a document's attachments. So after a
// request that times out, nothing can ask whether the file arrived — and the only honest
// thing to record is that nobody knows. These tests are mostly about refusing to turn
// that into a cheerful answer.
//
// All data invented — this repo is public.

const reply = (over: Partial<PeakReply> = {}): PeakReply => ({ httpStatus: 200, body: {}, ...over });
const withCode = (resCode: string, resDesc = "") => reply({ body: { resCode, resDesc } });

const flag = process.env.CERTIFICATE_PEAK_ATTACH;
afterEach(() => {
  if (flag === undefined) delete process.env.CERTIFICATE_PEAK_ATTACH;
  else process.env.CERTIFICATE_PEAK_ATTACH = flag;
});

describe("PEAK said 200, which is not the same as the file being there", () => {
  it("exactly \"200\" with a 2xx is the one acceptance", () => {
    const out = classifyPeakReply(withCode("200", "Success"));
    expect(out.state).toBe("PEAK_ACCEPTED");
    expect(out.resCode).toBe("200");
    // The wording matters: this is what an admin reads before deciding whether to look.
    expect(out.why).toContain("not a sighting of the file");
  });

  it("reads the code through PEAK's wrapper as well as beside it", () => {
    expect(classifyPeakReply(reply({ body: { peakExpenses: { resCode: "200", resDesc: "Success" } } })).state).toBe("PEAK_ACCEPTED");
  });

  it("an all-zero code is UNCERTAIN here, though the slip path counts it a success", () => {
    // The list endpoints use all-zeros for success, and the slip reader inherited that.
    // insertfile documents "200". A code that merely resembles another endpoint's
    // convention is a guess, and guessing this way records a file nobody has seen.
    for (const code of ["0", "00", "0000"]) {
      expect(classifyPeakReply(withCode(code, "Success")).state, `code ${code}`).toBe("ATTACHMENT_UNCERTAIN");
    }
  });

  it("a success code under a failed transport is not an acceptance", () => {
    expect(classifyPeakReply(reply({ httpStatus: 502, body: { resCode: "200" } })).state).toBe("ATTACHMENT_UNCERTAIN");
  });
});

describe("only refusals that prove nothing was stored may be sent again", () => {
  it("the base64 rejection is one — the request never became a file", () => {
    const out = classifyPeakReply(withCode("400", "Invalid Base64 string."));
    expect(out.state).toBe("REFUSED");
    expect(out.why).toContain("nothing was stored");
  });

  it("so is a request PEAK could not parse or address", () => {
    expect(classifyPeakReply(withCode("400", "Bad Json Request : Missing Transaction Code or UUID")).state).toBe("REFUSED");
  });

  it("an unrecognised code is UNCERTAIN, not a refusal", () => {
    const out = classifyPeakReply(withCode("347", "Transaction must be Waiting Payment Status."));
    expect(out.state).toBe("ATTACHMENT_UNCERTAIN");
    expect(out.resCode).toBe("347");
  });

  it("an error code with no description is UNCERTAIN — there is nothing to match on", () => {
    expect(classifyPeakReply(withCode("400", "")).state).toBe("ATTACHMENT_UNCERTAIN");
  });

  it("an empty body is UNCERTAIN", () => {
    expect(classifyPeakReply(reply({ body: null })).state).toBe("ATTACHMENT_UNCERTAIN");
    expect(classifyPeakReply(reply({ body: {} })).state).toBe("ATTACHMENT_UNCERTAIN");
  });

  it("a request that never completed is UNCERTAIN, and says why", () => {
    const out = classifyPeakReply(reply({ transportError: "fetch failed: ETIMEDOUT" }));
    expect(out.state).toBe("ATTACHMENT_UNCERTAIN");
    expect(out.why).toContain("did not complete");
  });

  it("the refusal list is short on purpose", () => {
    expect(DEFINITIVE_REFUSALS.length).toBeLessThanOrEqual(4);
  });
});

describe("what the states are allowed to mean", () => {
  it("only an admin's sighting counts as attached", () => {
    expect(isAttached("ATTACHED_CONFIRMED")).toBe(true);
    for (const s of ["CLAIMED", "PEAK_ACCEPTED", "REFUSED", "ATTACHMENT_UNCERTAIN", "NOT_FOUND_IN_PEAK", null]) {
      expect(isAttached(s), `${s} must not count as attached`).toBe(false);
    }
  });

  it("both an acceptance and an uncertainty need a person to look", () => {
    expect(needsLooking("PEAK_ACCEPTED")).toBe(true);
    expect(needsLooking("ATTACHMENT_UNCERTAIN")).toBe(true);
    expect(needsLooking("ATTACHED_CONFIRMED")).toBe(false);
    expect(needsLooking("REFUSED")).toBe(false);
  });

  it("the ledger has exactly these states", () => {
    expect([...ATTACH_STATES]).toEqual([
      "CLAIMED", "PEAK_ACCEPTED", "REFUSED", "ATTACHMENT_UNCERTAIN", "ATTACHED_CONFIRMED", "NOT_FOUND_IN_PEAK",
    ]);
  });
});

describe("with the flag off, nothing happens at all", () => {
  it("off by default, and only the exact value turns it on", () => {
    delete process.env.CERTIFICATE_PEAK_ATTACH;
    expect(attachEnabled()).toBe(false);
    for (const v of ["", "0", "false", "off", "true", "yes"]) {
      process.env.CERTIFICATE_PEAK_ATTACH = v;
      expect(attachEnabled(), `"${v}" must not enable attaching`).toBe(false);
    }
    process.env.CERTIFICATE_PEAK_ATTACH = "1";
    expect(attachEnabled()).toBe(true);
  });

  it("the claim refuses before it writes anything or calls PEAK", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/peak-attach.ts"), "utf8");
    const claim = src.slice(src.indexOf("export async function claimAttachment"));
    const gate = claim.indexOf("attachEnabled()");
    const firstWrite = claim.indexOf("peakAttachment.create");
    expect(gate).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(gate); // the refusal comes first
  });

  it("nothing in this module posts to PEAK — the sender is the caller's to supply", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/peak-attach.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ["fetch(", "insertExpenseFile", "insertfile", "axios"]) {
      expect(src, `this module reaches PEAK directly via ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("linkage does not depend on the flag", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/peak-link.ts"), "utf8");
    expect(src).not.toContain("attachEnabled");
    expect(src).not.toContain("CERTIFICATE_PEAK_ATTACH");
  });
});
