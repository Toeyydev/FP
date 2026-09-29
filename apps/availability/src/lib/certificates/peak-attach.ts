import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient, PeakAttachment } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sanitizePeakError } from "@/lib/peak-api";

// Attaching a certificate PDF to the PEAK expense document its job is already in.
//
// It adds no accounting entry, no amount, no line and no document. The EXP is untouched:
// its total, its withholding, its payment status and its paid state are exactly what
// they were. This puts a file beside it.
//
// The hard part is not sending the file. It is that PEAK has no endpoint that lists or
// reads back a document's attachments, so after a request that times out there is no way
// to ask whether the file arrived. Retrying might duplicate it; not retrying might lose
// it. Neither is safe, so neither is automatic: the attempt is recorded as uncertain and
// a person looks.
//
// That is why "PEAK answered 200" and "the file is in PEAK" are different states here.
// The first is all this code can ever observe. The second requires someone to have
// looked.

/**
 * Real attaching is off unless a deployment says otherwise.
 *
 * With it off, nothing is claimed, no ledger row is written and PEAK is not called — the
 * button is not merely hidden, the path refuses. Linking a certificate to its job sheet,
 * its FOLK-PAY reference and its EXP is unaffected and goes on working: that is reading
 * what the system already recorded, not writing to anybody else's.
 */
export const attachEnabled = () => (process.env.CERTIFICATE_PEAK_ATTACH ?? "").trim() === "1";

export const ATTACH_STATES = [
  "CLAIMED",
  "PEAK_ACCEPTED",
  "REFUSED",
  "ATTACHMENT_UNCERTAIN",
  "ATTACHED_CONFIRMED",
  "NOT_FOUND_IN_PEAK",
] as const;
export type AttachState = (typeof ATTACH_STATES)[number];

export type RequestEncoding = "DATA_URI_BASE64" | "PLAIN_BASE64";

/** What an admin reports after looking at the document in PEAK. */
export type AdminFinding = "FOUND_IN_PEAK" | "NOT_FOUND_IN_PEAK";

export type PeakReply = { httpStatus: number; body: Record<string, unknown> | null; transportError?: string | null };
export type Outcome = { state: Extract<AttachState, "PEAK_ACCEPTED" | "REFUSED" | "ATTACHMENT_UNCERTAIN">; resCode: string | null; resDesc: string | null; why: string };

/**
 * Refusals that prove nothing was stored, so the attempt may be tried again.
 *
 * An allowlist, and short on purpose. Everything else — an unrecognised code, a code
 * with no description, an empty body, a gateway error — is uncertain, because the
 * difference between "PEAK rejected this before storing it" and "PEAK stored it and the
 * answer was lost" cannot be guessed from a message nobody has seen before.
 */
export const DEFINITIVE_REFUSALS: readonly RegExp[] = [
  /invalid\s*base\s*-?\s*64/i,          // the request never became a file
  /missing\s+transaction\s+(code|uuid)/i,
  /bad\s+json\s+request/i,
];

const readCode = (body: Record<string, unknown> | null): { code: string; desc: string } => {
  const wrap = (body?.peakExpenses ?? {}) as Record<string, unknown>;
  const code = String((body?.resCode ?? wrap?.resCode) ?? "").trim();
  const desc = sanitizePeakError(String((body?.resDesc ?? wrap?.resDesc) ?? "").trim());
  return { code, desc };
};

/**
 * What PEAK's answer means for the ledger.
 *
 * Stricter than the slip path's reader on one point, deliberately. That one accepts an
 * all-zero result code as success because the list endpoints use that convention. Here
 * an all-zero code is UNCERTAIN: PEAK documents this endpoint's success as exactly
 * "200", and a code that merely looks like the other endpoints' success is a guess about
 * an endpoint that has never been seen to answer that way. Guessing in this direction
 * records a file as attached when nobody knows whether it is.
 */
