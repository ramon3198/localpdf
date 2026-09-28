// Bold, italic and colour of OCR'd words, measured on the scan itself: tesseract's LSTM engine reports no font
// attributes. Bold letters have thicker stems (≈ 0.14 em against ≈ 0.085 em), measured as the dark runs across the
// x-height band; italic letters lean, so their columns of ink line up best once the word is sheared back by ≈ 0.2 (12°);
// the colour is the one of the word's darkest pixels (the cores of its strokes).
import * as UPNGModule from "@pdf-lib/upng";
import { decodeJpeg } from "./graphics-jpeg";
import { encodePng } from "./graphics-place";
import type { RenderedImage, TextLine } from "./types";

type UpngDecode = { decode: (buf: ArrayBuffer) => unknown; toRGBA8: (img: unknown) => ArrayBuffer[] };
const UPNG: UpngDecode = ((UPNGModule as unknown as { default?: UpngDecode }).default ?? UPNGModule) as unknown as UpngDecode;

/** Grey levels of a rendered page, row by row (0 black – 255 white), and its colours (RGB) when it has any. */
export type GreyImage = { width: number; height: number; grey: Uint8Array; color?: { data: Uint8Array; stride: number } };

/** The rendered page in grey levels (PNG or JPEG), or null when it can't be decoded here. */
export const greyImage = (image: RenderedImage): GreyImage | null => {
    try {
        if (image.mime === "image/png") {
            const bytes = image.data;
            const buf = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
            const decoded = UPNG.decode(buf) as { width: number; height: number };
            const frames = UPNG.toRGBA8(decoded);
            if (!frames[0]) return null;
            const px = new Uint8Array(frames[0]);
            const n = decoded.width * decoded.height;
            const grey = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                const o = 4 * i;
                const g = (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) / 1000;
                grey[i] = Math.round(255 - (px[o + 3] / 255) * (255 - g));
            }
            return { width: decoded.width, height: decoded.height, grey, color: { data: px, stride: 4 } };
        }
        const jpeg = decodeJpeg(image.data);
        if (!jpeg || (jpeg.components !== 1 && jpeg.components !== 3)) return null;
        const n = jpeg.width * jpeg.height;
        const grey = new Uint8Array(n);
        for (let i = 0; i < n; i++)
            grey[i] =
                jpeg.components === 1 ? jpeg.data[i] : Math.round((jpeg.data[3 * i] * 299 + jpeg.data[3 * i + 1] * 587 + jpeg.data[3 * i + 2] * 114) / 1000);
        return { width: jpeg.width, height: jpeg.height, grey, ...(jpeg.components === 3 ? { color: { data: jpeg.data, stride: 3 } } : {}) };
    } catch {
        return null;
    }
};

/** Shears tried to stand a word's strokes upright (0 = upright; italic leans ≈ 0.2). */
export const SHEARS = [-0.1, 0, 0.1, 0.2, 0.3];

/**
 * Ink measurements of one word: stem thickness in em, how sharp its columns of ink are at each of SHEARS, and the
 * colour of its darkest pixels (RGB 0–255, when the image has colours).
 */
export type WordInk = { stem: number; sharpness: number[]; pixels: number; color?: [number, number, number] };

/**
 * Measures a word in the page image. `box`: its pixel box; `baseline`: pixel row of its baseline; `em`: its font size
 * in pixels. Null when the box is too small or too faint to measure, or holds light letters on a dark ground.
 */
