/*
Purpose: Protects recording-info display contracts across unavailable values, unit boundaries, and source formats.
File Dependencies: app/file-read-utils.ts, app/recording-info.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionStart, formatByteCount, formatByteRate, formatMetricDuration,
  sourceReadProfile, estimatedDecodedSourceBytes } from "../app/recording-info.ts";
import { validatePositiveSafeInteger } from "../app/file-read-utils.ts";

/** Checks that source-clock formatting is independent of the local timezone. */
test("recording start retains the source UTC clock", () => {
  assert.equal(formatSessionStart(new Date("2024-06-19T13:28:00Z")), "Jun 19, 13:28 source clock");
  assert.equal(formatSessionStart(), "Not provided");
});

/** Checks missing values and the existing binary-unit labels at size boundaries. */
test("resource sizes retain their unavailable, rounding, and unit contracts", () => {
  for (const missing of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(formatByteCount(missing), "Unavailable");
  }
  for (const [bytes, expected] of [[-2, "0 B"], [1023, "1023 B"], [1024, "1.00 KB"],
    [10 * 1024, "10.0 KB"], [100 * 1024, "100 KB"], [1024 ** 2, "1.00 MB"],
    [1024 ** 3, "1.00 GB"], [1024 ** 4, "1.00 TB"]]) {
    assert.equal(formatByteCount(bytes), expected);
  }
  assert.equal(formatByteRate(0), "—");
  assert.equal(formatByteRate(NaN), "—");
  assert.equal(formatByteRate(1024), "1.00 KB/s");
  // Preserve the existing nonfinite-positive throughput text during cleanup.
  assert.equal(formatByteRate(Infinity), "Unavailable/s");
});

/** Checks precision transitions without silently changing measurement units. */
test("resource durations preserve precision at millisecond, second, and minute boundaries", () => {
  for (const [duration, expected] of [[null, "Unavailable"], [NaN, "Unavailable"],
    [0.125, "0.13 ms"], [1, "1.0 ms"], [10, "10 ms"], [999, "999 ms"],
    [1000, "1.00 s"], [60000, "1.0 min"]]) {
    assert.equal(formatMetricDuration(duration), expected);
  }
});

/** Checks the distinction between retained MAT matrices and file-backed sources. */
test("source descriptions and retained-matrix estimates follow the recording format", () => {
  assert.equal(sourceReadProfile("edf", false).origin, "No recording loaded");
  assert.match(sourceReadProfile("edf+", true).access, /EDF record slices/);
  assert.match(sourceReadProfile("raw-int16-le", true).access, /DAT frame slices/);
  assert.match(sourceReadProfile("mat-v7.3", true).access, /HDF5 dataset slices/);
  assert.match(sourceReadProfile("mat-v5", true).access, /matrix in memory/);
  const meta = { format: "mat-v5", durationSec: 1.25, sampleRates: [200, 125] };
  assert.equal(estimatedDecodedSourceBytes(meta), (250 + 157) * 4);
  assert.equal(estimatedDecodedSourceBytes({ ...meta, format: "edf" }), 0);
});

/** Checks the shared decoder guard retains its exact error type and field text. */
test("file decoder integer guards reject unsafe and nonpositive values", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePositiveSafeInteger(value, "Frame count"),
      { name: "RangeError", message: "Frame count must be a positive safe integer." });
  }
  assert.equal(validatePositiveSafeInteger(1, "Frame count"), undefined);
  assert.equal(validatePositiveSafeInteger(Number.MAX_SAFE_INTEGER, "Frame count"), undefined);
});
