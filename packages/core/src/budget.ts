export interface Budget {
  pxPerToken: number;
  maxTargetPx: number;
  maxTargetTokens: number;
}

export const DEFAULT_BUDGET: Budget = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 };

function fits(w: number, h: number, b: Budget): boolean {
  return Math.max(w, h) <= b.maxTargetPx
    && Math.ceil(w / b.pxPerToken) * Math.ceil(h / b.pxPerToken) <= b.maxTargetTokens;
}

/** Largest size with the same aspect ratio that satisfies the pixel and token limits. */
export function fitBudget(w: number, h: number, b: Budget): [number, number] {
  if (fits(w, h, b)) return [w, h];
  const long = Math.max(w, h);
  const at = (l: number): [number, number] => {
    const k = l / long;
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  };
  let lo = 1;
  let hi = long;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const [a, c] = at(mid);
    if (fits(a, c, b)) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}

/** CDP output size = CSS size * dpr * clip.scale, so the scale is measured against device pixels. */
export function planCapture(
  viewportW: number,
  viewportH: number,
  dpr: number,
  b: Budget = DEFAULT_BUDGET,
): { clipScale: number; outWidth: number; outHeight: number } {
  const s = Math.round(viewportW * dpr);
  const e = Math.round(viewportH * dpr);
  const [m] = fitBudget(s, e, b);
  const clipScale = Math.min(1, m / s);
  return { clipScale, outWidth: Math.round(s * clipScale), outHeight: Math.round(e * clipScale) };
}
