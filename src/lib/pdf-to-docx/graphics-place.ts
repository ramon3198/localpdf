// Where and how an image appears on the page: the unit square mapped by the CTM, clipped to the clip and the page.
// Upright, uncropped pictures keep their original bytes (JPEG stays JPEG); flipped, rotated or cropped ones are
// resampled into the visible box so Word shows exactly what the PDF shows.
import * as UPNGModule from "@pdf-lib/upng";
import type { Matrix } from "../pdf-text-engine/text-interpreter";
import type { RGB } from "./graphics-color";
import type { DecodedImage, Raster } from "./graphics-image";
import type { ImageDraw } from "./graphics-interpreter";
import { encodeJpeg } from "./graphics-jpegenc";
import { type Box, type ClipShape, boxH, boxW, intersectBox, polyBounds, shapeSpans } from "./graphics-region";
import type { PlacedImage } from "./types";

type Encoded = { ctype: number };
type UpngApi = {
    encode: ((bufs: ArrayBuffer[], w: number, h: number, cnum: number) => ArrayBuffer) & {
        // UPNG's own stages, used to pick the row filter (its one-call encoder leaves big images unfiltered).
        compress?: (bufs: ArrayBuffer[], w: number, h: number, cnum: number, prms: unknown[]) => Encoded;
        compressPNG?: (nimg: Encoded, filter: number) => void;
        _main?: (nimg: Encoded, w: number, h: number, dels: number[], tabs: object) => ArrayBuffer;
    };
};
const UPNG: UpngApi = ((UPNGModule as unknown as { default?: UpngApi }).default ?? UPNGModule) as UpngApi;

/** Longest side of a resampled image, in pixels. */
const MAX_SIDE = 4096;

export const encodePng = (r: Raster): Uint8Array => {
    const buf = (r.rgba.buffer.byteLength === r.rgba.length && r.rgba.byteOffset === 0 ? r.rgba.buffer : r.rgba.slice().buffer) as ArrayBuffer;
    const enc = UPNG.encode;
    if (enc.compress && enc.compressPNG && enc._main) {
        try {
            const nimg = enc.compress([buf], r.width, r.height, 0, [false, false, false, 0, false]);
            // Palette images compress best unfiltered; photos and gradients with the Paeth filter; small ones try all.
            const filter = nimg.ctype === 3 ? 0 : r.width * r.height > 120_000 ? 4 : -1;
            enc.compressPNG(nimg, filter);
            return new Uint8Array(enc._main(nimg, r.width, r.height, [], {}));
        } catch {
            /* fall back to the one-call encoder */
        }
    }
    return new Uint8Array(enc([buf], r.width, r.height, 0));
};

/**
 * PNG or JPEG for pixels that had to be decoded: JPEG for photographs (the source was a JPEG, or a large opaque
 * image that PNG cannot compress), PNG for everything else — transparency, drawings, screenshots, small images.
 */
export const encodeImage = (r: Raster, photo: boolean): { mime: "image/png" | "image/jpeg"; data: Uint8Array } => {
    if (!r.alpha && photo && r.width * r.height >= 4096) return { mime: "image/jpeg", data: encodeJpeg(r, 92) };
    const png = encodePng(r);
    const pixels = r.width * r.height;
    if (!r.alpha && pixels >= 250_000 && png.length > 1.2 * pixels) {
        const jpg = encodeJpeg(r, 90);
        if (jpg.length < 0.5 * png.length) return { mime: "image/jpeg", data: jpg };
    }
    return { mime: "image/png", data: png };
};

/**
 * The colour of an image that is one colour to the eye — 1×1 fills, solid swatches, faint background gradients
 * (every channel within 10/255) — or null. Large images are sampled on a grid.
 */
