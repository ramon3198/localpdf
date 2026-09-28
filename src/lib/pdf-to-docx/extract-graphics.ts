import type { PDFContext, PDFDocument } from "pdf-lib";
import { ColorSpaces, type RGB, rgbToHex } from "./graphics-color";
import { type DecodedImage, decodeImage } from "./graphics-image";
import { GraphicsInterpreter, type GraphicsScan, type RawFill, type RawRule } from "./graphics-interpreter";
import { type Placement, placeImage } from "./graphics-place";
import { type Box, boxArea, boxH, boxW, containsBox, intersectBox, unionBox } from "./graphics-region";
import type { PageGeometry } from "./page-geometry";
import type { FilledRect, PageGraphics, PlacedImage, Rect, RuleSegment } from "./types";

/**
 * What extractPageGraphics returns beyond the PageGraphics contract (optional extras; consumers may ignore them).
 *  - rules[].style: "dotted" / "dashed" for broken lines (dot leaders, dashed borders).
 *  - complexAreas: bounds of vector art that is neither a fill nor a rule (logos, charts, icons), clustered.
 *  - skippedImages: images whose compression cannot be decoded here (JPEG 2000, JBIG2, CCITT fax).
 */
export type GraphicsRule = RuleSegment & { style?: "dotted" | "dashed" };
export type GraphicsExtras = { complexAreas: Rect[]; skippedImages: { box: Rect; filter: string }[] };
export type ExtractedGraphics = PageGraphics & GraphicsExtras & { rules: GraphicsRule[] };

type Fill = { box: Box; rgb: RGB; alpha: number; order: number; gradient?: boolean; dead?: boolean };
type Rule = { horizontal: boolean; pos: number; a: number; b: number; width: number; rgb: RGB; order: number; style?: "dotted" | "dashed" };

const rect = (b: Box): Rect => ({ x: b.x0, y: b.y0, width: boxW(b), height: boxH(b) });
const WHITE: RGB = [1, 1, 1];
const close = (p: RGB, q: RGB, tol = 3 / 255) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol && Math.abs(p[2] - q[2]) <= tol;
const blend = (fg: RGB, bg: RGB, alpha: number): RGB => [0, 1, 2].map((k) => fg[k] * alpha + bg[k] * (1 - alpha)) as RGB;
const ruleBox = (r: Rule): Box =>
    r.horizontal
        ? { x0: r.a, y0: r.pos - r.width / 2, x1: r.b, y1: r.pos + r.width / 2 }
        : { x0: r.pos - r.width / 2, y0: r.a, x1: r.pos + r.width / 2, y1: r.b };

/** Decoded images shared by all pages of a document (the same logo on every page is decoded once). */
const imageCache = new WeakMap<PDFContext, Map<string, DecodedImage>>();

/**
 * Images (as JPEG/PNG bytes), filled rectangles and straight rules drawn on a page, in display space. Never throws:
 * a page whose drawing can't be read reports complex vector art (so it is reproduced from its rendered background).
 */
export const extractPageGraphics = async (doc: PDFDocument, pageIndex: number, geometry: PageGeometry): Promise<PageGraphics> => {
    try {
        return readPageGraphics(doc, pageIndex, geometry);
    } catch {
        const none: ExtractedGraphics = { images: [], fills: [], rules: [], hasComplexVector: true, complexAreas: [], skippedImages: [] };
        return none;
    }
};

