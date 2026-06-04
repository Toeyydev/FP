import nodemailer, { type Transporter } from "nodemailer";

// Provider-neutral SMTP. Works with Resend / SendGrid / Mailgun / Postmark / Gmail —
// anything that gives you SMTP credentials. If not configured, falls back to logging
// (so dev + stub mode keep working). Set these env vars on Railway to send for real:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, EMAIL_FROM
const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.EMAIL_FROM || "Folkpath <no-reply@folkpath.local>";
const secure = process.env.SMTP_SECURE === "true" || port === 465;

export const emailEnabled = Boolean(host && user && pass);

let transporter: Transporter | null = null;
function getTransport(): Transporter | null {
  if (!emailEnabled) return null;
  if (!transporter) transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  return transporter;
}

type Attachment = { filename: string; content: string; contentType?: string };

// Never throws — a failed/disabled email must not break the request that triggered it.
export async function sendEmail(opts: { to: string; subject: string; text: string; html?: string; attachments?: Attachment[]; icalEvent?: { method: string; content: string } }): Promise<{ sent: boolean }> {
  if (!emailEnabled) {
    console.log(`[email:stub] to=${opts.to} subject="${opts.subject}"${opts.icalEvent ? " (+calendar invite)" : ""}\n${opts.text}`);
    return { sent: false };
  }
  try {
    await getTransport()!.sendMail({
      from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html,
      attachments: opts.attachments,
      icalEvent: opts.icalEvent ? { method: opts.icalEvent.method, content: opts.icalEvent.content } : undefined,
    });
    return { sent: true };
  } catch (e) {
    console.error("[email:error]", (e as Error).message);
    return { sent: false };
  }
}
