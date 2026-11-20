// The guest QR for a walk-in seat (owner, 20 Nov 2026: "แขกสแกน ลงทะเบียน/ซื้อทัวร์ walk-in";
// mockup pr4q approved with Codex's corrections). Behind UPSELL_WALKIN_QR_ENABLED (off).
//
//   guide (own job) or Admin opens a QR for the job's walk-in seat → a guest scans it, sees the
//   tour, date, time, the ฿ total and the seats available, and REGISTERS (PENDING) → the guest
//   pays the guide in cash → the guide presses "Cash received" → recordWalkInSale makes the sale,
//   booking, guest-list row, cash custody and PEAK receipt event, and marks the registration
//   CONFIRMED — all in ONE transaction. Hand-in (code before transfer) and PEAK follow as for any
//   Extras cash.
//
// Rules this file keeps:
//   • A registration is never money and reserves no seat. Only the guide's cash confirmation is.
//     The guest has no "I paid" action; PAID is shown only once the server holds the sale.
//   • Tokens: 192-bit random, stored as SHA-256 (lookup) + encrypted (to show the same QR / link
//     again). The QR holds only the public URL of the canonical origin (lib/site), never a Host
//     header; the guest's status link carries its token in the URL fragment (never sent).
//   • One live QR per job: a new QR revokes the old; revoking, the end-tour report, a product or
//     price change (a new version), the job's day ending or 4 hours passing closes unpaid
//     registrations — the guest registers again from the current QR at the current total. No
//     stale price is ever charged. Paid ones are never touched.
//   • Personal data is optional (a name, a phone or email), seen only by the job's guide and
//     Admin, encrypted at rest (contact), cleared whenever a registration ends unpaid, never in
//     the QR, a URL, a log, an audit row or PEAK.

import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { PUBLIC_BASE_URL } from "@/lib/site";
import { SLOT_TIMES } from "@/lib/slots";
import { PAX_PER_GUIDE } from "@/lib/capacity";
import { UpsellSaleError, recordWalkInSale, saleByKey, walkInOffer, type SaleView } from "./sales";
import { upsellWalkInQrEnabled } from "./flags";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export class WalkInQrError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429, public code: string, message: string) { super(message); }
}
const refuse = (status: WalkInQrError["status"], code: string, message: string): never => { throw new WalkInQrError(status, code, message); };

export type QrActor = { userId: string; role: "GUIDE" | "ADMIN"; guideId: string | null };

/** A registration is open this long at most (and never past its QR). */
export const REGISTRATION_HOURS = 4;
/** Bot drafts cannot pile up: waiting registrations per QR, and new ones per 10 minutes. */
export const MAX_PENDING_PER_QR = 40;
export const MAX_NEW_PER_10_MIN = 30;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(24).toString("base64url"); // 192 bits, URL-safe, 32 chars
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () => { const b = randomBytes(8); let s = ""; for (let i = 0; i < 8; i++) s += REF_ALPHABET[b[i] % 32]; return `W-${s.slice(0, 4)}-${s.slice(4)}`; };

/** The origin a QR points at: the app's canonical public URL — https, or http on localhost outside production. */
export function qrOrigin(base = PUBLIC_BASE_URL, production = process.env.NODE_ENV === "production" && !process.env.E2E_ALLOW_HTTP_LOCALHOST): string {
  let u: URL;
  try { u = new URL(base); } catch { throw new WalkInQrError(409, "ORIGIN", "The app's public address (PUBLIC_BASE_URL) is not a valid URL"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) refuse(409, "ORIGIN", "The guest QR needs the app's https address (PUBLIC_BASE_URL)");
  return u.origin;
}
export const qrUrl = (token: string, origin = qrOrigin()) => `${origin}/w/${token}`;
/** The guest's own status link: the token travels in the fragment, which browsers never send. */
export const statusUrl = (viewToken: string, origin = qrOrigin()) => `${origin}/w/status#${viewToken}`;
export const qrSvg = (url: string) => QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });

