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
  // Matches target_evs in seizure_annotation_tool_update.m.
  { name: "Seizure", query: "sz, seizure, seiz, tonic, EEG onset" },
  { name: "Spikes / sharp waves", query: "spike, sharp" },
  { name: "Artifact", query: "artifact, artefact" },
  { name: "Stimulation", query: "stim" },
  { name: "Medication", query: "medication, med given, drug" },
  { name: "Button press", query: "button, push" },
  { name: "Sleep", query: "sleep, NREM, REM" },
] as const;

/** Commas mean OR; spaces within a keyword remain a phrase. No regex or clinical inference. */
export function eventKeywords(query: string): string[] {
  const seen = new Set<string>();
  return query.split(",").map((term) => term.trim()).filter((term) => {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Normalize the search once, like MATLAB's tgt_lower, not once per session. */
export function createEventLabelMatcher(query: string): (labels: readonly string[]) => boolean {
  const terms = eventKeywords(query).map((term) => term.toLowerCase());
  return (labels) => !terms.length || labels.some((label) => {
    const lower = label.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
}

export function eventLabelMatches(labels: readonly string[], query: string): boolean {
  return createEventLabelMatcher(query)(labels);
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
      const maxBytes = 4 * 1024 * 1024;
      const decoder = new TextDecoder();
      const parse = (bytes: Uint8Array) => {
        // TAL records are zero-padded. Avoid decoding and splitting megabytes
        // of empty strings; only trailing padding is removed, never interior TALs.
        let end = bytes.length;
        while (end && bytes[end - 1] === 0) end -= 1;
        if (end) parseEdfTalText(decoder.decode(bytes.subarray(0, end))).forEach((event) => add(event.label));
      };
      for (const signal of signals) {
        if (signal.samplesPerRecord * 2 > 1024 * 1024) throw new Error("EDF annotation record exceeds the 1 MiB background-search safety limit.");
      }
      const annotationBytes = signals.reduce((sum, signal) => sum + signal.samplesPerRecord * 2, 0);
      // Dense annotation layouts benefit from sequential disk reads. Bound both
      // memory and read amplification (<=4x); signal bytes are never decoded.
      if (annotationBytes >= header.bytesPerDataRecord / 4 && header.bytesPerDataRecord <= maxBytes) {
        const perChunk = Math.max(1, Math.floor(maxBytes / header.bytesPerDataRecord));
        for (let record = 0; record < header.dataRecordCount; record += perChunk) {
          const count = Math.min(perChunk, header.dataRecordCount - record);
          const start = header.headerBytes + record * header.bytesPerDataRecord;
          const bytes = new Uint8Array(await file.slice(start, start + count * header.bytesPerDataRecord).arrayBuffer());
          if (bytes.length !== count * header.bytesPerDataRecord) throw new Error("Truncated EDF annotation data.");
          for (let local = 0; local < count; local += 1) for (const signal of signals) {
            const offset = local * header.bytesPerDataRecord + signal.byteOffsetInRecord;
            parse(bytes.subarray(offset, offset + signal.samplesPerRecord * 2));
          }
        }
        return;
      }
      const chunks: Blob[] = [];
      let batchBytes = 0;
      const flush = async () => {
        if (!chunks.length) return;
        // A composite Blob batches sparse annotation ranges into one browser
        // read, without fetching intervening EEG samples or joining TAL records.
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        if (bytes.length !== batchBytes) throw new Error("Truncated EDF annotation data.");
        let offset = 0;
        for (const chunk of chunks) { parse(bytes.subarray(offset, offset + chunk.size)); offset += chunk.size; }
        chunks.length = 0;
        batchBytes = 0;
      };
      for (let record = 0; signals.length && record < header.dataRecordCount; record += 1) {
        for (const signal of signals) {
          const size = signal.samplesPerRecord * 2;
          if (chunks.length >= 256 || batchBytes + size > maxBytes) await flush();
          const start = header.headerBytes + record * header.bytesPerDataRecord + signal.byteOffsetInRecord;
          const chunk = file.slice(start, start + size);
          if (chunk.size !== size) throw new Error("Truncated EDF annotation data.");
          chunks.push(chunk);
          batchBytes += size;
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
