/** Normalized vertical slice of the complete waveform channel surface. */
export interface NormalizedVerticalViewport {
  top: number;
  bottom: number;
}

function assertViewport(viewport: NormalizedVerticalViewport, label: string) {
  if (!Number.isFinite(viewport.top)
    || !Number.isFinite(viewport.bottom)
    || viewport.top < 0
    || viewport.bottom > 1
    || viewport.bottom <= viewport.top) {
    throw new Error(`${label} must be a non-empty normalized vertical range.`);
  }
}

/** Fits a screen-space box inside the current vertical viewport. */
export function composeVerticalViewport(
  current: NormalizedVerticalViewport | null,
  selection: NormalizedVerticalViewport,
): NormalizedVerticalViewport {
  const parent = current ?? { top: 0, bottom: 1 };
  assertViewport(parent, "Current waveform viewport");
  assertViewport(selection, "Waveform box selection");
  const span = parent.bottom - parent.top;
  return {
    top: parent.top + selection.top * span,
    bottom: parent.top + selection.bottom * span,
  };
}

/** Maps complete-channel-space coordinates into the magnified screen viewport. */
export function projectVerticalFraction(
  contentFraction: number,
  viewport: NormalizedVerticalViewport | null,
) {
  if (!viewport) return contentFraction;
  assertViewport(viewport, "Waveform viewport");
  return (contentFraction - viewport.top) / (viewport.bottom - viewport.top);
}

/** Maps a pointer position in the magnified view back to complete channel space. */
export function unprojectVerticalFraction(
  screenFraction: number,
  viewport: NormalizedVerticalViewport | null,
) {
  if (!viewport) return screenFraction;
  assertViewport(viewport, "Waveform viewport");
  return viewport.top + screenFraction * (viewport.bottom - viewport.top);
}