/** End of the job's day in Bangkok. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59+07:00`);

async function actorMayOpen(db: Db | Tx, actor: QrActor, jobSheetId: string) {
  const job = await db.jobSheet.findUnique({ where: { id: jobSheetId }, select: { id: true, guideId: true, date: true, slotIdx: true, ref: true } });
  if (!job) refuse(404, "NO_JOB", "No such job");
  const me = await db.user.findUnique({ where: { id: actor.userId }, select: { role: true, state: true, guideId: true } });
  if (!me || me.state !== "ACTIVE" || me.role !== actor.role) refuse(403, "FORBIDDEN", "Not allowed");
  if (actor.role === "GUIDE" && (!me!.guideId || me!.guideId !== job!.guideId)) refuse(403, "NOT_YOUR_JOB", "Only the guide of this job opens its QR");
  if (actor.role !== "GUIDE" && actor.role !== "ADMIN") refuse(403, "FORBIDDEN", "Not allowed");
  return job!;
}

/** End unpaid registrations: status, when, why — and their personal data goes. */
async function closePending(tx: Db | Tx, where: Prisma.WalkInRegistrationWhereInput, status: "EXPIRED" | "CANCELLED", reason: string, by: string | null, now = new Date()) {
  const r = await tx.walkInRegistration.updateMany({ where: { ...where, status: "PENDING" }, data: { status, decidedAt: now, decidedById: by, endReason: reason.slice(0, 200), leadName: null, contactEnc: null } });
  return r.count;
}

// ── The QR (guide or Admin) ───────────────────────────────────────────────────────────────

export type QrCard = { open: true; url: string; svg: string; expiresAt: string; unitPriceSatang: number; seatsLeft: number; productName: string } | { open: false; reason: string; message: string };

const CLOSED_MESSAGE: Record<string, string> = {
  NO_QR: "No guest QR yet.", REVOKED: "This QR was stopped or replaced.", EXPIRED: "This QR's day is over.",
  REPORT_SENT: "The end-tour report is sent — the tour is finished.", NOT_TODAY: "Walk-in seats are sold on the day of the job only.",
  JOB_CANCELLED: "This job is no longer assigned.", NOT_ON_SALE: "Walk-in seats are not on sale on this job now.",
  PRODUCT_CHANGED: "The walk-in seat's price or details changed — open a new QR; unpaid registrations from the old one have ended.",
  NO_JOB: "No such job.",
};
const closed = (reason: string): QrCard => ({ open: false, reason, message: CLOSED_MESSAGE[reason] ?? "This QR is closed." });

/** The job's live QR as the guide shows it, or why there is none. Reads only. */
export async function currentQr(db: Db, actor: QrActor, jobSheetId: string, now = new Date()): Promise<QrCard> {
  await actorMayOpen(db, actor, jobSheetId);
  const qr = await db.walkInQr.findFirst({ where: { jobSheetId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  if (!qr) return closed("NO_QR");
  if (qr.expiresAt <= now) return closed("EXPIRED");
  const offer = await walkInOffer(db, jobSheetId, qr.productVersionId, now);
  if (!offer.open) return closed(offer.reason);
  const url = qrUrl(decrypt(qr.tokenEnc));
  return { open: true, url, svg: await qrSvg(url), expiresAt: qr.expiresAt.toISOString(), unitPriceSatang: offer.version.unitPriceSatang, seatsLeft: offer.seatsLeft, productName: offer.product.productName };
}

/** Open a QR for the job's walk-in seat now on sale; any older QR of this job is revoked first. */
export async function openQr(db: Db, actor: QrActor, jobSheetId: string, now = new Date()): Promise<QrCard> {
  const job = await actorMayOpen(db, actor, jobSheetId);
  qrOrigin(); // refuse before anything is written if the address is wrong
  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobSheet" WHERE "id" = ${jobSheetId} FOR UPDATE`;
    // Asked with no version, the offer names the one on sale now (as "PRODUCT_CHANGED").
    const anyVersion = await walkInOffer(tx, jobSheetId, "", now);
    const current = !anyVersion.open && anyVersion.reason === "PRODUCT_CHANGED" ? anyVersion.current : null;
    if (!current) { const why = anyVersion.open ? "NOT_ON_SALE" : anyVersion.reason; throw new WalkInQrError(409, why, CLOSED_MESSAGE[why] ?? "Walk-in seats are not on sale on this job now."); }
    await revokeLive(tx, jobSheetId, actor.userId, "Replaced by a new QR", now);
    const token = newToken();
    const qr = await tx.walkInQr.create({ data: { tokenHash: sha(token), tokenEnc: encrypt(token), jobSheetId, productVersionId: current.version.id, createdById: actor.userId, expiresAt: endOfDay(job.date) } });
    await tx.auditLog.create({ data: { actorId: actor.userId, actorRole: actor.role, action: "upsell.walk_in_qr_opened", entityType: "WalkInQr", entityId: qr.id, detail: { jobRef: job.ref, productVersionId: qr.productVersionId, expiresAt: qr.expiresAt.toISOString() } } });
    return qr;
  });
  void created;
  return currentQr(db, actor, jobSheetId, now);
}

async function revokeLive(tx: Tx, jobSheetId: string, by: string, reason: string, now: Date) {
  const live = await tx.walkInQr.findMany({ where: { jobSheetId, revokedAt: null }, select: { id: true } });
  for (const q of live) {
    await tx.walkInQr.update({ where: { id: q.id }, data: { revokedAt: now, revokedById: by, revokeReason: reason } });
    await closePending(tx, { qrId: q.id }, "EXPIRED", `The QR was ${reason === "Replaced by a new QR" ? "replaced by a new one" : "stopped"} — register again from the current QR`, by, now);
    await tx.auditLog.create({ data: { actorId: by, actorRole: "GUIDE_OR_ADMIN", action: "upsell.walk_in_qr_revoked", entityType: "WalkInQr", entityId: q.id, detail: { reason } } });
  }
  return live.length;
}

/** Stop the job's QR: it no longer opens; unpaid registrations from it end. Paid ones stay. */
export async function stopQr(db: Db, actor: QrActor, jobSheetId: string, now = new Date()) {
  await actorMayOpen(db, actor, jobSheetId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobSheet" WHERE "id" = ${jobSheetId} FOR UPDATE`;
    return { revoked: await revokeLive(tx, jobSheetId, actor.userId, "Stopped", now) };
  });
}

