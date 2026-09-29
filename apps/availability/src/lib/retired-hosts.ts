// Hosts the app used to answer on, and where to send people now.
//
// guide.folkpaths.com served the app until 2026-08-29. Its DNS record was pulled
// rather than redirected, which stranded every guide whose home-screen PWA still
// pointed there: the service worker kept serving the cached shell, so the app
// opened and looked completely normal while every /api call went to a host that
// no longer resolved. Pointing the record back and redirecting here means the old
// icon lands on the live site instead of failing in silence.
//
// Only hosts named below redirect. Everything else is served as-is — Railway's own
// *.up.railway.app hostnames, preview deploys and localhost included — so internal
// traffic and health checks are never bounced somewhere they cannot follow.
const RETIRED_HOSTS = new Set(["guide.folkpaths.com"]);

// Callbacks from other servers are served on a retired host, never redirected.
// LINE (job-offer Accept/Deny taps, link codes), Bokun and the offer-sweep cron POST
// to whatever URL was registered with them and do not follow a redirect: LINE drops
// the event and the guide's tap does nothing at all. That is what happened once the
// old host started redirecting — guides tapping Accept got no answer.
const MACHINE_CALLBACKS = new Set(["/api/line/webhook", "/api/bokun/webhook", "/api/offers/sweep"]);

/**
 * The canonical host this request should be sent to, or null to serve it here.
 * Matching is exact on the hostname (port stripped, case-insensitive), so a
 * lookalike such as guide.folkpaths.com.example.test is never treated as ours.
 * Server-to-server callbacks (`pathname` in MACHINE_CALLBACKS) are always served here.
 */
export function canonicalHostFor(host: string | null | undefined, canonical: string, pathname?: string | null): string | null {
  if (!host) return null;
  if (pathname && MACHINE_CALLBACKS.has(pathname.replace(/\/+$/, "") || "/")) return null;
  const bare = host.split(":")[0].toLowerCase();
  if (!RETIRED_HOSTS.has(bare)) return null;
  if (bare === canonical.toLowerCase()) return null; // never redirect a host to itself
  return canonical;
}
