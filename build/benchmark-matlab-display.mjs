import { performance } from 'node:perf_hooks';
import { buildMatlabDisplayWindow } from '../app/matlab-display-window.ts';
import { BrowserWorker } from '../tests/fixtures/browser-worker.mjs';
import { createMatlabDisplayTileCache } from '../app/matlab-display-tiles.ts';
globalThis.Worker = BrowserWorker;
const channels = 200, fs = 50, full = 70 * 3600, duration = 10 * 3600;
const labels = Array.from({ length: channels }, (_, i) => `LA${i + 1}`);
const pattern = new Float64Array(8192);
let rng = 123456789;
for (let i = 0; i < pattern.length; i++) {
  rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
  pattern[i] = (rng >>> 0) / 4294967296 * 100 - 50 + 20 * Math.sin(i * .2);
}
let reads = 0, generated = 0, generateMs = 0;
const source = {
  meta: { channelCount: channels, channelLabels: labels, channelUnits: labels.map(() => 'µV'), sampleRates: labels.map(() => fs), durationSec: full },
  async getWindow(start, span, selected, options = {}) {
    options.signal?.throwIfAborted();
    const t = performance.now(), first = Math.floor(start * fs), count = Math.min(Math.ceil(span * fs), full * fs - first);
    const data = selected.map(ch => {
      const a = new Float64Array(count);
      for (let i = 0; i < count; i++) a[i] = pattern[(first + i + ch * 37) & 8191] + ch * .01;
      return a;
    });
    reads++; generated += count * selected.length; generateMs += performance.now() - t;
    return { data, sampleRates: selected.map(() => fs), channelStartSecs: selected.map(() => first / fs), startSec: start, durationSec: span, channelIndices: [...selected], channelLabels: selected.map(i => labels[i]), channelUnits: selected.map(() => 'µV') };
  },
};
console.log(JSON.stringify({ kind: 'synthetic_processing_only', channels, sampleRate: fs, recordingHours: 70, windowHours: 10, equivalentInt16RecordingGB: channels * fs * full * 2 / 1e9, windowInputSamples: channels * fs * duration }));
const cache = createMatlabDisplayTileCache();
for (const [name, start, width, useCache] of [
  ['uncached-single-worker',18000,2000,false], ['first-index',18000,2000,true],
  ['pan-one-minute',18060,2000,true], ['zoom',18060,1000,true],
  ['new-sample-phase',18060.02,2000,true], ['cached-phase-pan',18060.06,2000,true],
]) {
  reads=0; generated=0; generateMs=0;
  const started=performance.now(); let firstPaint;
  const result=await buildMatlabDisplayWindow({source,startSec:start,durationSec:duration,pixelWidth:width,channelIndices:labels.map((_,i)=>i),montage:'referential'}, {
    fallbackToMainThread:false, workerCount:useCache?4:1, cache:useCache?cache:undefined,
    maxChunkBytes:(useCache?8:2)*1024*1024, maxChunkDurationSec:useCache?120:30,
    onPartial(){ firstPaint ??= performance.now()-started; }
  });
  console.log(JSON.stringify({name,elapsedMs:performance.now()-started,firstPaintMs:firstPaint,reads,generated,generateMs,cacheBytes:cache.byteLength,retainedBytes:result.byteLength,points:result.data[0].length}));
}
