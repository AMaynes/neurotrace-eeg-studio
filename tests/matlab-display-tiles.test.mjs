import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMatlabDisplayWindow } from '../app/matlab-display-window.ts';
import { createMatlabDisplayTileCache } from '../app/matlab-display-tiles.ts';
import { filterMatlabDisplayTrace } from '../app/matlab-display-processing.ts';
import { buildMontage, detectRawSynchronizedFlatlines } from '../app/eeg-core.ts';
import { detectMatlabTileFlatlines, createMatlabRawFlatlineDetector } from '../app/matlab-raw-flatlines.ts';

function fixture(rate = 200) {
  const labels = ['LA1', 'LA2', 'LA3'];
  const arrays = labels.map((_, ch) => Float64Array.from({ length: Math.floor(400 * rate) }, (_, i) =>
    (i >= 4000 && i <= 9000) || (i >= 23011 && i <= 23170) ? 3 + ch : Math.sin(i * .231 + ch) * 34 + Math.cos(i * .003) * 100));
  arrays[1][17001] = NaN;
  return {
    arrays, reads: 0, valuesRead: 0,
    meta: { channelCount: 3, channelLabels: labels, channelUnits: labels.map(() => 'µV'), sampleRates: labels.map(() => rate), durationSec: arrays[0].length / rate },
    async getWindow(start, duration, indices, options) {
      options.signal?.throwIfAborted();
      const first = Math.floor(start * rate), end = Math.min(arrays[0].length, first + Math.ceil(duration * rate));
      this.reads++; this.valuesRead += (end - first) * indices.length;
      return { data: indices.map(ch => arrays[ch].slice(first, end)), sampleRates: indices.map(() => rate),
        channelIndices: [...indices], channelStartSecs: indices.map(() => first / rate) };
    },
  };
}
const options = { fallbackToMainThread: true, maxChunkDurationSec: 8 };
const request = (source, startSec = 1.003, durationSec = 300, montage = 'referential', pixelWidth = 100) =>
  ({ source, startSec, durationSec, montage, pixelWidth, channelIndices: [2, 0, 1] });

function verify(source, req, result) {
  const rate = source.meta.sampleRates[0], first = Math.floor(req.startSec * rate);
  const count = Math.max(0, Math.min(Math.floor(req.durationSec * rate), source.arrays[0].length - first));
  const raw = req.channelIndices.map(ch => source.arrays[ch].slice(first, first + count));
  const filtered = raw.map(values => filterMatlabDisplayTrace(values, 2));
  const labels = req.channelIndices.map(ch => source.meta.channelLabels[ch]);
  const expected = buildMontage(filtered, labels, req.montage, new Set(), filtered.map(() => rate / 2), filtered.map(() => req.startSec + 1 / rate),
    { allChannelLabels: source.meta.channelLabels, sourceChannelIndices: req.channelIndices, channelUnits: labels.map(() => 'µV') });
  assert.deepEqual(result.labels, expected.labels);
  expected.data.forEach((values, row) => {
    const env = result.envelopes[row];
    const size = Math.round(env.bucketDurationSec * rate / 2);
    const globalFirst = Math.floor(first / 2), firstBin = Math.floor(globalFirst / size);
    assert.equal(env.startSec, req.startSec + ((firstBin * size - globalFirst) * 2 + 1) / rate);
    const min = new Float64Array(env.minima.length).fill(Infinity), max = new Float64Array(min.length).fill(-Infinity);
    const last = new Float64Array(min.length).fill(NaN), gaps = new Uint8Array(min.length);
    values.forEach((v, i) => {
      const bin = Math.floor((globalFirst + i) / size) - firstBin;
      if (!Number.isFinite(v)) gaps[bin] = 1;
      else { min[bin] = Math.min(min[bin], v); max[bin] = Math.max(max[bin], v); last[bin] = v; }
    });
    for (let i = 0; i < min.length; i++) if (!Number.isFinite(min[i])) { min[i] = NaN; max[i] = NaN; gaps[i] = 1; }
    assert.deepEqual(env.minima, min, `minimum ${row}`);
    assert.deepEqual(env.maxima, max, `maximum ${row}`);
    assert.deepEqual(env.gaps, gaps, `gaps ${row}`);
    assert.deepEqual(result.data[row], last, `last ${row}`);
  });
  const regions = detectRawSynchronizedFlatlines(raw, raw.map(() => rate), { startSec: req.startSec + 1 / rate });
  const round = regions => regions.map(r => [Math.round(r.startSec * rate * 1e6), Math.round(r.endSec * rate * 1e6)]);
  assert.deepEqual(round(result.flatlineRegions), round(regions), 'raw flatlines');
}

