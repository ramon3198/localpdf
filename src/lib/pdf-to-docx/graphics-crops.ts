// Vector artwork on flowing pages — logos, charts, icons, signatures drawn with paths — has no Word equivalent the
// converter can build shape by shape. It is reproduced as pictures: the page is rendered without its text, the art is
// cropped out of the rendering and placed where it was, like any other image; the text around and on it stays text.
import * as UPNGModule from "@pdf-lib/upng";
import { decodeJpeg } from "./graphics-jpeg";
import { encodePng } from "./graphics-place";
import { decorationGraphics } from "./layout-decorations";
import { runCharX } from "./text-lines";
import type { FilledRect, PageContent, PageModel, PlacedImage, Rect, RenderedImage, RuleSegment, Table, TableCell, TextLine } from "./types";

type UpngDecode = { decode: (buf: ArrayBuffer) => unknown; toRGBA8: (img: unknown) => ArrayBuffer[] };
const UPNG: UpngDecode = ((UPNGModule as unknown as { default?: UpngDecode }).default ?? UPNGModule) as unknown as UpngDecode;

/** Resolution of the page rendering the art is cut from (above 200 dpi the browser renders PNG, not JPEG). */
const CROP_DPI = 216;
/** Pixels of that rendering at most (big sheets are rendered coarser). */
const MAX_PIXELS = 16_000_000;

/** The resolution to render a page at for its crops. */
export const cropDpi = (page: { width: number; height: number }): number =>
    Math.max(72, Math.min(CROP_DPI, Math.floor(72 * Math.sqrt(MAX_PIXELS / Math.max(1, page.width * page.height)))));

/** Points of blank page kept around the art (anti-aliasing, round caps and joins). */
const PAD = 1.5;
const MAX_CROPS = 40;

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);
const union = (a: Rect, b: Rect): Rect => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
};
const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const inside = (outer: Rect, inner: Rect, tol = 0.5) =>
    inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
const isHorizontal = (r: RuleSegment) => Math.abs(r.y1 - r.y2) <= Math.abs(r.x1 - r.x2);
const ruleBox = (r: RuleSegment): Rect => {
    const x0 = Math.min(r.x1, r.x2);
    const y0 = Math.min(r.y1, r.y2);
    return isHorizontal(r)
        ? { x: x0, y: y0 - r.width / 2, width: Math.abs(r.x2 - r.x1), height: Math.max(0.25, r.width) }
        : { x: x0 - r.width / 2, y: y0, width: Math.max(0.25, r.width), height: Math.abs(r.y2 - r.y1) };
};

/**
 * What a flow page's vector art becomes: the boxes to cut out of the page (`areas`, with the pictures they take in)
 * and, inside tables, the boxes of art that sits in one cell (a status pill, an icon) — placed with the table.
 */
export type VectorPlan = { areas: Rect[]; images: Set<PlacedImage>; cells: { box: Rect; table: Table; cell: TableCell }[] };

/** Boxes of the words of a line (runs split at their spaces; exact where the extractor kept character positions). */
const wordBoxes = (l: TextLine): Rect[] => {
    if (l.rotation) return [l.box];
    const out: Rect[] = [];
    for (const r of l.runs) {
        const n = r.text.length;
        const known = runCharX.get(r);
        const xs = known && known.length === n + 1 ? known : Array.from({ length: n + 1 }, (_, i) => r.box.x + (i * r.box.width) / Math.max(1, n));
        let start = -1;
        for (let i = 0; i <= n; i++) {
            const space = i === n || /\s/.test(r.text[i]);
            if (!space && start < 0) start = i;
            if (space && start >= 0) {
                out.push({ x: xs[start], y: r.box.y, width: Math.max(0, xs[i] - xs[start]), height: r.box.height });
                start = -1;
            }
        }
    }
    return out;
};

/** Areas closer than `gap` points merged into one (repeatedly, so chains join). */
const mergeNear = (rects: Rect[], gap: number): Rect[] => {
    let areas = rects.map((a) => ({ ...a }));
    for (let changed = true; changed; ) {
        changed = false;
        const next: Rect[] = [];
        for (const a of areas) {
            const k = next.findIndex((n) => overlap(grow(n, gap / 2), grow(a, gap / 2)) > 0);
            if (k >= 0) {
                next[k] = union(next[k], a);
                changed = true;
            } else next.push(a);
        }
        areas = next;
    }
    return areas;
};

