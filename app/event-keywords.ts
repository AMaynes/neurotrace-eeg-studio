/** Case-insensitive literal matches. Commas separate alternatives; spaces stay within phrases. */
export function eventKeywords(query: string): string[] {
  const seen = new Set<string>();
  return query.split(",").map((term) => term.trim()).filter((term) => {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createEventLabelMatcher(query: string): (labels: readonly string[]) => boolean {
  const terms = eventKeywords(query).map((term) => term.toLowerCase());
  return (labels) => !terms.length || labels.some((label) => {
    const lower = label.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
}
