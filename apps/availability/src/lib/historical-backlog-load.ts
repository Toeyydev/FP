/**
 * Fetch the historical backlog and say plainly what happened.
 *
 * Separate from the component so the failure paths can be tested: the component
 * renders, and this project has no DOM test environment. Returns a result rather
 * than throwing, so a caller cannot ignore failure — which is precisely how the
 * page came to sit on "Loading the historical backlog…" forever.
 */
export type BacklogLoad<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function loadBacklog<T>(
  fetchFn: typeof fetch = fetch,
  month = "2026-05",
): Promise<BacklogLoad<T>> {
  let r: Response;
  try {
    r = await fetchFn(`/api/historical?month=${month}`, { cache: "no-store" });
  } catch {
    // The request never completed: offline, DNS, a dropped connection. Without
    // this the promise rejected unhandled and the page hung on its loading text.
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
  if (!r.ok) {
    return {
      ok: false,
      error: r.status === 403
        // The one status with an action attached, so it says what to do next.
        ? "Not authorised to view the historical backlog — sign in as an operator or admin."
        : `Couldn't load the backlog (HTTP ${r.status}).`,
    };
  }
  try {
    return { ok: true, data: (await r.json()) as T };
  } catch {
    // A 200 whose body is not the JSON we expect is still a failure, and used to
    // land in the same silent hole as the rest.
    return { ok: false, error: "The server replied with something unexpected. Try again." };
  }
}
