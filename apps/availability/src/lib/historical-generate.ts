/**
 * The two calls behind the admin "prepare the backlog" control.
 *
 * Kept out of the component and returning results rather than throwing, for the
 * same reason as the loader: vitest here runs in a node environment with no DOM,
 * so this is the part that can actually be tested — and a generation call that
 * fails silently is far worse than a list that fails silently.
 *
 * Neither function decides anything about authorisation. The route is the
 * authority: it requires ADMIN and the typed confirmation, and rejects without
 * them regardless of what the UI does.
 */
export const GENERATE_MONTH = "2026-05";

/** Exactly what the route demands. Compared verbatim — no trim, no casefold. */
export const REQUIRED_CONFIRMATION = `GENERATE ${GENERATE_MONTH}`;

/**
 * Whether the operator has typed the confirmation exactly.
 *
 * Deliberately strict: this is the last gate before 53 rows are written, and a
 * phrase that has to be typed character for character is the point. Trimming it
 * would quietly accept a stray space and make the gesture meaningless.
 */
export function isConfirmationValid(typed: string): boolean {
  return typed === REQUIRED_CONFIRMATION;
}

export type DryRun = { wouldCreate: number; skippedExistingSheet: number; tourInstances: number };

export type GenerateResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; conflict?: boolean };

async function post<T>(fetchFn: typeof fetch, body: unknown): Promise<GenerateResult<T>> {
  let r: Response;
  try {
    r = await fetchFn("/api/historical/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the server. Nothing was generated." };
  }

  let payload: Record<string, unknown> = {};
  try { payload = (await r.json()) as Record<string, unknown>; } catch { /* handled below */ }

  if (!r.ok) {
    // A second run started elsewhere won the unique index. Reported, never
    // retried automatically: the operator decides, after seeing the current state.
    if (r.status === 409 && payload.error === "concurrent-generation") {
      return {
        ok: false, conflict: true,
        error: "Another generation run is in progress or has just finished. Reload the backlog to see the current state before trying again.",
      };
    }
    if (r.status === 403) return { ok: false, error: "Not authorised — this action is admin-only." };
    if (payload.error === "confirmation-required") {
      return { ok: false, error: `The confirmation must read exactly "${REQUIRED_CONFIRMATION}".` };
    }
    if (payload.error === "month-not-in-pilot") {
      return { ok: false, error: "Only May 2026 is in the pilot." };
    }
    return { ok: false, error: `The request failed (HTTP ${r.status}).` };
  }
  return { ok: true, data: payload as T };
}

/** Counts only. `apply` is false, so the route writes nothing. */
export function dryRunGeneration(fetchFn: typeof fetch = fetch): Promise<GenerateResult<DryRun>> {
  return post<DryRun>(fetchFn, { month: GENERATE_MONTH, apply: false });
}

/**
 * The real run. Refuses to leave the browser unless the typed text matches, so a
 * mistyped confirmation costs a message rather than a request — the route would
 * reject it anyway, but there is no reason to ask it to.
 */
export function applyGeneration(
  fetchFn: typeof fetch,
  typedConfirmation: string,
): Promise<GenerateResult<{ created: number; skippedExistingSheet: number }>> {
  if (!isConfirmationValid(typedConfirmation)) {
    return Promise.resolve({ ok: false, error: `Type "${REQUIRED_CONFIRMATION}" exactly to continue.` });
  }
  return post(fetchFn, { month: GENERATE_MONTH, apply: true, confirm: typedConfirmation });
}
