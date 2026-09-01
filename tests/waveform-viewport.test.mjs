import assert from "node:assert/strict";
import test from "node:test";

import {
  composeVerticalViewport,
  panVerticalViewport,
  projectVerticalFraction,
  unprojectVerticalFraction,
} from "../app/waveform-viewport.ts";

test("fits a dragged vertical box to the complete waveform height", () => {
  const firstZoom = composeVerticalViewport(null, { top: 0.25, bottom: 0.75 });
  assert.deepEqual(firstZoom, { top: 0.25, bottom: 0.75 });
  assert.equal(projectVerticalFraction(0.25, firstZoom), 0);
  assert.equal(projectVerticalFraction(0.5, firstZoom), 0.5);
  assert.equal(projectVerticalFraction(0.75, firstZoom), 1);

  const nestedZoom = composeVerticalViewport(firstZoom, { top: 0.2, bottom: 0.8 });
  assert.deepEqual(nestedZoom, { top: 0.35, bottom: 0.65 });
  assert.equal(unprojectVerticalFraction(0.5, nestedZoom), 0.5);
});

test("pans a box-zoomed waveform vertically without changing its zoom", () => {
  const viewport = { top: 0.25, bottom: 0.5 };
  assert.deepEqual(panVerticalViewport(viewport, 0.5), { top: 0.375, bottom: 0.625 });
  assert.deepEqual(panVerticalViewport(viewport, -10), { top: 0, bottom: 0.25 });
  assert.deepEqual(panVerticalViewport(viewport, 10), { top: 0.75, bottom: 1 });
  assert.throws(() => panVerticalViewport(viewport, Number.NaN), /pan must be finite/i);
});

test("rejects empty or out-of-bounds vertical boxes", () => {
  assert.throws(() => composeVerticalViewport(null, { top: 0.5, bottom: 0.5 }), /non-empty normalized/i);
  assert.throws(() => composeVerticalViewport(null, { top: -0.1, bottom: 0.5 }), /non-empty normalized/i);
  assert.throws(() => projectVerticalFraction(0.5, { top: 0, bottom: 2 }), /non-empty normalized/i);
});
