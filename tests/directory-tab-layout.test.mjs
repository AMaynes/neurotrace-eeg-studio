import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adjacentDirectoryRecording, directoryTabHeaders, directoryTabLabel } from "../app/directory-tab-layout.ts";

const catalog = (id, paths) => ({ id, plan: { recordings: paths.map((relativePath) => ({ id: relativePath, relativePath })), supportingFiles: [], format: "edf" } });
const a = catalog("a", ["Study A/day1/a.edf", "Study A/day2/b.edf"]);
const b = catalog("b", ["Study B/day1/a.edf"]);

test("one directory header spans exactly its two session tabs", () => {
  const tabs = [{ id: "first", directoryId: "a" }, { id: "second", directoryId: "a" }, { id: "blank" }];
  const [header] = directoryTabHeaders(tabs, [a]);
  assert.deepEqual(header, { key: "a-0", catalogId: "a", label: "Study A", total: 2, column: 1, span: 2, sessionIds: ["first", "second"] });
  const afterClose = directoryTabHeaders(tabs.slice(1), [a]);
  assert.equal(afterClose[0].span, 1);
  assert.equal(afterClose[0].column, 1);
});

test("directory arrows follow the file list and stop at either end without wrapping", () => {
  const first = { id: "first", directoryId: a.id, directoryRecordingId: a.plan.recordings[0].id };
  const last = { ...first, directoryRecordingId: a.plan.recordings[1].id };
  assert.equal(adjacentDirectoryRecording(a, first, -1), undefined);
  assert.equal(adjacentDirectoryRecording(a, first, 1), a.plan.recordings[1]);
  assert.equal(adjacentDirectoryRecording(a, last, -1), a.plan.recordings[0]);
  assert.equal(adjacentDirectoryRecording(a, last, 1), undefined);
  for (const tab of [undefined, { id: "blank" }, { ...first, directoryId: "other" }, { ...first, directoryRecordingId: "missing" }]) {
    assert.equal(adjacentDirectoryRecording(a, tab, -1), undefined);
    assert.equal(adjacentDirectoryRecording(a, tab, 1), undefined);
  }
  const single = { id: "single", directoryId: b.id, directoryRecordingId: b.plan.recordings[0].id };
  assert.equal(adjacentDirectoryRecording(b, single, -1), undefined);
  assert.equal(adjacentDirectoryRecording(b, single, 1), undefined);
});

test("headers never cover standalone or other-directory tabs, even if given interleaved state", () => {
  const tabs = [{ id: "a1", directoryId: "a" }, { id: "plain" }, { id: "b1", directoryId: "b" }, { id: "a2", directoryId: "a" }];
  const headers = directoryTabHeaders(tabs, [a, b]);
  assert.deepEqual(headers.map(({ catalogId, column, span }) => [catalogId, column, span]), [["a", 1, 1], ["b", 3, 1], ["a", 4, 1]]);
  assert.equal(new Set(headers.map((header) => header.key)).size, 3);
  for (const header of headers) for (let index = header.column - 1; index < header.column - 1 + header.span; index++) {
    assert.equal(tabs[index].directoryId, header.catalogId);
  }
});

test("closed or not-yet-open catalogs stay reachable without attaching to unrelated tabs", () => {
  const headers = directoryTabHeaders([{ id: "plain" }], [a, b]);
  assert.deepEqual(headers.map(({ column, span, sessionIds }) => [column, span, sessionIds]), [[2, 1, []], [3, 1, []]]);
  assert.equal(directoryTabHeaders([{ id: "old", directoryId: "cleared" }], []).length, 0);
});

test("directory identity does not rely on folder names and labels do not invent a parent for loose files", () => {
  const sameName = catalog("other-import", ["Study A/a.edf"]);
  const headers = directoryTabHeaders([{ id: "a1", directoryId: "a" }, { id: "a2", directoryId: "other-import" }], [a, sameName]);
  assert.deepEqual(headers.map((header) => header.span), [1, 1]);
  assert.deepEqual(headers.map((header) => header.catalogId), ["a", "other-import"]);
  assert.equal(directoryTabLabel(catalog("loose", ["a.edf", "b.edf"]).plan), "Selected files");
  assert.equal(directoryTabLabel(catalog("mixed", ["A/a.edf", "B/b.edf"]).plan), "Selected files");
  assert.equal(directoryTabLabel(catalog("windows", ["Folder\\child\\a.edf"]).plan), "Folder");
});

test("production header occupies the shared grid above tabs and scrolls with its children", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const strip = page.slice(page.indexOf('<div className="session-tabs">'), page.indexOf('<div className="top-actions utility-actions">'));
  assert.match(strip, /directoryHeaders\.map/);
  assert.match(strip, /gridColumn: `\$\{group.column\} \/ span \$\{group.span\}`/);
  assert.match(strip, /gridColumn: index \+ 1/);
  assert.match(strip, /onClick=\{\(\) => openDirectoryCatalog\(group.catalogId\)\}/);
  assert.ok(strip.indexOf("directory-tab-header") < strip.indexOf("sessionTabs.map"));
  assert.equal((strip.match(/directory-sessions-toggle/g) ?? []).length, 1, "no leftover Directory button after +");
  assert.ok(strip.indexOf('className="directory-tab-navigation"') > strip.indexOf('className="directory-tab-name"'));
  assert.ok(strip.indexOf('className="directory-tab-navigation"') < strip.indexOf('className="directory-tab-count"'));
  assert.match(strip, /disabled=\{biasLocks \|\| navigationBusy \|\| !previous\}/);
  assert.match(strip, /locked by Bias Locks/);
  assert.match(strip, /onClick=\{\(\) => navigateDirectoryRecording\(group.catalogId, -1\)\}>\{biasLocks\s*\? <svg/);
  assert.match(strip, /disabled=\{navigationBusy \|\| !next\}/);
  assert.match(strip, /navigateDirectoryRecording\(group.catalogId, -1\)/);
  assert.match(strip, /navigateDirectoryRecording\(group.catalogId, 1\)/);
  assert.match(css, /\.session-tabs\s*\{[^}]*display: grid;[^}]*overflow-x: auto;/s);
  assert.match(css, /\.session-tabs \.directory-tab-header\s*\{[^}]*grid-row: 1;/s);
  assert.match(css, /\.session-tab-shell\s*\{[^}]*grid-row: 2;/s);
  assert.match(css, /height: calc\(100dvh - var\(--topbar-height\)\)/);
  assert.match(css, /min-height: calc\(650px - var\(--topbar-height\)\)/);
  assert.doesNotMatch(css, /top: 58px/, "responsive panels must move down with the two-row header");
});
