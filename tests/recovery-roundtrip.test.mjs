/** Real autosave payloads must pass the real recovery parser after a reload. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
const writers = [];
function collect(node) {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node);
  }
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "localStorage.setItem"
    && node.arguments[0]?.getText(syntax).includes("neurotrace:project:")) writers.push(node.arguments[1]);
  ts.forEachChild(node, collect);
}
collect(syntax);
assert.equal(writers.length, 2, "both session snapshot and debounced autosave paths are covered");
function evaluate(code, result, env = {}) {
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(env), `${javascript}\nreturn ${result};`)(...Object.values(env));
}
const helpers = ["clamp", "annotationGeometry", "normalizeAnnotationGeometry", "migrateAnnotationList",
  "migrateCandidateList", "hasValidRecoveryBounds", "parseRecoveryProject", "matlabExportIdentityFromInterpretation"];
const api = evaluate([
  ...["LABELS", "LABEL_BY_ID"].map((name) => `const ${declarations.get(name).getText(syntax)};`),
  ...helpers.map((name) => declarations.get(name).getText(syntax)),
].join("\n"), "({ parseRecoveryProject, matlabExportIdentityFromInterpretation })");

function review(sourceInterpretation = null) {
  return {
    annotations: [{ id: "annotation-1", labelId: "ictal", start: 1, end: 3, geometry: "interval",
      track: "windowed", status: "committed", channels: [0], reviewer: "QA", notes: "Preserve this review",
      confidence: 80, reliability: "silver", origin: "manual", revision: 1 }],
    candidates: [{ id: "candidate-1", time: 2, label: "Seizure", status: "queued", source: "bronze" }],
    activeCandidate: 0, reviewer: "QA", sourceInterpretation,
    cursorAmplitude: NaN,
  };
}
function save(writer, state) {
  return evaluate(`const saved = ${writer.getText(syntax)};`, "saved", {
    ...state, snapshot: state, matlabExportIdentityFromInterpretation: api.matlabExportIdentityFromInterpretation,
  });
}

test("both actual EDF autosaves recover committed labels despite an absent MATLAB identity", () => {
  for (const writer of writers) {
    const raw = save(writer, review());
    const serialized = JSON.parse(raw);
    assert.equal(serialized.matlabExportIdentity, null);
    assert.equal(Object.hasOwn(serialized, "cursorAmplitude"), false,
      "cursor NaN is not part of the local recovery payload");
    const restored = api.parseRecoveryProject(raw, 20, 2);
    assert.equal(restored.annotations.length, 1);
    assert.equal(restored.annotations[0].status, "committed");
    assert.equal(restored.annotations[0].notes, "Preserve this review");
    assert.equal(restored.candidates[0].id, "candidate-1");
    assert.equal(restored.reviewer, "QA");
    assert.equal(restored.matlabExportIdentity, null);
  }
});

test("both actual MAT+DAT autosaves preserve their export identity without relaxing field validation", () => {
  for (const writer of writers) {
    const raw = save(writer, review({ kind: "raw-int16-le", patient_id_hint: "Synthetic",
      companion_mat_path: "patient/session.mat", data_dir_hint: "patient", dat_file_base: "session" }));
    const restored = api.parseRecoveryProject(raw, 20, 2);
    assert.deepEqual(restored.matlabExportIdentity, {
      patientId: "Synthetic", matPath: "patient/session.mat", dataDirectory: "patient", datFile: "session",
    });
  }
  const valid = JSON.parse(save(writers[0], review()));
  for (const invalid of [false, 0, "identity", [], { patientId: 123 }, { matPath: [] }]) {
    assert.throws(() => api.parseRecoveryProject(JSON.stringify({ ...valid, matlabExportIdentity: invalid }), 20, 2),
      /MATLAB export identity/);
  }
  delete valid.matlabExportIdentity;
  assert.equal(api.parseRecoveryProject(JSON.stringify(valid), 20, 2).matlabExportIdentity, null,
    "older autosaves without the optional field remain valid");
});
