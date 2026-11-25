/*
Purpose: Checks workspace layout behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/channel-layout.ts, app/workspace-layout.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkspaceLayout } from "../app/workspace-layout.ts";
import { buildChannelRowLayout, channelPlotGeometry, channelRowFromFraction, normalizeChannelGroupGap } from "../app/channel-layout.ts";

test("new workspaces start with event labels and only the essential toolbar", () => {
  assert.deepEqual(normalizeWorkspaceLayout({}), { sidebarTab: "labels", infoTab: "files", labelsTab: "events", toolbarTools: [] });
});

test("restores pinned labels from workspace settings alongside viewing tools", () => {
  assert.deepEqual(normalizeWorkspaceLayout({
    toolbarTools: ["spectrogram", "label:ictal", "label:dictionary:f232-131d", "label:", "label:dict:other", "label:ictal"],
  }).toolbarTools, ["spectrogram", "label:ictal", "label:dictionary:f232-131d"]);
});

test("saved sidebar and tool choices retain order and reject unknown or duplicate controls", () => {
  assert.deepEqual(normalizeWorkspaceLayout({ sidebarTab: "view", labelsTab: "create", toolbarTools: ["gain", "channels", "unknown", "gain", "spectrogram", null] }),
    { sidebarTab: "view", infoTab: "files", labelsTab: "create", toolbarTools: ["gain", "spectrogram"] });
});

test("older inspector and resource JSON opens Info at Window/Performance", () => {
  for (const rightPanelView of ["inspect", "resources"]) {
    const layout = normalizeWorkspaceLayout({ rightPanelView });
    assert.equal(layout.sidebarTab, "info");
    assert.equal(layout.infoTab, "window");
  }
  assert.equal(normalizeWorkspaceLayout({ rightPanelView: "labels", sidebarTab: "unknown" }).sidebarTab, "labels");
});

test("old file and window tabs migrate to their matching Info subtab", () => {
  for (const sidebarTab of ["files", "window"]) {
    const layout = normalizeWorkspaceLayout({ sidebarTab });
    assert.equal(layout.sidebarTab, "info");
    assert.equal(layout.infoTab, sidebarTab);
  }
});

test("Info selection is restored independently of the main tab and invalid subtabs use Folder/File", () => {
  for (const sidebarTab of ["info", "view", "labels"]) {
    for (const infoTab of ["files", "window"]) {
      const layout = normalizeWorkspaceLayout({ sidebarTab, infoTab });
      assert.equal(layout.sidebarTab, sidebarTab);
      assert.equal(layout.infoTab, infoTab);
    }
  }
  assert.equal(normalizeWorkspaceLayout({ sidebarTab: "info", infoTab: "unknown" }).infoTab, "files");
});

test("a chosen group gap stays uniform and hit testing follows the same geometry", () => {
  for (const gap of [8, 40, 120, 240]) {
    const layout = buildChannelRowLayout(["C3", "Cz", "C4", "Fp1", "Fp2", "P3"], true, "name", gap);
    const geometry = channelPlotGeometry(layout, 500, true);
    for (const { startRow } of layout.groups.slice(1)) {
      const previousEnd = geometry.yForUnit(layout.rowStartUnits[startRow - 1]) + geometry.rowHeight;
      assert.equal(geometry.yForUnit(layout.rowStartUnits[startRow]) - previousEnd, gap);
      assert.equal(channelRowFromFraction(layout, geometry.unitForY(previousEnd + gap / 2) / layout.totalUnits), null);
    }
    layout.rowStartUnits.forEach((start, row) => {
      const y = geometry.yForUnit(start) + geometry.rowHeight / 2;
      assert.equal(channelRowFromFraction(layout, geometry.unitForY(y) / layout.totalUnits), row);
    });
  }
});

test("regular spacing remains automatic with no custom gap and saved malformed spacing cannot corrupt geometry", () => {
  for (const value of [null, undefined, "50", NaN, Infinity]) assert.equal(normalizeChannelGroupGap(value), null);
  assert.equal(normalizeChannelGroupGap(-20), 8);
  assert.equal(normalizeChannelGroupGap(1000), 240);
  const layout = buildChannelRowLayout(["C3", "Fp1", "P3"], true, "name");
  for (const height of [200, 600]) assert.equal(channelPlotGeometry(layout, height, false).contentHeight, height);
  const expandedLayout = buildChannelRowLayout(["C3", "Fp1", "P3"], true, "name", 240);
  assert.equal(channelPlotGeometry(expandedLayout, 200, false).contentHeight, 200, "returning to compact mode fits every enabled row even after increasing gaps");
});

test("fitted channels use tight centered spacing and all row centers remain selectable", () => {
  const labels = ["C3", "Cz", "C4", "Fp1", "Fp2", "P3"];
  for (const grouped of [false, true]) {
    const layout = buildChannelRowLayout(labels, grouped, "name", 240, true);
    const geometry = channelPlotGeometry(layout, 500, false);
    const top = geometry.yForUnit(layout.rowStartUnits[0]);
    const bottom = geometry.yForUnit(layout.rowStartUnits.at(-1)) + geometry.rowHeight;
    assert.ok(top > 0 && bottom < 500);
    assert.equal(top, 500 - bottom);
    for (const { startRow } of layout.groups.slice(1)) {
      const previousEnd = geometry.yForUnit(layout.rowStartUnits[startRow - 1]) + geometry.rowHeight;
      assert.equal(geometry.yForUnit(layout.rowStartUnits[startRow]) - previousEnd, 8);
    }
    layout.rowStartUnits.forEach((unit, row) => {
      const center = geometry.yForUnit(unit) + geometry.rowHeight / 2;
      assert.equal(channelRowFromFraction(layout, geometry.unitForY(center) / layout.totalUnits), row);
    });
  }
});
