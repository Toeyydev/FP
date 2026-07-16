import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const TOURS: [string, string, string][] = [
  ["T-001", "Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun", "08.30 AM"],
  ["T-002", "Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun", "13.30 PM"],
  ["T-003", "Wat Pho & Wat Arun Guided Tour", "10.00 AM"],
  ["T-004", "Wat Pho & Wat Arun Guided Tour", "15.00 PM"],
  ["T-005", "Wat Phrakaew & The Grand Palace Guided Tour", "14.00 PM"],
  ["T-006", "Wat Pho Evening Visit with Temple Cats", "17.30 PM"],
  ["T-007", "Eat Like a Local — China Town", "16.30 PM"],
  ["T-008", "Eat Like a Local — China Town", "17.30 PM"],
  ["T-009", "Eat Like a Local — China Town", "18.30 PM"],
];

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@folkpath.local").toLowerCase();
  const adminPw = process.env.ADMIN_PASSWORD || "folkpath";

  for (const [id, name, time] of TOURS) {
    await prisma.tour.upsert({ where: { id }, create: { id, name, time }, update: { name, time } });
  }

  // Bootstrap admin (active). The seed runs on every deploy (preDeployCommand), so the
  // update MUST NOT reset the password — otherwise a deploy silently reverts an admin
  // password changed in the app back to ADMIN_PASSWORD. Set the hash only on first
  // create; on an existing admin just keep the account ADMIN + ACTIVE.
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, displayName: "Folkpath Admin", role: "ADMIN", state: "ACTIVE", passwordHash: bcrypt.hashSync(adminPw, 10) },
    update: { role: "ADMIN", state: "ACTIVE" },
  });

  // No guide records are pre-seeded. Each guide self-registers (free-flow sign-up
  // → operator approval mints a new G-xxx) and fills in their own details. This
  // seed never deletes or alters guides that already exist in the database.
  console.log(`\nEnsured admin + ${TOURS.length} tours. No guides pre-seeded — guides self sign-up.`);
  console.log(`ADMIN login:  ${adminEmail}  (password = ADMIN_PASSWORD env)\n`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
