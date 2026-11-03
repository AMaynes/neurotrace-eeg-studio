import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { addDirectoryReviewRows, directoryReviewCache, findNextDirectoryReview, indexReviewRows, loadDirectoryReviewCsvs, matchReviewRecording, reviewRowMatches } from '../app/directory-review-resume.ts';
import { readDirectoryReviewMetadata } from '../app/directory-review-worker.ts';
import { planDirectoryImport } from '../app/directory-import.ts';
import { MATLAB_ANNOTATION_COLUMNS, parseMatlabAnnotations, serializeMatlabAnnotations } from '../app/matlab-annotations-csv.ts';
import { matWriter } from './fixtures/legacy-mat.mjs';

function fileAt(name, bytes = '') {
  const file = new File([bytes], name.split('/').at(-1));
  Object.defineProperty(file, 'webkitRelativePath', { value: name });
  return file;
}
function metadataFile(name, { compressed = false, little = true, extraSignal = false } = {}) {
  const w = matWriter(little);
  return w.file([w.struct('sessionInfo', [{ sFile: w.struct('', [{
    header: w.struct('', [{ sample_rate: w.numeric([100]), num_channels: w.numeric([100]) }]),
    events: w.struct('', [10, 30].map(time => ({ label: w.string('Seizure'), times: w.numeric([time]) }))),
  }]) }]), ...(extraSignal ? [w.numeric(Array(1024 * 1024).fill(1), { name: 'waveform' })] : [])], name, { compressed });
}
function plan() {
  const files = ['a', 'b', 'c'].flatMap(name => [fileAt(`Patient/day-${name}/session.mat`), fileAt(`Patient/day-${name}/session.dat`)]);
  return planDirectoryImport(files, 'mat-dat');
}
function row(session = 'a', time = 10, patch = {}) {
  return { mat_path: `C:\\study\\Patient\\day-${session}\\session.mat`, data_dir: `C:\\study\\Patient\\day-${session}`, dat_file: 'session',
    event_label: 'Seizure', event_time_original_sec: time, onset_offset_sec: -1, onset_time_adjusted_sec: time - 1,
    offset_offset_sec: 3, offset_time_adjusted_sec: time + 3, sampling_rate: 100, n_channels: 100, bad_channels: 'A1, A2',
    review_timestamp: '2026-11-03 09:04:05', accepted: 1, ...patch };
}
const csvFile = (rows, name = 'Patient_AM_annotations.csv') => new File([serializeMatlabAnnotations(rows)], name);
const metadata = () => ({ events: [10, 30].map(timeSec => ({ label: 'Seizure', timeSec })), sampleRate: 100, channelCount: 100, durationSec: 100, warnings: [] });

test('CSV matching uses complete relative paths across platforms, isolates patients, and rejects ambiguous basenames', () => {
  const p = plan();
  assert.equal(matchReviewRecording(p, row('b')).id, p.recordings[1].id);
  assert.equal(matchReviewRecording(p, row('a', 10, { mat_path: '/mnt/study/Patient/day-a/session.mat' })).id, p.recordings[0].id);
  assert.equal(matchReviewRecording(p, row('a', 10, { mat_path: 'session.mat' })), undefined);
  assert.equal(matchReviewRecording(p, row('a', 10, { mat_path: '/OtherPatient/day-a/session.mat' })), undefined);
  assert.equal(matchReviewRecording(p, row('a', 10, { mat_path: '/Patient/day-c/session.mat' })).id, p.recordings[2].id);
});

test('loading multiple CSVs keeps the newest accepted decision, retains good files after an invalid file, and isolates catalogs', async () => {
  const p = plan(), other = plan();
  const newer = row('a', 10, { bad_channels: 'A9', review_timestamp: '2026-11-03 10:00:00' });
  const bad = new File(['wrong,schema\n1,2'], 'broken_annotations.csv');
  const loaded = await loadDirectoryReviewCsvs(p, [csvFile([newer]), csvFile([row()]), bad]);
  assert.equal(loaded.rows.length, 1); assert.equal(loaded.rows[0].bad_channels, 'A9');
  assert.equal(loaded.byRecording.get(p.recordings[0].id).length, 1); assert.equal(loaded.warnings.length, 1);
  assert.equal(directoryReviewCache(other).rows.length, 0);
  const oversized = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large_annotations.csv');
  await loadDirectoryReviewCsvs(p, [oversized]); assert.equal(loaded.rows.length, 1);
  assert.match(loaded.warnings.at(-1), /8 MiB/);
});

