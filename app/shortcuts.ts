/** Shared shortcut catalogue: Controls, dispatch, and key hints use the same saved bindings. */
export const SHORTCUTS = [
  { id: "undo", scope: "workspace", label: "Undo label edit or zoom", keys: ["Mod+z", "u"] },
  { id: "redo", scope: "workspace", label: "Redo label edit or zoom", keys: ["Mod+Shift+z", "Shift+u"] },
  { id: "clear", scope: "workspace", label: "Clear selection / close dialog / end walkthrough", keys: ["Escape"] },
  { id: "help", scope: "viewer", label: "Open tutorials", keys: ["?"] },
  { id: "panLeft", scope: "viewer", label: "Back 1 second / move selected labels one snap", keys: ["ArrowLeft"] },
  { id: "panRight", scope: "viewer", label: "Forward 1 second / move selected labels one snap", keys: ["ArrowRight"] },
  { id: "panLeftFast", scope: "viewer", label: "Back 10 seconds / move selected labels 10 snaps", keys: ["Shift+ArrowLeft"] },
  { id: "panRightFast", scope: "viewer", label: "Forward 10 seconds / move selected labels 10 snaps", keys: ["Shift+ArrowRight"] },
  { id: "pageBack", scope: "viewer", label: "Previous time window", keys: ["PageUp"] },
  { id: "pageForward", scope: "viewer", label: "Next time window", keys: ["PageDown"] },
  { id: "zoomIn", scope: "viewer", label: "Zoom time in", keys: ["Mod+Plus"] },
  { id: "zoomOut", scope: "viewer", label: "Zoom time out", keys: ["Mod+Minus"] },
  { id: "commit", scope: "viewer", label: "Commit selected label / accept active candidate", keys: ["s"] },
  { id: "confirmWaveform", scope: "waveform", label: "Commit / accept with waveform focused", keys: ["Enter", "Space"] },
  { id: "delete", scope: "viewer", label: "Delete selected labels", keys: ["Delete", "Backspace"] },
  { id: "nextCandidate", scope: "viewer", label: "Next queued event", keys: ["n"] },
  { id: "previousCandidate", scope: "viewer", label: "Previous queued event", keys: ["p"] },
  { id: "ictalOnset", scope: "viewer", label: "Set ictal onset", keys: ["i"] },
  { id: "ictalOffset", scope: "viewer", label: "Set ictal offset", keys: ["o"] },
  { id: "label:ictal", scope: "viewer", label: "Label: Ictal", keys: ["1"] },
  { id: "label:preictal", scope: "viewer", label: "Label: Pre-ictal", keys: ["2"] },
  { id: "label:postictal", scope: "viewer", label: "Label: Post-ictal", keys: ["3"] },
  { id: "label:gpd", scope: "viewer", label: "Label: Generalized periodic discharges", keys: ["4"] },
  { id: "label:lpd", scope: "viewer", label: "Label: Lateralized periodic discharges", keys: ["5"] },
  { id: "label:bipd", scope: "viewer", label: "Label: Bilateral independent periodic discharges", keys: ["6"] },
  { id: "label:grda", scope: "viewer", label: "Label: Generalized rhythmic delta activity", keys: ["7"] },
  { id: "label:lrda", scope: "viewer", label: "Label: Lateralized rhythmic delta activity", keys: ["8"] },
  { id: "label:gsw", scope: "viewer", label: "Label: Generalized spike-and-wave", keys: ["9"] },
  { id: "spectrogramBrowse", scope: "spectrogram", label: "Browse tool", keys: ["b"] },
  { id: "spectrogramZoom", scope: "spectrogram", label: "Box zoom tool", keys: ["z"] },
  { id: "spectrogramLeft", scope: "spectrogram", label: "Pan back 15% of window", keys: ["ArrowLeft"] },
  { id: "spectrogramRight", scope: "spectrogram", label: "Pan forward 15% of window", keys: ["ArrowRight"] },
  { id: "spectrogramColorUp", scope: "spectrogram", label: "Lower color limits (C+)", keys: ["ArrowUp"] },
  { id: "spectrogramColorDown", scope: "spectrogram", label: "Raise color limits (C−)", keys: ["ArrowDown"] },
  { id: "sessionPrevious", scope: "sessionTabs", label: "Previous session tab", keys: ["ArrowLeft"] },
  { id: "sessionNext", scope: "sessionTabs", label: "Next session tab", keys: ["ArrowRight"] },
  { id: "sessionFirst", scope: "sessionTabs", label: "First session tab", keys: ["Home"] },
  { id: "sessionLast", scope: "sessionTabs", label: "Last session tab", keys: ["End"] },
  { id: "topicPrevious", scope: "tutorialTabs", label: "Previous tutorial topic", keys: ["ArrowLeft"] },
  { id: "topicNext", scope: "tutorialTabs", label: "Next tutorial topic", keys: ["ArrowRight"] },
  { id: "topicFirst", scope: "tutorialTabs", label: "First tutorial topic", keys: ["Home"] },
  { id: "topicLast", scope: "tutorialTabs", label: "Last tutorial topic", keys: ["End"] },
  { id: "queueShrink", scope: "queueResize", label: "Shrink session labels panel 10 px", keys: ["ArrowUp"] },
  { id: "queueGrow", scope: "queueResize", label: "Grow session labels panel 10 px", keys: ["ArrowDown"] },
  { id: "spectrogramGrow", scope: "spectrogramResize", label: "Grow spectrogram 20 px", keys: ["ArrowUp"] },
  { id: "spectrogramShrink", scope: "spectrogramResize", label: "Shrink spectrogram 20 px", keys: ["ArrowDown"] },
  { id: "coachLeft", scope: "coach", label: "Move walkthrough left 10 px", keys: ["ArrowLeft"] },
  { id: "coachRight", scope: "coach", label: "Move walkthrough right 10 px", keys: ["ArrowRight"] },
  { id: "coachUp", scope: "coach", label: "Move walkthrough up 10 px", keys: ["ArrowUp"] },
  { id: "coachDown", scope: "coach", label: "Move walkthrough down 10 px", keys: ["ArrowDown"] },
  { id: "coachLeftFast", scope: "coach", label: "Move walkthrough left 40 px", keys: ["Shift+ArrowLeft"] },
  { id: "coachRightFast", scope: "coach", label: "Move walkthrough right 40 px", keys: ["Shift+ArrowRight"] },
  { id: "coachUpFast", scope: "coach", label: "Move walkthrough up 40 px", keys: ["Shift+ArrowUp"] },
  { id: "coachDownFast", scope: "coach", label: "Move walkthrough down 40 px", keys: ["Shift+ArrowDown"] },
  { id: "coachReset", scope: "coach", label: "Reset walkthrough position", keys: ["Home"] },
  { id: "windowApply", scope: "windowInput", label: "Apply time-window amount", keys: ["Enter"] },
  { id: "gainApply", scope: "gainInput", label: "Apply gain multiplier", keys: ["Enter"] },
] as const;

