import assert from "node:assert/strict";
import test from "node:test";
import { listOlderBrowserReviews } from "../app/legacy-browser-recovery.ts";

test("older browser reviews are listed for explicit selection without changing any saved entry", () => {
  const record = (patch = {}) => JSON.stringify({ version: 2, annotations: [{ id: "review" }], candidates: [], savedAt: "2026-01-01", reviewer: "AB", ...patch });
  const values = new Map([
    [`neurotrace:project:${"a".repeat(32)}`, record()],
    [`neurotrace:project:${"b".repeat(32)}`, "unreadable"],
    [`neurotrace:project:${"c".repeat(32)}`, record({ annotations: [] })],
    [`neurotrace:project:local-v1:${"d".repeat(64)}`, record()],
    ["neurotrace:review-backup:local-v1:id:123", record({ recordingName: "current.edf", savedAt: "2026-02-01" })],
  ]);
  const before = [...values];
  const storage = { length: values.size, key: (index) => [...values.keys()][index], getItem: (key) => values.get(key) ?? null };
  const entries = listOlderBrowserReviews(storage);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "current.edf");
  assert.equal(entries[1].name, "Older review");
  assert.equal(entries[1].labels, 1);
  assert.deepEqual([...values], before);
});
