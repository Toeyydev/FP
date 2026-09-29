import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { getExpenseRaw } from "@/lib/peak-api";
import { compareShapes, expenseShape } from "@/lib/peak-expense-shape";

export const dynamic = "force-dynamic";

// GET ?codes=EXP-…,EXP-… — READ-ONLY. Two PEAK expense documents side by side: every
// field of each line, and the differences that could change how PEAK draws them (why a
// document made by hand in PEAK shows the หัก ณ ที่จ่าย column and one FolkOPS created
// does not). Creates nothing; GETs are not billed. Operators only.
//
// Plain text on purpose: the operator copies it into a message.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const codes = (req.nextUrl.searchParams.get("codes") ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean).slice(0, 2);
  if (codes.length !== 2 || !codes.every((c) => /^[A-Z]{2,6}-?\d{6,}$/.test(c))) {
    return new NextResponse("Give two PEAK document numbers: /api/peak/expense-compare?codes=EXP-…,EXP-…  (first: made by hand in PEAK, second: made by FolkOPS)\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const results = await Promise.all(codes.map((c) => getExpenseRaw(c)));
  const lines: string[] = [];
  const shapes = results.map((r, i) => {
    if (!r.ok) { lines.push(`${codes[i]}: could not read — ${r.desc}`); return null; }
    if (!r.expenses.length) { lines.push(`${codes[i]}: not found in PEAK`); return null; }
    if (r.expenses.length > 1) lines.push(`${codes[i]}: PEAK holds ${r.expenses.length} documents with this number (a voided one's number was reused) — comparing the first one that is not voided`);
    const pick = r.expenses.find((e) => Number(e.isVoid ?? 0) !== 1) ?? r.expenses[0];
    return expenseShape(pick);
  });
  if (shapes[0] && shapes[1]) {
    const diff = compareShapes(shapes[0], shapes[1], [codes[0], codes[1]]);
    lines.push("", "DIFFERENCES", ...(diff.length ? diff.map((d) => `- ${d}`) : ["- none found in fields or value kinds"]));
  }
  shapes.forEach((s, i) => {
    if (!s) return;
    lines.push("", `DOCUMENT ${codes[i]}`, `header: ${JSON.stringify(s.header)}`, `header fields: ${s.headerKeys.join(", ")}`);
    for (const l of s.lines) lines.push(`line ${l.n}: ${JSON.stringify(l.fields)}`);
    for (const p of s.payments) lines.push(`payment ${p.n}: ${JSON.stringify(p.fields)}`);
  });
  return new NextResponse(lines.join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
