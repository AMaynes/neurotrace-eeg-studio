/*
Purpose: Parses and bounds recording-relative timestamp input.
File Dependencies: None.
*/


/** Parses a finite recording-relative time and rejects values outside its bounds. */
export function parseRecordingTimestamp(value: string): number | null {
  const fields = value.trim().split(":");
  if (fields.length > 3 || !fields.every((field, index) =>
    (index === fields.length - 1 ? /^(?:\d+(?:\.\d+)?|\.\d+)$/ : /^\d+$/).test(field))) {
    return null;
  }

  const amounts = fields.map(Number);
  // The leading field can exceed 59 (hours, total minutes, or total seconds).
  if (amounts.slice(1).some((amount) => amount >= 60)) return null;
  const seconds = amounts.reduce((total, amount) => total * 60 + amount, 0);
  return Number.isFinite(seconds) ? seconds : null;
}