// ── The guest (no account) ────────────────────────────────────────────────────────────────

export type PublicQrView =
  | { state: "OPEN"; tourName: string; date: string; time: string | null; unitPriceSatang: number; seatsLeft: number; maxGuests: number; productName: string }
  | { state: "CLOSED"; message: string };

const GUEST_CLOSED: Record<string, string> = {
  REVOKED: "This QR is no longer valid. Ask your guide for the current one.",
  EXPIRED: "This QR has expired. Ask your guide for the current one.",
  PRODUCT_CHANGED: "This QR is out of date — the tour's details changed. Ask your guide for the new QR.",
  REPORT_SENT: "This tour has finished.",
};
const guestClosed = (reason: string): PublicQrView => ({ state: "CLOSED", message: GUEST_CLOSED[reason] ?? "Registration is not open on this QR now. Ask your guide." });

async function liveQr(db: Db | Tx, token: string, now: Date) {
  if (!TOKEN_RE.test(token)) return { qr: null, reason: "UNKNOWN" as const };
  const qr = await db.walkInQr.findUnique({ where: { tokenHash: sha(token) } });
  if (!qr) return { qr: null, reason: "UNKNOWN" as const };
  if (qr.revokedAt) return { qr, reason: "REVOKED" as const };
  if (qr.expiresAt <= now) return { qr, reason: "EXPIRED" as const };
  return { qr, reason: null };
}

/** What the guest sees after scanning — the tour, never anyone's details. Unknown token → null (404). */
export async function publicQrView(db: Db, token: string, now = new Date()): Promise<PublicQrView | null> {
  const { qr, reason } = await liveQr(db, token, now);
  if (!qr) return null;
  if (reason) return guestClosed(reason);
  const offer = await walkInOffer(db, qr.jobSheetId, qr.productVersionId, now);
  if (!offer.open) return guestClosed(offer.reason);
  const tour = await db.tour.findUnique({ where: { id: offer.sheet.tourId }, select: { name: true } });
  return { state: "OPEN", tourName: tour?.name ?? offer.product.productName, productName: offer.product.productName, date: offer.sheet.date, time: SLOT_TIMES[offer.sheet.slotIdx] ?? null,
    unitPriceSatang: offer.version.unitPriceSatang, seatsLeft: offer.seatsLeft, maxGuests: Math.min(offer.seatsLeft, PAX_PER_GUIDE) };
}