export const uniformColor = (r: Raster): { rgb: RGB; alpha: number } | null => {
    const d = r.rgba;
    const n = r.width * r.height;
    const step = n <= 16384 ? 1 : Math.ceil(Math.sqrt(n / 16384));
    const lo = [255, 255, 255, 255];
    const hi = [0, 0, 0, 0];
    const sum = [0, 0, 0, 0];
    let count = 0;
    for (let y = 0; y < r.height; y += step)
        for (let x = 0; x < r.width; x += step) {
            const o = (y * r.width + x) * 4;
            for (let k = 0; k < 4; k++) {
                const v = d[o + k];
                if (v < lo[k]) lo[k] = v;
                if (v > hi[k]) hi[k] = v;
                sum[k] += v;
            }
            count++;
            if (hi[0] - lo[0] > 10 || hi[1] - lo[1] > 10 || hi[2] - lo[2] > 10 || hi[3] !== lo[3]) return null;
        }
    if (!count) return null;
    return { rgb: [sum[0] / count / 255, sum[1] / count / 255, sum[2] / count / 255], alpha: lo[3] / 255 };
};

const invert = (m: Matrix): Matrix | null => {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

/** Inside spans of every shaped clip on the line y, intersected. */
const clipSpans = (shapes: ClipShape[], y: number): [number, number][] => {
    let spans: [number, number][] | null = null;
    for (const sh of shapes) {
        const next = shapeSpans(sh, y);
        if (!spans) spans = next;
        else {
            const out: [number, number][] = [];
            for (const [a0, a1] of spans)
                for (const [b0, b1] of next) {
                    const lo = Math.max(a0, b0);
                    const hi = Math.min(a1, b1);
                    if (hi > lo) out.push([lo, hi]);
                }
            spans = out;
        }
    }
    return spans ?? [];
};

/** Whether a shaped clip leaves the corners of a box visible (then it does not cut the picture). */
const cornersInside = (b: Box, shapes: ClipShape[]) => {
    const inset = 0.75;
    for (const y of [b.y0 + inset, b.y1 - inset]) {
        const spans = clipSpans(shapes, y);
        for (const x of [b.x0 + inset, b.x1 - inset]) if (!spans.some(([a, c]) => x >= a && x < c)) return false;
    }
    return true;
};

/**
 * Resamples the part of the image inside `vis` (display space) onto an upright pixel grid (nearest neighbour);
 * pixels outside the shaped clips (a circular portrait, rounded corners) become transparent.
 */
const resample = (src: Raster, ctm: Matrix, vis: Box, alphaMul: number, shapes?: ClipShape[]): Raster | null => {
    const inv = invert(ctm);
    if (!inv) return null;
    const [a, b, c, d] = ctm;
    const area = Math.abs(a * d - b * c);
    // Keep the source's pixel density.
    const density = Math.sqrt((src.width * src.height) / Math.max(area, 1e-9));
    let ow = Math.max(1, Math.round(boxW(vis) * density));
    let oh = Math.max(1, Math.round(boxH(vis) * density));
    const scale = Math.min(1, MAX_SIDE / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * scale));
    oh = Math.max(1, Math.round(oh * scale));
    if (ow * oh > 40_000_000) return null;
    const out = new Uint8Array(ow * oh * 4);
    const sx = boxW(vis) / ow;
    const sy = boxH(vis) / oh;
    let alpha = false;
    for (let j = 0; j < oh; j++) {
        const y = vis.y0 + (j + 0.5) * sy;
        const spans = shapes ? clipSpans(shapes, y) : null;
        for (let i = 0; i < ow; i++) {
            const x = vis.x0 + (i + 0.5) * sx;
            const u = x * inv[0] + y * inv[2] + inv[4];
            const v = x * inv[1] + y * inv[3] + inv[5];
            const o = (j * ow + i) * 4;
            if (u < 0 || u >= 1 || v <= 0 || v > 1 || (spans && !spans.some(([a, c]) => x >= a && x < c))) {
                alpha = true;
                continue;
            }
            const col = Math.min(src.width - 1, Math.floor(u * src.width));
            const row = Math.min(src.height - 1, Math.floor((1 - v) * src.height));
            const s = (row * src.width + col) * 4;
            out[o] = src.rgba[s];
            out[o + 1] = src.rgba[s + 1];
            out[o + 2] = src.rgba[s + 2];
            const al = Math.round(src.rgba[s + 3] * alphaMul);
            out[o + 3] = al;
            if (al !== 255) alpha = true;
        }
    }
    return { width: ow, height: oh, rgba: out, alpha };
};

