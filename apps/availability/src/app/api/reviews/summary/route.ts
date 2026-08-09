import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { thb } from "@/lib/jobsheet";
import { money2 } from "@/lib/review-incentives";

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// GET ?payoutId=…  |  ?guideId=…&from=YYYY-MM-DD&to=YYYY-MM-DD — a print-ready
// Review Incentive Summary (guide + period + one line per review + total), the
// supporting document Folkpaths attaches to the PEAK expense (spec §10/§11).
// Same print pattern as the job-sheet PDF: HTML + the browser's Save-as-PDF.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const payoutId = sp.get("payoutId");

  let reviews, guideId: string, periodStart: string, periodEnd: string, headerRef = "", peakRef = "";
  if (payoutId) {
    const payout = await prisma.reviewPayout.findUnique({ where: { id: payoutId }, include: { reviews: { orderBy: { reviewDate: "asc" } } } });
    if (!payout) return NextResponse.json({ error: "not-found" }, { status: 404 });
    ({ guideId, periodStart, periodEnd } = payout);
    reviews = payout.reviews;
    headerRef = payout.ref;
    peakRef = payout.peakRef ?? "";
  } else {
    guideId = sp.get("guideId") || "";
    periodStart = sp.get("from") || "";
    periodEnd = sp.get("to") || "";
    if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return NextResponse.json({ error: "bad-query", hint: "payoutId, or guideId+from+to" }, { status: 400 });
    }
    reviews = await prisma.review.findMany({
      where: { guideId, reviewDate: { gte: periodStart, lte: periodEnd }, paymentStatus: { not: "VOID" } },
      orderBy: { reviewDate: "asc" },
    });
  }

  const [u, tours] = await Promise.all([
    prisma.user.findFirst({ where: { guideId }, select: { displayName: true, fullName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? "";
  const total = money2(reviews.reduce((s, r) => s + r.incentiveAmount, 0));
  const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const stars = (n: number | null) => (n ? "★".repeat(n) : "—");

  const rows = reviews.map((r, i) => `<tr>
    <td>${i + 1}</td><td>${esc(fmt(r.reviewDate))}</td><td>${esc(r.bookingReference || "—")}</td>
    <td>${esc(r.jobSheetRef || "—")}</td><td>${esc(tName(r.tourId) || "—")}</td>
    <td class="c">${stars(r.rating)}</td><td class="n">${thb(r.incentiveAmount)}</td>
  </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Review incentives · ${esc(guideId)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Inter","Noto Sans Thai",-apple-system,sans-serif; color:#16201c; font-size:12px; margin:0; }
  .toolbar { background:#0E3B2E; color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .toolbar button { background:#fff; color:#0E3B2E; border:none; border-radius:7px; padding:7px 14px; font-weight:600; cursor:pointer; font-size:13px; }
  .page { max-width:800px; margin:16px auto; padding:0 16px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0E3B2E; padding-bottom:10px; }
  .brand { font-size:22px; font-weight:600; color:#0E3B2E; }
  .brand small { display:block; font-size:12px; color:#6b746f; font-weight:400; }
  .meta div { margin:2px 0; }
  h2 { margin:18px 0 4px; font-size:15px; }
  .sub { color:#6b746f; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th, td { border:1px solid #d9ded9; padding:6px 8px; text-align:left; }
  th { background:#eef4ef; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .n { text-align:right; font-variant-numeric:tabular-nums; }
  .c { text-align:center; }
  tr.tot td { font-weight:700; background:#f7f9f7; }
  .note { color:#6b746f; font-size:11px; margin-top:12px; }
  @media print { .toolbar { display:none; } .page { margin:0; } }
</style></head>
<body>
  <div class="toolbar"><span>Review incentive summary${headerRef ? ` · ${esc(headerRef)}` : ""}</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <div class="page">
    <div class="head">
      <div class="brand">FOLKPATHS<small>บริษัท โฟล์คพาธส์ จำกัด</small></div>
      <div class="meta">
        ${headerRef ? `<div><b>Ref</b> ${esc(headerRef)}</div>` : ""}
        <div><b>Guide</b> ${esc(guideId)} · ${esc(u?.fullName || u?.displayName || "")}</div>
        <div><b>Period</b> ${esc(fmt(periodStart))} – ${esc(fmt(periodEnd))}</div>
        ${peakRef ? `<div><b>PEAK</b> ${esc(peakRef)}</div>` : ""}
      </div>
    </div>
    <h2>Review incentives</h2>
    <div class="sub">${reviews.length} review${reviews.length === 1 ? "" : "s"} · each earned separately from the job sheet (original job sheets unchanged)</div>
    <table>
      <thead><tr><th>No.</th><th>Review date</th><th>Booking ref</th><th>Job no.</th><th>Tour</th><th class="c">Rating</th><th class="n">Incentive</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" style="color:#aaa">No reviews in this period.</td></tr>`}
        <tr class="tot"><td colspan="6" style="text-align:right">Total review incentive</td><td class="n">${thb(total)}</td></tr>
      </tbody>
    </table>
    <div class="note">Supporting detail for the PEAK expense "Review incentive — ${esc(guideId)} · ${esc(periodStart)} – ${esc(periodEnd)}". Each line traces to its OTA booking reference and job number.</div>
  </div>
</body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