/**
 * Areas of vector art worth reproducing as pictures on a flowing page. Left out: specks, bullets and hairline
 * flourishes, art that is mostly the background of text (a panel behind a paragraph), page-sized backdrops, anything
 * over a table (the table draws its own lines and shading) or over a large picture (a scan, a photo: the crop would
 * carry a copy of it). Small rules, fills and pictures touching the art (the frame of an icon, the bitmap part of a
 * logo) join its area.
 */
export const planVectorArt = (content: PageContent, tables: Table[]): VectorPlan | null => {
    try {
        return vectorPlan(content, tables);
    } catch {
        return null;
    }
};

/** Specks, bullets and hairline flourishes. */
const tiny = (a: Rect) => Math.max(a.width, a.height) < 6 || area(a) < 36 || Math.min(a.width, a.height) < 2;

const vectorPlan = (content: PageContent, tables: Table[]): VectorPlan | null => {
    const g = content.graphics;
    const raw = (g.complexAreas ?? []).filter((a) => a.width > 0 && a.height > 0);
    if (!raw.length) return null;
    const pageArea = content.width * content.height;
    // A page that is a picture (scans, full-page backgrounds): the rendering would copy it into every crop.
    if (g.images.some((im) => area(im.box) >= 0.5 * pageArea)) return null;
    const words = content.lines.filter((l) => !l.invisible && l.runs.some((r) => r.text.trim())).flatMap(wordBoxes);

    // Art over a table: only what sits inside one cell, clear of its edges, is the table's own mark (the table draws
    // its lines and shading itself).
    const merged = mergeNear(raw, 4);
    const onTable = (a: Rect) => tables.some((t) => overlap(t.box, a) > 0.05 * Math.min(area(a), area(t.box)));
    const cells: VectorPlan["cells"] = [];
    for (const a of merged.filter(onTable)) {
        if (tiny(a)) continue;
        for (const t of tables)
            for (const row of t.rows)
                for (const cell of row.cells) {
                    const inner = grow(cell.box, -0.75);
                    if (!inside(inner, a, 0.25)) continue;
                    const r = grow(a, PAD);
                    const x = Math.max(inner.x, r.x);
                    const y = Math.max(inner.y, r.y);
                    cells.push({ box: { x, y, width: Math.min(right(inner), right(r)) - x, height: Math.min(bottom(inner), bottom(r)) - y }, table: t, cell });
                }
    }

    // Areas that nearly touch are one piece of art; small straight pieces and pictures touching it belong to it.
    const images = new Set<PlacedImage>();
    const taken = new Set<object>();
    const small = (b: Rect, a: Rect) => b.width <= a.width + 12 && b.height <= a.height + 12;
    let areas = merged
        .filter((a) => !onTable(a))
        .map((a0) => {
            let a = a0;
            for (let round = 0; round < 4; round++) {
                let grew = false;
                const zone = grow(a, PAD);
                const join = (item: object, b: Rect) => {
                    if (taken.has(item) || overlap(zone, b) <= 0 || !small(b, a)) return;
                    taken.add(item);
                    a = union(a, b);
                    grew = true;
                };
                for (const r of g.rules) join(r, ruleBox(r));
                for (const f of g.fills) join(f, f);
                for (const im of g.images) {
                    if (taken.has(im) || overlap(zone, im.box) <= 0 || area(im.box) > 3 * area(a)) continue;
                    taken.add(im);
                    images.add(im);
                    a = union(a, im.box);
                    grew = true;
                }
                if (!grew) break;
            }
            return a;
        });
    // Grown areas that now overlap are one picture.
    areas = mergeNear(areas, 0);

    const keep = areas.filter((a) => {
        if (tiny(a)) return false;
        // Page-sized backdrops and frames.
        if (area(a) > 0.6 * pageArea) return false;
        if (onTable(a)) return false;
        // Over a picture it does not take in: the crop would copy the picture.
        if (g.images.some((im) => !images.has(im) && overlap(im.box, a) > 0.05 * area(a))) return false;
        // Mostly the background of text: a panel, a band or a bubble behind a paragraph (words drawn over it; an
        // icon between two words of a line is not under text).
        const covered = words.reduce((s, w) => s + overlap(w, a), 0);
        return covered <= 0.3 * area(a);
    });
    if (!keep.length && !cells.length) return null;
    keep.sort((p, q) => area(q) - area(p));
    const chosen = keep.slice(0, MAX_CROPS).map((a) => {
        let r = grow(a, PAD);
        // A line the crop only grazes (an axis along the edge of a chart) is taken in across its whole width: the
        // crop then shows that stretch of it and the rest of the line is cut away there (see applyVectorArt), instead
        // of half a line in the picture beside the whole line drawn again.
        for (let round = 0; round < 2; round++)
            for (const rule of g.rules) {
                const b = ruleBox(rule);
                if (overlap(b, r) <= 0 || inside(r, b, 0)) continue;
                r = isHorizontal(rule)
                    ? { ...r, y: Math.min(r.y, b.y), height: Math.max(bottom(r), bottom(b)) - Math.min(r.y, b.y) }
                    : { ...r, x: Math.min(r.x, b.x), width: Math.max(right(r), right(b)) - Math.min(r.x, b.x) };
            }
        const x = Math.max(0, r.x);
        const y = Math.max(0, r.y);
        return { x, y, width: Math.min(content.width, right(r)) - x, height: Math.min(content.height, bottom(r)) - y };
    });
    return { areas: chosen, images: new Set([...images].filter((im) => chosen.some((a) => inside(a, im.box)))), cells: cells.slice(0, MAX_CROPS) };
};

