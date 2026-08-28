// The app's public base URL, in ONE place.
//
// It was hardcoded as https://guide.folkpaths.com in a dozen files, so renaming the
// site meant a code change across all of them — and a half-applied rename sends
// guides one-tap job links pointing at a host that does not answer.
//
// Set PUBLIC_BASE_URL to move the site. No deploy needed: Railway restarts on a
// variable change. Default stays guide.folkpaths.com, so nothing moves until the
// new domain actually exists and someone deliberately switches.
const RAW = (process.env.PUBLIC_BASE_URL || "https://guide.folkpaths.com").trim();

export const PUBLIC_BASE_URL = RAW.replace(/\/+$/, "");
export const PUBLIC_HOST = (() => {
  try { return new URL(PUBLIC_BASE_URL).hostname; } catch { return "guide.folkpaths.com"; }
})();

// Absolute URL for a path — for emails, LINE messages and anything else that leaves
// the app and cannot use a relative link.
export function siteUrl(path = "/"): string {
  return `${PUBLIC_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
