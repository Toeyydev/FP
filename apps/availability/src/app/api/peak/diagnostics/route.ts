import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { classifyPeakHost, endpointSource } from "@/lib/peak-env";
import {
  peakBaseUrl, peakConfigured, peakEnabled,
  getAccountCodes, getContacts, getPaymentMethods, getUserDetail, sanitizePeakError,
  type PeakEnvelope,
} from "@/lib/peak-api";

export const dynamic = "force-dynamic";

// GET — one read-only picture of which PEAK we are connected to and what it holds.
//
// READ-ONLY throughout: it authenticates and LISTS. It creates no document, no
// contact, no journal entry, and writes nothing to our database.
//
// Reports structure, never contents: counts, array keys and FIELD NAMES. The one
// exception is the merchant name, which is the whole point — it answers "whose
// books are these", and cannot be inferred from anything else.
export async function GET() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const env = classifyPeakHost(peakBaseUrl);
  const source = endpointSource({ PEAK_API_BASE_URL: process.env.PEAK_API_BASE_URL, PEAK_BASE_URL: process.env.PEAK_BASE_URL });

  // Variable NAMES and whether they are set — never a value. PEAK_SIGN_SECRET and
  // PEAK_SIG_ENCODING are included because either one set to the wrong thing
  // silently breaks a signature that is otherwise correct.
  const varNames = [
    "PEAK_API_BASE_URL", "PEAK_BASE_URL", "PEAK_CONNECT_ID", "PEAK_CONNECT_KEY", "PEAK_USER_TOKEN",
    "PEAK_SIGN_SECRET", "PEAK_SIG_ENCODING", "PEAK_ACCT_GUIDE_FEE", "PEAK_ACCT_EXPENSES",
    "PEAK_CONTACT_TYPE", "PEAK_PAYMENT_METHOD", "PEAK_VAT_TYPE",
  ];
  const variables = Object.fromEntries(varNames.map((k) => [k, (process.env[k] ?? "").trim() ? "configured" : "not set"]));

  const connection = {
    environment: env.environment,          // SANDBOX | PRODUCTION | UNKNOWN
    environmentLabel: env.label,
    apiHost: env.host,
    effectiveEndpoint: peakBaseUrl,
    endpointSource: source.source,
    endpointOverridden: source.overridden,  // the variable being ignored, if any
    credentialsPresent: peakConfigured,
    userTokenPresent: peakEnabled,
  };

  if (!peakEnabled) {
    return NextResponse.json({
      connection, variables,
      identity: null, accounts: null, paymentMethods: null, contacts: null,
      note: "PEAK is not fully configured, so no live calls were made.",
    });
  }

  // All four are read-only lists/reads. Run together: they are independent, and a
  // failure in one must not hide the others.
  const [identityRes, accountsRes, methodsRes, contactsRes] = await Promise.all([
    getUserDetail().catch((e) => ({ ok: false, desc: sanitizePeakError(e) })),
    getAccountCodes().catch((e) => ({ ok: false, desc: sanitizePeakError(e) })),
    getPaymentMethods().catch((e) => ({ ok: false, desc: sanitizePeakError(e) })),
    getContacts({ limit: 200 }).catch((e) => ({ ok: false, desc: sanitizePeakError(e) })),
  ]);

  // Tax numbers identify a legal entity; enough to confirm which company without
  // reproducing the whole number.
  // The envelope is reported whether the call succeeded or failed. A zero count
  // means nothing on its own — it is the HTTP status, the wrapper PEAK used and
  // its resCode that say whether the list is genuinely empty or the request never
  // reached the data. Structure and status only: no row contents, ever.
  const envelopeOf = (res: { envelope?: PeakEnvelope }) =>
    res.envelope
      ? {
          httpStatus: res.envelope.httpStatus,
          wrapperName: res.envelope.wrapperName,
          wrapperFields: res.envelope.wrapperKeys,
          resCode: res.envelope.resCode,
          resDesc: res.envelope.resDesc,   // sanitized in peak-api before it gets here
          arrayKey: res.envelope.arrayKey,
          rawCount: res.envelope.rawCount,
        }
      : null;

  const maskTax = (t: string | null | undefined) => (!t ? null : t.length <= 4 ? "••••" : `${"•".repeat(Math.max(0, t.length - 4))}${t.slice(-4)}`);

  const id = "identity" in identityRes ? identityRes.identity : undefined;
  const identity = {
    ok: identityRes.ok,
    ...(identityRes.ok && id
      ? { merchantName: id.merchantName, taxNumberMasked: maskTax(id.taxNumber), package: id.package, branchCode: id.branchCode }
      : { error: identityRes.desc ?? "could not read PEAK user detail" }),
    peak: envelopeOf(identityRes as { envelope?: PeakEnvelope }),
  };

  const listInfo = (
    res: { ok: boolean; desc?: string; envelope?: PeakEnvelope; meta?: { arrayKey: string; rawCount: number; sampleKeys: string[] } },
    kept: number,
  ) => ({
    ok: res.ok,
    ...(res.ok
      ? { rawCount: res.meta?.rawCount ?? kept, usableCount: kept, arrayKey: res.meta?.arrayKey ?? null, fieldsOnFirstRow: res.meta?.sampleKeys ?? [] }
      : { error: res.desc ?? "request failed" }),
    peak: envelopeOf(res),
  });

  const accounts = listInfo(accountsRes as never, ("accounts" in accountsRes ? accountsRes.accounts?.length : 0) ?? 0);
  const paymentMethods = listInfo(methodsRes as never, ("methods" in methodsRes ? methodsRes.methods?.length : 0) ?? 0);
  const contacts = {
    ok: contactsRes.ok,
    ...(contactsRes.ok
      // Count only. Contact rows are people and companies — names, tax numbers
      // and codes — and none of that belongs in a diagnostic.
      ? { rawCount: ("contacts" in contactsRes ? contactsRes.contacts?.length : 0) ?? 0 }
      : { error: contactsRes.desc ?? "request failed" }),
    peak: envelopeOf(contactsRes as { envelope?: PeakEnvelope }),
  };

  // §6: the saved mappings came from a chart someone read in PEAK's web UI. If that
  // was a different environment from this one, the codes will not exist here — and
  // posting would be rejected. Check rather than assume.
  const saved = await prisma.peakAccountMapping.findMany({
    where: { peakAccountCode: { not: null } },
    select: { folkopsCategory: true, peakAccountCode: true },
  });
  const liveCodes = new Set(("accounts" in accountsRes ? accountsRes.accounts ?? [] : []).map((a) => a.code));
  const mappingCheck = {
    savedCount: saved.length,
    // Only meaningful when the chart actually loaded; otherwise we cannot tell.
    verifiable: accountsRes.ok && liveCodes.size > 0,
    presentInThisEnvironment: saved.filter((m) => liveCodes.has(m.peakAccountCode!)).map((m) => m.folkopsCategory),
    missingFromThisEnvironment: accountsRes.ok && liveCodes.size > 0
      ? saved.filter((m) => !liveCodes.has(m.peakAccountCode!)).map((m) => ({ category: m.folkopsCategory, code: m.peakAccountCode }))
      : [],
  };

  // §6. GET /DailyJournals/accountcode is the path this client has always used for
  // the chart of accounts, but it is not confirmed against the current Production
  // API and has never returned rows here. Rather than swap in a guessed endpoint,
  // the diagnostic states the position and the saved manual mapping stands.
  const accountCodeEndpoint = {
    path: "GET /DailyJournals/accountcode",
    status: accountsRes.ok && ((("meta" in accountsRes ? accountsRes.meta?.rawCount : 0) ?? 0) > 0)
      ? "responded with rows"
      : "unconfirmed on this environment — no rows have ever been returned",
    note: "Not replaced with an alternative endpoint: none is documented for the chart of accounts. "
        + "FolkOPS category → PEAK account codes stay manually mapped, and nothing auto-posts.",
  };

  return NextResponse.json({
    connection, variables, identity, accounts, paymentMethods, contacts,
    accountCodeEndpoint, mappingCheck,
    readOnly: true,
  });
}
