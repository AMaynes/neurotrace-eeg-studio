/** Explicit scalp pairs; electrode names are never paired by a numeric suffix. */
export type BipolarMontageKind = "scalp" | "anatomical" | "mixed" | "unavailable";

export const ANATOMICAL_EXCLUDED_GROUPS = new Set([
  "DC", "MARK", "E", "C", "EX", "F", "REF", "GND", "ECG", "EKG", "EMG",
  "EOG", "TRIG", "SYNC", "AUX", "STI",
]);

// ACNS Guideline 3, longitudinal bipolar LB-18.3. The left label is the
// positive input: Fp1-F7 means Fp1 minus F7. Legacy temporal names are aliases.
// https://www.acns.org/UserFiles/file/EEGGuideline3Montage.pdf
const SCALP_CHAINS = [
  ["Fp1", "F7", "T7", "P7", "O1"],
  ["Fp2", "F8", "T8", "P8", "O2"],
  ["Fp1", "F3", "C3", "P3", "O1"],
  ["Fp2", "F4", "C4", "P4", "O2"],
  ["Fz", "Cz", "Pz"],
] as const;

const SCALP_NAMES = new Map(SCALP_CHAINS.flat().map((name) => [name.toUpperCase(), name]));
const TEMPORAL_ALIASES: Readonly<Record<string, string>> = { T3: "T7", T4: "T8", T5: "P7", T6: "P8" };
const SCALP_AUXILIARY_NAMES = new Set(["FPZ", "OZ", "IZ", "FCZ", "CPZ", "A1", "A2", "M1", "M2", "T1", "T2", "PG1", "PG2", "SPO2", "ETCO2"]);

/** Only a leading EEG token and case are normalized; derived/reference labels are not guessed. */
export function canonicalScalpElectrode(label: string): string | null {
  const key = label.trim().replace(/^EEG\s+/i, "").toUpperCase();
  return TEMPORAL_ALIASES[key] ?? SCALP_NAMES.get(key) ?? null;
}

/** Classify the complete recording, so hiding a channel cannot select another montage family. */
export function bipolarMontageKind(labels: readonly string[]): BipolarMontageKind {
  let scalp = false;
  let anatomical = false;
  for (const label of labels) {
    if (canonicalScalpElectrode(label)) {
      scalp = true;
      continue;
    }
    // Classification may notice a prefixed depth name, but anatomical pairing
    // still uses the original MATLAB acceptance rules in eeg-core.
    const plain = label.trim().replace(/^(?:EEG|SEEG)\s+/i, "");
    if (SCALP_AUXILIARY_NAMES.has(plain.toUpperCase())) continue;
    const contact = /^([A-Za-z]+)\d+$/.exec(plain);
    if (contact && !ANATOMICAL_EXCLUDED_GROUPS.has(contact[1].toUpperCase())) anatomical = true;
  }
  return scalp && anatomical ? "mixed" : scalp ? "scalp" : anatomical ? "anatomical" : "unavailable";
}

export function bipolarMontageLabel(labels: readonly string[]): string {
  const kind = bipolarMontageKind(labels);
  return kind === "scalp" ? "Longitudinal bipolar"
    : kind === "anatomical" ? "Anatomical bipolar"
      : "Bipolar (unavailable)";
}

export interface BipolarPair {
  first: number;
  second: number;
  label: string;
}

export function scalpBipolarPairs(labels: readonly string[]): { pairs: BipolarPair[]; warnings: string[] } {
  const electrodes = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const name = canonicalScalpElectrode(label);
    if (name) electrodes.set(name, [...(electrodes.get(name) ?? []), index]);
  });
  const pairs: BipolarPair[] = [];
  const unavailable: string[] = [];
  const ambiguous = [...electrodes].filter(([, indices]) => indices.length > 1).map(([name]) => name);
  for (const chain of SCALP_CHAINS) {
    for (let index = 1; index < chain.length; index += 1) {
      const first = electrodes.get(chain[index - 1]);
      const second = electrodes.get(chain[index]);
      const label = `${chain[index - 1]}-${chain[index]}`;
      if (first?.length === 1 && second?.length === 1) pairs.push({ first: first[0], second: second[0], label });
      else unavailable.push(label);
    }
  }
  const warnings: string[] = [];
  if (ambiguous.length) warnings.push(`Ambiguous scalp electrodes (${ambiguous.join(", ")}) have duplicate labels or aliases; their bipolar pairs were omitted.`);
  if (unavailable.length) warnings.push(`Longitudinal bipolar omitted ${unavailable.length} pairs with missing or ambiguous electrodes: ${unavailable.join(", ")}.`);
  return { pairs, warnings };
}
