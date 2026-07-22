/**
 * Ask LINE whether the payment bubble is valid — and optionally send yourself one.
 *
 * The bubble is built by the same code the e-slip upload uses, and wrapped in the
 * same envelope linePushFlex sends, so a pass here means the real notice is
 * accepted. Worth running because a malformed bubble fails at send time, inside a
 * best-effort catch: the guide silently gets nothing.
 *
 *   railway run npx tsx scripts/check-payment-flex.ts              # validate only, sends nothing
 *   railway run npx tsx scripts/check-payment-flex.ts --send-to-me # also deliver one to yourself
 *
 * --send-to-me looks up YOUR user row (by OWNER_EMAIL below) and pushes to that
 * lineUserId. It never touches a guide's account.
 */
import { flexMessage } from "@/lib/line";
import { paymentBubble } from "@/lib/jobsheet-send";
import { prisma } from "@/lib/db";

const OWNER_EMAIL = "folkpaths@gmail.com";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// The mockup's figures. Values don't change the shape LINE validates, but the long
// tour name and the 3-row table make it a realistic bubble.
const JOBS = [
  { dateLabel: "7 Jul", time: "13:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 1280, fee: 970, total: 2250 },
  { dateLabel: "8 Jul", time: "08:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 665, fee: 970, total: 1635 },
  { dateLabel: "14 Jul", time: "08:30", tour: "Grand Palace, Wat Pho & Wat Arun", expenses: 881, fee: 970, total: 1851 },
];
const HEADING = "💸 July 2026 payment transferred";
const SLIP = "https://drive.google.com/file/d/EXAMPLE/view";

async function main() {
  if (!TOKEN) {
    console.error("✗ No LINE_CHANNEL_ACCESS_TOKEN in the environment.");
    console.error("  Run it through Railway so it picks up the real key:");
    console.error("  railway run npx tsx scripts/check-payment-flex.ts");
    process.exit(1);
  }

  const bubble = paymentBubble(HEADING, JOBS, 5736, SLIP);
  const message = flexMessage(`${HEADING} — ฿5,736 · 3 tours`, bubble);
  console.log(`Bubble built: ${JSON.stringify(message).length} bytes (LINE's cap is 30,000).\n`);

  // Validate — LINE checks the payload and delivers nothing.
  const v = await fetch("https://api.line.me/v2/bot/message/validate/push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messages: [message] }),
  });
  if (v.ok) {
    console.log("✓ LINE accepts the bubble.");
  } else {
    console.error(`✗ LINE rejected it (HTTP ${v.status}):`);
    console.error(await v.text().catch(() => ""));
    // 400 means the bubble itself is wrong; anything else is env/auth, not layout.
    console.error(v.status === 400
      ? "\nThe detail above names the offending property path inside the bubble."
      : "\nThat's not a layout problem — check the access token / environment.");
    process.exit(1);
  }

  if (!process.argv.includes("--send-to-me")) {
    console.log("\nNothing was sent. Add --send-to-me to deliver one to your own LINE.");
    return;
  }

  const me = await prisma.user.findFirst({ where: { email: OWNER_EMAIL }, select: { lineUserId: true, displayName: true } });
  if (!me?.lineUserId) {
    console.error(`\n✗ No lineUserId on the user for ${OWNER_EMAIL} — link your LINE first, or pass an id another way.`);
    process.exit(1);
  }
  const p = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ to: me.lineUserId, messages: [message] }),
  });
  if (p.ok) console.log(`\n✓ Sent to ${me.displayName ?? OWNER_EMAIL}. Check LINE — try dark and light mode.`);
  else { console.error(`\n✗ Push failed (HTTP ${p.status}):`, await p.text().catch(() => "")); process.exit(1); }
}

main().finally(() => prisma.$disconnect());
