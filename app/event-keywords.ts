/*
Purpose: Defines common event-label presets and matches comma-separated keyword alternatives.
File Dependencies: None.
*/


export const COMMON_EVENT_KEYWORDS = [
  // Matches target_evs in seizure_annotation_tool_update.m.
  { name: "Seizure / Sz / Seiz", query: "sz, seizure, seiz, tonic, EEG onset" },
  { name: "Spikes / sharp waves", query: "spike, sharp" },
  { name: "Artifact", query: "artifact, artefact" },
  { name: "Stimulation", query: "stim" },
  { name: "Medication", query: "medication, med given, drug" },
  { name: "Button press", query: "button, push" },
  { name: "Sleep", query: "sleep, NREM, REM" },
] as const;

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

/** Reports whether every alias is present and returns the query after toggling the preset. */
export function eventKeywordPresetState(terms: readonly string[], presetQuery: string) {
  const aliases = eventKeywords(presetQuery);
  const aliasKeys = new Set(aliases.map((alias) => alias.toLowerCase()));
  const termKeys = new Set(terms.map((term) => term.toLowerCase()));
  const selected = [...aliasKeys].every((key) => termKeys.has(key));
  const next = selected ? terms.filter((term) => !aliasKeys.has(term.toLowerCase())) : [...terms, ...aliases];
  return { selected, toggledQuery: eventKeywords(next.join(", ")).join(", ") };
}

/** Creates the event label matcher. */
export function createEventLabelMatcher(query: string): (labels: readonly string[]) => boolean {
  const terms = eventKeywords(query).map((term) => term.toLowerCase());
  return (labels) => !terms.length || labels.some((label) => {
    const lower = label.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
}
