// Settings › Upsell products (PR2) in a real browser against a real server and database.
//
//  • The products come from the real deploy seed (prisma/seed.ts), run here as it runs on
//    every deploy, twice — the second run must change nothing.
//  • The three product pages at 1280 and 390 px: nothing reaches past the screen edge, every
//    control has a name, nothing interactive is smaller than 44 px, ids are unique.
//  • Three Temples on-site shows the owner's rules; Save edits an unsold version, and after a
//    sale Save makes v2 instead. Activate is not "live" while the switch is off, nor while no
//    version is on sale today (a gap between versions).
//  • ACCOUNTANT reads with no controls; OPERATOR is turned away; the API says the same.
//  • The server makes no request to PEAK, a payment gateway or anything else off this machine.
//
// Run after `next build`:  node scripts/e2e/upsell-products.mjs
// Needs DATABASE_URL (a THROWAWAY database — it truncates), the managed browser and AUTH_SECRET.
// Every name, figure and reference here is invented — this repository is public.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const url = process.env.DATABASE_URL ?? "";
if (!url || (/railway|amazonaws|supabase|\.com\b/i.test(url) && !/test/i.test(url))) {
  console.error("refusing to run: DATABASE_URL must be a throwaway test database (this truncates tables)");
  process.exit(2);
}
const PORT = Number(process.env.E2E_PORT ?? 3991);
const BASE = `http://localhost:${PORT}`;
const SHOTS = (process.env.E2E_SCREEN_DIR ?? "").trim();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OUTBOUND = join(appDir, ".e2e-outbound.log");
writeFileSync(OUTBOUND, "");
const PASSWORD = "e2e-password-not-real-1";
const AUTH_SECRET = process.env.AUTH_SECRET || "e2e-only-not-a-real-secret-0123456789";
const ADMIN = "admin-ups@example.test", ACCT = "acct-ups@example.test", OPS = "ops-ups@example.test";
const BKK_TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const prisma = new PrismaClient();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

function browserPath() {
  const root = join(appDir, ".browser-cache", "chrome-headless-shell");
  for (const build of readdirSync(root)) for (const dir of readdirSync(join(root, build))) {
    const exe = join(root, build, dir, "chrome-headless-shell");
    if (existsSync(exe)) return exe;
  }
  throw new Error("managed browser not installed — npm run browser:install");
}

// ── data ─────────────────────────────────────────────────────────────────────
const runSeed = () => spawnSync(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
  cwd: appDir, encoding: "utf8", env: { ...process.env, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PASSWORD },
});
async function seed() {
  const tables = ["AuditLog", "Notification", "CashCustodyEntry", "CashSettlementReturn", "CashSettlement", "UpsellPayment", "UpsellSale",
    "UpsellProductVersion", "UpsellProduct", "TaxProfile", "UpsellDocCounter", "PeakAccountMapping", "JobSheet", "Booking", "Assignment", "RefreshToken", "User", "Tour"];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const first = runSeed();
  check("the deploy seed runs", first.status === 0, first.status === 0 ? "" : (first.stderr || first.stdout).slice(-600));
  const snapshot = async () => JSON.stringify(await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } }));
  const before = await snapshot();
  const second = runSeed();
  check("run again, the seed changes nothing", second.status === 0 && (await snapshot()) === before && (await prisma.upsellProduct.count()) === 3 && (await prisma.taxProfile.count()) === 1);
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await prisma.user.create({ data: { email: ACCT, displayName: "Accountant Example", role: "ACCOUNTANT", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: OPS, displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE", passwordHash: hash } });
  await prisma.user.create({ data: { email: "g971@example.test", displayName: "Fon Example", guideId: "G-971", role: "GUIDE", state: "ACTIVE", passwordHash: hash } });
}
// A sale under a version, written straight to the database: PR2 has no way to sell.
async function sellUnder(productCode) {
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode } }, orderBy: { version: "desc" } });
  const job = await prisma.jobSheet.create({ data: { guideId: "G-971", date: "2099-06-01", slotIdx: 0, tourId: "T-008" } });
  return prisma.upsellSale.create({ data: {
    saleNo: "FOLK-UPS-209906-001", productVersionId: v.id, ruleSnapshot: { test: true }, sourceJobSheetId: job.id, sellingGuideId: "G-971",
    guests: 1, unitPriceSatang: v.unitPriceSatang, grossSatang: v.unitPriceSatang, status: "PENDING_PAYMENT", requestKey: "e2e-ups-1",
  } });
}

