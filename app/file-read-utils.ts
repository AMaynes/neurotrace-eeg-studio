/*
Purpose: Supplies common clock and integer-validation operations for bounded file decoders.
File Dependencies: None.
*/


/** Returns monotonic milliseconds when available, otherwise wall-clock milliseconds. */
export function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Rejects nonpositive or unsafe integers with the caller-provided field name. */
export function validatePositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}
