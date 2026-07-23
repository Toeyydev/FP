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

  // Bootstrap the TourMaster catalogue so the read-path is live end-to-end. Each
  // internal tour gets a master row keyed by its own id as `tourCode`, with the
  // current name as a PLACEHOLDER title — so nothing on screen changes until the
  // real OTA product title is filled in (by editing tour_master.tour_name, or the
  // n8n Bokun→Master flow). Idempotent and non-destructive: `update: {}` keeps any
  // title already there, and the link is only set on tours not yet linked — so
  // operator edits and Flow A titles survive every redeploy.
  // Seed real OTA product titles for the tours we know them for (from Folkpaths'
  // own GetYourGuide bookings). Everything else falls back to the internal name.
  // Edit / extend this map (or the tour_master rows directly) to switch a tour's
  // shown title; `update: {}` below means a title already in the DB is never
  // overwritten, so operator edits and the n8n Bokun→Master flow win over this seed.
  const REAL_TITLES: Record<string, string> = {
    "T-001": "Bangkok: Grand Palace, Wat Pho & Wat Arun Guided Experience",
    "T-002": "Bangkok: Grand Palace, Wat Pho & Wat Arun Guided Experience",
  };
  for (const [id, name, time] of TOURS) {
    const hhmm = time.trim().split(/\s+/)[0].replace(".", ":"); // "08.30 AM" → "08:30"
    await prisma.tourMaster.upsert({
      where: { tourCode: id },
      create: { tourCode: id, tourName: REAL_TITLES[id] ?? name, tourTime: new Date(`1970-01-01T${hhmm}:00Z`) },
      update: {},
    });
    await prisma.tour.updateMany({ where: { id, tourCode: null }, data: { tourCode: id } });
  }

  // Bootstrap admin (active)
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, displayName: "Folkpath Admin", role: "ADMIN", state: "ACTIVE", passwordHash: bcrypt.hashSync(adminPw, 10) },
    update: { role: "ADMIN", state: "ACTIVE", passwordHash: bcrypt.hashSync(adminPw, 10) },
  });

  // No guide records are pre-seeded. Each guide self-registers (free-flow sign-up
  // → operator approval mints a new G-xxx) and fills in their own details. This
  // seed never deletes or alters guides that already exist in the database.
  console.log(`\nEnsured admin + ${TOURS.length} tours. No guides pre-seeded — guides self sign-up.`);
  console.log(`ADMIN login:  ${adminEmail}  (password = ADMIN_PASSWORD env)\n`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