async function startServer() {
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, ["--require", join(appDir, "scripts/e2e/outbound-guard.cjs"), nextBin, "start", "-p", String(PORT)], {
    cwd: appDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUTBOUND_LOG: OUTBOUND, AUTH_TRUST_HOST: "true", NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET,
      // The master switch (the page exists) and, in this throwaway server only, the route
      // extension's — so "live" and "no version on sale today" can be seen. Production keeps
      // every switch off; nothing here can sell (PR2 has no sale path).
      UPSELL_ENABLED: "1", UPSELL_ROUTE_EXTENSION_ENABLED: "1", UPSELL_FOOD_TOUR_ENABLED: "", UPSELL_ONSITE_TOUR_ENABLED: "",
      UPSELL_PAYMENT_LINK_ENABLED: "", UPSELL_PEAK_AUTO_SYNC: "", PEAK_ADVANCE_AUTO_SYNC: "" },
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

async function sessionCookie(email) {
  const c = await fetch(`${BASE}/api/auth/csrf`);
  const jar = (c.headers.getSetCookie?.() ?? []).map((s) => s.split(";")[0]);
  const { csrfToken } = await c.json();
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: "true" }) });
  const session = [...jar, ...(r.headers.getSetCookie?.() ?? []).map((s) => s.split(";")[0])].find((s) => /session-token=/.test(s));
  if (!session) throw new Error(`could not sign in as ${email} (${r.status})`);
  const at = session.indexOf("=");
  return { name: session.slice(0, at), value: session.slice(at + 1), domain: "localhost", path: "/" };
}