const readPageGraphics = (doc: PDFDocument, pageIndex: number, geometry: PageGeometry): ExtractedGraphics => {
    const page = doc.getPage(pageIndex);
    const pageBox: Box = { x0: 0, y0: 0, x1: geometry.width, y1: geometry.height };
    const interp = new GraphicsInterpreter(doc.context, geometry, geometry.matrix);
    try {
        interp.runPage(page.node, page.node.Resources() ?? null);
    } catch {
        interp.out.truncated = true;
    }
    const scan = interp.out;

    // ── Images ──
    const spaces = new ColorSpaces(doc.context);
    let cache = imageCache.get(doc.context);
    if (!cache) imageCache.set(doc.context, (cache = new Map()));
    const images: PlacedImage[] = [];
    const imageFills: RawFill[] = [];
    const skippedImages: GraphicsExtras["skippedImages"] = [];
    const opaqueImages: { box: Box; order: number }[] = [];
    for (const draw of scan.images) {
        let decoded: DecodedImage;
        const key = draw.src.kind === "xobject" && draw.src.ref ? `${draw.src.ref.toString()}|${draw.fill ? rgbToHex(draw.fill) : ""}` : null;
        const hit = key ? cache.get(key) : undefined;
        if (hit) decoded = hit;
        else {
            try {
                decoded = decodeImage(doc.context, spaces, draw.src, draw.fill);
            } catch {
                decoded = { kind: "invalid" };
            }
            // Keep compressed results only: rasters of big pictures would pin a lot of memory.
            if (key && (decoded.kind !== "raster" || decoded.raster.width * decoded.raster.height <= 250_000)) cache.set(key, decoded);
        }
        if (decoded.kind === "unsupported") {
            const m = draw.ctm;
            const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
            const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
            const b = intersectBox({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, pageBox);
            if (b) skippedImages.push({ box: rect(b), filter: decoded.filter });
            continue;
        }
        let placed: Placement = null;
        try {
            placed = placeImage(draw, decoded, pageBox);
        } catch {
            placed = null;
        }
        if (!placed) continue;
        if ("fill" in placed) {
            imageFills.push({ box: placed.fill.box, rgb: placed.fill.rgb, alpha: placed.fill.alpha, order: draw.order });
            continue;
        }
        images.push(placed.image);
        const b = placed.image.box;
        if (placed.image.mime === "image/jpeg" && draw.alpha >= 0.98)
            opaqueImages.push({ box: { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }, order: draw.order });
    }

    const strips = mergeStrips(scan.fills, scan.rules);
    const pieces = smallPieces(strips.fills, strips.rules);
    const fills = cleanFills(
        [...strips.fills.filter((f) => !pieces.used.has(f)), ...imageFills].sort((p, q) => p.order - q.order),
        opaqueImages,
    );
    const rules = cleanRules(pieces.rules, fills, pageBox);
    for (const box of strips.gradients) scan.complex.push({ box, order: 0 });
    const complexAreas = clusterComplex(scan);
    const hasComplexVector = scan.truncated || complexAreas.some((b) => (boxW(b) >= 10 && boxH(b) >= 10) || boxArea(b) >= 120);

    const out: ExtractedGraphics = {
        images,
        fills: fills.filter((f) => !f.dead).map((f): FilledRect => ({ ...rect(f.box), color: rgbToHex(f.rgb), opacity: 1 })),
        rules,
        hasComplexVector,
        complexAreas: complexAreas.map(rect),
        skippedImages,
    };
    return out;
};

// ── Fills ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Gradients some generators paint as many touching bands of slowly changing colour (six or more bands of equal
 * size, three or more colours, small steps) become one fill of their average colour — and a gradient area when the
 * colours span a wide range. Thin bands arrive as rules (with their box) and are taken back.
 */