/**
 * After layout: a crop any text touches goes behind the text. The crops are opaque (see cropRendered) and hold the
 * page without its text, so in front they would hide the letters that sit on or at the edge of the art.
 */
export const artUnderText = (model: PageModel, content: PageContent, crops: Set<PlacedImage>): void => {
    if (!crops.size) return;
    const boxes = content.lines.filter((l) => !l.invisible && l.runs.some((r) => r.text.trim())).map((l) => l.box);
    for (const b of model.blocks) if (b.kind === "image" && crops.has(b.image) && boxes.some((t) => overlap(t, b.image.box) > 0)) b.behindText = true;
};

/** RGBA pixels of a rendered page (PNG or JPEG). */
const pixelsOf = (image: RenderedImage): { width: number; height: number; rgba: Uint8Array } | null => {
    if (image.mime === "image/png") {
        const bytes = image.data;
        const buf = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
        const decoded = UPNG.decode(buf) as { width: number; height: number };
        const rgba = UPNG.toRGBA8(decoded)[0];
        return rgba ? { width: decoded.width, height: decoded.height, rgba: new Uint8Array(rgba) } : null;
    }
    const jpeg = decodeJpeg(image.data);
    if (!jpeg || (jpeg.components !== 3 && jpeg.components !== 1)) return null;
    const n = jpeg.width * jpeg.height;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (jpeg.components === 3) {
            rgba[o] = jpeg.data[i * 3];
            rgba[o + 1] = jpeg.data[i * 3 + 1];
            rgba[o + 2] = jpeg.data[i * 3 + 2];
        } else rgba[o] = rgba[o + 1] = rgba[o + 2] = jpeg.data[i];
        rgba[o + 3] = 255;
    }
    return { width: jpeg.width, height: jpeg.height, rgba };
};

/**
 * Cuts the areas (display space, points) out of a rendering of the page (text removed) as PNG pictures, one per area
 * (null where nothing is drawn). The pictures are opaque: Word's PDF export turns transparent pixels black under their
 * mask, which smoothing smears into dark fringes around the art.
 */
export const cropRendered = (image: RenderedImage, page: { width: number; height: number }, areas: Rect[]): (PlacedImage | null)[] => {
    const px = pixelsOf(image);
    if (!px) return areas.map(() => null);
    const sx = px.width / page.width;
    const sy = px.height / page.height;
    return areas.map((a): PlacedImage | null => {
        const x0 = Math.max(0, Math.floor(a.x * sx));
        const y0 = Math.max(0, Math.floor(a.y * sy));
        const x1 = Math.min(px.width, Math.ceil(right(a) * sx));
        const y1 = Math.min(px.height, Math.ceil(bottom(a) * sy));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < 2 || h < 2) return null;
        const rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
            const src = ((y0 + y) * px.width + x0) * 4;
            rgba.set(px.rgba.subarray(src, src + w * 4), y * w * 4);
        }
        // Nothing drawn there after all (art hidden under later paint, or clipped away).
        let ink = 0;
        for (let o = 0; o < rgba.length && ink < 4; o += 4) if (rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250) ink++;
        if (ink < 4) return null;
        return {
            box: { x: x0 / sx, y: y0 / sy, width: w / sx, height: h / sy },
            mime: "image/png",
            data: encodePng({ width: w, height: h, rgba, alpha: false }),
            pixelWidth: w,
            pixelHeight: h,
        };
    });
};

