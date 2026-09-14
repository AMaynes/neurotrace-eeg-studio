/** Guards waveform rendering against vertical layout-dependent mode changes. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/page.tsx", import.meta.url);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `expected ${start}`);
  assert.ok(endIndex > startIndex, `expected ${end} after ${start}`);
  return source.slice(startIndex, endIndex);
}

test("spectrogram height cannot change the waveform rendering policy", async () => {
  const page = await readFile(pagePath, "utf8");
  const drawing = section(page, "const traceOrder", "if (markOnset !== null)");

  assert.match(drawing, /if \(envelope\) \{[\s\S]*?drawContinuousTrace\(/);
  assert.match(drawing, /\} else \{[\s\S]*?drawContinuousTrace\(/);
  assert.doesNotMatch(drawing, /rowHeight[\s\S]*?renderMode/);
  assert.doesNotMatch(drawing, /drawGroupedExtrema|drawOverviewEnvelope|pixelEnvelope/);
});
