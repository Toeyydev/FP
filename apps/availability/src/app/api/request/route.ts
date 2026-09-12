import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { sendPushToUser } from "@/lib/push";
import { encOpt, encrypt, encryptBuffer } from "@/lib/crypto";
import { maskEmail } from "@/lib/codes";
import { rateLimit, callerKey } from "@/lib/rate-limit";
import {
  APPLICATION_DOC_KINDS, MAX_TOTAL_BYTES, checkDocument, validateApplication,
  type ApplicationDocKind,
} from "@/lib/signup-application";

// Public sign-up -> creates a PENDING account (hashed password). No login until an
// operator approves and links it to a guide record.
const schema = z.object({
  fullName: z.string().trim().min(1).max(120),
  nickname: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(1).max(40),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  // FolkOPS Mobile posts multipart/form-data (application + three documents).
  // The original web sign-up posts JSON and is handled unchanged below, so one
  // endpoint serves both and neither client needs to know about the other.
  if ((req.headers.get("content-type") || "").toLowerCase().includes("multipart/form-data")) {
    return postApplication(req);
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { fullName, nickname, phone, email, password } = parsed.data;
  const lower = email.toLowerCase().trim();

  // Don't let an already-active account be shadowed by a new request.
  const existing = await prisma.user.findUnique({ where: { email: lower } });
  if (existing && existing.state === "ACTIVE") {
    return NextResponse.json({ error: "account-exists" }, { status: 409 });
  }

  const r = await prisma.accessRequest.create({
    data: {
      name: fullName.trim(),
      nickname: nickname.trim(),
      phone: phone.trim(),
      email: lower,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await audit({ action: "request.created", entityType: "AccessRequest", entityId: r.id, detail: { email: lower } });

  // Reliable notice to every operator/admin: in-app bell + home-screen push.
  // (Email below is a best-effort extra channel and may be unconfigured.)
  const operators = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
  const opMsg = `🆕 New guide sign-up: ${fullName.trim()} (${nickname.trim()}) <${lower}> — approve in Accounts → Pending requests.`;
  for (const op of operators) {
    await prisma.notification.create({ data: { userId: op.id, kind: "signup", message: opMsg } });
    await sendPushToUser(op.id, { title: "New guide sign-up", body: `${fullName.trim()} (${nickname.trim()}) awaiting approval`, url: "/", tag: "signup" });
  }

  // Acknowledge the applicant (never blocks the request — sendEmail can't throw).
  await sendEmail({
    to: lower,
    subject: "Folkpaths — sign-up received",
    text: `Hi ${fullName.trim()},\n\nWe've received your request to join Folkpaths. An operator will review and activate your account, and you'll be able to log in once approved.`,
  });
  // Alert operators (in-app badge already polls the count; this is the email channel).
  const opsAlert = process.env.OPS_ALERT_EMAIL;
  if (opsAlert) {
    await sendEmail({
      to: opsAlert,
      subject: "Folkpaths — new guide sign-up pending",
      text: `New sign-up awaiting approval:\n${fullName.trim()} (${nickname.trim()}) <${lower}>\n\nReview it in the operator console → Accounts → Pending requests.`,
    });
  } else {
    console.log(`[alert:new-signup] ${fullName.trim()} (${nickname.trim()}) <${lower}> awaiting approval`);
  }
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// FolkOPS Mobile: guide application with supporting documents.
//
// Everything sensitive is encrypted before it touches the database, and nothing
// sensitive is ever logged or audited — the audit trail carries the request id
// and a masked email, which is enough to find the row without reproducing the
// applicant's ID card in a log aggregator.
// ---------------------------------------------------------------------------

// A generous window: a real applicant submits once, maybe twice after fixing a
// field. Anything past this from one address is not a person filling in a form.
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60_000;

async function postApplication(req: NextRequest) {
  const rl = rateLimit(callerKey(req.headers, "signup"), SIGNUP_LIMIT, SIGNUP_WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "bad-body" }, { status: 400 });
  }

  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };

  const check = validateApplication({
    fullNameThai: text("fullNameThai"),
    fullNameEnglish: text("fullNameEnglish"),
    nationalId: text("nationalId"),
    phone: text("phone"),
    email: text("email"),
    licenseNo: text("licenseNo"),
    licenseExpiry: text("licenseExpiry"),
    bankName: text("bankName"),
    bankAccountName: text("bankAccountName"),
    bankAccountNo: text("bankAccountNo"),
    password: text("password"),
    medicalConditionStatus: text("medicalConditionStatus"),
    medicalConditionDetails: text("medicalConditionDetails"),
    emergencyInstructions: text("emergencyInstructions"),
    preferredLanguage: text("preferredLanguage"),
    privacyVersion: text("privacyVersion"),
    privacyConsentAt: text("privacyConsentAt"),
  });
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: "validation", fields: check.errors }, { status: 400 });
  }
  const app = check.value;

  // An account already in use must not be shadowed by a new application, and a
  // second application while one is still pending would give operators two rows
  // for one person to approve.
  const [existingUser, pending] = await Promise.all([
    prisma.user.findUnique({ where: { email: app.email }, select: { state: true } }),
    prisma.accessRequest.findFirst({ where: { email: app.email, state: "PENDING" }, select: { id: true } }),
  ]);
  if (existingUser?.state === "ACTIVE") {
    return NextResponse.json({ ok: false, error: "account-exists" }, { status: 409 });
  }
  if (pending) {
    return NextResponse.json({ ok: false, error: "request-pending" }, { status: 409 });
  }

  // Read the three documents. All are required: an operator cannot verify a
  // guide without the ID card, the licence and the bank book together.
  const docs: { kind: ApplicationDocKind; filename: string; mimeType: string; size: number; data: Buffer }[] = [];
  let total = 0;
  for (const kind of APPLICATION_DOC_KINDS) {
    const f = form.get(kind);
    if (!f || typeof f === "string") {
      return NextResponse.json({ ok: false, error: "missing-document", kind }, { status: 400 });
    }
    const file = f as File;
    const mimeType = (file.type || "").toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());
    const verdict = checkDocument(mimeType, buf.length);
    if (!verdict.ok) {
      return NextResponse.json({ ok: false, error: verdict.reason, kind },
        { status: verdict.reason === "too-large" ? 413 : 400 });
    }
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json({ ok: false, error: "too-large", kind }, { status: 413 });
    }
    docs.push({ kind, filename: file.name || `${kind.toLowerCase()}`, mimeType, size: buf.length, data: buf });
  }

  // One transaction: an application without its documents is not reviewable, and
  // documents without their application are orphaned bytes nobody can interpret.
  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.accessRequest.create({
      data: {
        // `name` is the legacy column the operator console already reads.
        name: app.fullNameEnglish,
        nickname: app.fullNameEnglish.split(" ")[0] || app.fullNameEnglish,
        phone: app.phone,
        email: app.email,
        fullNameThai: app.fullNameThai,
        fullNameEnglish: app.fullNameEnglish,
        nationalId: encrypt(app.nationalId),
        licenseNo: app.licenseNo,
        licenseExpiry: app.licenseExpiry,
        bankName: encrypt(app.bankName),
        bankAccountName: encrypt(app.bankAccountName),
        bankAccountNo: encrypt(app.bankAccountNo),
        preferredLanguage: app.preferredLanguage,
        privacyVersion: app.privacyVersion,
        privacyConsentAt: app.privacyConsentAt,
        // Health data is encrypted here, at the only point it exists in plain
        // text on the server. Even the status is encrypted: "HAS_CONDITION"
        // sitting in a readable column is itself a disclosure about the person.
        medicalConditionStatus: encrypt(app.medicalConditionStatus),
        medicalConditionDetails: encOpt(app.medicalConditionDetails),
        emergencyInstructions: encOpt(app.emergencyInstructions),
        // The applicant chooses their password here and logs in with it once an
        // operator approves — the same self-sign-up shape the web form uses.
        // Hashed before it is stored; the plain text never leaves this function.
        passwordHash: bcrypt.hashSync(app.password, 10),
      },
      select: { id: true },
    });
    for (const d of docs) {
      await tx.accessRequestDocument.create({
        data: {
          requestId: r.id, kind: d.kind, filename: d.filename.slice(0, 200),
          mimeType: d.mimeType, size: d.size, data: new Uint8Array(encryptBuffer(d.data)),
        },
      });
    }
    return r;
  });

  // Audit carries only what is safe to keep: the row id and a masked address.
  await audit({
    action: "request.created", entityType: "AccessRequest", entityId: created.id,
    detail: { email: maskEmail(app.email), source: "mobile", documents: docs.length },
  });

  // Same operator alerting as the web sign-up: in-app bell + push.
  const operators = await prisma.user.findMany({
    where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true },
  });
  const opMsg = `🆕 New guide application: ${app.fullNameEnglish} — review in Accounts → Pending requests.`;
  for (const op of operators) {
    await prisma.notification.create({ data: { userId: op.id, kind: "signup", message: opMsg } });
    await sendPushToUser(op.id, { title: "New guide application", body: `${app.fullNameEnglish} awaiting approval`, url: "/", tag: "signup" });
  }

  const th = app.preferredLanguage === "th";
  await sendEmail({
    to: app.email,
    subject: th ? "Folkpaths — ได้รับใบสมัครแล้ว" : "Folkpaths — application received",
    text: th
      ? `สวัสดีคุณ ${app.fullNameThai}\n\nเราได้รับใบสมัครไกด์ของคุณแล้ว ทีมงานจะตรวจสอบเอกสารและแจ้งผลทางอีเมลนี้\nเมื่อได้รับอนุมัติ คุณเข้าใช้งานได้ทันทีด้วยอีเมลและรหัสผ่านที่ตั้งไว้ตอนสมัคร`
      : `Hi ${app.fullNameEnglish},\n\nWe've received your guide application. Our team will review your documents and reply to this address.\nOnce you're approved you can sign in straight away with the email and password you chose.`,
  });

  return NextResponse.json({ ok: true, requestId: created.id });
}