export const REGISTER_BODY = z.object({
  requestKey: z.string().regex(/^[A-Za-z0-9-]{16,80}$/),
  guests: z.number().int().min(1).max(PAX_PER_GUIDE),
  leadName: z.string().trim().max(80).optional(),
  contact: z.string().trim().max(120).optional(),
}).strict();

/**
 * Register from the QR: PENDING, at the server's price for the QR's version — nothing a guest
 * sends sets the job, the product, the price or a status. The same request key again answers
 * with the same registration (a retry never makes a second).
 */
export async function registerFromQr(db: Db, token: string, body: unknown, now = new Date()): Promise<{ reference: string; viewToken: string; replay: boolean }> {
  const parsed = REGISTER_BODY.safeParse(body);
  if (!parsed.success) refuse(400, "BAD_REQUEST", "Check the number of guests and try again");
  const req = parsed.data!;
  return db.$transaction(async (tx) => {
    const { qr, reason } = await liveQr(tx, token, now);
    if (!qr) refuse(404, "UNKNOWN", "Not found");
    // Serialise registrations on one QR (the caps below are counts).
    await tx.$queryRaw`SELECT "id" FROM "WalkInQr" WHERE "id" = ${qr!.id} FOR UPDATE`;
    const again = await tx.walkInRegistration.findUnique({ where: { qrId_requestKey: { qrId: qr!.id, requestKey: req.requestKey } } });
    if (again) {
      if (again.guests !== req.guests) refuse(409, "REQUEST_KEY_REUSED", "Start again");
      return { reference: again.reference, viewToken: decrypt(again.viewTokenEnc), replay: true };
    }
    if (reason) refuse(409, "CLOSED", GUEST_CLOSED[reason] ?? "Registration is closed");
    const offer = await walkInOffer(tx, qr!.jobSheetId, qr!.productVersionId, now);
    if (!offer.open) throw new WalkInQrError(409, "CLOSED", GUEST_CLOSED[offer.reason] ?? "Registration is not open on this QR now. Ask your guide.");
    if (req.guests > offer.seatsLeft) refuse(409, "TOO_MANY_GUESTS", offer.seatsLeft > 0 ? `Only ${offer.seatsLeft} seat${offer.seatsLeft === 1 ? " is" : "s are"} available now` : "The tour is full");
    const pending = await tx.walkInRegistration.count({ where: { qrId: qr!.id, status: "PENDING", expiresAt: { gt: now } } });
    const recent = await tx.walkInRegistration.count({ where: { qrId: qr!.id, createdAt: { gt: new Date(now.getTime() - 10 * 60_000) } } });
    if (pending >= MAX_PENDING_PER_QR || recent >= MAX_NEW_PER_10_MIN) refuse(429, "BUSY", "Too many registrations right now — ask your guide");
    const viewToken = newToken();
    const expiresAt = new Date(Math.min(now.getTime() + REGISTRATION_HOURS * 3600_000, qr!.expiresAt.getTime()));
    let created;
    for (let i = 0; i < 4 && !created; i++) {
      const reference = newReference();
      if (await tx.walkInRegistration.findUnique({ where: { reference }, select: { id: true } })) continue;
      created = await tx.walkInRegistration.create({ data: {
        reference, viewTokenHash: sha(viewToken), viewTokenEnc: encrypt(viewToken), qrId: qr!.id, jobSheetId: qr!.jobSheetId, productVersionId: qr!.productVersionId,
        requestKey: req.requestKey, guests: req.guests, unitPriceSatang: offer.version.unitPriceSatang, totalSatang: req.guests * offer.version.unitPriceSatang,
        leadName: req.leadName || null, contactEnc: req.contact ? encrypt(req.contact) : null, expiresAt } });
    }
    if (!created) refuse(409, "TRY_AGAIN", "Try again");
    // No personal data in the audit row.
    await tx.auditLog.create({ data: { actorId: null, actorRole: "PUBLIC", action: "upsell.walk_in_registered", entityType: "WalkInRegistration", entityId: created!.id, detail: { reference: created!.reference, guests: created!.guests, totalSatang: created!.totalSatang } } });
    return { reference: created!.reference, viewToken, replay: false };
  });
}