export type ShortcutAction = typeof SHORTCUTS[number]["id"];
export type ShortcutScope = typeof SHORTCUTS[number]["scope"];
export type ControlBindings = Record<ShortcutAction, string[]>;
export const DEFAULT_CONTROLS = Object.fromEntries(SHORTCUTS.map(({ id, keys }) => [id, [...keys]])) as ControlBindings;
export const SHORTCUT_GROUPS: { scopes: ShortcutScope[]; title: string; note: string }[] = [
  { scopes: ["workspace", "viewer", "waveform"], title: "Viewer, labels & history", note: "Viewer shortcuts work outside fields and toolbar buttons. Undo/redo include Recenter and also work from the spectrogram and walkthrough; undo without Ctrl/⌘ cancels a pending ictal onset first. Waveform commit shortcuts require waveform focus." },
  { scopes: ["spectrogram"], title: "Spectrogram", note: "Click or focus the spectrogram plot first." },
  { scopes: ["sessionTabs", "tutorialTabs"], title: "Session & tutorial tabs", note: "Focus a tab in the corresponding tab strip first." },
  { scopes: ["queueResize", "spectrogramResize", "windowInput", "gainInput"], title: "Panel sizing, time window & gain", note: "Focus the corresponding divider, Window input, or Gain input first. Gain also applies when leaving its field; Clear selection cancels an uncommitted gain entry without clearing viewer selections." },
  { scopes: ["coach"], title: "Walkthrough positioning", note: "Focus the walkthrough’s Move handle first. Placement still avoids covering the highlighted target." },
];

