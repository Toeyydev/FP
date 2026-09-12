import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { issueInvite } from "@/lib/provision";
import { maskEmail } from "@/lib/codes";
import { maskTail } from "@/lib/signup-application";
import { decrypt } from "@/lib/crypto";
import { revokeAllForUser } from "@/lib/sessionTokens";
import { randomBytes } from "crypto";
import { sendPushToUser } from "@/lib/push";
import { sendEmail } from "@/lib/email";
import { lineLoginEnabled, lineGetFollowerIds } from "@/lib/line";
import { listUnlinkedContacts, linkContactToGuide, captureLineContact } from "@/lib/line-contacts";
import { siteUrl } from "@/lib/site";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [rows, requests] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, guideId: true, displayName: true, email: true, role: true, state: true, claimedAt: true, lineUserId: true, lineId: true, lineLinkCode: true },
      orderBy: [{ role: "asc" }, { guideId: "asc" }, { email: "asc" }],
    }),
    prisma.accessRequest.findMany({
      where: { state: "PENDING" },
      orderBy: { createdAt: "asc" },
      // Explicit: the row now holds encrypted PII and a password hash, and a
      // bare findMany would ship all of it to the browser.
      select: {
        id: true, name: true, nickname: true, phone: true, email: true,
        believedGuideId: true, createdAt: true,
        fullNameThai: true, fullNameEnglish: true, licenseNo: true, licenseExpiry: true,
        preferredLanguage: true, privacyVersion: true, privacyConsentAt: true,
        nationalId: true, bankName: true, bankAccountName: true, bankAccountNo: true,
        // Health columns are read ONLY to say whether something was declared.
        // Their values never reach the response — see the mapping below.
        medicalConditionStatus: true, emergencyInstructions: true,
        documents: { select: { id: true, kind: true, mimeType: true, size: true }, orderBy: { uploadedAt: "asc" } },
      },
    }),
  ]);
  // Don't leak the raw LINE user id — just whether they're linked.
  const accounts = rows.map(({ lineUserId, ...a }) => ({ ...a, lineLinked: Boolean(lineUserId) }));
  // Decrypt only to mask. The console shows enough to recognise a person and to
  // match a bank transfer; the full number is in the document the operator opens
  // deliberately, which is auditable, rather than in a list payload.
  const requestRows = requests.map((r) => {
    const {
      nationalId, bankName, bankAccountName, bankAccountNo,
      medicalConditionStatus, emergencyInstructions, ...rest
    } = r;
    return {
      ...rest,
      nationalIdMasked: maskTail(decrypt(nationalId), 4),
      bankName: decrypt(bankName),
      bankAccountName: decrypt(bankAccountName),
      bankAccountNoMasked: maskTail(decrypt(bankAccountNo), 4),
      // Booleans only. The board shows that emergency information exists so an
      // operator knows to open the record; what it says is not list material,
      // and a row of medical text on a shared screen is a disclosure by itself.
      hasHealthInfo: Boolean(medicalConditionStatus),
      hasEmergencyInstructions: Boolean(emergencyInstructions),
    };
  });
  // Followers who added the OA but aren't matched to a guide yet (+ a suggestion).
  const lineContacts = await listUnlinkedContacts();
  return NextResponse.json({ accounts, requests: requestRows, isAdmin: session!.user!.role === "ADMIN", lineOaUrl: process.env.NEXT_PUBLIC_LINE_ADD_URL ?? null, lineLoginEnabled, lineContacts });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actorId = session!.user!.id ?? null;
  const actorRole = session!.user!.role ?? null;
  const body = await req.json().catch(() => null);
  const action = body?.action;

  // Issue / re-issue an invite for an existing account (guide or operator).
  if (action === "issueInvite") {
    const userId = z.string().min(1).safeParse(body?.userId);
    if (!userId.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: userId.data } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.state === "ACTIVE") return NextResponse.json({ error: "already-active" }, { status: 400 });
    const { code } = await issueInvite({ userId: user.id, role: user.role, email: user.email, actorId, actorRole });
    await prisma.user.update({ where: { id: user.id }, data: { state: "INVITED" } });
    return NextResponse.json({ ok: true, code });
  }

  // Invite a new operator or accountant (ADMIN only). Accountant = freelance
  // finance role: views the money screens + records PEAK refs, no operations.
  if (action === "inviteOperator") {
    if (actorRole !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });
    const schema = z.object({ email: z.string().email(), displayName: z.string().min(1).max(120), role: z.enum(["OPERATOR", "ACCOUNTANT"]).optional().default("OPERATOR") });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const email = parsed.data.email.toLowerCase().trim();
    const newRole = parsed.data.role;
    if (await prisma.user.findUnique({ where: { email } })) return NextResponse.json({ error: "email-exists" }, { status: 400 });
    const user = await prisma.user.create({
      data: { email, displayName: parsed.data.displayName.trim(), role: newRole, state: "INVITED" },
    });
    const { code } = await issueInvite({ userId: user.id, role: newRole, email, actorId, actorRole });
    return NextResponse.json({ ok: true, code });
  }

  // Change an existing account's role (ADMIN only). Used to make a self-signed-up
  // user an Accountant or Operator. Cannot touch ADMIN accounts or escalate to ADMIN.
  if (action === "setRole") {
    if (actorRole !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });
    const parsed = z.object({ userId: z.string().min(1), role: z.enum(["GUIDE", "OPERATOR", "ACCOUNTANT"]) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, role: true } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 404 });
    if (user.role === "ADMIN") return NextResponse.json({ error: "cannot-change-admin" }, { status: 400 });
    await prisma.user.update({ where: { id: user.id }, data: { role: parsed.data.role } });
    await audit({ actorId, actorRole, action: "account.role_changed", entityType: "User", entityId: user.id, detail: { from: user.role, to: parsed.data.role } });
    return NextResponse.json({ ok: true });
  }

  // Approve a pending sign-up and ACTIVATE it: link or mint a guide account, copy
  // the password the applicant chose, and move their application and documents
  // onto the account. They sign in with the email and password from the form —
  // no invite, no claim step. The guide id is auto-assigned
  // (first-come-first-serve) and never chosen by the applicant; an explicit
  // guideUserId overrides the auto-pick.
  if (action === "approveRequest") {
    const schema = z.object({ requestId: z.string().min(1), guideUserId: z.string().min(1).optional() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: parsed.data.requestId } });
    if (!reqRow || reqRow.state !== "PENDING") return NextResponse.json({ error: "no-request" }, { status: 400 });
    // Self-sign-up sets its own password, web and mobile alike; approval turns
    // that into a live account. Without one there is nothing to activate.
    if (!reqRow.passwordHash) return NextResponse.json({ error: "no-password" }, { status: 400 });
    // The sign-up email becomes the login email; make sure it isn't already taken.
    const clash = await prisma.user.findUnique({ where: { email: reqRow.email } });

    let guide;
    if (parsed.data.guideUserId) {
      // Operator manually linked this sign-up to a specific existing guide record.
      guide = await prisma.user.findUnique({ where: { id: parsed.data.guideUserId } });
      if (!guide || guide.role !== "GUIDE") return NextResponse.json({ error: "no-guide" }, { status: 400 });
      if (guide.state === "ACTIVE") return NextResponse.json({ error: "already-active" }, { status: 400 });
    } else {
      // Auto-match by email: if a guide record already exists for this sign-up's
      // email (e.g. one of the originals), reuse it so the guide keeps their
      // original G-id — they never need to know the number.
      guide = await prisma.user.findFirst({
        where: { role: "GUIDE", email: reqRow.email, state: { not: "ACTIVE" } },
      });
      if (!guide) {
        // No match — mint a brand-new guide id (next in sequence), in sign-up order.
        const last = await prisma.user.findFirst({
          where: { role: "GUIDE", guideId: { not: null } },
          orderBy: { guideId: "desc" },
        });
        const n = last?.guideId ? parseInt(last.guideId.slice(2), 10) + 1 : 1;
        const newGuideId = `G-${String(n).padStart(3, "0")}`;
        guide = await prisma.user.create({
          data: { guideId: newGuideId, role: "GUIDE", state: "INVITED", email: `unassigned-${newGuideId.toLowerCase()}@folkpath.local`, displayName: reqRow.nickname || reqRow.name },
        });
      }
    }
    if (clash && clash.id !== guide.id) return NextResponse.json({ error: "email-in-use" }, { status: 400 });

    const application = reqRow.fullNameEnglish || reqRow.fullNameThai
      ? {
          fullNameThai: reqRow.fullNameThai,
          fullNameEnglish: reqRow.fullNameEnglish,
          nationalId: reqRow.nationalId,      // already encrypted at rest — moved as-is
          licenseNo: reqRow.licenseNo,
          licenseExpiry: reqRow.licenseExpiry,
          bankName: reqRow.bankName,
          bankAccountName: reqRow.bankAccountName,
          bankAccountNo: reqRow.bankAccountNo,
          // Ciphertext in, ciphertext out — approval never decrypts health data.
          medicalConditionStatus: reqRow.medicalConditionStatus,
          medicalConditionDetails: reqRow.medicalConditionDetails,
          emergencyInstructions: reqRow.emergencyInstructions,
          languages: reqRow.preferredLanguage ? [reqRow.preferredLanguage] : undefined,
        }
      : {};

    // One transaction: an approved account whose documents did not move is a
    // guide the operator can no longer verify, and the request row would already
    // say APPROVED so nobody would look again.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: guide.id },
        data: {
          email: reqRow.email,
          displayName: reqRow.nickname || guide.displayName,
          fullName: reqRow.name,
          phone: reqRow.phone ?? guide.phone,
          // The applicant already proved who they are with an ID card, a licence
          // and a bank book, which the operator has just reviewed. Activation is
          // that decision taking effect: their own password becomes live.
          passwordHash: reqRow.passwordHash,
          state: "ACTIVE",
          claimedAt: new Date(),
          ...application,
        },
      });
      const docs = await tx.accessRequestDocument.findMany({ where: { requestId: reqRow.id } });
      for (const d of docs) {
        await tx.guideDocument.create({
          data: {
            userId: guide.id, kind: d.kind, filename: d.filename,
            mimeType: d.mimeType, size: d.size, data: d.data, // stays encrypted; never decrypted here
          },
        });
      }
      await tx.accessRequest.update({
        where: { id: reqRow.id },
        data: { state: "APPROVED", linkedUserId: guide.id, reviewedById: actorId, reviewedAt: new Date() },
      });
    });

    await audit({ actorId, actorRole, action: "request.approved", entityType: "AccessRequest", entityId: reqRow.id, detail: { guideId: guide.guideId, email: maskEmail(reqRow.email) } });
    // Tell the new guide they're approved — in-app (seen on first login), push
    // (if subscribed), and email (the channel that reaches them before login).
    const firstName = (reqRow.name || "").split(" ")[0] || "there";
    // They can sign in immediately, with the password they chose on the form —
    // so the message says exactly that, and nothing about a code.
    await prisma.notification.create({ data: { userId: guide.id, kind: "approved", message: `You're approved! Welcome to Folkpaths, ${firstName}. Sign in with the email and password you chose to set your availability and start getting jobs.` } });
    await sendPushToUser(guide.id, { title: "You're approved 🎉", body: "Sign in with the password you chose at sign-up.", url: "/", tag: "approved" });
    const th = reqRow.preferredLanguage === "th";
    await sendEmail({
      to: reqRow.email,
      subject: th ? "ใบสมัครไกด์ Folkpaths ได้รับอนุมัติแล้ว" : "Your Folkpaths guide account is approved",
      text: th
        ? `สวัสดีคุณ ${reqRow.fullNameThai || firstName}\n\nใบสมัครไกด์ของคุณได้รับอนุมัติแล้ว (รหัสไกด์ ${guide.guideId})\n\nเข้าใช้งานได้ที่ ${siteUrl()} ด้วยอีเมลและรหัสผ่านที่คุณตั้งไว้ตอนสมัคร แล้วเริ่มระบุวันว่างเพื่อรับงานได้เลย\n\nยินดีต้อนรับสู่ Folkpaths`
        : `Hi ${firstName},\n\nGood news — your Folkpaths guide account (${guide.guideId}) has been approved.\n\nSign in at ${siteUrl()} with the email and password you chose when you applied, to set your availability and start receiving job offers.\n\nWelcome aboard!\nFolkpaths`,
    });
    return NextResponse.json({ ok: true, guideId: guide.guideId });
  }

  if (action === "rejectRequest") {
    const schema = z.object({ requestId: z.string().min(1), note: z.string().max(300).optional() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: parsed.data.requestId } });
    if (!reqRow || reqRow.state !== "PENDING") return NextResponse.json({ error: "no-request" }, { status: 400 });
    await prisma.accessRequest.update({
      where: { id: reqRow.id }, data: { state: "REJECTED", reviewedById: actorId, reviewedAt: new Date(), note: parsed.data.note ?? null },
    });
    await audit({ actorId, actorRole, action: "request.rejected", entityType: "AccessRequest", entityId: reqRow.id });
    return NextResponse.json({ ok: true });
  }

  // Suspend / reactivate an account.
  if (action === "setSuspended") {
    const schema = z.object({ userId: z.string().min(1), suspend: z.boolean() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.id === actorId) return NextResponse.json({ error: "cannot-suspend-self" }, { status: 400 });
    const nextState = parsed.data.suspend ? "SUSPENDED" : user.claimedAt ? "ACTIVE" : "INVITED";
    await prisma.user.update({ where: { id: user.id }, data: { state: nextState } });
    if (parsed.data.suspend) await revokeAllForUser(user.id); // kill persistent sessions on suspend
    await audit({ actorId, actorRole, action: parsed.data.suspend ? "account.suspended" : "account.reactivated", entityType: "User", entityId: user.id });
    return NextResponse.json({ ok: true, state: nextState });
  }

  // Generate (or re-generate) a guide's one-time LINE link code so the operator
  // can hand it to the guide to send to the Official Account. Does not message
  // anyone — linking still happens when the guide sends the code from their LINE.
  if (action === "lineCode") {
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user || user.role !== "GUIDE") return NextResponse.json({ error: "no-guide" }, { status: 400 });
    const code = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
    await prisma.user.update({ where: { id: user.id }, data: { lineLinkCode: code } });
    await audit({ actorId, actorRole, action: "line.code.issued", entityType: "User", entityId: user.id });
    return NextResponse.json({ ok: true, code });
  }

  // One-click connect: match a captured OA follower to a guide account. The guide
  // does nothing — linking happens entirely operator-side.
  if (action === "lineLinkContact") {
    const parsed = z.object({ contactId: z.string().min(1), guideUserId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const ok = await linkContactToGuide(parsed.data.contactId, parsed.data.guideUserId, { id: actorId, role: actorRole });
    if (!ok) return NextResponse.json({ error: "link-failed" }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // Optional one-off backfill: pull the OA's existing followers (Verified/Premium
  // accounts only) and capture any not yet linked, so guides who added the OA
  // before capture existed still show up in the match list.
  if (action === "lineBackfill") {
    let start: string | undefined;
    let added = 0, pages = 0;
    for (;;) {
      const res = await lineGetFollowerIds(start);
      if (!res.ok) return NextResponse.json({ ok: false, forbidden: Boolean(res.forbidden), added });
      for (const uid of res.userIds) { await captureLineContact(uid).catch(() => {}); added++; }
      pages++;
      if (!res.next || pages >= 20) break; // cap the sweep (≈6k followers) to stay bounded
      start = res.next;
    }
    await audit({ actorId, actorRole, action: "line.backfill", entityType: "LineContact", detail: { scanned: added } });
    return NextResponse.json({ ok: true, added });
  }

  // Nudge every active guide who hasn't linked LINE yet to connect. We can't reach
  // them ON LINE (that's the id we're missing), so we use the channels we do have:
  // an in-app notification + web push, pointing at the one-tap connect on /profile.
  if (action === "lineRemindUnlinked") {
    const unlinked = await prisma.user.findMany({
      where: { role: "GUIDE", state: "ACTIVE", lineUserId: null },
      select: { id: true, displayName: true, email: true },
    });
    const msg = "Connect your LINE to get job offers & job sheets there — open My details → Connect LINE.";
    let emailed = 0;
    await Promise.all(unlinked.map(async (g) => {
      await prisma.notification.create({ data: { userId: g.id, kind: "line", message: msg } }).catch(() => {});
      await sendPushToUser(g.id, { title: "Connect your LINE", body: "Tap to link LINE and get job offers there.", url: "/profile", tag: "line-connect" }).catch(() => {});
      // Skip placeholder addresses for guides auto-created without a real email.
      if (g.email && !g.email.endsWith("@folkpath.local")) {
        const firstName = g.displayName.split(" ")[0];
        const r = await sendEmail({
          to: g.email,
          subject: "Connect your LINE to Folkpaths",
          text: `Hi ${firstName},\n\nConnect your LINE to Folkpaths to get job offers and job sheets on LINE.\n\nOpen ${siteUrl("/profile")} and tap "Connect LINE" — it takes one tap.\n\nThanks!\nFolkpaths`,
        }).catch(() => ({ sent: false }));
        if (r.sent) emailed++;
      }
    }));
    await audit({ actorId, actorRole, action: "line.remind_unlinked", entityType: "User", detail: { count: unlinked.length, emailed } });
    return NextResponse.json({ ok: true, count: unlinked.length, emailed });
  }

  // Remove a single guide account. Cascades clean up their availability,
  // assignments, invites, documents and notifications. Only GUIDE rows can be
  // removed here (never an operator/admin), and the Guide Database view stays —
  // it just no longer lists this guide.
  if (action === "deleteGuide") {
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.role !== "GUIDE") return NextResponse.json({ error: "not-a-guide" }, { status: 400 });
    await revokeAllForUser(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    await audit({ actorId, actorRole, action: "guide.deleted", entityType: "User", entityId: user.id, detail: { guideId: user.guideId, email: user.email } });
    return NextResponse.json({ ok: true });
  }

  // Remove ALL guide accounts (ADMIN only) — a blank slate. Operators/admin and
  // tours are untouched. Guides self-register again afterwards and are assigned a
  // fresh id in sign-up order (G-001, G-002, ...). The Guide Database view remains.
  if (action === "clearGuides") {
    if (actorRole !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });
    const guides = await prisma.user.findMany({ where: { role: "GUIDE" }, select: { id: true } });
    for (const g of guides) await revokeAllForUser(g.id);
    const res = await prisma.user.deleteMany({ where: { role: "GUIDE" } });
    await audit({ actorId, actorRole, action: "guides.cleared", entityType: "User", detail: { count: res.count } });
    return NextResponse.json({ ok: true, count: res.count });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
