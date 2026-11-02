export interface BrowserReviewEntry { key: string; savedAt: string; reviewer: string; labels: number; events: number; name: string }

/** Old hash-keyed reviews lack filenames. Offer explicit recovery; never guess. */
export function listOlderBrowserReviews(storage: Pick<Storage, "length" | "key" | "getItem">): BrowserReviewEntry[] {
  const entries: BrowserReviewEntry[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || !/^neurotrace:(?:project:[a-f0-9]{32}|review-backup:.+)$/.test(key)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null");
      if (value?.version !== 2 || !Array.isArray(value.annotations)) continue;
      const events = Array.isArray(value.candidates) ? value.candidates.length : 0;
      if (!value.annotations.length && !events) continue;
      entries.push({ key, savedAt: typeof value.savedAt === "string" ? value.savedAt : "Unknown date",
        reviewer: typeof value.reviewer === "string" ? value.reviewer : "",
        labels: value.annotations.length, events,
        name: typeof value.recordingName === "string" ? value.recordingName : "Older review" });
    } catch { /* Leave unreadable entries untouched. */ }
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
