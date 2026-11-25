/*
Purpose: Splits committed event-label searches into literal keyword alternatives.
File Dependencies: None.
*/


/** Splits comma-separated label keywords into trimmed, nonempty alternatives. */
export function eventKeywords(query: string): string[] {
  const seen = new Set<string>();
  return query.split(",").map((term) => term.trim()).filter((term) => {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Creates the event label matcher. */
export function createEventLabelMatcher(query: string): (labels: readonly string[]) => boolean {
  const terms = eventKeywords(query).map((term) => term.toLowerCase());
  return (labels) => !terms.length || labels.some((label) => {
    const lower = label.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
}
