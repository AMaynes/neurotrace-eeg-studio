"use client";

import { useEffect, useRef } from "react";
import { notifyTutorialAction, type TutorialAction } from "./tutorial-events";

/** Committed UI outcomes only; loading/progress ticks and waveform samples are excluded. */
export type TutorialMilestones = {
  scope: string;
  stateKey: string;
  recording: string | null;
  importOpen: boolean;
  importFormat: string | null;
  filesReady: boolean;
  directoryFilesReady: boolean;
  directoryListOpen: boolean;
  settingsOpen: boolean;
  biasLocks: boolean;
  channelsOpen: boolean;
  montage: string;
  groups: boolean;
  playing: boolean;
  labelFilterOpen: boolean;
  olderReviewOpen: boolean;
  gain: number;
  clamp: string;
  filtersOpen: boolean;
  boxZoom: boolean;
  spectrogramOpen: boolean;
  labelsPanelOpen: boolean;
  labelPickerOpen: boolean;
  sessionLabelPickerOpen: boolean;
  labelsVisible: boolean;
  saveOpen: boolean;
};

/** Session restoration and initial mounting are not actions in a walkthrough. */
export function tutorialMilestoneActions(before: TutorialMilestones | null, after: TutorialMilestones): TutorialAction[] {
  if (!before || before.scope !== after.scope) return [];
  const actions: TutorialAction[] = [];
  const changed = <K extends keyof TutorialMilestones>(key: K, action: TutorialAction, condition = true) => {
    if (before[key] !== after[key] && condition) actions.push(action);
  };
  changed("recording", "recording-opened", after.recording !== null);
  changed("importOpen", "import-opened", after.importOpen);
  changed("importFormat", "import-format-chosen", after.importFormat !== null);
  changed("filesReady", "import-files-ready", after.filesReady);
  changed("directoryFilesReady", "directory-files-ready", after.directoryFilesReady);
  changed("directoryListOpen", "directory-list-opened", after.directoryListOpen);
  // Loading/restoring a recording can reset many controls without a user action.
  if (before.recording !== after.recording || before.stateKey !== after.stateKey) return actions;
  changed("settingsOpen", "settings-opened", after.settingsOpen);
  changed("olderReviewOpen", "older-review-opened", after.olderReviewOpen);
  changed("biasLocks", "bias-locks-changed");
  changed("channelsOpen", after.channelsOpen ? "channels-opened" : "channels-closed");
  changed("montage", "montage-changed");
  changed("groups", "groups-changed");
  changed("playing", after.playing ? "playback-started" : "playback-stopped");
  changed("labelFilterOpen", after.labelFilterOpen ? "label-filter-opened" : "label-filter-closed");
  changed("gain", "gain-changed");
  changed("clamp", "clamp-changed");
  changed("filtersOpen", "filters-opened", after.filtersOpen);
  changed("boxZoom", after.boxZoom ? "waveform-zoom-enabled" : "waveform-zoom-disabled");
  changed("spectrogramOpen", "spectrogram-opened", after.spectrogramOpen);
  changed("labelsPanelOpen", "label-panel-opened", after.labelsPanelOpen);
  changed("labelPickerOpen", after.labelPickerOpen ? "label-picker-opened" : "label-picker-closed");
  changed("sessionLabelPickerOpen", "session-label-picker-opened", after.sessionLabelPickerOpen);
  changed("labelsVisible", "labels-toggled");
  changed("saveOpen", "save-opened", after.saveOpen);
  return actions;
}

/** Publish after React commits, so disabled/canceled/failed operations cannot advance a step. */
export function useTutorialMilestones(current: TutorialMilestones): void {
  const previous = useRef<TutorialMilestones | null>(null);
  useEffect(() => {
    const actions = tutorialMilestoneActions(previous.current, current);
    previous.current = current;
    actions.forEach(notifyTutorialAction);
  }, [current]);
}