/** The parts of a box outside `hole` (up to four bands). */
const subtract = (r: Rect, hole: Rect): Rect[] => {
    if (overlap(r, hole) <= 0) return [r];
    const out: Rect[] = [];
    if (hole.y > r.y) out.push({ x: r.x, y: r.y, width: r.width, height: hole.y - r.y });
    if (bottom(hole) < bottom(r)) out.push({ x: r.x, y: bottom(hole), width: r.width, height: bottom(r) - bottom(hole) });
    const y0 = Math.max(r.y, hole.y);
    const y1 = Math.min(bottom(r), bottom(hole));
    if (hole.x > r.x) out.push({ x: r.x, y: y0, width: hole.x - r.x, height: y1 - y0 });
    if (right(hole) < right(r)) out.push({ x: right(hole), y: y0, width: right(r) - right(hole), height: y1 - y0 });
    return out.filter((b) => b.width >= 0.3 && b.height >= 0.3);
};

/** The parts of a rule outside `hole` (a rule only grazed by it stays whole). */
const cutRule = (r: RuleSegment, hole: Rect): RuleSegment[] => {
    const b = ruleBox(r);
    if (overlap(b, hole) <= 0) return [r];
    const horizontal = isHorizontal(r);
    // The hole must cover the rule's whole thickness to hide a stretch of it.
    if (horizontal ? hole.y > b.y + 0.1 || bottom(hole) < bottom(b) - 0.1 : hole.x > b.x + 0.1 || right(hole) < right(b) - 0.1) return [r];
    const [lo, hi] = horizontal ? [Math.min(r.x1, r.x2), Math.max(r.x1, r.x2)] : [Math.min(r.y1, r.y2), Math.max(r.y1, r.y2)];
    const [h0, h1] = horizontal ? [hole.x, right(hole)] : [hole.y, bottom(hole)];
    const out: RuleSegment[] = [];
    const piece = (a: number, z: number) => {
        if (z - a < 0.5) return;
        out.push(horizontal ? { ...r, x1: a, x2: z, y2: r.y1 } : { ...r, y1: a, y2: z, x2: r.x1 });
    };
    piece(lo, Math.min(hi, h0));
    piece(Math.max(lo, h1), hi);
    return out;
};

/** Pictures cut for a page: the art the layout places (`page`) and the marks inside table cells (`cells`). */
export type VectorCrops = { page: Set<PlacedImage>; cells: { image: PlacedImage; table: Table; cell: TableCell }[] };

/**
 * Puts the art of a flow page into its graphics as pictures (the layout places them like any image). What the crops
 * show is taken out of the rest of the drawing — pictures they took in, the parts of fills and rules under them — so
 * nothing is drawn twice. The art inside table cells comes back apart, for placeTableMarks.
 */
export const applyVectorArt = (content: PageContent, plan: VectorPlan, rendered: RenderedImage, tables: Table[]): VectorCrops => {
    const all = cropRendered(rendered, content, [...plan.areas, ...plan.cells.map((c) => c.box)]);
    const cells = plan.cells.flatMap((c, i) => {
        const image = all[plan.areas.length + i];
        return image ? [{ image, table: c.table, cell: c.cell }] : [];
    });
    const crops = all.slice(0, plan.areas.length).filter((c): c is PlacedImage => !!c);
    const added: VectorCrops = { page: new Set(crops), cells };
    if (!crops.length) return added;
    const holes = crops.map((c) => c.box);
    // Kept whole: underlines and strike-throughs already turned into text formatting (not drawn), and whatever reaches
    // into a table (its shading and borders belong to the table).
    const whole = (item: object, box: Rect) => decorationGraphics.has(item) || tables.some((t) => overlap(t.box, box) > 0);
    let fills: FilledRect[] = content.graphics.fills;
    let rules: RuleSegment[] = content.graphics.rules;
    for (const hole of holes) {
        fills = fills.flatMap((f) => (whole(f, f) ? [f] : subtract(f, hole).map((b) => (b === f ? f : { ...f, ...b }))));
        rules = rules.flatMap((r) => (whole(r, ruleBox(r)) ? [r] : cutRule(r, hole)));
    }
    const g = content.graphics;
    content.graphics = {
        ...g,
        images: [...g.images.filter((im) => !(plan.images.has(im) && holes.some((h) => inside(h, im.box)))), ...crops],
        fills,
        rules,
    };
    return added;
};
