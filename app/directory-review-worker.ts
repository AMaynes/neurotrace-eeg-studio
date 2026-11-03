/** Explicit resume reads event metadata only; DAT samples are never sent to this worker. */
import { EDFSource, indexMatReviewEvents } from "./eeg-core.ts";
import type { DirectoryImportFormat } from "./directory-import.ts";
import type { ReviewMetadata } from "./directory-review-resume.ts";

export async function readDirectoryReviewMetadata(format: DirectoryImportFormat, file: File, datBytes?: number): Promise<ReviewMetadata> {
  if (format === "edf") {
    const source = await EDFSource.create(file);
    const rate = source.meta.sampleRates[0];
    return { events: source.events, sampleRate: source.meta.sampleRates.every(value => value === rate) ? rate : undefined,
      channelCount: source.meta.channelCount, durationSec: source.meta.durationSec,
      warnings: source.meta.details?.discontinuous ? ["Discontinuous EDF timing needs conversion before CSV resume."]
        : !source.meta.sampleRates.every(value => value === rate) ? ["Mixed sampling rates cannot be represented by the MATLAB review CSV."] : [] };
  }
  const metadata = await indexMatReviewEvents(file);
  if (!metadata.sampleRate || !metadata.channelCount) throw new Error("Acquisition rate/channel metadata is incomplete; open this recording to check it.");
  return { ...metadata, durationSec: datBytes === undefined ? undefined : Math.floor(datBytes / (metadata.channelCount * 2)) / metadata.sampleRate,
    warnings: metadata.warnings.filter(warning => !warning.startsWith("No sessionInfo.ChannelMat.Channel.Name")) };
}

if (typeof self !== "undefined" && typeof document === "undefined") self.onmessage = async (event: MessageEvent<{ format: DirectoryImportFormat; file: File; datBytes?: number }>) => {
  try { self.postMessage({ metadata: await readDirectoryReviewMetadata(event.data.format, event.data.file, event.data.datBytes) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Could not read resume metadata." }); }
};