export function classifyPeakReply(reply: PeakReply): Outcome {
  if (reply.transportError) {
    return { state: "ATTACHMENT_UNCERTAIN", resCode: null, resDesc: sanitizePeakError(reply.transportError),
      why: "The request to PEAK did not complete, so whether the file reached it is unknown." };
  }
  const { code, desc } = readCode(reply.body);
  const ok2xx = reply.httpStatus >= 200 && reply.httpStatus < 300;

  if (ok2xx && code === "200") {
    return { state: "PEAK_ACCEPTED", resCode: code, resDesc: desc || "Success",
      why: "PEAK answered its documented success code. That is a reply, not a sighting of the file." };
  }
  if (desc && DEFINITIVE_REFUSALS.some((re) => re.test(desc))) {
    return { state: "REFUSED", resCode: code || null, resDesc: desc,
      why: "PEAK refused the request in a way that means nothing was stored, so it can be sent again." };
  }
  return { state: "ATTACHMENT_UNCERTAIN", resCode: code || null, resDesc: desc || null,
    why: code
      ? `PEAK answered ${code}, which is neither its documented success nor a refusal known to store nothing.`
      : `PEAK answered HTTP ${reply.httpStatus} with no result code.` };
}

type Db = PrismaClient | Prisma.TransactionClient;

export class AttachRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "AttachRefused";
  }
}
const refuse = (reasons: string[], status = 409): never => { throw new AttachRefused(reasons, status); };

export type ClaimInput = {
  certificateId: string;
  certificateNo: string;
  peakDocumentId: string;
  peakDocumentNo: string | null;
  peakPaymentRef: string | null;
  pdfHash: string;
  fileName: string;
};

/**
 * Take the one ledger row for this certificate on this document, or find out somebody
 * already has.
 *
 * The unique index on (certificateId, peakDocumentId) is the idempotency, not a check
 * before the insert: a double click, a retried request and two tabs all race the same
 * index, and exactly one of them wins. The loser is told what the winner's row says and
 * sends nothing.
 *
 * A row whose `pdfHash` differs from the file in hand is a contradiction rather than an
 * update. A certificate's filed PDF never changes — reissuing means voiding it and
 * making a new certificate, which has a new id and so a new row. So a different hash
 * under the same id means something rewrote a document that was supposed to be settled.
 */
export async function claimAttachment(input: ClaimInput, actorId: string | null, db: Db = prisma): Promise<{ claimed: boolean; row: PeakAttachment; token: string | null }> {
  if (!attachEnabled()) {
    refuse(["Attaching certificates to PEAK is switched off in this deployment, so nothing was claimed and PEAK was not called."], 503);
  }
  if (!input.peakDocumentId.trim()) {
    refuse(["This certificate's PEAK document has no internal id recorded, and the id is half of what identifies an attachment. Nothing can be attached until it does."]);
  }

  const token = randomUUID();
  try {
    const row = await db.peakAttachment.create({
      data: {
        certificateId: input.certificateId, peakDocumentId: input.peakDocumentId,
        peakDocumentNo: input.peakDocumentNo, peakPaymentRef: input.peakPaymentRef,
        pdfHash: input.pdfHash, fileName: input.fileName,
        state: "CLAIMED" satisfies AttachState, claimToken: token, leaseUntil: null,
        attemptedById: actorId,
      },
    });
    return { claimed: true, row, token };
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
  }

  const existing = await db.peakAttachment.findUnique({
    where: { certificateId_peakDocumentId: { certificateId: input.certificateId, peakDocumentId: input.peakDocumentId } },
  });
  if (!existing) refuse(["This certificate's attachment record could not be read back after another request created it. Reload and look at where it got to."], 500);

  if (existing!.pdfHash !== input.pdfHash) {
    refuse([
      `The document filed for ${input.certificateNo} is not the one this attachment record was made for. A certificate's PDF does not change — a replacement is a new certificate with a new number — so this needs looking at before anything is sent to PEAK.`,
    ]);
  }
  return { claimed: false, row: existing!, token: null };
}

/** Record what PEAK said. Only the row this attempt holds, and only from CLAIMED. */
export async function recordAttempt(
  rowId: string,
  token: string,
  sent: { encoding: RequestEncoding; at: Date },
  outcome: Outcome,
  actor: { actorId?: string | null; actorRole?: string | null },
  db: Db = prisma,
): Promise<PeakAttachment | null> {
  const moved = await db.peakAttachment.updateMany({
    where: { id: rowId, claimToken: token, state: "CLAIMED" },
    data: {
      state: outcome.state,
      requestEncoding: sent.encoding,
      peakResCode: outcome.resCode,
      peakResDesc: outcome.resDesc,
      attemptedAt: sent.at,
      claimToken: null,
      leaseUntil: null,
    },
  });
  if (moved.count !== 1) return null;
  const row = await db.peakAttachment.findUnique({ where: { id: rowId } });
  await audit({ ...actor, action: `certificate.peak_attach_${outcome.state.toLowerCase()}`, entityType: "PeakAttachment", entityId: rowId,
    detail: { certificateId: row?.certificateId, peakDocumentNo: row?.peakDocumentNo, peakDocumentId: row?.peakDocumentId,
      requestEncoding: sent.encoding, resCode: outcome.resCode, resDesc: outcome.resDesc, why: outcome.why,
      note: "attaching a file changes no amount, no withholding and no payment state" } });
  return row;
}