export type GuestRegistrationView = {
  reference: string; guests: number; totalSatang: number; unitPriceSatang: number; tourName: string; date: string; time: string | null;
  state: RegState; endedBecause: string | null; validUntil: string;
  sale: { saleNo: string; jobRef: string | null; receipt: SaleView["receipt"] } | null;
};

/**
 * What a registration is now, truthfully. A CONFIRMED registration whose sale an Admin later
 * reversed is not "paid, on the tour": REFUNDED (the guest got the money back) or CANCELLED
 * (recorded in error — no money was taken). Its references stay readable; nothing is reopened.
 */
export type RegState = "WAITING" | "PAID" | "REFUNDED" | "CANCELLED" | "ENDED";
type SaleOutcome = { status: string; reversals: { kind: string }[] } | null;
function stateOf(status: string, closedWhy: string | null, sale: SaleOutcome): RegState {
  if (status === "CONFIRMED") {
    if (sale?.status === "REVERSED") return sale.reversals.some((x) => x.kind === "REFUNDED") ? "REFUNDED" : "CANCELLED";
    return "PAID";
  }
  return status === "PENDING" && !closedWhy ? "WAITING" : "ENDED";
}
const SALE_OUTCOME = { select: { id: true, saleNo: true, status: true, sourceJobSheet: { select: { ref: true } }, reversals: { where: { status: "APPROVED" }, select: { kind: true } } } } as const;

/** Why a PENDING registration can no longer be paid — or null while it can (read-time; the sweep writes it). */
async function closedBecause(db: Db | Tx, r: { status: string; expiresAt: Date; jobSheetId: string; productVersionId: string; qr: { revokedAt: Date | null; expiresAt: Date } }, now: Date): Promise<string | null> {
  if (r.status !== "PENDING") return null;
  if (!upsellWalkInQrEnabled()) return "Guest registration is switched off — ask your guide";
  if (r.expiresAt <= now || r.qr.expiresAt <= now) return "Time ran out — register again from your guide's current QR";
  if (r.qr.revokedAt) return "The QR was replaced or stopped — register again from your guide's current QR";
  const offer = await walkInOffer(db, r.jobSheetId, r.productVersionId, now);
  if (!offer.open) return offer.reason === "PRODUCT_CHANGED" ? "The tour's details changed — register again from your guide's new QR" : offer.reason === "REPORT_SENT" ? "The tour has finished" : "Registration closed";
  return null;
}

const RECEIPT_STATE: Record<string, SaleView["receipt"]["state"]> = { POSTED: "SYNCED", PENDING: "QUEUED", SENDING: "QUEUED", BLOCKED: "WAITING", FAILED: "CHECKING", UNCERTAIN: "CHECKING", CANCELLED: "NONE" };

/** The guest's own registration, by its view token only. Unknown → null. No other guest, ever. */
export async function guestRegistrationView(db: Db, viewToken: string, now = new Date()): Promise<GuestRegistrationView | null> {
  if (!TOKEN_RE.test(viewToken)) return null;
  const r = await db.walkInRegistration.findUnique({ where: { viewTokenHash: sha(viewToken) }, include: { qr: { select: { revokedAt: true, expiresAt: true } }, jobSheet: { select: { date: true, slotIdx: true, tourId: true } },
    sale: SALE_OUTCOME } });
  if (!r) return null;
  const tour = await db.tour.findUnique({ where: { id: r.jobSheet.tourId }, select: { name: true } });
  const why = await closedBecause(db, r, now);
  let sale: GuestRegistrationView["sale"] = null;
  if (r.status === "CONFIRMED" && r.sale) {
    const ev = await db.upsellPeakEvent.findUnique({ where: { eventKind_sourceTable_sourceId: { eventKind: "RECEIPT", sourceTable: "UpsellSale", sourceId: r.sale.id } }, select: { status: true, peakCode: true } });
    // Only the state and, once POSTED, the document number — never an error text or an account.
    sale = { saleNo: r.sale.saleNo, jobRef: r.sale.sourceJobSheet.ref, receipt: ev ? { state: RECEIPT_STATE[ev.status] ?? "WAITING", peakCode: ev.status === "POSTED" ? ev.peakCode : null } : { state: "NONE", peakCode: null } };
  }
  return {
    reference: r.reference, guests: r.guests, totalSatang: r.totalSatang, unitPriceSatang: r.unitPriceSatang, tourName: tour?.name ?? "Tour", date: r.jobSheet.date, time: SLOT_TIMES[r.jobSheet.slotIdx] ?? null,
    state: stateOf(r.status, why, r.sale),
    endedBecause: r.status === "PENDING" ? why : r.status === "CONFIRMED" ? null : r.endReason, validUntil: r.expiresAt.toISOString(), sale,
  };
}

