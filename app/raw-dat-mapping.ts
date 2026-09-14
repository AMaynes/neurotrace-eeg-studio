/** Confirmation helpers for headerless, channel-interleaved int16 recordings. */
export function parseRawDatChannelNames(text: string): string[] {
  if (!text.trim()) return [];
  // Accept one name per line, including MATLAB's displayed {'contact'} cells.
  // Never sort or drop an interior blank: positions identify binary channels.
  return text.trim().split(/\r?\n|\t/).map((line, index) => {
    let name = line.trim();
    if (name.startsWith("{") && name.endsWith("}")) name = name.slice(1, -1).trim();
    if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
      const quote = name[0];
      name = name.slice(1, -1).replaceAll(quote + quote, quote).trim();
    }
    if (!name) throw new Error(`Channel ${index + 1} has no name. Enter a placeholder to preserve channel order.`);
    return name;
  });
}

/** Size confirms frame alignment, not that the declared rate/count is correct. */
export function describeRawDatLayout(byteLength: number, channelCount: number, sampleRate: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0
    || !Number.isSafeInteger(channelCount) || channelCount <= 0
    || !Number.isSafeInteger(channelCount * 2)
    || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const bytesPerFrame = channelCount * 2;
  const frames = Math.floor(byteLength / bytesPerFrame);
  return { frames, durationSec: frames / sampleRate, trailingBytes: byteLength % bytesPerFrame };
}
