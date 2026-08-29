// The app's public base URL, in ONE place.
//
// It was hardcoded as the site domain in a dozen files, so renaming the
// site meant a code change across all of them — and a half-applied rename sends
// guides one-tap job links pointing at a host that does not answer.
//
// Set PUBLIC_BASE_URL to move the site. No deploy needed: Railway restarts on a
// variable change. The default follows wherever the app actually lives — on
// 2026-08-29 the guide.folkpaths.com DNS record was removed and the app moved to
// ops.folkpaths.com, so a default of guide. pointed every outgoing link at a host
// that no longer resolves.
const RAW = (process.env.PUBLIC_BASE_URL || "https://ops.folkpaths.com").trim();

export const PUBLIC_BASE_URL = RAW.replace(/\/+$/, "");
export const PUBLIC_HOST = (() => {
  try { return new URL(PUBLIC_BASE_URL).hostname; } catch { return "ops.folkpaths.com"; }
})();

// Absolute URL for a path — for emails, LINE messages and anything else that leaves
// the app and cannot use a relative link.
export function siteUrl(path = "/"): string {
  return `${PUBLIC_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
