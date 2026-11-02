declare const __DEV__: boolean;

declare module "gifenc" {
  export type Palette = number[][];
  export interface WriteFrameOptions { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; first?: boolean }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: object): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array;
}
