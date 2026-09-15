// TEST ONLY. A tiny in-memory stand-in for the Prisma models Payments v2 touches, with the
// two uniqueness rules that matter (payment number; one ACTIVE payment per job). Not
// imported by application code. Real-database behaviour is covered by service.db.test.ts.
import { Prisma } from "@prisma/client";

type Row = Record<string, any>;
const clone = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
    if ("not" in cond) return cond.not === null ? v !== null && v !== undefined : v !== cond.not;
    if ("in" in cond) return cond.in.includes(v);
    if ("startsWith" in cond) return typeof v === "string" && v.startsWith(cond.startsWith);
    if ("equals" in cond) return v === cond.equals;
    if ("array_contains" in cond) return Array.isArray(v) && (cond.array_contains as Row[]).every((want) => v.some((have: Row) => Object.entries(want).every(([k, x]) => have?.[k] === x)));
    if ("gte" in cond || "lte" in cond) return (cond.gte === undefined || v >= cond.gte) && (cond.lte === undefined || v <= cond.lte);
  }
  return v === cond;
}
export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (k === "AND") return (cond as Row[]).every((w) => matches(row, w));
    if (k === "guideId_date_slotIdx") return row.guideId === cond.guideId && row.date === cond.date && row.slotIdx === cond.slotIdx;
    return matchValue(row[k], cond);
  });
}

const unique = (target: string[]) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: { target } });

export function memoryDb(seed: Partial<Record<string, Row[]>> = {}) {
  const t: Record<string, Row[]> = {};
  const names = ["jobSheet", "tourPayment", "guidePayment", "guidePaymentJob", "guidePaymentAdjustment", "assignment", "payrollStatus", "guidePaymentDocument", "paymentBatchItem", "paymentBatch", "guideAdvance", "guideAdvanceReturn", "paymentTransaction", "auditLog"];
  for (const n of names) t[n] = (seed[n] ?? []).map((r, i) => ({ id: r.id ?? `${n}_${i}`, ...clone(r) }));
  let seq = 1000;
  const relations: Record<string, Record<string, (row: Row) => any>> = {
    guidePaymentJob: { payment: (r) => t.guidePayment.find((p) => p.id === r.paymentId) },
    guidePaymentAdjustment: { payment: (r) => t.guidePayment.find((p) => p.id === r.paymentId) },
    guidePayment: { jobs: (r) => t.guidePaymentJob.filter((j) => j.paymentId === r.id), adjustments: (r) => t.guidePaymentAdjustment.filter((a) => a.paymentId === r.id) },
    paymentBatchItem: { batch: (r) => t.paymentBatch.find((b) => b.id === r.batchId) },
  };
  const shape = (name: string, row: Row, args: Row = {}): Row => {
    const pick = args.select as Row | undefined;
    const inc = args.include as Row | undefined;
    const rel = relations[name] ?? {};
    const project = (rn: string, v: any, spec: any) => {
      if (spec === true || !spec?.select) return clone(v);
      const one = (x: Row) => Object.fromEntries(Object.keys(spec.select).map((k) => [k, x?.[k]]));
      return Array.isArray(v) ? v.map(one) : v ? one(v) : v;
    };
    if (pick) return Object.fromEntries(Object.entries(pick).map(([k, spec]) => [k, rel[k] ? project(k, rel[k](row), spec) : clone(row[k])]));
    const out: Row = clone(row);
    for (const [k, spec] of Object.entries(inc ?? {})) if (rel[k]) out[k] = project(k, rel[k](row), spec);
    return out;
  };
  const checkUnique = (name: string, row: Row) => {
    if (name === "guidePayment" && t.guidePayment.some((p) => p !== row && p.paymentNo === row.paymentNo)) throw unique(["paymentNo"]);
    if (name === "guidePaymentJob" && row.active !== false && t.guidePaymentJob.some((j) => j !== row && j.active !== false && j.guideId === row.guideId && j.date === row.date && j.slotIdx === row.slotIdx)) throw unique(["GuidePaymentJob_one_active_payment_per_job"]);
    if (name === "tourPayment" && t.tourPayment.some((p) => p !== row && p.guideId === row.guideId && p.date === row.date && p.slotIdx === row.slotIdx)) throw unique(["guideId", "date", "slotIdx"]);
  };
  const model = (name: string) => ({
    findMany: async (args: Row = {}) => {
      let rows = t[name].filter((r) => matches(r, args.where));
      if (args.orderBy) { const [[k, dir]] = Object.entries(args.orderBy as Row); rows = [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === "desc" ? -1 : 1)); }
      return rows.map((r) => shape(name, r, args));
    },
    findFirst: async (args: Row = {}) => { const rows = await model(name).findMany(args); return rows[0] ?? null; },
    findUnique: async (args: Row) => { const r = t[name].find((x) => matches(x, args.where)); return r ? shape(name, r, args) : null; },
    count: async (args: Row = {}) => t[name].filter((r) => matches(r, args.where)).length,
    create: async (args: Row) => {
      const { jobs, adjustments, ...data } = args.data;
      const row: Row = { id: `${name}_${seq++}`, createdAt: new Date(), ...data };
      if (name === "guidePaymentJob" && row.active === undefined) row.active = true;
      t[name].push(row);
      try { checkUnique(name, row); } catch (e) { t[name].pop(); throw e; }
      for (const j of jobs?.create ?? []) await model("guidePaymentJob").create({ data: { ...j, paymentId: row.id } });
      for (const a of adjustments?.create ?? []) await model("guidePaymentAdjustment").create({ data: { ...a, paymentId: row.id } });
      return shape(name, row, args);
    },
    update: async (args: Row) => { const r = t[name].find((x) => matches(x, args.where)); if (!r) throw new Error("not found"); Object.assign(r, args.data); return shape(name, r, args); },
    updateMany: async (args: Row) => { const hit = t[name].filter((x) => matches(x, args.where)); for (const r of hit) Object.assign(r, args.data); return { count: hit.length }; },
    deleteMany: async (args: Row = {}) => { const keep = t[name].filter((x) => !matches(x, args.where)); const count = t[name].length - keep.length; t[name] = keep; return { count }; },
  });
  const db: Row = Object.fromEntries(names.map((n) => [n, model(n)]));
  // Rollback on error, like a real transaction: restore every table.
  db.$transaction = async (fn: any) => {
    if (Array.isArray(fn)) return Promise.all(fn);
    const snapshot = Object.fromEntries(names.map((n) => [n, t[n].map((r) => ({ ...r }))]));
    try { return await fn(db); } catch (e) { for (const n of names) t[n] = snapshot[n]; throw e; }
  };
  return { db: db as any, tables: t };
}
