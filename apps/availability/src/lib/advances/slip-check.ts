// The slip check, as the server runs it before an advance is recorded.
//
// The screen asks first (POST /api/advances/slip-check) so the person sees the result
// while they fill in the form — but the screen's answer is never trusted: the create
// routes read the SAME uploaded bytes again and gate on their own result. A request that
// skips the screen gets the same check and the same refusal.
//
// Names and account numbers stay on this server: the slip is read in-process
// (lib/advances/slip-read), the guide's account is decrypted here, and only results and
// masked digits are kept on the advance (storedDetail). The audit row records the result,
// who confirmed it and why — never a name.
import type { PrismaClient } from "@prisma/client";
import { decrypt } from "@/lib/crypto";
import { readSlip } from "@/lib/advances/slip-read";
import { checkSlip, slipGate, storedDetail, type GuideIdentity, type SlipCheck, type SlipDecision, type SlipResult, type StoredSlipDetail, type Typed } from "@/lib/advances/slip-match";

export type StoredSlipCheck = { result: SlipResult; detail: StoredSlipDetail; confirmedById: string | null; reason: string | null; override: boolean };

/** Every guide's names and account, decrypted, for comparison only. */
export async function guideIdentities(db: Pick<PrismaClient, "user">): Promise<GuideIdentity[]> {
  const rows = await db.user.findMany({
    where: { guideId: { not: null } },
    select: { guideId: true, fullName: true, fullNameThai: true, fullNameEnglish: true, bankAccountName: true, bankAccountNo: true },
  });
  return rows.map((r) => ({
    guideId: r.guideId!,
    names: [r.fullNameThai, r.fullNameEnglish, r.fullName, decrypt(r.bankAccountName) || null],
    accountNo: (decrypt(r.bankAccountNo) || "").replace(/\D/g, "") || null,
  }));
}

export type SlipFileLike = { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> };

/** Read the slip and compare it with what was typed and with the guide. */
export async function runSlipCheck(db: Pick<PrismaClient, "user">, file: SlipFileLike, guideId: string, typed: Typed): Promise<SlipCheck> {
  const bytes = file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  const read = bytes.length ? await readSlip(bytes, file.type, file.name) : { ok: false as const, why: "no slip attached" };
  const everyone = await guideIdentities(db);
  const guide = everyone.find((g) => g.guideId === guideId) ?? { guideId, names: [], accountNo: null };
  return checkSlip(read.ok ? read.read : null, read.ok ? null : read.why, typed, guide, everyone.filter((g) => g.guideId !== guideId));
}

/** The person's answer to the check, as a form or JSON body carries it. */
export function slipDecisionFrom(get: (k: string) => unknown): SlipDecision {
  const flag = (k: string) => { const v = get(k); return v === true || v === "1" || v === "true"; };
  const reason = get("slipCheckReason");
  return { confirmed: flag("slipCheckConfirmed"), override: flag("slipCheckOverride"), reason: typeof reason === "string" ? reason.slice(0, 500) : null };
}

export type SlipGateResult =
  | { ok: true; stored: StoredSlipCheck; check: SlipCheck }
  | { ok: false; status: number; body: { error: string; code: string; reasons: string[]; detail: string; hint: string; slipCheck: SlipCheck } };

/** Run the check and apply the rule. The refusal carries the check so the screen can show it. */
export async function gateSlip(db: Pick<PrismaClient, "user">, file: SlipFileLike, guideId: string, typed: Typed, decision: SlipDecision,
  actor: { actorId: string | null; actorRole: string | null }): Promise<SlipGateResult> {
  const check = await runSlipCheck(db, file, guideId, typed);
  const refused = slipGate(check.result, decision, actor.actorRole);
  if (refused) {
    const reasons = [...refused, ...check.reasons];
    return { ok: false, status: 422, body: { error: "slip-check", code: `SLIP_CHECK_${check.result}`, reasons, detail: reasons.join("\n"), hint: refused[1], slipCheck: check } };
  }
  const needsPerson = check.result !== "MATCH";
  return {
    ok: true, check,
    stored: {
      result: check.result, detail: storedDetail(check),
      confirmedById: needsPerson ? actor.actorId : null,
      reason: needsPerson ? (decision.reason ?? "").trim() || null : null,
      override: check.result === "MISMATCH" && decision.override,
    },
  };
}
