/**
 * Resolves local MAT/DAT imports for the recording dialog. Legacy sessionInfo
 * metadata configures a separate binary source; standalone MAT signals keep
 * their existing decoder. Acquisition paths inside metadata are never used.
 */

import { inspectMatRecording, type LegacyMatMetadata, type SignalSource } from "./eeg-core.ts";
import { relativeFilePath } from "./bids-companions.ts";

type ImportDiagnostics = {
  format: "legacy-mat-dat" | "standalone-mat" | "raw-dat";
  sampleRate: number | null;
  channelCount: number | null;
  channelLabelCount: number;
};

export type MatDatImport = (
  | { kind: "standalone-mat"; file: File; source: SignalSource }
  | { kind: "legacy-dat"; file: File; mat: File; metadata: LegacyMatMetadata; metadataIssue: string | null }
  | { kind: "raw-dat"; file: File; metadataError?: string }
) & { diagnostics: ImportDiagnostics };

/** User-actionable import failures, without generic invalid-header advice. */
export class MatDatImportError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = "MatDatImportError";
    this.title = title;
  }
}

/** Reuse staged companions only for the same recording, never an unrelated new selection. */
export function pendingFilesForSelection(pending: readonly File[], incoming: readonly File[]): File[] {
  const recordingKey = (file: File) => file.name.replace(/\.(mat|dat)$/i, "").toLowerCase();
  const directory = (file: File) => relativeFilePath(file).replace(/[^/]*$/, "").toLowerCase();
  const continuesPending = incoming.some((file) => /\.(mat|dat)$/i.test(file.name) && pending.some((staged) =>
    /\.(mat|dat)$/i.test(staged.name) && recordingKey(file) === recordingKey(staged) &&
    (!directory(file) || !directory(staged) || directory(file) === directory(staged)),
  ));
  return continuesPending ? [...pending] : [];
}

/**
 * Matches case-insensitive basenames, preferring siblings in a selected folder.
 * Multiple equally plausible matches require the user to select an exact pair.
 */
export function findMatDatCompanion(file: File, files: readonly File[], extension: "mat" | "dat"): File | null {
  const stem = file.name.replace(/\.(mat|dat)$/i, "").toLowerCase();
  const expected = `${stem}.${extension}`;
  const matches = files.filter((candidate) => candidate.name.toLowerCase() === expected);
  const directory = relativeFilePath(file).replace(/[^/]*$/, "").toLowerCase();
  const siblings = matches.filter((candidate) =>
    relativeFilePath(candidate).replace(/[^/]*$/, "").toLowerCase() === directory,
  );
  const preferred = siblings.length ? siblings : matches;
  if (preferred.length > 1) {
    throw new MatDatImportError("Ambiguous MAT + DAT pair", "More than one matching companion was selected. Choose only the MAT and DAT for this recording, or select their containing folder.");
  }
  return preferred[0] ?? null;
}

/** Returns mapping problems without guessing missing values or dropping labels. */
export function legacyMetadataIssue(metadata: LegacyMatMetadata): string | null {
  const issues: string[] = [];
  if (metadata.sampleRate === undefined) issues.push("sessionInfo.sFile.header.sample_rate is missing or is not a positive real scalar.");
  if (metadata.channelCount === undefined) issues.push("sessionInfo.sFile.header.num_channels is missing or is not a positive whole-number scalar.");
  if (metadata.channelCount !== undefined && metadata.channelEntryCount !== undefined && metadata.channelEntryCount !== metadata.channelCount) {
    issues.push(`Legacy EEG MAT metadata reports ${metadata.channelCount} channels but sessionInfo.ChannelMat.Channel contains ${metadata.channelEntryCount} entries.`);
  }
  if (!metadata.channelLabels.length) issues.push("sessionInfo.ChannelMat.Channel.Name contains no channel names.");
  else if (metadata.channelCount !== undefined && metadata.channelLabels.length !== metadata.channelCount) {
    issues.push(`Legacy EEG MAT metadata reports ${metadata.channelCount} channels but ${metadata.channelLabels.length} channel labels were found.`);
  }
  return issues.length ? `${issues.join(" ")} Correct and confirm the DAT mapping before opening.` : null;
}

/**
 * Classifies MAT contents before signal-matrix selection. A true standalone MAT
 * remains standalone even when a same-named DAT is supplied. Returned diagnostics
 * contain counts only, never filenames, channel names, events, or patient fields.
 */
export async function resolveMatDatImport(
  primary: File,
  files: readonly File[],
  inspect: typeof inspectMatRecording = inspectMatRecording,
): Promise<MatDatImport> {
  const primaryIsMat = /\.mat$/i.test(primary.name);
  const mat = primaryIsMat ? primary : findMatDatCompanion(primary, files, "mat");
  if (!mat) {
    return { kind: "raw-dat", file: primary, diagnostics: { format: "raw-dat", sampleRate: null, channelCount: null, channelLabelCount: 0 } };
  }
  let inspected: Awaited<ReturnType<typeof inspectMatRecording>>;
  try {
    inspected = await inspect(mat);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The MAT contents could not be decoded.";
    if (!primaryIsMat) {
      return {
        kind: "raw-dat", file: primary,
        metadataError: `Companion MAT could not be read: ${detail} The DAT can still be opened after you confirm its mapping manually.`,
        diagnostics: { format: "raw-dat", sampleRate: null, channelCount: null, channelLabelCount: 0 },
      };
    }
    throw new MatDatImportError("MAT file could not be read", `Unable to parse this MAT as a standalone EEG recording or legacy metadata. ${detail}`);
  }
  if (inspected.kind === "standalone") {
    const { source } = inspected;
    return {
      kind: "standalone-mat", file: mat, source,
      diagnostics: { format: "standalone-mat", sampleRate: source.meta.sampleRate, channelCount: source.meta.channelCount, channelLabelCount: source.meta.channelLabels.length },
    };
  }
  const dat = primaryIsMat ? findMatDatCompanion(mat, files, "dat") : primary;
  if (!dat) {
    throw new MatDatImportError("Legacy MAT needs its DAT file", `This MAT contains legacy EEG metadata, not the waveform. Add the matching ${mat.name.replace(/\.mat$/i, ".dat")} file. The MAT is kept here so you can add the DAT separately.`);
  }
  const { metadata } = inspected;
  return {
    kind: "legacy-dat", file: dat, mat, metadata, metadataIssue: legacyMetadataIssue(metadata),
    diagnostics: { format: "legacy-mat-dat", sampleRate: metadata.sampleRate ?? null, channelCount: metadata.channelCount ?? null, channelLabelCount: metadata.channelLabels.length },
  };
}
