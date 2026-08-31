import { sendEmail } from "@/lib/email";
import { buildConfirmation, type ConfirmationInput } from "@/lib/booking-confirmation";

// Sends the guest confirmation. Called AFTER the booking transaction has
// committed, and swallows everything: a mail server having a bad afternoon must
// never turn a confirmed seat into an error page. The booking is the record of
// truth; the email is a courtesy on top of it.
//
// Returns whether it went out, so the caller can tell the guest "check your
// email" only when that is actually true.
export async function sendBookingConfirmation(i: ConfirmationInput, to: string | null | undefined): Promise<boolean> {
  if (!to) return false;
  try {
    const c = buildConfirmation(i);
    const r = await sendEmail({
      to,
      subject: c.subject,
      text: c.text,
      html: c.html,
      // A calendar entry is the difference between a code in an inbox and a
      // reminder that surfaces itself the morning of the tour.
      ...(c.ics ? { icalEvent: { method: "PUBLISH", content: c.ics } } : {}),
    });
    return r.sent;
  } catch (e) {
    console.error("[confirmation:error]", (e as Error).message);
    return false;
  }
}