type KeyEvent = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; getModifierState?(key: string): boolean };
const namedKeys = new Set(["Escape", "Enter", "Space", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Plus", "Minus"]);

/** Ctrl and Command are one portable modifier. Shifted +/- and punctuation use their printed symbol. */
export function shortcutFromEvent(event: KeyEvent): string | null {
  if (event.isComposing || event.getModifierState?.("AltGraph") || (event.ctrlKey && event.metaKey)) return null;
  let key = event.key;
  if (event.altKey && /^Key[A-Z]$/.test(event.code ?? "")) key = event.code!.slice(3).toLowerCase();
  if (key === " ") key = "Space";
  if (key === "+" || key === "=") key = "Plus";
  if (key === "-" || key === "_") key = "Minus";
  if (key.length === 1) key = key.toLowerCase();
  if (!namedKeys.has(key) && !/^F([1-9]|1[0-2])$/.test(key) && !/^[a-z0-9?,./;:'"\[\]\\`~!@#$%^&*(){}<>|]$/.test(key)) return null;
  const shiftedSymbol = key === "Plus" || key === "Minus" || (key.length === 1 && !/^[a-z0-9]$/.test(key));
  return [event.ctrlKey || event.metaKey ? "Mod" : "", event.altKey ? "Alt" : "", event.shiftKey && !shiftedSymbol ? "Shift" : "", key].filter(Boolean).join("+");
}

function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split("+");
  const key = parts.pop()!;
  if (new Set(parts).size !== parts.length || parts.some((part) => !["Mod", "Alt", "Shift"].includes(part))) return null;
  return shortcutFromEvent({ key, ctrlKey: parts.includes("Mod"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift") });
}

export function shortcutLabel(chord: string): string {
  return chord.split("+").map((part) => ({ Mod: "Ctrl/⌘", Plus: "+", Minus: "−", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" })[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join(" + ");
}

export function shortcutHint(bindings: ControlBindings, action: ShortcutAction): string {
  return bindings[action].map(shortcutLabel).join(" or ") || "Not assigned";
}

/** Tutorial copy resolves key hints at render time so remapping cannot leave stale instructions. */
export function shortcutText(text: string, bindings: ControlBindings): string {
  return text.replace(/\{shortcut:([^}]+)\}/g, (_, action: string) => Object.hasOwn(bindings, action) ? shortcutHint(bindings, action as ShortcutAction) : "Not assigned");
}

export function matchesShortcut(event: KeyEvent, bindings: ControlBindings, action: ShortcutAction): boolean {
  const chord = shortcutFromEvent(event);
  return chord !== null && bindings[action].includes(chord);
}

export function shortcutAction(event: KeyEvent, bindings: ControlBindings, scopes: ShortcutScope[]): ShortcutAction | null {
  const chord = shortcutFromEvent(event);
  return chord ? SHORTCUTS.find((item) => scopes.includes(item.scope) && bindings[item.id].includes(chord))?.id ?? null : null;
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || a === "workspace" || b === "workspace" || ([a, b].includes("viewer") && [a, b].includes("waveform"));
}

/** Reject ambiguous shortcuts only where their focus contexts can actually overlap. */
export function shortcutConflict(bindings: ControlBindings, action: ShortcutAction, chord: string): string | null {
  const scope = SHORTCUTS.find((item) => item.id === action)!.scope;
  return SHORTCUTS.find((item) => item.id !== action && scopesOverlap(scope, item.scope) && bindings[item.id].includes(chord))?.label ?? null;
}

/** Browser-owned focus/editing chords cannot reliably be overridden by a web application. */
export function shortcutRestriction(chord: string, action: ShortcutAction): string | null {
  if (/^Mod\+(?:Shift\+)?(?:[acflnqrtvw]|Space)$/.test(chord) || /^Alt\+(?:F4|ArrowLeft|ArrowRight)$/.test(chord) || chord === "F5" || chord === "F11" || chord === "F12") return "That combination is reserved by the browser or system. Choose another.";
  const typingKey = chord.split("+").at(-1)!;
  if (["windowApply", "gainApply"].includes(action) && !/^(Mod|Alt)\+/.test(chord) && typingKey !== "Enter" && !/^F\d+$/.test(typingKey)) return "Choose Enter, a function key, or Ctrl/⌘/Alt combination so you can still type an amount.";
  if (["undo", "redo", "clear"].includes(action) && /^(Shift\+)?(Enter|Space)$/.test(chord)) return "Enter and Space activate focused buttons. Use a modifier combination for workspace-wide shortcuts.";
  return null;
}

/** Restore current arrays or migrate the original seven letter-only preferences, including implicit Shift+redo. */
export function normalizeControlBindings(value: unknown): ControlBindings {
  const result = Object.fromEntries(SHORTCUTS.map(({ id }) => [id, []])) as unknown as ControlBindings;
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const legacy = Object.values(saved).some((entry) => typeof entry === "string");
  const desired = { ...DEFAULT_CONTROLS };
  for (const item of SHORTCUTS) {
    const entry = saved[item.id];
    if (Array.isArray(entry)) desired[item.id] = [...new Set(entry.map(normalizeShortcut).filter((key): key is string => key !== null && !shortcutRestriction(key, item.id)))];
    else if (legacy && typeof entry === "string" && /^[a-z]$/i.test(entry)) {
      const key = `${item.id === "redo" ? "Shift+" : ""}${entry.toLowerCase()}`;
      desired[item.id] = item.id === "undo" ? ["Mod+z", key] : item.id === "redo" ? ["Mod+Shift+z", key] : [key];
    }
  }
  // Custom choices win over newly introduced defaults; corrupt duplicate preferences are resolved deterministically.
  const ordered = [...SHORTCUTS].sort((a, b) => Number(Object.hasOwn(saved, b.id)) - Number(Object.hasOwn(saved, a.id)));
  for (const { id } of ordered) result[id] = desired[id].filter((key) => !shortcutConflict(result, id, key));
  return result;
}