test('cached zoom levels preserve exact FIR, montage, phase, gaps, extrema and window boundaries', async () => {
  for (const rate of [200, 200.5]) for (const montage of ['referential', 'average', 'bipolar']) {
    const source = fixture(rate), cache = createMatlabDisplayTileCache();
    for (const [start, duration, width] of [[0, 300, 100], [1.003, 300, 100], [1.013, 300, 100], [1.018, 300, 100], [1.018, 300, 60], [19.99, 300, 100], [44.9, 300, 100], [200, 300, 50]]) {
      const req = request(source, start, duration, montage, width);
      verify(source, req, await buildMatlabDisplayWindow(req, { ...options, cache }));
    }
  }
});

test('panning and zooming reuse processed interiors; boundary correction reads stay small', async () => {
  const source = fixture(), cache = createMatlabDisplayTileCache();
  await buildMatlabDisplayWindow(request(source), { ...options, cache });
  const coldRead = source.valuesRead;
  for (const req of [request(source, 1.013), request(source, 1.013, 300, 'referential', 60)]) {
    source.valuesRead = 0;
    verify(source, req, await buildMatlabDisplayWindow(req, { ...options, cache }));
    assert.ok(source.valuesRead < coldRead * .08, `${source.valuesRead} versus ${coldRead}`);
  }
});

test('progressive snapshots are immutable and never fill unread bins with fabricated data', async () => {
  const source = fixture(), cache = createMatlabDisplayTileCache(), snapshots = [];
  const result = await buildMatlabDisplayWindow(request(source), { ...options, cache, onPartial(view, through) {
    snapshots.push({ view, through, copy: view.data.map(a => a.slice()) });
  } });
  assert.ok(snapshots.length);
  for (const { view, through, copy } of snapshots) {
    assert.deepEqual(view.data, copy);
    assert.ok(through < 301.003);
    assert.ok(view.data[0].some(v => !Number.isFinite(v)));
    assert.notEqual(view.data[0], result.data[0]);
  }
});

test('cache budget, source identity, channel selection and montage changes cannot leak samples', async () => {
  const source = fixture(), cache = createMatlabDisplayTileCache(16000);
  for (const req of [request(source), request(fixture()), { ...request(source), channelIndices: [0, 1] }, request(source, 1, 300, 'average')]) {
    verify(req.source, req, await buildMatlabDisplayWindow(req, { ...options, cache }));
    assert.ok(cache.byteLength <= 16000);
  }
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.byteLength, 0);
});

test('cancellation from a partial publication stops subsequent publications', async () => {
  const source = fixture(), controller = new AbortController(); let publications = 0;
  await assert.rejects(buildMatlabDisplayWindow(request(source), { ...options, cache: createMatlabDisplayTileCache(), signal: controller.signal,
    onPartial() { publications++; controller.abort(); } }), { name: 'AbortError' });
  assert.equal(publications, 1);
});

test('tile flatline scanning agrees with streaming detection at exact threshold lengths and NaNs', () => {
  for (const rate of [17, 50, 200, 200.5, 1000]) {
    const length = Math.ceil(rate * 12), lag = Math.ceil(rate / 4);
    for (let seed = 1; seed <= 12; seed++) {
      let random = seed;
      const arrays = Array.from({ length: 5 }, (_, ch) => {
        const values = Float64Array.from({ length }, (_, i) => Math.sin(i + ch));
        for (let i = 0; i < length;) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          const count = Math.max(1, random % (lag * 4));
          values.fill(random % 7 === 0 ? NaN : random % 3, i, Math.min(length, i + count));
          i += count;
        }
        return values;
      });
      const stream = createMatlabRawFlatlineDetector(5, rate, 0);
      stream.push(arrays, 0);
      assert.deepEqual(detectMatlabTileFlatlines(arrays, rate), stream.finish().map(r => ({
        startSample: Math.round(r.startSec * rate), endSample: Math.round(r.endSec * rate) })), `rate ${rate}, seed ${seed}`);
    }
  }
});

test('small uncached windows publish independent prefixes without corrupting final results', async () => {
  const source = fixture(), req = request(source, 3, 20, 'average', 2000), partials = [];
  const plain = await buildMatlabDisplayWindow(req, options);
  const progressive = await buildMatlabDisplayWindow(req, { ...options, onPartial(view) { partials.push(view); } });
  assert.ok(partials.length);
  assert.ok(partials[0].data[0].some(v => !Number.isFinite(v)));
  assert.deepEqual(progressive, plain);
});

test('failed read-ahead is reported and does not contaminate completed cache tiles', async () => {
  const source = fixture(), cache = createMatlabDisplayTileCache(); let calls = 0;
  await assert.rejects(buildMatlabDisplayWindow(request(source), { ...options, cache,
    readWindow(...args) { if (++calls === 3) return Promise.reject(new Error('disk read failed')); return source.getWindow(...args); },
  }), /disk read failed/);
  const req = request(source);
  verify(source, req, await buildMatlabDisplayWindow(req, { ...options, cache }));
});