const mergeStrips = (fills: RawFill[], rules: RawRule[]): { fills: RawFill[]; rules: RawRule[]; gradients: Box[] } => {
    type Item = { box: Box; rgb: RGB; alpha: number; order: number; fill?: RawFill; rule?: RawRule };
    const items: Item[] = [
        ...fills.filter((f) => !f.gradient).map((f) => ({ box: f.box, rgb: f.rgb, alpha: f.alpha, order: f.order, fill: f })),
        ...rules.filter((r) => r.box && !r.style).map((r) => ({ box: r.box!, rgb: r.rgb, alpha: r.alpha, order: r.order, rule: r })),
    ];
    if (items.length < 6) return { fills, rules, gradients: [] };
    const usedFills = new Set<RawFill>();
    const usedRules = new Set<RawRule>();
    const merged: RawFill[] = [];
    const gradients: Box[] = [];
    const step = (p: RGB, q: RGB) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
    for (const alongX of [true, false]) {
        // Bands side by side along x share their top and bottom (and the other way round).
        const key = (b: Box) => (alongX ? `${Math.round(b.y0 * 2)}:${Math.round(b.y1 * 2)}` : `${Math.round(b.x0 * 2)}:${Math.round(b.x1 * 2)}`);
        const groups = new Map<string, Item[]>();
        for (const it of items) {
            if ((it.fill && usedFills.has(it.fill)) || (it.rule && usedRules.has(it.rule))) continue;
            const k = key(it.box);
            const g = groups.get(k);
            if (g) g.push(it);
            else groups.set(k, [it]);
        }
        for (const g of groups.values()) {
            if (g.length < 6) continue;
            const lo = (b: Box) => (alongX ? b.x0 : b.y0);
            const hi = (b: Box) => (alongX ? b.x1 : b.y1);
            g.sort((p, q) => lo(p.box) - lo(q.box));
            let i = 0;
            while (i < g.length) {
                let j = i + 1;
                const size = hi(g[i].box) - lo(g[i].box);
                // Gradient bands are narrow; table cells (a heat map's shading) are not.
                if (size > 12) {
                    i++;
                    continue;
                }
                while (
                    j < g.length &&
                    Math.abs(lo(g[j].box) - hi(g[j - 1].box)) <= 0.6 &&
                    Math.abs(hi(g[j].box) - lo(g[j].box) - size) <= Math.max(0.6, 0.25 * size) &&
                    step(g[j].rgb, g[j - 1].rgb) <= 24 / 255
                )
                    j++;
                const run = g.slice(i, j);
                const colours = new Set(run.map((it) => rgbToHex(it.rgb)));
                if (run.length >= 6 && colours.size >= 3) {
                    const box = run.map((it) => it.box).reduce(unionBox);
                    const area = run.reduce((s, it) => s + boxArea(it.box), 0) || 1;
                    const rgb = [0, 1, 2].map((k) => run.reduce((s, it) => s + it.rgb[k] * boxArea(it.box), 0) / area) as RGB;
                    merged.push({ box, rgb, alpha: Math.min(...run.map((it) => it.alpha)), order: Math.max(...run.map((it) => it.order)) });
                    let spread = 0;
                    for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.max(...run.map((it) => it.rgb[k])) - Math.min(...run.map((it) => it.rgb[k])));
                    if (spread > 0.1) gradients.push(box);
                    for (const it of run) {
                        if (it.fill) usedFills.add(it.fill);
                        if (it.rule) usedRules.add(it.rule);
                    }
                }
                i = j;
            }
        }
    }
    if (!merged.length) return { fills, rules, gradients };
    return {
        fills: [...fills.filter((f) => !usedFills.has(f)), ...merged].sort((p, q) => p.order - q.order),
        rules: rules.filter((r) => !usedRules.has(r)),
        gradients,
    };
};

/**
 * Flattens fills against what lies beneath them (so `color` is what the reader sees and `opacity` is 1), drops the
 * invisible ones (white on white, a colour repainted over itself) and those completely hidden by later paint.
 */
