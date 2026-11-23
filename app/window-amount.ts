/** Compact window entry: one decimal place and at most three integer digits. */
export const MAX_WINDOW_AMOUNT = 999.9;
export const WINDOW_TIME_UNITS = ["ms", "s", "m", "hrs", "days"] as const;
export type WindowTimeUnit = typeof WINDOW_TIME_UNITS[number];
export const WINDOW_UNIT_SECONDS: Record<WindowTimeUnit, number> = { ms: .001, s: 1, m: 60, hrs: 3_600, days: 86_400 };
export const WINDOW_UNIT_LABELS: Record<WindowTimeUnit, string> = { ms: "ms", s: "sec", m: "min", hrs: "hrs", days: "days" };

const roundTenth = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

export function formatWindowAmount(value: number): string {
  return Number.isFinite(value) ? roundTenth(value).toFixed(1) : "";
}

/** Keep incomplete decimal typing editable; round pasted or typed extra precision. */
export function editWindowAmount(raw: string): string | null {
  if (!/^\d*(?:\.\d*)?$/.test(raw)) return null;
  const value = raw.replace(/^0+(?=\d)/, "");
  if (!value || value === ".") return value;
  if (Number(value) > MAX_WINDOW_AMOUNT) return formatWindowAmount(MAX_WINDOW_AMOUNT);
  return (value.split(".")[1]?.length ?? 0) > 1 ? formatWindowAmount(Number(value)) : value;
}

export function parseWindowAmount(raw: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_WINDOW_AMOUNT, Math.max(.1, roundTenth(value)));
}

/** A zoom or restored window can exceed 999.9 seconds without exceeding the field. */
export function windowAmountPresentation(seconds: number, preferred: WindowTimeUnit) {
  const unit = [preferred, ...WINDOW_TIME_UNITS].find(candidate => {
    const amount = roundTenth(seconds / WINDOW_UNIT_SECONDS[candidate]);
    return amount >= .1 && amount <= MAX_WINDOW_AMOUNT;
  }) ?? "days";
  return { unit, amount: formatWindowAmount(Math.min(MAX_WINDOW_AMOUNT, seconds / WINDOW_UNIT_SECONDS[unit])) };
}
