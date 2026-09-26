import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { actingAdmin, confirmPayers, decide, HistoricalEvidenceRefused, loadJob, prepareCertificate, selectRows } from "@/lib/historical-evidence/service";
import { NOT_REQUIRED_REASONS } from "@/lib/historical-evidence/classify";
import { requireAdmin, deniedWrite } from "../access";

export const dynamic = "force-dynamic";

// One job in the campaign.
//
// GET   the job, its rows beside the guide's own report, and why it stands where it does
// POST  one admin action on it
//
// The body says WHAT to do and against which version of the sheet. It never says who is
// doing it, under what name or role, when, or who recorded the rows — every one of those
// comes from the session and the database. The schema is strict, so a body that tries to
// say any of them is refused outright rather than having the field quietly ignored.

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.number().int().min(0);
const note = z.string().max(500);

const bodyZ = z.discriminatedUnion("action", [
  z.object({ action: z.literal("not_required"), snapshotHash: hash, reviewVersion: version, reasonCode: z.enum(NOT_REQUIRED_REASONS), note: note.optional() }).strict(),
  z.object({ action: z.literal("reviewed"), snapshotHash: hash, reviewVersion: version, note }).strict(),
  z.object({ action: z.literal("reopen"), snapshotHash: hash, reviewVersion: version, note }).strict(),
  z.object({
    action: z.literal("confirm_payers"), snapshotHash: hash,
    rows: z.array(z.object({
      identity: z.string().min(1).max(600),
      payer: z.enum(["GUIDE_PERSONAL", "GUIDE_ADVANCE", "COMPANY_DIRECT"]),
      reason: z.string().max(300).optional(),
    }).strict()).min(1).max(40),
  }).strict(),
  z.object({
    action: z.literal("select_rows"), snapshotHash: hash,
    rows: z.array(z.object({
      identity: z.string().min(1).max(600),
      certify: z.boolean(),
      acknowledgeReceipt: z.boolean().optional(),
    }).strict()).min(1).max(40),
  }).strict(),
  z.object({ action: z.literal("prepare_certificate"), snapshotHash: hash, source: z.enum(["GUIDE_REPORTED", "ADMIN_RECORDED"]) }).strict(),
]);

const refused = (e: HistoricalEvidenceRefused) =>
  NextResponse.json({ error: e.status === 404 ? "not-found" : "not-allowed", reasons: e.reasons }, { status: e.status });

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await requireAdmin();
  if (!who.ok) return NextResponse.json({ error: "forbidden" }, { status: who.status });
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ ok: true, job: await loadJob(id) });
  } catch (e) {
    if (e instanceof HistoricalEvidenceRefused) return refused(e);
    throw e;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await requireAdmin();
  if (!who.ok) {
    await deniedWrite("historical_evidence.action");
    return NextResponse.json({ error: "forbidden" }, { status: who.status });
  }
  const { id } = await ctx.params;
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, { status: 400 });
  }
  const b = parsed.data;
  try {
    const actor = await actingAdmin(who.userId);
    switch (b.action) {
      case "not_required":
        return NextResponse.json({ ok: true, review: await decide(id, actor, { kind: "NOT_REQUIRED", snapshotHash: b.snapshotHash, reviewVersion: b.reviewVersion, reasonCode: b.reasonCode, note: b.note }) });
      case "reviewed":
        return NextResponse.json({ ok: true, review: await decide(id, actor, { kind: "REVIEWED", snapshotHash: b.snapshotHash, reviewVersion: b.reviewVersion, note: b.note }) });
      case "reopen":
        return NextResponse.json({ ok: true, review: await decide(id, actor, { kind: "REOPEN", snapshotHash: b.snapshotHash, reviewVersion: b.reviewVersion, note: b.note }) });
      case "confirm_payers":
        return NextResponse.json({ ok: true, confirmed: await confirmPayers(id, actor, { snapshotHash: b.snapshotHash, rows: b.rows }) });
      case "select_rows":
        return NextResponse.json({ ok: true, ...(await selectRows(id, actor, { snapshotHash: b.snapshotHash, rows: b.rows })) });
      case "prepare_certificate": {
        const cert = await prepareCertificate(id, actor, { snapshotHash: b.snapshotHash, source: b.source });
        return NextResponse.json({ ok: true, certificate: { id: cert.id, certificateNo: cert.certificateNo, status: cert.status, source: cert.source } });
      }
    }
  } catch (e) {
    if (e instanceof HistoricalEvidenceRefused) return refused(e);
    throw e;
  }
}