/** The guest withdraws a WAITING registration. A paid one is never touched from here. */
export async function guestCancel(db: Db, viewToken: string, now = new Date()) {
  if (!TOKEN_RE.test(viewToken)) refuse(404, "UNKNOWN", "Not found");
  return db.$transaction(async (tx) => {
    const r = await tx.walkInRegistration.findUnique({ where: { viewTokenHash: sha(viewToken) }, select: { id: true, status: true } });
    if (!r) refuse(404, "UNKNOWN", "Not found");
    await tx.$queryRaw`SELECT "id" FROM "WalkInRegistration" WHERE "id" = ${r!.id} FOR UPDATE`;
    const fresh = await tx.walkInRegistration.findUniqueOrThrow({ where: { id: r!.id }, select: { status: true } });
    if (fresh.status === "CONFIRMED") refuse(409, "PAID", "This registration is paid — ask your guide");
    if (fresh.status !== "PENDING") return { cancelled: false };
    await closePending(tx, { id: r!.id }, "CANCELLED", "Cancelled by the guest", null, now);
    await tx.auditLog.create({ data: { actorId: null, actorRole: "PUBLIC", action: "upsell.walk_in_registration_cancelled", entityType: "WalkInRegistration", entityId: r!.id, detail: { by: "guest" } } });
    return { cancelled: true };
  });
}

// ── The guide: waiting registrations, cash received ───────────────────────────────────────

export type GuideRegistration = { id: string; reference: string; guests: number; totalSatang: number; unitPriceSatang: number; leadName: string | null; contact: string | null;
  createdAt: string; validUntil: string; state: RegState; endedBecause: string | null; saleNo: string | null };

/** This job's registrations for its own guide (or Admin): today's waiting ones and what became of the rest. */
export async function guideRegistrations(db: Db, actor: QrActor, jobSheetId: string, now = new Date()): Promise<GuideRegistration[]> {
  await actorMayOpen(db, actor, jobSheetId);
  const rows = await db.walkInRegistration.findMany({ where: { jobSheetId }, orderBy: { createdAt: "asc" }, take: 200,
    include: { qr: { select: { revokedAt: true, expiresAt: true } }, sale: SALE_OUTCOME } });
  const out: GuideRegistration[] = [];
  for (const r of rows) {
    const why = await closedBecause(db, r, now);
    const state = stateOf(r.status, why, r.sale);
    out.push({ id: r.id, reference: r.reference, guests: r.guests, totalSatang: r.totalSatang, unitPriceSatang: r.unitPriceSatang,
      leadName: state === "ENDED" ? null : r.leadName, contact: state === "ENDED" || !r.contactEnc ? null : decrypt(r.contactEnc),
      createdAt: r.createdAt.toISOString(), validUntil: r.expiresAt.toISOString(), state, endedBecause: r.status === "PENDING" ? why : r.endReason, saleNo: r.sale?.saleNo ?? null });
  }
  return out;
}

/**
 * The guide received the guest's cash: the sale, in ONE transaction with the registration —
 * locked first, still PENDING and open (its QR live, not expired), for the same job, version and
 * price; then recordWalkInSale's own checks (assignment, report, capacity, price, version). The
 * request key is the registration's own, so a retry or a second tab returns the same sale.
 */
