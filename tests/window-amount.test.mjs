/*
Purpose: Checks window amount behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/window-amount.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { editWindowAmount, formatWindowAmount, parseWindowAmount, windowAmountPresentation } from "../app/window-amount.ts";

test("window typing preserves incomplete decimals, rounds tenths, and caps three integer digits", () => {
  for (const [input, expected] of [
    ["", ""], [".", "."], ["20.", "20."], ["020", "20"], [".25", "0.3"],
    ["12.26", "12.3"], ["999.94", "999.9"], ["1000", "999.9"], ["9999", "999.9"],
  ]) assert.equal(editWindowAmount(input), expected, input);
  for (const input of ["-1", "1e3", "1.2.3", "sec", "Infinity"]) assert.equal(editWindowAmount(input), null, input);
});

test("applying a window accepts positive tenths and rejects invalid or empty entry", () => {
  for (const [input, expected] of [["1.25", 1.3], [".05", .1], ["20.", 20], ["9999", 999.9]]) {
    assert.equal(parseWindowAmount(input), expected, input);
    assert.match(formatWindowAmount(expected), /^\d{1,3}\.\d$/);
  }
  for (const input of ["", ".", "0", "-1", "NaN", "Infinity", "1e2"]) assert.equal(parseWindowAmount(input), null, input);
});

test("long and subsecond windows choose a fitting unit without changing their duration", () => {
  for (const [seconds, preferred, expected] of [
    [20, "s", { unit: "s", amount: "20.0" }],
    [1200, "s", { unit: "m", amount: "20.0" }],
    [.005, "s", { unit: "ms", amount: "5.0" }],
    [8640000, "s", { unit: "days", amount: "100.0" }],
    [7200, "hrs", { unit: "hrs", amount: "2.0" }],
  ]) assert.deepEqual(windowAmountPresentation(seconds, preferred), expected);
});
