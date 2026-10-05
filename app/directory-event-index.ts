/** Read-only, local label indexing. Runs in a worker; never opens a signal source or hashes recordings. */
import { indexMatRecordingLabels, parseEDFHeader, parseEdfTalText } from "./eeg-core.ts";
import { analyzeBidsCompanions } from "./bids-companions.ts";
import { readNeurotraceProjectArchive } from "./neurotrace-project.ts";
import type { DirectoryImportFormat } from "./directory-import.ts";

export interface DirectoryEventIndex {
  state: "ready" | "partial" | "error";
  labels: string[];
  warnings: string[];
}

export interface DirectoryEventRequest {
  format: DirectoryImportFormat;
  /** MAT companion for MAT+DAT; the DAT is never read by the indexer. */
  file: File;
  eventTables: File[];
}

export const COMMON_EVENT_KEYWORDS = [
  { name: "Seizure", query: "seizure, seiz, sz, tonic, EEG onset, ictal" },
  { name: "Spikes / sharp waves", query: "spike, sharp" },
  { name: "Artifact", query: "artifact, artefact" },
  { name: "Stimulation", query: "stim" },
  { name: "Medication", query: "medication, med given, drug" },
  { name: "Button press", query: "button, push" },
  { name: "Sleep", query: "sleep, NREM, REM" },
] as const;

/** Commas mean OR; spaces within a keyword remain a phrase. No regex or clinical inference. */
export function eventLabelMatches(labels: readonly string[], query: string): boolean {
  const terms = query.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
  return !terms.length || labels.some((label) => terms.some((term) => label.toLowerCase().includes(term)));
}

/** Partial/error results must never be presented as a confirmed non-match. */
export async function readDirectoryEventIndex(request: DirectoryEventRequest): Promise<DirectoryEventIndex> {
  const labels = new Set<string>();
  const warnings: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    if (labels.size >= 10000 && !labels.has(value.trim())) throw new Error("More than 10,000 distinct labels; search results are incomplete.");
    labels.add(value.trim());
  };
  const attempt = async (read: () => Promise<void>) => {
    try { await read(); } catch (error) { warnings.push(error instanceof Error ? error.message : "Event labels could not be checked."); }
  };

  async function recording(format: DirectoryImportFormat, file: File) {
    if (format === "mat" || format === "mat-dat") {
      const result = await indexMatRecordingLabels(file);
      warnings.push(...result.warnings);
      result.labels.forEach(add);
    } else if (format === "edf") {
      const header = await parseEDFHeader(file);
      const signals = header.signals.filter((signal) => signal.isAnnotation);
      const chunks: Array<Promise<ArrayBuffer>> = [];
      const flush = async () => {
        for (const bytes of await Promise.all(chunks)) parseEdfTalText(new TextDecoder().decode(bytes)).forEach((event) => add(event.label));
        chunks.length = 0;
      };
      // Read TAL byte ranges only, at most 16 small reads concurrently. Never
      // scan the interleaved waveform samples just to discover event text.
      for (let record = 0; signals.length && record < header.dataRecordCount; record += 1) {
        for (const signal of signals) {
          if (signal.samplesPerRecord * 2 > 1024 * 1024) throw new Error("EDF annotation record exceeds the 1 MiB background-search safety limit.");
          const start = header.headerBytes + record * header.bytesPerDataRecord + signal.byteOffsetInRecord;
          chunks.push(file.slice(start, start + signal.samplesPerRecord * 2).arrayBuffer());
          if (chunks.length >= 16) await flush();
        }
      }
      await flush();
    }
  }

  async function tables(files: File[], source?: File) {
    await attempt(async () => {
      const bundle = await analyzeBidsCompanions(files, { recordingFile: source });
      warnings.push(...bundle.warnings);
      for (const table of bundle.tables) {
        if (table.applied && !table.columns.includes("onset")) warnings.push(`${table.path}: event table has no onset column.`);
      }
      bundle.events.forEach((event) => add(event.label));
    });
  }

  await attempt(async () => {
    if (request.format !== "neurotrace") { await recording(request.format, request.file); return; }
    const project = await readNeurotraceProjectArchive(request.file, { labelDefinitions: true });
    const definitions = project.labelDefinitions as { labels?: Array<{ id?: string; name?: string }> } | null;
    const names = new Map(Array.isArray(definitions?.labels) ? definitions.labels
      .filter((label) => typeof label?.id === "string" && typeof label?.name === "string")
      .map((label) => [label.id, label.name]) : []);
    const review = project.review as { annotations?: unknown[]; candidates?: unknown[] } | null;
    for (const value of [...(Array.isArray(review?.annotations) ? review.annotations : []), ...(Array.isArray(review?.candidates) ? review.candidates : [])]) {
      if (!value || typeof value !== "object") continue;
      const item = value as { label?: string; labelId?: string; recordingLabel?: { label?: string } };
      add(item.label); add(item.recordingLabel?.label); add(names.get(item.labelId)); add(item.labelId);
    }
    const source = project.recordingFile;
    if (source) await attempt(async () => {
      if (/\.dat$/i.test(source.name)) {
        const companion = project.supportingFiles.find((file) => file.name.toLowerCase() === source.name.replace(/\.dat$/i, ".mat").toLowerCase());
        if (companion) await recording("mat-dat", companion);
        else warnings.push("Embedded DAT has no matching MAT event metadata; only saved review labels were checked.");
      } else if (/\.(edf|mat)$/i.test(source.name)) await recording(/\.edf$/i.test(source.name) ? "edf" : "mat", source);
      else warnings.push("The embedded recording's event format cannot be checked.");
    });
    const reference = source ?? (project.manifest.recording ? new File([], project.manifest.recording.name) : undefined);
    if (reference) await tables(project.supportingFiles.filter((file) => /(?:^|_)events\.tsv$/i.test(file.name)), reference);
    else if (project.supportingFiles.some((file) => /(?:^|_)events\.tsv$/i.test(file.name))) warnings.push("Project has no recording reference to associate event tables with.");
  });
  await tables(request.eventTables, request.format === "neurotrace" ? undefined : request.file);
  return { state: warnings.length ? labels.size ? "partial" : "error" : "ready", labels: [...labels].sort((a, b) => a.localeCompare(b)), warnings: [...new Set(warnings)] };
}