export const measureWord = (img: GreyImage, box: { x: number; y: number; width: number; height: number }, baseline: number, em: number): WordInk | null => {
    const x0 = Math.max(0, Math.floor(box.x));
    const x1 = Math.min(img.width, Math.ceil(box.x + box.width));
    const y0 = Math.max(0, Math.floor(box.y));
    const y1 = Math.min(img.height, Math.ceil(box.y + box.height));
    if (x1 - x0 < 4 || y1 - y0 < 4 || em < 10) return null;
    const W = img.width;
    const g = img.grey;
    // Ink: darker than halfway between the word's darkest and lightest grey.
    let lo = 255;
    let hi = 0;
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const v = g[y * W + x];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    if (hi - lo < 60) return null;
    const T = (lo + hi) / 2;
    // Mostly dark: light letters on a dark band (the "ink" would be the ground).
    let dark = 0;
    let r = 0;
    let gg = 0;
    let b = 0;
    let core = 0;
    const deep = lo + 0.3 * (hi - lo);
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const v = g[y * W + x];
            if (v < T) dark++;
            if (v <= deep && img.color) {
                const o = img.color.stride * (y * W + x);
                r += img.color.data[o];
                gg += img.color.data[o + 1];
                b += img.color.data[o + 2];
                core++;
            }
        }
    if (dark > 0.5 * (x1 - x0) * (y1 - y0)) return null;
    // Stems: dark runs across the rows of the x-height body (bars and bowls' tops lie outside it), measured to a fraction
    // of a pixel — each pixel counts with its share of ink, the half-covered ones at the run's edges too.
    const cover = (v: number) => Math.max(0, Math.min(1, (hi - v) / (hi - lo)));
    const runs: number[] = [];
    const bandTop = Math.max(y0, Math.round(baseline - 0.36 * em));
    const bandBottom = Math.min(y1 - 1, Math.round(baseline - 0.12 * em));
    for (let y = bandTop; y <= bandBottom; y++) {
        const row = y * W;
        let start = -1;
        for (let x = x0; x <= x1; x++) {
            const dark = x < x1 && g[row + x] < T;
            if (dark && start < 0) start = x;
            else if (!dark && start >= 0) {
                let width = 0;
                for (let k = start; k < x; k++) width += cover(g[row + k]);
                if (start > x0) width += cover(g[row + start - 1]);
                if (x < x1) width += cover(g[row + x]);
                runs.push(width);
                start = -1;
            }
        }
    }
    if (runs.length < 4) return null;
    runs.sort((a, b) => a - b);
    // Stems, not bars or joins: the lower-middle of the runs.
    const middle = runs.slice(Math.floor(0.2 * runs.length), Math.max(Math.floor(0.2 * runs.length) + 1, Math.ceil(0.6 * runs.length)));
    const stem = middle.reduce((a, b) => a + b, 0) / middle.length / em;
    // Slant: columns of ink after shearing each row back by s · (height above the baseline).
    const top = Math.max(y0, Math.round(baseline - 0.72 * em));
    const bottomRow = Math.min(y1, Math.round(baseline));
    let pixels = 0;
    const sharpness = SHEARS.map((s) => {
        const off = Math.ceil(Math.abs(s) * (baseline - top)) + 1;
        const cols = new Float64Array(x1 - x0 + 2 * off + 1);
        let total = 0;
        for (let y = top; y < bottomRow; y++) {
            const shift = Math.round(s * (baseline - y));
            for (let x = x0; x < x1; x++)
                if (g[y * W + x] < T) {
                    cols[x - x0 + off - shift]++;
                    total++;
                }
        }
        pixels = total;
        let sq = 0;
        for (const c of cols) sq += c * c;
        return total ? sq / (total * total) : 0;
    });
    return core ? { stem, sharpness, pixels, color: [r / core, gg / core, b / core] } : { stem, sharpness, pixels };
};

