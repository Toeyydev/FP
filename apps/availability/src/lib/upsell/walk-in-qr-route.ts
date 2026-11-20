import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { upsellWalkInQrEnabled } from "./flags";
import { WalkInQrError, type QrActor } from "./walk-in-qr";
import { UpsellSaleError } from "./sales";

// Route plumbing for the guest QR. Public answers are never cached, never indexed and send no
// referrer; while UPSELL_WALKIN_QR_ENABLED is off every route is a 404.

export const PUBLIC_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;
/** Bodies a guest sends are tiny; anything bigger is refused unread. */
export const PUBLIC_BODY_LIMIT = 2048;

export const off = () => NextResponse.json({ error: "not-found" }, { status: 404, headers: PUBLIC_HEADERS });

export async function publicBody(req: Request): Promise<unknown | NextResponse> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > PUBLIC_BODY_LIMIT) return NextResponse.json({ error: "TOO_LARGE" }, { status: 413, headers: PUBLIC_HEADERS });
  const text = await req.text().catch(() => "");
  if (text.length > PUBLIC_BODY_LIMIT) return NextResponse.json({ error: "TOO_LARGE" }, { status: 413, headers: PUBLIC_HEADERS });
  try { return JSON.parse(text); } catch { return NextResponse.json({ error: "BAD_REQUEST", message: "Not JSON" }, { status: 400, headers: PUBLIC_HEADERS }); }
}

/** A refusal the person can act on → its status and message (generic for the public); anything else is thrown. */
export async function answerQr<T>(fn: () => Promise<T>, headers: Record<string, string> = {}) {
  try {
    return NextResponse.json(await fn(), { headers });
  } catch (e) {
    if (e instanceof WalkInQrError || e instanceof UpsellSaleError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers });
    throw e;
  }
}

/** The signed-in guide or Admin, checked against the database now. */
export async function qrActor(): Promise<QrActor | NextResponse> {
  if (!upsellWalkInQrEnabled()) return off();
  const session = await auth();
  const id = session?.user?.id ?? null;
  if (!id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session?.user?.role as string | undefined;
  const me = await prisma.user.findUnique({ where: { id }, select: { role: true, state: true, guideId: true } });
  if (!me || me.state !== "ACTIVE" || me.role !== role || (role !== "GUIDE" && role !== "ADMIN")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (role === "GUIDE" && !me.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return { userId: id, role, guideId: me.guideId };
}
