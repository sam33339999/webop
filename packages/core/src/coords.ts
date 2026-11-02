export interface ScreenshotContext {
  viewportWidth: number;
  viewportHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
}

export function toViewport(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): { viewport: [number, number] } | { oobError: string } {
  const { viewportWidth, viewportHeight, screenshotWidth, screenshotHeight } = ctx;
  const inBounds = Number.isFinite(x) && Number.isFinite(y)
    && !(x < 0 || y < 0 || x >= screenshotWidth + 2 || y >= screenshotHeight + 2);
  if (!inBounds) {
    return {
      oobError: `Coordinate (${x}, ${y}) is outside the coordinate frame (${screenshotWidth}x${screenshotHeight}). Coordinates are pixels in the full-resolution frame, not a scaled image's own pixels. If the page changed, take a new screenshot first.`,
    };
  }
  return {
    viewport: [
      Math.round((x * viewportWidth) / screenshotWidth),
      Math.round((y * viewportHeight) / screenshotHeight),
    ],
  };
}

/** Inverse of toViewport: viewport pixels → screenshot-frame pixels. */
export function fromViewport(x: number, y: number, ctx: ScreenshotContext): [number, number] {
  const { viewportWidth, viewportHeight, screenshotWidth, screenshotHeight } = ctx;
  return [
    Math.round((x * screenshotWidth) / viewportWidth),
    Math.round((y * screenshotHeight) / viewportHeight),
  ];
}