export type Placement = { image: PlacedImage } | { fill: { box: Box; rgb: RGB; alpha: number } } | null;

const toRect = (b: Box) => ({ x: b.x0, y: b.y0, width: boxW(b), height: boxH(b) });

/** Turns a decoded image and its drawing state into a placed picture (or a fill, for single-colour images). */
export const placeImage = (draw: ImageDraw, decoded: DecodedImage, page: Box): Placement => {
    if (decoded.kind === "unsupported" || decoded.kind === "invalid") return null;
    const m = draw.ctm;
    const corners = [m[4], m[5], m[0] + m[4], m[1] + m[5], m[2] + m[4], m[3] + m[5], m[0] + m[2] + m[4], m[1] + m[3] + m[5]];
    const full = polyBounds(corners);
    if (boxW(full) < 0.1 || boxH(full) < 0.1) return null;
    const clipped = intersectBox(full, draw.clip.bbox);
    const vis = clipped && intersectBox(clipped, page);
    if (!vis) return null;
    const tol = 0.005;
    const upright = Math.abs(m[1]) <= tol * Math.abs(m[0]) && Math.abs(m[2]) <= tol * Math.abs(m[3]) && m[0] > 0 && m[3] < 0;
    // Crops below half a point (or 0.5 %) are rounding noise: keep the whole picture.
    const cropped =
        vis.x0 - full.x0 > Math.max(0.5, 0.005 * boxW(full)) ||
        full.x1 - vis.x1 > Math.max(0.5, 0.005 * boxW(full)) ||
        vis.y0 - full.y0 > Math.max(0.5, 0.005 * boxH(full)) ||
        full.y1 - vis.y1 > Math.max(0.5, 0.005 * boxH(full));
    const translucent = draw.alpha < 0.98;

    const raster = (): Raster | null => (decoded.kind === "raster" ? decoded.raster : decoded.raster());
    // Single-colour images are rectangles of colour.
    const axisAligned =
        (Math.abs(m[1]) <= tol * Math.abs(m[0]) && Math.abs(m[2]) <= tol * Math.abs(m[3])) ||
        (Math.abs(m[0]) <= tol * Math.abs(m[1]) && Math.abs(m[3]) <= tol * Math.abs(m[2]));
    if (decoded.kind === "raster" && axisAligned) {
        const u = uniformColor(decoded.raster);
        if (u) return u.alpha * draw.alpha < 0.03 ? null : { fill: { box: vis, rgb: u.rgb, alpha: u.alpha * draw.alpha } };
    }
    const photo = decoded.kind === "jpeg";
    // A curved or slanted clip that cuts into the picture: mask it.
    const shapes = draw.clip.shapes && draw.clip.shapes.length && !cornersInside(vis, draw.clip.shapes) ? draw.clip.shapes : undefined;
    if (upright && !cropped && !translucent && !shapes) {
        if (decoded.kind === "jpeg" && decoded.passThrough)
            return { image: { box: toRect(full), mime: "image/jpeg", data: decoded.bytes, pixelWidth: decoded.width, pixelHeight: decoded.height } };
        const r = raster();
        if (r) return { image: { box: toRect(full), ...encodeImage(r, photo), pixelWidth: r.width, pixelHeight: r.height } };
    } else {
        const r = raster();
        const out = r && resample(r, m, vis, draw.alpha, shapes);
        if (out) return { image: { box: toRect(vis), ...encodeImage(out, photo), pixelWidth: out.width, pixelHeight: out.height } };
    }
    // Could not decode: the original JPEG, uncropped, is the best we can do.
    if (decoded.kind === "jpeg")
        return { image: { box: toRect(full), mime: "image/jpeg", data: decoded.bytes, pixelWidth: decoded.width, pixelHeight: decoded.height } };
    return null;
};
