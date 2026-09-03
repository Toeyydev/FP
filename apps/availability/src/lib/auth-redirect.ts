/**
 * Where to send someone back to after the middleware intercepts a gated page.
 *
 * The middleware used to pass only `pathname`, which silently dropped every
 * query string. A deep link like `/bookings?date=2026-08-31` — the dashboard's
 * "Record" on a past unstaffed tour — survived the round trip as a bare
 * `/bookings`, landing the operator on a default view with no sign anything had
 * been stripped. It read as the button bouncing and doing nothing.
 *
 * Kept relative and same-origin: the value is handed to a redirect, so an
 * absolute or protocol-relative target would be an open redirect.
 */
export function returnTarget(pathname: string, search: string): string {
  const p = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  if (!search || !search.startsWith("?")) return p;
  return p + search;
}
