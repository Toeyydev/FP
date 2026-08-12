// Matching a job sheet's hand-written guide name against platform guide records.
// Paper sheets carry old GuideMaster IDs that don't always match platform guideIds
// (real cases: a sheet's "G-001" was platform G-026, a sheet's "G-005" was G-031),
// so the sheet's name — not its ID — is the reliable key when the ID is unknown.

// Significant name tokens (drop titles + punctuation) for matching a sheet's guide
// name against the platform record.
export function nameTokens(s: string | null | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/\b(miss|mrs|mr|ms|khun|k|dr)\.?\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// Pick the ONE guide whose name best overlaps the sheet's guide name, or null when
// there is no overlap or the best match is ambiguous (a tie). One shared significant
// token is enough when it's unique — nicknames like "Siri" only cover part of a
// formal "Miss Siripanya Poompana" — but any tie means a human must decide.
export function bestGuideByName<T extends { fullName?: string | null; displayName?: string | null }>(
  guides: T[],
  sheetName: string | null | undefined,
): T | null {
  const want = nameTokens(sheetName);
  if (!want.length) return null;
  const scored = guides
    .map((g) => {
      const have = new Set(nameTokens(`${g.fullName ?? ""} ${g.displayName ?? ""}`));
      return { g, hits: want.filter((t) => have.has(t)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].hits === scored[1].hits) return null; // ambiguous
  return scored[0].g;
}
