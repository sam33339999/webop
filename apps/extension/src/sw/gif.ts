import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { ContentBlock } from "@webop/core/protocol";
import type { ScreenshotContext } from "@webop/core/coords";
import { siteOf } from "@webop/core/domain";
import { GIF_MAX_FRAMES, GIF_MAX_WIDTH, planFrames, type FrameMeta, type GifStep, type PlannedFrame, type Point } from "@webop/core/gif";
import { CdpError } from "./cdp.ts";

/** One recorded frame: the encoded screenshot bytes (decoded only at export) and what happened to produce it. */
interface Frame {
  bytes: Uint8Array;
  mimeType: string;
  ctx: ScreenshotContext;
  meta: FrameMeta;
}

interface Recording {
  recording: boolean;
  frames: Frame[];
  /** A frame was refused because the limit was reached. */
  capped: boolean;
}

const recordings = new Map<string, Recording>();

const MARKER_RADIUS = 18;
const MARKER_LINE = 4;
const MARKER_COLOR = "#ef4444";
const CAPTION_HEIGHT = 36;
const CAPTION_FONT = "16px sans-serif";
const CAPTION_PAD = 10;

export function isRecording(session_id: string): boolean {
  return recordings.get(session_id)?.recording ?? false;
}

/** Drops any earlier frames and starts recording. */
export function start(session_id: string): void {
  recordings.set(session_id, { recording: true, frames: [], capped: false });
}

/** Stops recording and keeps the frames; returns how many there are. */
export function stop(session_id: string): number {
  const r = recordings.get(session_id);
  if (!r) return 0;
  r.recording = false;
  return r.frames.length;
}

export function frameCount(session_id: string): number {
  return recordings.get(session_id)?.frames.length ?? 0;
}

export function isCapped(session_id: string): boolean {
  return recordings.get(session_id)?.capped ?? false;
}

export function clear(session_id: string): void {
  const r = recordings.get(session_id);
  if (!r) return;
  r.frames = [];
  r.capped = false;
}

/** The session ended: its frames are discarded and recording stops. */
export function dropSession(session_id: string): void {
  recordings.delete(session_id);
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Adds a frame to the session's recording. Ignored when not recording or when the block is not an image; once the
 * limit is reached further frames are dropped and the recording is marked capped.
 */
export function record(session_id: string, tabId: number, url: string, block: ContentBlock, ctx: ScreenshotContext, step: GifStep): void {
  const r = recordings.get(session_id);
  if (!r || !r.recording || block.type !== "image") return;
  if (r.frames.length >= GIF_MAX_FRAMES) {
    r.capped = true;
    return;
  }
  r.frames.push({
    bytes: decodeBase64(block.data),
    mimeType: block.mimeType,
    ctx,
    meta: { tabId, site: siteOf(url) ?? "", step },
  });
}

interface Layout { scale: number; dx: number; dy: number }

/** Fits a w×h image into the output size, keeping its aspect ratio and centring it. */
function fit(w: number, h: number, outW: number, outH: number): Layout {
  const scale = Math.min(outW / w, outH / h);
  return { scale, dx: (outW - w * scale) / 2, dy: (outH - h * scale) / 2 };
}

const place = (p: Point, l: Layout): Point => [p[0] * l.scale + l.dx, p[1] * l.scale + l.dy];

function drawMarker(g: OffscreenCanvasRenderingContext2D, marker: NonNullable<PlannedFrame["marker"]>, l: Layout): void {
  const [x, y] = place(marker.point, l);
  g.strokeStyle = MARKER_COLOR;
  g.fillStyle = MARKER_COLOR;
  g.lineWidth = MARKER_LINE;
  if (marker.to) {
    const [tx, ty] = place(marker.to, l);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(tx, ty);
    g.stroke();
    // Arrow head at the drop point.
    const angle = Math.atan2(ty - y, tx - x);
    const head = 16;
    g.beginPath();
    g.moveTo(tx, ty);
    g.lineTo(tx - head * Math.cos(angle - Math.PI / 6), ty - head * Math.sin(angle - Math.PI / 6));
    g.lineTo(tx - head * Math.cos(angle + Math.PI / 6), ty - head * Math.sin(angle + Math.PI / 6));
    g.closePath();
    g.fill();
  }
  g.beginPath();
  g.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(x, y, MARKER_LINE, 0, Math.PI * 2);
  g.fill();
}

/** Shortens `text` with an ellipsis until it fits `maxWidth`. */
function truncate(g: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (g.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 0 && g.measureText(chars.join("") + "…").width > maxWidth) chars.pop();
  return chars.join("") + "…";
}

function drawCaption(g: OffscreenCanvasRenderingContext2D, caption: string, w: number, h: number): void {
  g.fillStyle = "rgba(0, 0, 0, 0.7)";
  g.fillRect(0, h - CAPTION_HEIGHT, w, CAPTION_HEIGHT);
  g.font = CAPTION_FONT;
  g.fillStyle = "#ffffff";
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillText(truncate(g, caption, w - 2 * CAPTION_PAD), CAPTION_PAD, h - CAPTION_HEIGHT / 2);
}

/**
 * Encodes the session's frames into an animated GIF (infinite loop) with click markers and a caption bar on each
 * frame. Frames are kept after export. Throws `no_frames` when there is nothing to export.
 */
export async function exportGif(session_id: string): Promise<{ bytes: Uint8Array; frames: number; capped: boolean }> {
  const r = recordings.get(session_id);
  const frames = r ? [...r.frames] : [];
  const capped = r?.capped ?? false;
  if (frames.length === 0) throw new CdpError("no_frames", "No frames recorded; call start_recording, then act on a tab (browser_computer, browser_form_input, browser_navigate) before export.");
  const plan = planFrames(frames.map((f) => f.meta));
  const first = await createImageBitmap(new Blob([frames[0].bytes as BlobPart], { type: frames[0].mimeType }));
  const outW = Math.max(1, Math.min(first.width, GIF_MAX_WIDTH));
  const outH = Math.max(1, Math.round((first.height * outW) / first.width));
  const canvas = new OffscreenCanvas(outW, outH);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new CdpError("export_failed", "Could not create a 2D canvas.");
  const enc = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const bmp = i === 0 ? first : await createImageBitmap(new Blob([frames[i].bytes as BlobPart], { type: frames[i].mimeType }));
    try {
      g.fillStyle = "#000000";
      g.fillRect(0, 0, outW, outH);
      const l = fit(bmp.width, bmp.height, outW, outH);
      g.drawImage(bmp, l.dx, l.dy, bmp.width * l.scale, bmp.height * l.scale);
      // Marker points are in the frame's own screenshot space; map them through the same fit as the image.
      const p = plan[i];
      const own = frames[i].ctx;
      const unit = own.screenshotWidth > 0 ? bmp.width / own.screenshotWidth : 1;
      if (p.marker) {
        const ml: Layout = { scale: l.scale * unit, dx: l.dx, dy: l.dy };
        drawMarker(g, p.marker, ml);
      }
      drawCaption(g, p.caption, outW, outH);
    } finally {
      bmp.close();
    }
    const { data } = g.getImageData(0, 0, outW, outH);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    const delay = plan[i].durationMs;
    enc.writeFrame(index, outW, outH, i === 0 ? { palette, delay, repeat: 0 } : { palette, delay });
  }
  enc.finish();
  return { bytes: enc.bytes(), frames: frames.length, capped };
}
