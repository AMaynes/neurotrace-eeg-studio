import assert from "node:assert/strict";
import test from "node:test";

import { adaptiveTimeGridInterval, timeGridLineBudget } from "../app/time-grid.ts";

test("candidate-relative views retain one-second ticks through 30 seconds", () => {
  for (const durationSec of [0.001, 1, 10, 29.999, 30]) {
    assert.equal(adaptiveTimeGridInterval(durationSec, { candidateRelative: true }), 1);
  }
});

test("candidate-relative views become adaptive beyond 30 seconds", () => {
  assert.equal(adaptiveTimeGridInterval(30.001, { candidateRelative: true }), 2);
  assert.equal(adaptiveTimeGridInterval(60, { candidateRelative: true }), 2.5);
  assert.equal(adaptiveTimeGridInterval(3_600, { candidateRelative: true }), 200);
  assert.equal(adaptiveTimeGridInterval(86_400, { candidateRelative: true }), 5_000);
});

test("absolute grids use only nice 1, 2, 2.5, 5, or 10 decade intervals", () => {
  const allowedMantissas = new Set([1, 2, 2.5, 5, 10]);
  for (const durationSec of [0.003, 0.5, 20, 31, 300, 3_600, 43_200, 86_400]) {
    const interval = adaptiveTimeGridInterval(durationSec);
    const magnitude = 10 ** Math.floor(Math.log10(interval));
    const mantissa = interval / magnitude;
    assert.ok(allowedMantissas.has(mantissa), `${interval} is not a nice interval`);
  }
});

test("wide hour and day views stay at roughly 24 grid lines or fewer", () => {
  for (const durationSec of [3_600, 7_200, 21_600, 43_200, 86_400, 604_800]) {
    for (const candidateRelative of [false, true]) {
      const interval = adaptiveTimeGridInterval(durationSec, { candidateRelative });
      // One additional line can appear where the stable anchor lands inside
      // the viewport rather than exactly on its left edge.
      assert.ok(Math.ceil(durationSec / interval) + 1 <= 25);
    }
  }
});

test("interval selection is independent of pan position and supports a custom cap", () => {
  const durationSec = 12_345;
  const first = adaptiveTimeGridInterval(durationSec, { candidateRelative: true });
  const afterPan = adaptiveTimeGridInterval(durationSec, { candidateRelative: true });
  assert.equal(first, afterPan);

  const capped = adaptiveTimeGridInterval(3_600, { targetGridLines: 12 });
  assert.equal(capped, 500);
  assert.ok(Math.ceil(3_600 / capped) <= 12);
});

test("invalid or empty durations return a safe finite interval", () => {
  for (const durationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(adaptiveTimeGridInterval(durationSec), 1);
  }
});

test("measured label widths reduce grid density before time labels can touch", () => {
  const viewportWidthPx = 874;
  const labelWidthPx = 48;
  const targetGridLines = timeGridLineBudget(viewportWidthPx, labelWidthPx);
  const durationSec = 3_400;
  const intervalSec = adaptiveTimeGridInterval(durationSec, { targetGridLines });
  const renderedSpacingPx = intervalSec / durationSec * viewportWidthPx;

  assert.equal(targetGridLines, 14);
  assert.ok(renderedSpacingPx >= labelWidthPx + 12);
  assert.equal(timeGridLineBudget(2_000, labelWidthPx), 24);
});

test("grid line budgets retain safe defaults for invalid canvas measurements", () => {
  assert.equal(timeGridLineBudget(Number.NaN, 48), 24);
  assert.equal(timeGridLineBudget(800, Number.NaN), 24);
  assert.equal(timeGridLineBudget(120, 48), 2);
  assert.equal(timeGridLineBudget(800, 48, { minimumLabelGapPx: 32, maximumGridLines: 8 }), 8);
});