const cleanFills = (raw: Fill[], opaqueImages: { box: Box; order: number }[]): Fill[] => {
    const fills: Fill[] = [];
    for (const f0 of raw) {
        const f: Fill = { ...f0 };
        if (boxW(f.box) < 0.75 && boxH(f.box) < 0.75) continue;
        // Topmost earlier fill that contains this one.
        let backdrop: Fill | null = null;
        for (let i = fills.length - 1; i >= 0; i--) {
            const e = fills[i];
            if (!e.dead && containsBox(e.box, f.box, 0.25)) {
                backdrop = e;
                break;
            }
        }
        const under = backdrop ? backdrop.rgb : WHITE;
        if (f.alpha < 0.98) f.rgb = blend(f.rgb, under, f.alpha);
        f.alpha = 1;
        if (close(f.rgb, under)) continue;
        // An opaque fill hides earlier fills it covers completely.
        for (const e of fills) if (!e.dead && containsBox(f.box, e.box, 0.1)) e.dead = true;
        fills.push(f);
    }
    for (const img of opaqueImages) for (const f of fills) if (!f.dead && f.order < img.order && containsBox(img.box, f.box, 0.1)) f.dead = true;
    return fills.filter((f) => !f.dead);
};

// ── Rules ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const toRule = (r: RawRule): Rule => {
    const horizontal = Math.abs(r.y2 - r.y1) <= Math.abs(r.x2 - r.x1);
    return horizontal
        ? { horizontal, pos: (r.y1 + r.y2) / 2, a: Math.min(r.x1, r.x2), b: Math.max(r.x1, r.x2), width: r.width, rgb: r.rgb, order: r.order, style: r.style }
        : { horizontal, pos: (r.x1 + r.x2) / 2, a: Math.min(r.y1, r.y2), b: Math.max(r.y1, r.y2), width: r.width, rgb: r.rgb, order: r.order, style: r.style };
};

/** Rows of small equal squares (CSS dotted borders, dot leaders drawn as graphics) → one dotted rule. */
const dottedRows = (pieces: Fill[]): { rules: Rule[]; used: Set<Fill> } => {
    const rules: Rule[] = [];
    const used = new Set<Fill>();
    for (const horizontal of [true, false]) {
        const key = (f: Fill) => (horizontal ? (f.box.y0 + f.box.y1) / 2 : (f.box.x0 + f.box.x1) / 2);
        const along = (f: Fill) => (horizontal ? f.box.x0 : f.box.y0);
        const size = (f: Fill) => (horizontal ? boxW(f.box) : boxH(f.box));
        const cands = pieces.filter((f) => !used.has(f)).sort((p, q) => key(p) - key(q) || along(p) - along(q));
        let i = 0;
        while (i < cands.length) {
            // Pieces on the same line with the same colour and size.
            let j = i + 1;
            while (j < cands.length && Math.abs(key(cands[j]) - key(cands[i])) <= 0.3) j++;
            const line = cands.slice(i, j).sort((p, q) => along(p) - along(q));
            let k = 0;
            while (k < line.length) {
                // A chain of same-looking pieces with small gaps; mostly regular spacing (end dots may be off-beat).
                const run = [line[k]];
                const gaps: number[] = [];
                for (let m = k + 1; m < line.length; m++) {
                    const prev = run[run.length - 1];
                    const g = along(line[m]) - (along(prev) + size(prev));
                    const s = size(prev);
                    const ok = close(line[m].rgb, prev.rgb, 8 / 255) && Math.abs(size(line[m]) - s) <= 0.3 * s + 0.1 && g >= -0.05 && g <= 4 * s + 0.5;
                    if (!ok) break;
                    gaps.push(g);
                    run.push(line[m]);
                }
                const sorted = [...gaps].sort((p, q) => p - q);
                const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
                const regular = gaps.filter((g) => Math.abs(g - median) <= 0.35 * median + 0.2).length >= 0.7 * gaps.length;
                if (run.length >= 5 && median >= 0.1 * size(run[0]) && regular) {
                    const first = run[0];
                    const last = run[run.length - 1];
                    const thick = horizontal ? boxH(first.box) : boxW(first.box);
                    rules.push({
                        horizontal,
                        pos: key(first),
                        a: along(first),
                        b: along(last) + size(last),
                        width: thick,
                        rgb: first.rgb,
                        order: first.order,
                        style: "dotted",
                    });
                    run.forEach((f) => used.add(f));
                }
                k += run.length;
            }
            i = j;
        }
    }
    return { rules, used };
};