test('resume reader ignores unaccepted CSV rows while the save parser retains its strict accepted-review contract', () => {
  const accepted = serializeMatlabAnnotations([row()]);
  const unaccepted = accepted.replace(/,1\r\n$/, ',0\r\n');
  assert.deepEqual(parseMatlabAnnotations(unaccepted, { acceptedOnly: true }), []);
  assert.throws(() => parseMatlabAnnotations(unaccepted));
  assert.deepEqual(parseMatlabAnnotations(MATLAB_ANNOTATION_COLUMNS.join(',') + '\r\n'), []);
});

test('six-decimal event identity still verifies source metadata, timing bounds, and offsets', () => {
  const event = { timeSec: 10.0000001, label: 'Seizure' };
  assert.equal(reviewRowMatches(row(), event, metadata()), true);
  for (const patch of [{ sampling_rate: 200 }, { n_channels: 99 }, { onset_time_adjusted_sec: -1 },
    { offset_time_adjusted_sec: 101 }, { onset_offset_sec: -9 }, { event_time_original_sec: 11 }]) {
    assert.equal(reviewRowMatches(row('a', 10, patch), event, metadata()), false);
  }
});

test('folder resume skips completed events across sessions and stops at the first unfinished event without checking later files', async () => {
  const p = plan();
  await loadDirectoryReviewCsvs(p, [csvFile([row('a', 10), row('a', 30), row('b', 10)])]);
  const checked = [];
  const next = await findNextDirectoryReview(p, new AbortController().signal, () => {}, async (_p, recording) => { checked.push(recording.id); return metadata(); });
  assert.equal(next.recording.id, p.recordings[1].id); assert.equal(next.timeSec, 30);
  assert.deepEqual(checked, p.recordings.slice(0, 2).map(r => r.id));
  await loadDirectoryReviewCsvs(p, [csvFile([row('b', 30), row('c', 10), row('c', 30)])]);
  assert.equal(await findNextDirectoryReview(p, new AbortController().signal, () => {}, async () => metadata()), undefined);
});

test('unreadable or partial metadata stops resume without declaring a session completed; cancellation never opens a file', async () => {
  const p = plan(), controller = new AbortController();
  await assert.rejects(findNextDirectoryReview(p, controller.signal, () => {}, async () => ({ ...metadata(), warnings: ['incomplete metadata'] })), /did not skip it/);
  let opened = false;
  const read = async () => { controller.abort(); return metadata(); };
  await assert.rejects(findNextDirectoryReview(p, controller.signal, () => {}, read).then(() => { opened = true; }), /abort/i);
  assert.equal(opened, false);
});

test('real worker metadata reads known MAT event times and acquisition fields across compression and byte orders', async () => {
  for (const compressed of [false, true]) for (const little of [false, true]) {
    const file = metadataFile('source.mat', { compressed, little });
    const result = await readDirectoryReviewMetadata('mat-dat', file, 100 * 100 * 100 * 2);
    assert.deepEqual(result, metadata());
  }
});

test('uncompressed resume scanning seeks past large numeric waveform matrices', async () => {
  const file = metadataFile('source.mat', { extraSignal: true });
  let bytesRead = 0;
  const slice = file.slice.bind(file);
  file.slice = (...args) => { const blob = slice(...args); bytesRead += blob.size; return blob; };
  const result = await readDirectoryReviewMetadata('mat-dat', file, 2_000_000);
  assert.equal(result.events.length, 2); assert.ok(bytesRead < 100_000, `${bytesRead} bytes read`);
});