// ── Clean scan backgrounds ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A scanned page's background without the text that OCR turned into real text: each run's box is painted over with
 * the ground under its letters (the box's median colour) — rules crossing the box stay — so a positioned (layout) page
 * keeps the scan's pictures, rules and bands without showing its letters a second time behind the editable ones.
 * `lines` are in page points (the page's OCR lines, or the invisible OCR layer); the result is a PNG of the same size.
 */
export const cleanScanBackground = (image: RenderedImage, lines: TextLine[], page: { width: number; height: number }): RenderedImage => {
    let width = 0;
    let height = 0;
    let rgba: Uint8Array;
    try {
        if (image.mime === "image/png") {
            const bytes = image.data;
            const buf = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
            const decoded = UPNG.decode(buf) as { width: number; height: number };
            const frames = UPNG.toRGBA8(decoded);
            if (!frames[0]) return image;
            [width, height, rgba] = [decoded.width, decoded.height, new Uint8Array(frames[0]).slice()];
        } else {
            const jpeg = decodeJpeg(image.data);
            if (!jpeg || (jpeg.components !== 1 && jpeg.components !== 3)) return image;
            [width, height] = [jpeg.width, jpeg.height];
            rgba = new Uint8Array(4 * width * height);
            for (let i = 0; i < width * height; i++) {
                const c = jpeg.components;
                rgba[4 * i] = jpeg.data[c * i];
                rgba[4 * i + 1] = jpeg.data[c * i + (c === 3 ? 1 : 0)];
                rgba[4 * i + 2] = jpeg.data[c * i + (c === 3 ? 2 : 0)];
                rgba[4 * i + 3] = 255;
            }
        }
    } catch {
        return image;
    }
    const sx = width / page.width;
    const sy = height / page.height;
    const at = (x: number, y: number) => 4 * (y * width + x);
    for (const line of lines) {
        if (line.rotation) continue;
        const size = line.fontSize || 10;
        const pad = Math.max(1.5, 0.15 * size);
        const top = Math.max(0, Math.floor((line.baseline - 0.95 * size - 0.5) * sy));
        const bottom = Math.min(height - 1, Math.ceil((line.baseline + 0.25 * size + 0.5) * sy));
        for (const run of line.runs) {
            if (!run.text.trim()) continue;
            const left = Math.max(0, Math.floor((run.box.x - pad) * sx));
            const right = Math.min(width - 1, Math.ceil((run.box.x + run.box.width + pad) * sx));
            if (right <= left || bottom <= top) continue;
            // The ground under the letters: the box's median colour (ink covers a small part of a text box; on a coloured
            // band the band's colour, so light letters on it go and the band stays).
            const ground: number[][] = [[], [], []];
            const step = Math.max(1, Math.floor((right - left) * (bottom - top)) > 4000 ? 2 : 1);
            for (let y = top; y <= bottom; y += step)
                for (let x = left; x <= right; x += step) {
                    const o = at(x, y);
                    for (let c = 0; c < 3; c++) ground[c].push(rgba[o + c]);
                }
            const fill = ground.map((v) => v.sort((p, q) => p - q)[v.length >> 1]);
            const ink = (o: number) => Math.max(Math.abs(rgba[o] - fill[0]), Math.abs(rgba[o + 1] - fill[1]), Math.abs(rgba[o + 2] - fill[2])) > 48;
            // Rules crossing the box (a table's borders under its text) are rows or columns of ink from end to end that go
            // on outside it: kept.
            const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
            const keepRow = new Uint8Array(bottom - top + 1);
            const keepCol = new Uint8Array(right - left + 1);
            for (let y = top; y <= bottom; y++) {
                let n = 0;
                for (let x = left; x <= right; x++) if (ink(at(x, y))) n++;
                const beyond = (!inside(left - 2, y) || ink(at(left - 2, y))) && (!inside(right + 2, y) || ink(at(right + 2, y)));
                if (n >= 0.85 * (right - left + 1) && beyond) keepRow[y - top] = 1;
            }
            for (let x = left; x <= right; x++) {
                let n = 0;
                for (let y = top; y <= bottom; y++) if (ink(at(x, y))) n++;
                const beyond = (!inside(x, top - 2) || ink(at(x, top - 2))) && (!inside(x, bottom + 2) || ink(at(x, bottom + 2)));
                if (n >= 0.85 * (bottom - top + 1) && beyond) keepCol[x - left] = 1;
            }
            // Each row takes the ground just left and right of the box when both sides agree (a band's edge, the paper
            // above it), else the box's.
            const side = (x0: number, x1: number, y: number) => {
                const c = [0, 0, 0];
                let n = 0;
                for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
                    const o = at(x, y);
                    c[0] += rgba[o];
                    c[1] += rgba[o + 1];
                    c[2] += rgba[o + 2];
                    n++;
                }
                return n ? c.map((v) => v / n) : null;
            };
            for (let y = top; y <= bottom; y++) {
                if (keepRow[y - top]) continue;
                const l = side(left - 4, left - 2, y);
                const r = side(right + 2, right + 4, y);
                const row = l && r && Math.max(...l.map((v, i) => Math.abs(v - r[i]))) < 40 ? l.map((v, i) => Math.round((v + r[i]) / 2)) : fill;
                for (let x = left; x <= right; x++) {
                    if (keepCol[x - left]) continue;
                    const o = at(x, y);
                    rgba[o] = row[0];
                    rgba[o + 1] = row[1];
                    rgba[o + 2] = row[2];
                    rgba[o + 3] = 255;
                }
            }
        }
    }
    return { data: encodePng({ width, height, rgba, alpha: false }), mime: "image/png", pixelWidth: width, pixelHeight: height };
};