// ── page checks ──────────────────────────────────────────────────────────────
const fits = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  let worst = 0; const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (!r.width || !r.height || r.right <= vw + 1 || s.visibility === "hidden" || s.display === "none" || s.position === "fixed" || inScroller(el)) continue;
    worst = Math.max(worst, Math.round(r.right - vw)); out.push(`${el.tagName.toLowerCase()}→${Math.round(r.right)}`);
  }
  return { over: worst, culprits: out.slice(0, 8) };
});
// What an assistive technology needs from this form, checked on the live page.
const a11y = (page) => page.evaluate(() => {
  const problems = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const nameOf = (el) => {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    const by = el.getAttribute("aria-labelledby"); if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
    return (el.textContent ?? "").trim();
  };
  for (const el of document.querySelectorAll("main input, main select, main textarea, .op-main input, .op-main select, .op-main textarea")) {
    if (el.type === "hidden") continue;
    if (!nameOf(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}#${el.id || "?"}`);
    if ((el.type === "radio" || el.type === "checkbox") && !el.closest("fieldset")?.querySelector("legend")?.textContent?.trim()) problems.push(`${el.type} ${el.value} has no group legend`);
  }
  for (const el of document.querySelectorAll(".op-main button, .op-main a[href], .op-main summary")) {
    if (!visible(el)) continue;
    if (!nameOf(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}`);
    const h = el.getBoundingClientRect().height;
    if (h < 44 && !el.closest("ul[aria-label]") && el.tagName !== "A") problems.push(`${el.tagName.toLowerCase()} "${nameOf(el).slice(0, 20)}" is ${Math.round(h)}px tall`);
  }
  for (const el of document.querySelectorAll(".op-main input:not([type=radio]):not([type=checkbox]), .op-main select, .op-main label:has(input[type=radio]), .op-main label:has(input[type=checkbox])")) {
    if (visible(el) && el.getBoundingClientRect().height < 44) problems.push(`target ${el.tagName.toLowerCase()} ${el.id || nameOf(el).slice(0, 20)} is ${Math.round(el.getBoundingClientRect().height)}px`);
  }
  const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) problems.push(`duplicate ids ${[...new Set(dup)].join(",")}`);
  for (const el of document.querySelectorAll("[aria-describedby]")) for (const id of el.getAttribute("aria-describedby").split(/\s+/)) if (!document.getElementById(id)) problems.push(`aria-describedby → missing #${id}`);
  const hs = [...document.querySelectorAll(".op-main h1, .op-main h2, .op-main h3")].map((h) => Number(h.tagName[1]));
  if (hs[0] !== 1 || hs.filter((n) => n === 1).length !== 1) problems.push(`headings ${hs.join(",")}: one h1, first`);
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) problems.push(`heading jumps h${hs[i - 1]}→h${hs[i]}`);
  return problems;
});
const text = (page) => page.evaluate(() => document.querySelector(".op-main")?.innerText ?? "");
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `upsell-${name}.png`), fullPage: true }); };
const goto = async (page, path) => { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 30000 }); await new Promise((r) => setTimeout(r, 300)); };
const api = (page, path, init) => page.evaluate(async (p, i) => { const r = await fetch(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, path, init);

// ── the test ─────────────────────────────────────────────────────────────────
await seed();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const pageErrors = [];
try {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("/api/health reports six upsell switches, as this test server set them", JSON.stringify(health.upsell) === JSON.stringify({ enabled: true, routeExtension: true, foodTour: false, onsiteTour: false, paymentLink: false, peakAutoSync: false }), JSON.stringify(health.upsell));

  // ── ADMIN ──
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setCookie(await sessionCookie(ADMIN));
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h });
    await goto(page, "/admin/upsell-products");
    const t = await text(page);
    check(`${w}px list shows the three products, inactive`, /Food Tour[\s\S]*฿1,000 \/ guest/.test(t) && /Wat Pho \+ Wat Arun[\s\S]*฿200 \/ guest/.test(t) && /Three Temples \(on-site\)[\s\S]*THREE-TEMPLES-ONSITE · Join the guide's tour[\s\S]*฿700 \/ guest[\s\S]*Inactive/.test(t), t.slice(0, 300));
    const f = await fits(page); check(`${w}px list fits`, f.over <= 1, f.culprits.join(" "));
    const a = await a11y(page); check(`${w}px list accessibility`, a.length === 0, a.join("; "));
    await shot(page, `list-${w}`);
    for (const code of ["RTE-WPWA", "FOOD-BKK", "THREE-TEMPLES-ONSITE"]) {
      await goto(page, `/admin/upsell-products/${code}`);
      const ff = await fits(page); check(`${w}px ${code} fits`, ff.over <= 1, ff.culprits.join(" "));
      const aa = await a11y(page); check(`${w}px ${code} accessibility`, aa.length === 0, aa.join("; "));
      await shot(page, `${code}-${w}`);
    }
  }
  const navHas = await page.evaluate(() => [...document.querySelectorAll(".op-nav a")].some((a) => a.getAttribute("href") === "/admin/upsell-products"));
  await page.setViewport({ width: 1280, height: 900 });
  await goto(page, "/admin/upsell-products/THREE-TEMPLES-ONSITE");
  check("the menu has Settings › Upsell products for an admin", navHas || await page.evaluate(() => [...document.querySelectorAll(".op-nav a")].some((a) => a.getAttribute("href") === "/admin/upsell-products")));

  const t3 = await text(page);
  const want = ["Cash to the guide only", "Booking on existing job · no new job", "T-001 · 08:30", "T-002 · 13:30", "Selling Guide = Service Guide", "OTA mix", "Allowed for this product",
    "Max 12 guests on the job, OTA + on-site", "None — no fixed cost, no incentive", "All of it — ฿700 per guest", "Bank transfer only", "UPSELL_ONSITE_TOUR_REVENUE · awaiting accountant",
    "New category, not mapped yet: PEAK export stays blocked.", "UPSELL-STD · Draft", "FOLK-UPS-YYYYMM-NNN", "FOLK-CSH-YYYYMM-NNN"];
  const missing = want.filter((s) => !t3.includes(s));
  check("Three Temples on-site shows every owner rule", missing.length === 0, missing.join(" | "));
  check("no guest-limit setting anywhere on it", !/max\s*guests|maxGuests|guest limit/i.test(t3.replace("Max 12 guests on the job", "")));
  check("on-site has no payment-method, fixed-cost or incentive control", await page.evaluate(() => !document.querySelector('input[name="methods"], #fc, #inc')));

  // Save edits the unsold v1 in place.
  await page.click("#price", { clickCount: 3 }); await page.type("#price", "750");
  await page.click('input[name="tours"][value="T-002"]');
  await page.click("button.up-save");
  await page.waitForFunction(() => /Saved v1\./.test(document.querySelector('[role="status"]')?.textContent ?? ""), { timeout: 10000 });
  const v = await prisma.upsellProductVersion.findMany({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } } });
  check("Save on an unsold version edits it: one version, ฿750, T-001 only, still cash + bank transfer remittance", v.length === 1 && v[0].unitPriceSatang === 75000 && JSON.stringify(v[0].eligibleSourceTourIds) === '["T-001"]' && JSON.stringify(v[0].allowedPaymentMethods) === '["CASH"]' && v[0].remittanceMethod === "BANK_TRANSFER", JSON.stringify(v.map((x) => [x.unitPriceSatang, x.eligibleSourceTourIds])));
  check("the result is announced and takes focus", await page.evaluate(() => document.activeElement?.getAttribute("role") === "status"));
  check("the page now says ฿750 per guest to hand in", (await text(page)).includes("All of it — ฿750 per guest"));

  // A refused save says why and writes nothing.
  await page.click('input[name="tours"][value="T-001"]');
  await page.click("button.up-save");
  await page.waitForFunction(() => (document.querySelector('[role="alert"]')?.textContent ?? "").length > 0, { timeout: 10000 });
  check("unticking every tour is refused, with a reason", (await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } } })).eligibleSourceTourIds.length === 1);

  // Activate: active, not live — its switch is off.
  page.once("dialog", (d) => d.accept());
  await goto(page, "/admin/upsell-products/THREE-TEMPLES-ONSITE");
  await page.click("button.up-active");
  await page.waitForFunction(() => /Active · switch off/.test(document.body.innerText), { timeout: 10000 });
  check("Activate makes it Active · switch off — not live", (await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "THREE-TEMPLES-ONSITE" } })).active === true);

  // Live needs Active + switch + a version on sale today. A gap between versions is not live.
  page.once("dialog", (d) => d.accept());
  await goto(page, "/admin/upsell-products/RTE-WPWA");
  await page.click("button.up-active");
  await page.waitForFunction(() => /Active · live/.test(document.body.innerText), { timeout: 10000 });
  check("Active + switch on + v1 on sale today = Active · live", true);
  const rv1 = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  const day = (n) => new Date(new Date(`${BKK_TODAY}T00:00:00Z`).getTime() + n * 86400000);
  await prisma.upsellProductVersion.update({ where: { id: rv1.id }, data: { activeFrom: day(-10), activeTo: day(-1) } });
  await prisma.upsellProductVersion.create({ data: { productId: rv1.productId, version: 2, unitPriceSatang: 25000, allowedPaymentMethods: ["CASH"], revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: rv1.taxProfileId, activeFrom: day(5) } });
  await goto(page, "/admin/upsell-products/RTE-WPWA");
  const gapText = await text(page);
  check("between versions the product page says not on sale today, never live", gapText.includes("Active · no version on sale today") && !gapText.includes("Active · live"));
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h });
    await goto(page, "/admin/upsell-products");
    const lt = await text(page);
    const row = lt.slice(lt.indexOf("Wat Pho + Wat Arun"), lt.indexOf("Three Temples"));
    check(`${w}px list: the product between versions is not live`, row.includes("Active · no version on sale today") && !row.includes("live"), row.replace(/\s+/g, " "));
    const gf = await fits(page); check(`${w}px list with the longest status fits`, gf.over <= 1, gf.culprits.join(" "));
    await shot(page, `list-gap-${w}`);
  }
  await page.setViewport({ width: 1280, height: 900 });

  // After a sale the version is locked: Save makes v2.
  await sellUnder("FOOD-BKK");
  await goto(page, "/admin/upsell-products/FOOD-BKK");
  const tf = await text(page);
  check("a sold version says it is locked and Save will make v2", tf.includes("v1 has 1 sale, so it is locked. Saving creates v2") && (await page.$eval("button.up-save", (b) => b.textContent)) === "Save as v2");
  await page.click("#inc", { clickCount: 3 }); await page.type("#inc", "120");
  await page.click("button.up-save");
  await page.waitForFunction(() => /Saved as v2/.test(document.querySelector('[role="status"]')?.textContent ?? ""), { timeout: 10000 });
  const fv = await prisma.upsellProductVersion.findMany({ where: { product: { productCode: "FOOD-BKK" } }, orderBy: { version: "asc" } });
  check("v1 keeps its rules and ends the day before v2", fv.length === 2 && fv[0].incentivePerGuestSatang === 10000 && fv[1].incentivePerGuestSatang === 12000 && fv[0].activeTo && fv[0].activeTo.getTime() === fv[1].activeFrom.getTime() - 86400000, JSON.stringify(fv.map((x) => [x.version, x.incentivePerGuestSatang, x.activeFrom, x.activeTo])));
  check("v2 starts after today", fv[1]?.activeFrom.toISOString().slice(0, 10) > BKK_TODAY);
  await page.setViewport({ width: 390, height: 844 });
  await goto(page, "/admin/upsell-products/FOOD-BKK");
  await page.click("details summary");
  const fl = await fits(page); check("390px Food Tour with two versions open fits", fl.over <= 1, fl.culprits.join(" "));
  await shot(page, "FOOD-BKK-v2-390");
  await page.close();

  // ── ACCOUNTANT: reads, no controls, writes refused ──
  const acct = await browser.newPage();
  acct.on("pageerror", (e) => pageErrors.push(String(e)));
  await acct.setViewport({ width: 390, height: 844 });
  await acct.setCookie(await sessionCookie(ACCT));
  await goto(acct, "/admin/upsell-products/THREE-TEMPLES-ONSITE");
  check("ACCOUNTANT opens the page", acct.url().endsWith("/admin/upsell-products/THREE-TEMPLES-ONSITE") && (await text(acct)).includes("Read only — an Admin changes these settings."));
  check("ACCOUNTANT sees no Save or Activate, and every control is disabled", await acct.evaluate(() =>
    !document.querySelector("button.up-save, button.up-active") && [...document.querySelectorAll(".op-main input, .op-main select")].every((el) => el.matches(":disabled"))));
  const aa = await a11y(acct); check("ACCOUNTANT view accessibility", aa.length === 0, aa.join("; "));
  await shot(acct, "accountant-390");
  const stamp = (await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "RTE-WPWA" } })).updatedAt.toISOString();
  const put = await api(acct, "/api/admin/upsell-products/RTE-WPWA", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: stamp, price: "1" }) });
  const act = await api(acct, "/api/admin/upsell-products/RTE-WPWA/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: stamp, active: true }) });
  check("ACCOUNTANT writes are 403", put.status === 403 && act.status === 403, `${put.status} ${act.status}`);
  await acct.close();

  // ── OPERATOR: turned away ──
  const ops = await browser.newPage();
  await ops.setCookie(await sessionCookie(OPS));
  await goto(ops, "/admin/upsell-products");
  check("OPERATOR is sent away from the page", !ops.url().includes("/admin/upsell-products"), ops.url());
  const r = await api(ops, "/api/admin/upsell-products");
  check("OPERATOR gets 403 from the API", r.status === 403, String(r.status));
  check("OPERATOR's menu has no Upsell products", await ops.evaluate(async () => { await new Promise((x) => setTimeout(x, 300)); return ![...document.querySelectorAll(".op-nav a")].some((a) => a.getAttribute("href") === "/admin/upsell-products"); }));
  await ops.close();

  check("no page error", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  const outbound = readFileSync(OUTBOUND, "utf8").trim();
  check("the server called nothing off this machine (no PEAK, no gateway)", outbound === "", outbound.slice(0, 300));
  check("no sale, payment or custody was created by the page", (await prisma.upsellSale.count()) === 1 && (await prisma.upsellPayment.count()) === 0 && (await prisma.cashCustodyEntry.count()) === 0);
} finally {
  await browser.close();
  server.kill();
  await prisma.$disconnect();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
