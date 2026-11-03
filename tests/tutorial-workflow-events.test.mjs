/** Real resume controls emit payload-free tutorial outcomes only after successful work. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as resume from '../app/directory-review-resume.ts';
import { MATLAB_ANNOTATION_COLUMNS } from '../app/matlab-annotations-csv.ts';
const source = await readFile(new URL('../app/directory-review-controls.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
function all(tree) {
  if (Array.isArray(tree)) return tree.flatMap(all);
  return !tree || typeof tree !== 'object' ? [] : [tree, ...all(tree.props?.children)];
}
function fixture(files = []) {
  const hooks = [], effects = [], actions = [], opened = [];
  let index = 0, pendingEffects = [];
  const exports = {};
  const ui = { plan: { format: 'mat-dat', recordings: [], supportingFiles: files }, readNext: async () => undefined };
  new Function('require', 'exports', code)(name => {
    if (name === 'react') return {
      useState(initial) { const n = index++; if (!(n in hooks)) hooks[n] = typeof initial === 'function' ? initial() : initial; return [hooks[n], value => { hooks[n] = typeof value === 'function' ? value(hooks[n]) : value; }]; },
      useRef(initial) { const n = index++; return hooks[n] ??= { current: initial }; },
      useEffect(effect, dependencies) { const n = index++; if (!effects[n] || dependencies.some((v, i) => v !== effects[n].dependencies[i])) pendingEffects.push(() => { effects[n]?.cleanup?.(); effects[n] = { dependencies, cleanup: effect() }; }); },
    };
    if (name === './directory-review-resume') return { ...resume, findNextDirectoryReview: (...args) => ui.readNext(...args) };
    if (name === './tutorial-events') return { notifyTutorialAction: action => actions.push(action) };
    return require(name);
  }, exports);
  const props = { plan: ui.plan, busy: false, onResume: recording => opened.push(recording), onBusyChange() {} };
  Object.assign(ui, { actions, opened,
    render() { index = 0; ui.tree = exports.DirectoryReviewControls(props); const run = pendingEffects; pendingEffects = []; run.forEach(fn => fn()); return ui.tree; },
    find(predicate) { const node = all(ui.tree).find(predicate); assert.ok(node); return node; },
    async settle() { await tick(); ui.render(); },
    async load(files) { ui.find(node => node.props?.['aria-label'] === 'Saved annotation CSVs').props.onChange({ currentTarget: { files, value: 'selected' } }); await ui.settle(); },
    startResume() { ui.find(node => node.props?.['data-tutorial'] === 'directory-review-resume').props.onClick(); },
    cancel() { ui.find(node => node.type === 'button' && node.props.children === 'Cancel').props.onClick(); ui.render(); },
    dispose() { effects.forEach(effect => effect?.cleanup?.()); },
  });
  ui.render(); return ui;
}
const validCsv = () => new File([MATLAB_ANNOTATION_COLUMNS.join(',') + '\r\n'], 'Patient_AM_annotations.csv');

test('successful CSV reads notify once; empty selection, invalid CSVs, and duplicate reads do not', async () => {
  const csv = validCsv(), ui = fixture([csv]); await ui.settle();
  assert.deepEqual(ui.actions, ['review-csvs-loaded']);
  ui.actions.length = 0;
  await ui.load([]); await ui.load([csv]); await ui.load([new File(['wrong schema'], 'bad.csv')]);
  assert.deepEqual(ui.actions, []);
  await ui.load([validCsv()]); assert.deepEqual(ui.actions, ['review-csvs-loaded']);
  ui.dispose();
});

test('a chosen resume destination notifies after opening it; complete, failed, or cancelled scans do not', async () => {
  const ui = fixture(); await ui.settle();
  ui.startResume(); await ui.settle(); assert.deepEqual(ui.actions, []);
  ui.readNext = async () => { throw Error('Unreadable metadata'); };
  ui.startResume(); await ui.settle(); assert.deepEqual(ui.actions, []);
  let finish;
  ui.readNext = (_plan, signal) => new Promise((resolve, reject) => { finish = () => signal.aborted ? reject(signal.reason) : resolve({ recording: { id: 'next' }, timeSec: 30 }); });
  ui.startResume(); ui.render(); ui.cancel(); finish(); await ui.settle();
  assert.deepEqual(ui.actions, []); assert.deepEqual(ui.opened, []);
  ui.startResume(); finish(); await ui.settle();
  assert.deepEqual(ui.opened, [{ id: 'next' }]); assert.deepEqual(ui.actions, ['directory-review-found']);
  ui.dispose();
});

test('closing the directory while a CSV read is pending suppresses late completion notifications', async () => {
  let finish;
  const csv = validCsv(); csv.text = () => new Promise(resolve => { finish = resolve; });
  const ui = fixture([csv]); await tick(); ui.dispose();
  finish(MATLAB_ANNOTATION_COLUMNS.join(',') + '\r\n'); await tick();
  assert.deepEqual(ui.actions, []);
});