const sameLine = (p: Rule, q: Rule) =>
    p.horizontal === q.horizontal &&
    Math.abs(p.pos - q.pos) <= Math.max(0.6, 0.5 * Math.min(p.width, q.width)) &&
    Math.abs(p.width - q.width) <= Math.max(0.6, 0.5 * Math.max(p.width, q.width)) &&
    close(p.rgb, q.rgb, 12 / 255) &&
    (p.style ?? "") === (q.style ?? "");

/** Merges collinear pieces that touch or overlap into single rules. */
const mergeTouching = (rules: Rule[]): Rule[] => {
    const out: Rule[] = [];
    for (const horizontal of [true, false]) {
        const group = rules.filter((r) => r.horizontal === horizontal).sort((p, q) => p.pos - q.pos || p.a - q.a);
        const used = new Array(group.length).fill(false);
        for (let i = 0; i < group.length; i++) {
            if (used[i]) continue;
            used[i] = true;
            const cur: Rule = { ...group[i] };
            let len = Math.max(cur.b - cur.a, 1e-6);
            let wsum = cur.pos * len;
            let changed = true;
            while (changed) {
                changed = false;
                for (let j = i + 1; j < group.length; j++) {
                    if (used[j]) continue;
                    const r = group[j];
                    if (r.pos - cur.pos > Math.max(0.6, cur.width)) break;
                    if (!sameLine(cur, r)) continue;
                    const gap = Math.max(r.a - cur.b, cur.a - r.b);
                    if (gap > Math.max(1, 1.5 * Math.min(cur.width, r.width))) continue;
                    used[j] = true;
                    const l = Math.max(r.b - r.a, 1e-6);
                    wsum += r.pos * l;
                    len += l;
                    cur.a = Math.min(cur.a, r.a);
                    cur.b = Math.max(cur.b, r.b);
                    cur.width = Math.max(cur.width, r.width);
                    cur.order = Math.max(cur.order, r.order);
                    changed = true;
                }
            }
            cur.pos = wsum / len;
            out.push(cur);
        }
    }
    return out;
};

/** Runs of 4+ equal pieces with a steady gap (dashed borders drawn piece by piece) → one dashed rule. */
const mergeDashes = (rules: Rule[]): Rule[] => {
    const out: Rule[] = [];
    const used = new Set<Rule>();
    const sorted = [...rules].sort((p, q) => Number(q.horizontal) - Number(p.horizontal) || p.pos - q.pos || p.a - q.a);
    for (const r of sorted) {
        if (used.has(r)) continue;
        if (r.style) {
            out.push(r);
            continue;
        }
        const run = [r];
        const len = r.b - r.a;
        let gap = -1;
        for (const q of sorted) {
            if (used.has(q) || run.includes(q) || !sameLine(r, q) || q.style) continue;
            const last = run[run.length - 1];
            const g = q.a - last.b;
            if (g <= 0 || g > Math.max(6, 4 * r.width)) continue;
            if (Math.abs(q.b - q.a - len) > 0.35 * len + 0.3) continue;
            if (gap >= 0 && Math.abs(g - gap) > 0.35 * gap + 0.3) continue;
            if (gap < 0) gap = g;
            run.push(q);
        }
        if (run.length >= 4 && len <= 12) {
            run.forEach((q) => used.add(q));
            out.push({ ...r, a: run[0].a, b: run[run.length - 1].b, style: "dashed", order: Math.max(...run.map((q) => q.order)) });
        } else {
            used.add(r);
            out.push(r);
        }
    }
    return out;
};

/**
 * Small squares first become dotted rules (rows of dots) or are absorbed by the rule they cap (the corner pieces
 * Word draws at every border junction). Returns the rules and the fills that were used up.
 */