export async function confirmRegistrationCash(db: Db, guide: { userId: string; guideId: string }, registrationId: string, now = new Date()) {
  const r = await db.walkInRegistration.findUnique({ where: { id: registrationId } });
  if (!r) refuse(404, "NO_REGISTRATION", "No such registration");
  const requestKey = `walkin-qr-${r!.id}`;
  try {
    const result = await recordWalkInSale(db, { requestKey, jobSheetId: r!.jobSheetId, productVersionId: r!.productVersionId, guests: r!.guests, expectedUnitPriceSatang: r!.unitPriceSatang, ...(r!.leadName ? { leadName: r!.leadName } : {}) }, guide, now, {
      async guard(tx) {
        await tx.$queryRaw`SELECT "id" FROM "WalkInRegistration" WHERE "id" = ${r!.id} FOR UPDATE`;
        const fresh = await tx.walkInRegistration.findUniqueOrThrow({ where: { id: r!.id }, include: { qr: { select: { revokedAt: true, expiresAt: true } } } });
        if (fresh.status !== "PENDING") throw new UpsellSaleError(409, "REGISTRATION_CLOSED", "This registration has ended — the guest registers again from the current QR");
        const why = await closedBecause(tx, fresh, now);
        if (why) throw new UpsellSaleError(409, "REGISTRATION_CLOSED", `${why}. Nothing was recorded.`);
      },
      async after(tx, sale) {
        await tx.walkInRegistration.update({ where: { id: r!.id }, data: { status: "CONFIRMED", saleId: sale.id, decidedAt: now, decidedById: guide.userId } });
        await tx.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.walk_in_registration_paid", entityType: "WalkInRegistration", entityId: r!.id, detail: { reference: r!.reference, saleNo: sale.saleNo } } });
      },
    });
    return result;
  } catch (e) {
    // Another tap or tab confirmed it a moment ago: the same sale — never a second one.
    const now2 = await db.walkInRegistration.findUnique({ where: { id: r!.id }, select: { status: true } });
    if (now2?.status === "CONFIRMED") {
      const sale = await saleByKey(db, requestKey, guide.guideId);
      if (sale) return { sale, replay: true };
    }
    // A product or price change, the report, or time running out: the registration ends (unpaid,
    // its personal data cleared) — never a sale at an old price.
    if (e instanceof UpsellSaleError && ["REGISTRATION_CLOSED", "PRICE_CHANGED", "NOT_ON_SALE", "REPORT_SENT", "VERSION_NOT_SELLABLE"].includes(e.code)) {
      await sweepWalkInRegistrations(db, now, { id: r!.id });
    }
    throw e;
  }
}

/** The guide: this guest is not coming (or will not pay). */
export async function guideDecline(db: Db, actor: QrActor, registrationId: string, now = new Date()) {
  const r = await db.walkInRegistration.findUnique({ where: { id: registrationId }, select: { id: true, jobSheetId: true } });
  if (!r) refuse(404, "NO_REGISTRATION", "No such registration");
  await actorMayOpen(db, actor, r!.jobSheetId);
  const n = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "WalkInRegistration" WHERE "id" = ${r!.id} FOR UPDATE`;
    const c = await closePending(tx, { id: r!.id }, "CANCELLED", "Your guide marked it as not going ahead", actor.userId, now);
    if (c) await tx.auditLog.create({ data: { actorId: actor.userId, actorRole: actor.role, action: "upsell.walk_in_registration_cancelled", entityType: "WalkInRegistration", entityId: r!.id, detail: { by: "guide" } } });
    return c;
  });
  if (!n) refuse(409, "NOT_WAITING", "This registration is not waiting any more");
  return { cancelled: true };
}

/**
 * Write the end of every registration that can no longer be paid (switch off, time, QR revoked,
 * report sent, product changed, job no longer sold): EXPIRED with the reason, personal data
 * cleared — and clear any personal data still left on an ended unpaid row. Paid registrations are
 * never touched. Runs in the worker whatever the switches say (turning the QR off must not strand
 * waiting registrations or their data) and after a refused confirmation. Bounded per run.
 */
export async function sweepWalkInRegistrations(db: Db, now = new Date(), only: Prisma.WalkInRegistrationWhereInput = {}) {
  const rows = await db.walkInRegistration.findMany({ where: { ...only, status: "PENDING" }, include: { qr: { select: { revokedAt: true, expiresAt: true } } }, orderBy: { createdAt: "asc" }, take: 500 });
  let ended = 0;
  for (const r of rows) {
    const why = await closedBecause(db, r, now);
    if (why) ended += await closePending(db, { id: r.id }, "EXPIRED", why, null, now);
  }
  const scrubbed = (await db.walkInRegistration.updateMany({ where: { ...only, status: { in: ["CANCELLED", "EXPIRED"] }, OR: [{ leadName: { not: null } }, { contactEnc: { not: null } }] }, data: { leadName: null, contactEnc: null } })).count;
  return { ended, scrubbed };
}