/**
 * An admin looked in PEAK and says what they saw.
 *
 * The only way to `ATTACHED_CONFIRMED`. Nothing this code can observe gets a certificate
 * there: PEAK's success code says a request was accepted, and this says a person opened
 * the document and saw the file on it.
 */
export async function resolveAttachment(
  rowId: string,
  finding: AdminFinding,
  actor: { id: string; role: string },
  note: string | null,
  db: Db = prisma,
): Promise<PeakAttachment> {
  const row = await db.peakAttachment.findUnique({ where: { id: rowId } });
  if (!row) refuse(["No such attachment record"], 404);
  if (!["PEAK_ACCEPTED", "ATTACHMENT_UNCERTAIN"].includes(row!.state)) {
    refuse([`This attachment is ${row!.state.toLowerCase().replace(/_/g, " ")}, which is not waiting on anybody to look in PEAK.`]);
  }

  const state: AttachState = finding === "FOUND_IN_PEAK" ? "ATTACHED_CONFIRMED" : "NOT_FOUND_IN_PEAK";
  const moved = await db.peakAttachment.updateMany({
    where: { id: rowId, state: row!.state },
    data: { state, resolvedById: actor.id, resolvedAt: new Date(), resolutionNote: (note ?? "").trim().slice(0, 500) || null },
  });
  if (moved.count !== 1) refuse(["Somebody else recorded what they found at the same moment. Reload and look at where it got to."]);

  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.peak_attach_resolved", entityType: "PeakAttachment", entityId: rowId,
    detail: { certificateId: row!.certificateId, peakDocumentNo: row!.peakDocumentNo, peakDocumentId: row!.peakDocumentId,
      was: row!.state, finding, note: (note ?? "").trim().slice(0, 500) || null,
      evidence: finding === "FOUND_IN_PEAK"
        ? "a named admin opened the document in PEAK and saw this file on it"
        : "a named admin opened the document in PEAK and the file was not there" } });
  return (await db.peakAttachment.findUnique({ where: { id: rowId } }))!;
}

/**
 * Let an admin send a refused attempt again, on the SAME row.
 *
 * Never a new row: a second row for one certificate on one document would be a second
 * answer to a question that has one, and the unique index exists to stop exactly that.
 * Only a REFUSED row qualifies, because only a refusal is known to have stored nothing.
 * An uncertain one is resolved by looking, not by sending again.
 */
export async function reclaimRefused(rowId: string, actor: { id: string; role: string }, db: Db = prisma): Promise<{ row: PeakAttachment; token: string }> {
  if (!attachEnabled()) refuse(["Attaching certificates to PEAK is switched off in this deployment."], 503);
  const token = randomUUID();
  const moved = await db.peakAttachment.updateMany({
    where: { id: rowId, state: "REFUSED" },
    data: { state: "CLAIMED" satisfies AttachState, claimToken: token, attemptedById: actor.id, peakResCode: null, peakResDesc: null },
  });
  if (moved.count !== 1) {
    const row = await db.peakAttachment.findUnique({ where: { id: rowId } });
    refuse([row
      ? `Only a refused attempt can be sent again, and this one is ${row.state.toLowerCase().replace(/_/g, " ")}. An uncertain attempt is settled by looking in PEAK, not by sending the file a second time.`
      : "No such attachment record"], row ? 409 : 404);
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.peak_attach_retry_claimed", entityType: "PeakAttachment", entityId: rowId,
    detail: { note: "an admin asked for a refused attachment to be sent again; the same ledger row was reused" } });
  return { row: (await db.peakAttachment.findUnique({ where: { id: rowId } }))!, token };
}

/** Whether the file is known to be on the document. Exactly one state means yes. */
export const isAttached = (state: string | null | undefined) => state === "ATTACHED_CONFIRMED";

/** Whether a person needs to go and look. */
export const needsLooking = (state: string | null | undefined) =>
  state === "ATTACHMENT_UNCERTAIN" || state === "PEAK_ACCEPTED";