const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const syntax = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const funcs = new Map();
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) funcs.set(node.name.text, node.getText(syntax)); ts.forEachChild(node, visit); }
visit(syntax);
const helper = ts.transpileModule(funcs.get('reconcileCandidateQueue') + '\n' + funcs.get('restoreCsvCandidateReviews'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const restore = new Function('reviewRowMatches', 'indexReviewRows', 'clamp', helper + '\nreturn restoreCsvCandidateReviews;')(reviewRowMatches, indexReviewRows, (v, lo, hi) => Math.max(lo, Math.min(hi, v)));
const candidate = (id, time) => ({ id, time, label: 'Seizure', source: 'bronze', status: 'queued', confidence: 0 });
const meta = { sampleRates: [100, 100], channelCount: 100, durationSec: 100 };

test('actual page restores accepted intervals and bad-channel notes and selects the first remaining event', () => {
  const result = restore([candidate('one', 10), candidate('two', 30)], [], [row()], meta);
  assert.equal(result.restoredCount, 1); assert.equal(result.activeIndex, 1);
  assert.equal(result.candidates[0].status, 'reviewed'); assert.equal(result.candidates[1].status, 'active');
  assert.equal(result.candidates[0].badChannels, 'A1, A2');
  assert.equal(result.annotations[0].status, 'committed'); assert.equal(result.annotations[0].candidateId, 'one');
  assert.equal(result.annotations[0].start, 9); assert.equal(result.annotations[0].end, 13);
});

test('actual page preserves local drafts, skips, and accepted edits instead of overwriting them with CSV decisions', () => {
  for (const status of ['reviewed', 'skipped', 'conflict']) {
    assert.equal(restore([{ ...candidate('one', 10), status }], [], [row()], meta).restoredCount, 0);
  }
  const draft = { id: 'draft', candidateId: 'one', status: 'draft', start: 8, end: 14 };
  const result = restore([candidate('one', 10)], [draft], [row()], meta);
  assert.equal(result.restoredCount, 0); assert.equal(result.annotations[0], draft);
  assert.equal(restore([candidate('one', 10)], [], [row()], { ...meta, sampleRates: [100, 200] }).restoredCount, 0);
  assert.equal(restore([candidate('one', 10)], [], [row('a', 10, { review_timestamp: 'invalid' })], meta).restoredCount, 0);
});


test('live accepted decisions join the CSV cache before resuming again within the same visit', async () => {
  const p = plan();
  await loadDirectoryReviewCsvs(p, [csvFile([row('a', 10), row('a', 30)])]);
  addDirectoryReviewRows(p, [row('b', 10), row('b', 30)]);
  const next = await findNextDirectoryReview(p, new AbortController().signal, () => {}, async () => metadata());
  assert.equal(next.recording.id, p.recordings[2].id); assert.equal(next.timeSec, 10);
});

test('canceling an actual pending resume terminates its worker and never submits DAT bytes', async () => {
  const NativeWorker = globalThis.Worker, calls = [];
  globalThis.Worker = class {
    constructor(url) { this.url = url; calls.push(this); }
    postMessage(request) { this.request = request; }
    terminate() { this.terminated = true; }
  };
  try {
    const controller = new AbortController(), p = plan();
    const pending = findNextDirectoryReview(p, controller.signal, () => {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].request.file.name, /\.mat$/);
    assert.equal(typeof calls[0].request.datBytes, 'number');
    controller.abort();
    await assert.rejects(pending, /abort/i); assert.equal(calls[0].terminated, true);
  } finally { globalThis.Worker = NativeWorker; }
});

test('resume reuses one worker across completed files and releases it when every event is complete', async () => {
  const NativeWorker = globalThis.Worker, workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); this.requests = 0; }
    postMessage() { this.requests++; queueMicrotask(() => this.onmessage({ data: { metadata: metadata() } })); }
    terminate() { this.terminated = true; }
  };
  try {
    const p = plan();
    await loadDirectoryReviewCsvs(p, [csvFile(['a','b','c'].flatMap(name => [row(name, 10), row(name, 30)]))]);
    assert.equal(await findNextDirectoryReview(p, new AbortController().signal, () => {}), undefined);
    assert.equal(workers.length, 1); assert.equal(workers[0].requests, 3); assert.equal(workers[0].terminated, true);
  } finally { globalThis.Worker = NativeWorker; }
});
