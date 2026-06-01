import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();

const GUIDES: [string, string][] = [
  ["G-001", "Miss Rajatawan Chankhwan"], ["G-002", "Mr. Pakorn Anyu"],
  ["G-003", "Miss Kawita Permpoolchokana"], ["G-004", "Miss Sataporn Wanittawiwat"],
  ["G-005", "Miss Siripanya Poompana"], ["G-006", "Miss Temsiri Temvipassiri"],
  ["G-007", "Mrs. Namthip Luengprasert"], ["G-008", "Mr. Saravoot Pradyawong"],
  ["G-009", "Miss Prapaiporn Honghem"], ["G-010", "Miss Chanipat Thongsom"],
  ["G-011", "Miss Sangaroon Vongleammacha"], ["G-012", "Miss Plangrueta Kampingjai"],
  ["G-013", "Mr. Kunanont Bhandhfalck"], ["G-014", "Miss Onhathai Niyomtham"],
  ["G-015", "Miss Ninlaya Boonchuaychoosakul"], ["G-016", "Miss Penwadee Tirawongsaroj"],
  ["G-017", "Mr. Anan Tangvongcharoenlarp"], ["G-018", "Mr. Phongthep Saengthong"],
  ["G-019", "Mr. Praiwal Wattanasirang"], ["G-020", "Mr. Krishna Kullayasiri"],
  ["G-021", "Ms. Tipakorn Saraphat"], ["G-022", "Mr. Panusorn Pakunpanya"],
  ["G-023", "Mr. Suwat Saengkerdsub"], ["G-024", "Miss Ing-on Saenthaweesuk"],
  ["G-025", "Miss Nareerat Meesukko"],
];

const EMAILS: Record<string, string> = {
  "G-001": "rachatawan.guide@gmail.com", "G-002": "tawhouse@gmail.com",
  "G-003": "kawita.elle@gmail.com", "G-004": "sulee_zhang2006@yahoo.com",
  "G-007": "fonlueng@gmail.com", "G-010": "chanipat.ts@gmail.com",
  "G-011": "kathareena@gmail.com", "G-012": "kratainoi_teerak@hotmail.com",
  "G-013": "tinntinnair@gmail.com", "G-014": "onhathaimail@gmail.com",
  "G-015": "ninlayab@hotmail.com", "G-016": "penwadeegg@gmail.com",
  "G-017": "iammike2424@gmail.com", "G-018": "sendtonui@gmail.com",
  "G-019": "praiwal.wattanasirang@gmail.com", "G-020": "kenguy007@gmail.com",
  "G-021": "tipakorn_s@yahoo.com", "G-023": "suwat.tohoku@gmail.com",
  "G-024": "ingdao.p@gmail.com", "G-025": "livernun@hotmail.com",
};

const TOURS: [string, string, string][] = [
  ["T-001", "Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun", "08.30 AM"],
  ["T-002", "Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun", "13.30 PM"],
  ["T-003", "Wat Pho & Wat Arun Guided Tour", "10.00 AM"],
  ["T-004", "Wat Pho & Wat Arun Guided Tour", "15.00 PM"],
  ["T-005", "Wat Phra Kaew & Grand Palace", "14.00 PM"],
  ["T-006", "Wat Pho Evening Visit with Temple Cats", "17.30 PM"],
  ["T-007", "Eat Like a Local — China Town", "16.30 PM"],
  ["T-008", "Eat Like a Local — China Town", "17.30 PM"],
  ["T-009", "Eat Like a Local — China Town", "18.30 PM"],
];

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randStr(len: number) {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
const emailFor = (gid: string) => (EMAILS[gid] ?? `${gid.toLowerCase()}@guides.folkpath.local`).toLowerCase();

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@folkpath.local").toLowerCase();
  const adminPw = process.env.ADMIN_PASSWORD || "folkpath";

  for (const [id, name, time] of TOURS) {
    await prisma.tour.upsert({ where: { id }, create: { id, name, time }, update: { name, time } });
  }

  // Bootstrap admin (active)
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, displayName: "Folkpath Admin", role: "ADMIN", state: "ACTIVE", passwordHash: bcrypt.hashSync(adminPw, 10) },
    update: { role: "ADMIN", state: "ACTIVE", passwordHash: bcrypt.hashSync(adminPw, 10) },
  });

  // Guide records (INVITED placeholders). Idempotent: an existing account is left
  // completely untouched, so re-running on every deploy never resets a guide who has
  // already signed up / been activated.
  const issued: { guideId: string; email: string; code: string }[] = [];
  for (const [guideId, displayName] of GUIDES) {
    if (await prisma.user.findUnique({ where: { guideId } })) continue;
    const email = emailFor(guideId);
    const user = await prisma.user.create({
      data: { email, displayName, guideId, role: "GUIDE", state: "INVITED" },
    });
    const selector = randStr(6), secret = randStr(10);
    await prisma.invite.create({
      data: {
        selector, secretHash: bcrypt.hashSync(secret, 10), userId: user.id, role: "GUIDE",
        channel: "email", sentTo: email, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    issued.push({ guideId, email, code: `${selector}-${secret}` });
  }

  console.log(`\nEnsured admin + ${TOURS.length} tours. New guide records created: ${issued.length}.`);
  console.log(`\nADMIN login:  ${adminEmail}  (password = ADMIN_PASSWORD env)\n`);
  console.log("Guide invite codes (claim at /start -> \"I have an invite code\"):");
  console.log("─".repeat(60));
  for (const x of issued) console.log(`  ${x.guideId}  ${x.code}   ${x.email}`);
  console.log("─".repeat(60));
  console.log('In stub mode the OTP after entering a code is shown in the claim UI + server log.\n');
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
