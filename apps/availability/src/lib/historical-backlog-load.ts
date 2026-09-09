/**
 * Fetch the historical backlog and say plainly what happened.
 *
 * Separate from the component so the failure paths can be tested: the component
 * renders, and this project has no DOM test environment. Returns a result rather
 * than throwing, so a caller cannot ignore failure — which is precisely how the
 * page came to sit on "Loading the historical backlog…" forever.
 */
/**
 * The minimum a backlog payload must carry to be renderable.
 *
 * `as T` on its own let any JSON through: `null` reached setData(null) and the
 * page went straight back to showing "Loading…" forever — the very defect this
 * module exists to remove — and `[]` or `{ error: "..." }` would have crashed on
 * the first property access instead. A 200 is not the same thing as an answer.
 */
export function isBacklogShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.month === "string"
    && typeof o.totals === "object" && o.totals !== null && !Array.isArray(o.totals)
    && Array.isArray(o.guides)
    && Array.isArray(o.rows);
}

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
    const body: unknown = await r.json();
    // Checked before it is handed on: the cast below only narrows a value that
    // has already been shown to carry the fields the page reads.
    if (!isBacklogShape(body)) {
      return { ok: false, error: "The server replied with something unexpected. Try again." };
    }
    return { ok: true, data: body as T };
  } catch {
    // A 200 whose body is not the JSON we expect is still a failure, and used to
    // land in the same silent hole as the rest.
    return { ok: false, error: "The server replied with something unexpected. Try again." };
  }
}
