import assert from "node:assert/strict";
import test from "node:test";
import { matlabSampleSnap, matlabSampleTime } from "../app/matlab-timing.ts";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("MATLAB timestamps start at 1/Fs and decimation retains local samples 1, 3, 5", () => {
  for (const rate of [200, 256, 1000]) for (const start of [0, .0073, 13574.1234]) {
    near(matlabSampleTime(start, rate, 0), start + 1 / rate);
    near(matlabSampleTime(start, rate, 1), start + 2 / rate);
    near(matlabSampleTime(start, rate, 0, 2), start + 1 / rate);
    near(matlabSampleTime(start, rate, 1, 2), start + 3 / rate);
    near(matlabSampleTime(start, rate, 2, 2), start + 5 / rate);
  }
});

test("fractional starts retain their own plotting origin instead of snapping to the absolute source grid", () => {
  near(matlabSampleSnap(.0102, .0073, 1000, 2), .0103);
  near(matlabSampleSnap(.0082, .0073, 1000, 2), .0083);
  near(matlabSampleSnap(.0095, .0073, 1000), .0093);
  near(matlabSampleSnap(.0095, .0073, 1000, 2), .0103);
  assert.notEqual(matlabSampleSnap(.0102, .0073, 1000, 2), Math.round(.0102 * 1000) / 1000);
});

test("an odd first source index is not moved to the global even decimation phase", () => {
  // Request .007 begins with source sample 7; retained samples are 7, 9, 11,
  // while MATLAB draws them at .008, .010, .012, respectively.
  const firstSourceIndex = 7;
  for (let index = 0; index < 3; index++) {
    const sourceIndex = firstSourceIndex + index * 2;
    assert.equal(sourceIndex % 2, 1);
    near(matlabSampleTime(.007, 1000, index, 2), sourceIndex / 1000 + .001);
    near(matlabSampleSnap(matlabSampleTime(.007, 1000, index, 2), .007, 1000, 2), matlabSampleTime(.007, 1000, index, 2));
  }
});

test("sample snapping is stable at grid points and leaves recording bounds to callers", () => {
  for (const rate of [200, 256, 1000]) for (const factor of [1, 2]) {
    for (const index of [0, 1, 100, 999]) {
      const time = matlabSampleTime(13574.1234, rate, index, factor);
      near(matlabSampleSnap(time, 13574.1234, rate, factor), time);
    }
  }
  near(matlabSampleSnap(-1, 0, 200), -1);
});

test("invalid grid metadata cannot produce misleading MATLAB timestamps", () => {
  for (const rate of [0, -1, NaN, Infinity]) {
    assert.throws(() => matlabSampleTime(0, rate, 0), RangeError);
    assert.throws(() => matlabSampleSnap(0, 0, rate), RangeError);
  }
  for (const factor of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => matlabSampleTime(0, 200, 0, factor), RangeError);
    assert.throws(() => matlabSampleSnap(0, 0, 200, factor), RangeError);
  }
  for (const index of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => matlabSampleTime(0, 200, index, 2), RangeError);
  }
  assert.throws(() => matlabSampleTime(NaN, 200, 0), RangeError);
  assert.throws(() => matlabSampleSnap(Infinity, 0, 200), RangeError);
  assert.throws(() => matlabSampleSnap(0, NaN, 200), RangeError);
});
