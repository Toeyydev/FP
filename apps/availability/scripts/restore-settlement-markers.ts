// Restore missing advanceSettlement markers from the ledger (lib/advances/marker-restore).
//
// The rollback-safety repair. Approved use, once advance writes have ever been enabled:
//   FREEZE WRITES → roll back only if unavoidable → no advance writes while old code runs →
//   run this (dry run, then apply) → roll forward → revalidate → only then consider unfreezing.
//
//   npx tsx scripts/restore-settlement-markers.ts                 # DRY RUN (the default): reads only
//   npx tsx scripts/restore-settlement-markers.ts --apply \
//       --expect-database <name> --expect-system-id <id> --operator "<who is running it>" \
//       [--production --health-url https://<app>/api/health]   # required for any non-local database
//
// APPLY refuses unless: ADVANCE_WRITES_FROZEN=1 in this process; the connected database's name
// AND cluster system identifier equal the ones typed (the dry run prints them); an operator is
// named for the audit log; and, for a database that is not on this machine, --production is
// given and the app's /api/health reports advance writes frozen. Never prints the connection URL.
import { PrismaClient } from "@prisma/client";
import { runMarkerRestore, type RestoreReport } from "../src/lib/advances/marker-restore";
import { applyGate } from "../src/lib/advances/marker-restore-safety";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? "" : ""; };
const known = new Set(["--apply", "--dry-run", "--production", "--expect-database", "--expect-system-id", "--operator", "--health-url"]);
const unknown = args.filter((a, i) => a.startsWith("--") && !known.has(a) && !(i > 0 && ["--expect-database", "--expect-system-id", "--operator", "--health-url"].includes(args[i - 1])));
const fail = (msg: string): never => { console.error(`REFUSED: ${msg}`); process.exit(2); };

(async () => {
  if (unknown.length) fail(`unknown option(s) ${unknown.join(" ")}`);
  if (flag("apply") && flag("dry-run")) fail("choose --apply or --dry-run, not both");
  const apply = flag("apply");
  const url = process.env.DATABASE_URL ?? "";
  if (!url) fail("DATABASE_URL is not set");
  let host = "";
  try { const u = new URL(url); host = u.searchParams.get("host") ?? u.hostname; } catch { fail("DATABASE_URL is not a URL this tool can identify"); }
  const local = host.startsWith("/") || host === "localhost" || host === "127.0.0.1" || host === "::1";

  const prisma = new PrismaClient();
  try {
    const [id] = await prisma.$queryRaw<{ db: string; sysid: string; server: string | null }[]>`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sysid, inet_server_addr()::text AS server`;
    if (!id?.db || !id?.sysid) fail("could not prove which database this is (no name or system identifier)");
    console.log(`database: ${id.db} · system identifier: ${id.sysid} · ${local ? "on this machine" : "REMOTE (treated as production)"} · mode: ${apply ? "APPLY" : "dry run"}`);

    const gate = await applyGate(
      { apply, production: flag("production"), expectDatabase: value("expect-database"), expectSystemId: value("expect-system-id"), operator: value("operator"), healthUrl: value("health-url"), frozenInProcess: process.env.ADVANCE_WRITES_FROZEN },
      { db: id.db, sysid: id.sysid, local },
    );
    if (!gate.ok) fail(gate.reason);

    const out = await runMarkerRestore(prisma, { mode: apply ? "apply" : "dry-run", operator: value("operator") });
    if ("refused" in out) fail(out.refused);
    const r = out as RestoreReport;
    console.log(JSON.stringify({
      mode: r.mode, sheetsInspected: r.sheetsInspected, liveSettlementsInspected: r.settlementsInspected,
      expectedMarkers: r.expectedMarkers, alreadyCorrect: r.correctMarkers, missing: r.missingMarkers,
      restored: r.restoredMarkers, sheetsRepaired: r.sheetsRepaired,
      refusedSheets: r.refusedSheets.map((s) => ({ jobNo: s.jobNo, sheetId: s.sheetId, issues: s.issues.map((i) => `${i.code}${i.entryId ? ` [${i.entryId}]` : ""}: ${i.detail}`) })),
      conflictsAtWrite: r.conflictsAtWrite,
    }, null, 2));
    process.exitCode = r.refusedSheets.length || r.conflictsAtWrite.length ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
})();