const smallPieces = (fills: RawFill[], rawRules: RawRule[]): { rules: Rule[]; used: Set<RawFill> } => {
    const small = fills.filter((f) => Math.max(boxW(f.box), boxH(f.box)) <= 3.2 && !f.gradient);
    const dotted = dottedRows(small);
    const rules = mergeTouching([...rawRules.map(toRule), ...dotted.rules]);
    const used = new Set<RawFill>(dotted.used);
    for (const p of small) {
        if (used.has(p)) continue;
        const cx = (p.box.x0 + p.box.x1) / 2;
        const cy = (p.box.y0 + p.box.y1) / 2;
        for (const r of rules) {
            const along = r.horizontal ? [p.box.x0, p.box.x1] : [p.box.y0, p.box.y1];
            const across = r.horizontal ? cy : cx;
            if (Math.abs(across - r.pos) > r.width / 2 + 0.35 || !close(p.rgb, r.rgb, 12 / 255)) continue;
            if (along[1] < r.a - 0.6 || along[0] > r.b + 0.6) continue;
            r.a = Math.min(r.a, along[0]);
            r.b = Math.max(r.b, along[1]);
            used.add(p);
        }
    }
    return { rules: mergeDashes(mergeTouching(rules)), used };
};

const cleanRules = (merged: Rule[], fills: Fill[], page: Box): GraphicsRule[] => {
    const rules = merged;
    // Drop rules drawn in the colour of what is under them, and rules hidden under later opaque fills.
    const visible = rules.filter((r) => {
        const box = ruleBox(r);
        let under: RGB = WHITE;
        for (let i = fills.length - 1; i >= 0; i--) {
            const f = fills[i];
            if (f.order > r.order && containsBox(f.box, box, 0.1)) return false;
            if (f.order < r.order && containsBox(f.box, box, 0.25)) {
                under = f.rgb;
                break;
            }
        }
        return !close(r.rgb, under) && r.b - r.a >= 1;
    });
    const out: GraphicsRule[] = [];
    for (const r of visible) {
        const a = Math.max(r.a, r.horizontal ? page.x0 : page.y0);
        const b = Math.min(r.b, r.horizontal ? page.x1 : page.y1);
        if (b - a < 1) continue;
        const color = rgbToHex(r.rgb);
        const width = Math.round(r.width * 100) / 100;
        const seg: GraphicsRule = r.horizontal ? { x1: a, y1: r.pos, x2: b, y2: r.pos, width, color } : { x1: r.pos, y1: a, x2: r.pos, y2: b, width, color };
        if (r.style) seg.style = r.style;
        out.push(seg);
    }
    return out;
};

// ── Complex vector art ─────────────────────────────────────────────────────────────────────────────────────────────

const clusterComplex = (scan: GraphicsScan): Box[] => {
    let boxes = scan.complex.map((c) => c.box);
    if (boxes.length > 3000) {
        // Very busy pages: one cluster per coarse grid cell first.
        const grid = new Map<string, Box>();
        for (const b of boxes) {
            const k = `${Math.floor(b.x0 / 50)}:${Math.floor(b.y0 / 50)}`;
            const g = grid.get(k);
            grid.set(k, g ? unionBox(g, b) : b);
        }
        boxes = [...grid.values()];
    }
    const near = (p: Box, q: Box) => p.x0 <= q.x1 + 2 && q.x0 <= p.x1 + 2 && p.y0 <= q.y1 + 2 && q.y0 <= p.y1 + 2;
    let changed = true;
    while (changed) {
        changed = false;
        const next: Box[] = [];
        for (const b of boxes) {
            const hit = next.findIndex((n) => near(n, b));
            if (hit >= 0) {
                next[hit] = unionBox(next[hit], b);
                changed = true;
            } else next.push(b);
        }
        boxes = next;
    }
    return boxes;
};
