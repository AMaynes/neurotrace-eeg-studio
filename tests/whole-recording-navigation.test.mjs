/** End-to-end data-path checks without browser automation or private recordings. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RawDatSource } from "../app/eeg-core.ts";
import { buildRawDatEnvelopeWindow } from "../app/raw-dat-envelope.ts";
import {
  RecordingOverviewCache,
  recordingOverviewDisplayWindow,
  recordingOverviewPlan,
} from "../app/recording-overview.ts";

test("157-channel hour index serves whole-file zooms and newly enabled channels without rereading", async () => {
  const sampleRate = 10;
  const channelCount = 157;
  const samples = Int16Array.from({ length: 3600 * sampleRate * channelCount },
    (_, index) => (index * 47 % 65536) - 32768);
  const file = new File([samples], "synthetic-full-session.dat");
  const slice = file.slice.bind(file);
  let readBytes = 0;
  file.slice = (start, end, type) => {
    readBytes += (end ?? file.size) - (start ?? 0);
    return slice(start, end, type);
  };
  const source = await RawDatSource.create(file, {
    sampleRate, channelCount,
    channelLabels: Array.from({ length: channelCount }, (_, index) => `A${index + 1}`),
  });
  const plan = recordingOverviewPlan(source.meta);
  assert.equal(plan.channelIndices.length, channelCount);
  assert.equal(plan.bucketCount, 2048);
  const cache = new RecordingOverviewCache();
  const prefixes = [];
  const result = await buildRawDatEnvelopeWindow({
    ...source.envelopeWorkerSource,
    ...plan,
    integrity: { sha256: true },
    overviewIntervalMs: 500,
    chunkSizeBytes: 512 * 1024,
  }, {
    onOverview: (window) => {
      assert.equal(cache.put(source, window, { complete: false }), true);
      const entry = cache.get(source);
      const projected = recordingOverviewDisplayWindow(entry, 0, 3600, [156, 0]);
      const completed = window.data[0].length;
      assert.deepEqual(projected.minima[0].slice(0, completed), window.minima[156]);
      if (completed < plan.bucketCount) {
        assert.ok(Number.isNaN(projected.data[0][completed]));
        assert.ok(Number.isNaN(projected.minima[0][completed]));
        assert.equal(projected.gaps[0][completed], 1, "unread data cannot appear as a flat recording");
      }
      prefixes.push(window);
    },
  });
  assert.ok(prefixes.some((window) => window.durationSec < 3600), "show an exact prefix before the full read finishes");
  assert.equal(cache.put(source, result.window, { complete: true }), true);
  const sourceReadBytes = readBytes;
  assert.equal(sourceReadBytes, file.size, "hashing and all-channel indexing share one source pass");
  assert.ok(cache.byteLength < 6 * 1024 * 1024, "the entire 157-channel index stays compact");
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const entry = cache.get(source);
    const channels = iteration % 2 ? [156, 40, 2] : [0, 1];
    const full = recordingOverviewDisplayWindow(entry, 0, 3600, channels);
    assert.deepEqual(full.minima[0], result.window.minima[channels[0]]);
    assert.deepEqual(full.maxima[0], result.window.maxima[channels[0]]);
    const detail = recordingOverviewDisplayWindow(entry, 100, 20, channels);
    assert.ok(detail.data[0].length < full.data[0].length);
  }
  assert.equal(readBytes, sourceReadBytes, "zooming out and changing enabled channels perform no source reads");
  for (const prefix of prefixes) {
    for (const field of ["data", "minima", "maxima", "gaps", "variation"]) {
      assert.deepEqual(prefix[field][156], result.window[field][156].slice(0, prefix.data[0].length));
    }
  }
});

test("existing zoom controls use protected overviews without new buttons, modes, or filter overrides", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /wholeFileOverviewMode|setWholeFileOverviewMode|aria-label="Whole file"/);
  assert.match(page, /const canUseRecordingOverview\s*=\s*!filters\.enabled\s*&&\s*montage\s*===\s*"referential"/);
  assert.match(page, /const overviewRefreshRevision\s*=\s*canUseRecordingOverview\s*\?\s*recordingOverviewRevision\s*:\s*0/,
    "index progress must not cancel detailed reads that cannot use the coarse index");
  const refresh = page.slice(page.indexOf("const refreshWindow ="), page.indexOf("const spectrogramInputPlan"));
  assert.ok(refresh.indexOf("recordingOverviewDisplayWindow") < refresh.indexOf("sourceVerificationRef.current"),
    "already indexed data stays navigable while the remainder is verified");
  assert.match(page, /if \(verificationAbortController\.signal\.aborted\) return;\s*if \(recordingOverviewCacheRef\.current\.put/);
  assert.match(page, /fullOverviewPlan\?\.channelIndices\s*\?\?\s*\[\]/);
  assert.match(page, /onOverview:\s*publishRecordingOverview/);
  assert.match(page, /publishRecordingOverview\(result\.window, true\)/);
  assert.match(page, /Not indexed yet/);
  assert.match(page, /File validation is also in progress/);
});
