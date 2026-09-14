// How long a job runs, in minutes, for rules that depend on the tour being over.
//
// Resolution order: the job's own duration (the offer the guide accepted) → the tour's
// duration → 180 minutes. A stored value counts only if it is a whole number of minutes
// within 15–720 — exactly the range the Tours and Offers APIs already accept, so no new
// limit is introduced. Anything else (missing, 0, negative, under 15, over 720) falls
// through to the next level. Such a value can only come from outside those APIs (a
// direct database edit), so when a stored one is met it is logged once per process and
// shown on the Tours page instead of being quietly replaced.
export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 720;
/** Used when neither the job nor the tour has a valid duration (the calendar's long-standing default). */
export const FALLBACK_DURATION_MIN = 180;

export function isValidDurationMin(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_DURATION_MIN && v <= MAX_DURATION_MIN;
}

export type DurationLevel = "job" | "tour";
export type ResolvedDuration = {
  minutes: number;
  source: DurationLevel | "fallback";
  /** Stored values that were present but outside 15–720 and therefore skipped. */
  ignored: { level: DurationLevel; id: string | null; value: number }[];
};

const warned = new Set<string>();

export function resolveDurationMin(
  job: { id?: string | null; durationMin?: number | null } | null | undefined,
  tour: { id?: string | null; durationMin?: number | null } | null | undefined,
  warn: (message: string) => void = (m) => console.warn(m),
): ResolvedDuration {
  const ignored: ResolvedDuration["ignored"] = [];
  const levels: [DurationLevel, typeof job][] = [["job", job], ["tour", tour]];
  let resolved: ResolvedDuration | null = null;
  for (const [level, rec] of levels) {
    const v = rec?.durationMin;
    if (v == null) continue; // not set — normal for most jobs and for imported tours
    if (isValidDurationMin(v)) { resolved = { minutes: v, source: level, ignored }; break; }
    ignored.push({ level, id: rec?.id ?? null, value: v });
  }
  const out = resolved ?? { minutes: FALLBACK_DURATION_MIN, source: "fallback" as const, ignored };
  for (const i of ignored) {
    const key = `${i.level}:${i.id}:${i.value}`;
    if (warned.has(key)) continue;
    warned.add(key);
    warn(`[tour-duration] ignored invalid ${i.level} duration ${i.value} min${i.id ? ` (${i.id})` : ""}: valid range is ${MIN_DURATION_MIN}–${MAX_DURATION_MIN}; using ${out.source === "fallback" ? `the ${FALLBACK_DURATION_MIN}-minute fallback` : `the ${out.source} duration (${out.minutes} min)`}`);
  }
  return out;
}

/** Why the Tours page flags a tour's duration, or null when it is valid. */
export function tourDurationWarning(durationMin: number | null | undefined): string | null {
  if (isValidDurationMin(durationMin)) return null;
  if (durationMin == null) return `No duration set — FolkOPS assumes ${FALLBACK_DURATION_MIN} min (3 h) unless the job has its own`;
  return `Invalid duration (${durationMin} min) — must be ${MIN_DURATION_MIN}–${MAX_DURATION_MIN}; FolkOPS ignores it and assumes ${FALLBACK_DURATION_MIN} min`;
}
