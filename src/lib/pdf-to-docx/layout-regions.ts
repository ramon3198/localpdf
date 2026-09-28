// Page segmentation for reading order: horizontal zones stacked top to bottom, each split by vertical gutters into
// text columns, side-by-side blocks, or kept whole when the "gutter" only separates the pieces of tabbed rows.
import type { Rect, Table, TextLine } from "./types";

export type Item = { box: Rect; line?: TextLine; table?: Table };

export type Region = { box: Rect; items: Item[] };

export type Zone = {
    top: number;
    bottom: number;
    /**
     * single: one flow of text; rows: one flow whose rows have tab-separated pieces (forms, "label  value");
     * columns: text columns of similar width; blocks: side-by-side blocks that flowing text can't express.
     */
    kind: "single" | "rows" | "columns" | "blocks";
    regions: Region[];
};

const right = (b: Rect) => b.x + b.width;
const bottom = (b: Rect) => b.y + b.height;

const bounds = (items: Item[]): Rect => {
    const x0 = Math.min(...items.map((i) => i.box.x));
    const y0 = Math.min(...items.map((i) => i.box.y));
    const x1 = Math.max(...items.map((i) => right(i.box)));
    const y1 = Math.max(...items.map((i) => bottom(i.box)));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** Free x-intervals between the items (gaps at least `min` wide), as [start, end] pairs. */
const gutters = (items: Item[], min: number): [number, number][] => {
    const spans = items.map((i) => [i.box.x, right(i.box)] as [number, number]).sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let end = -Infinity;
    for (const [s, e] of spans) {
        if (end > -Infinity && s - end >= min) out.push([end, s]);
        end = Math.max(end, e);
    }
    return out;
};

const lineSize = (l: TextLine) => l.fontSize || 10;

/** Does the zone's gutter only separate pieces of rows that share baselines (a form, key/value pairs, tab stops)? */
const isRowStructure = (items: Item[], gutter: [number, number]) => {
    const leftLines = items.filter((i) => i.line && right(i.box) <= gutter[0] + 0.5).map((i) => i.line!);
    const rightLines = items.filter((i) => i.line && i.box.x >= gutter[1] - 0.5).map((i) => i.line!);
    if (!leftLines.length || !rightLines.length) return false;
    // Pieces of one source line sit on exactly the same baseline; neighbouring blocks only by chance, and loosely.
    const same = (l: TextLine, r: TextLine) => Math.abs(l.baseline - r.baseline) <= 0.08 * Math.min(lineSize(l), lineSize(r)) + 0.3;
    const shared = rightLines.filter((r) => leftLines.some((l) => same(l, r))).length;
    const frac = shared / Math.min(leftLines.length, rightLines.length);
    if (frac < 0.7) return false;
    // Text columns set on a common baseline grid also share rows: there the left side is wrapped text that runs up
    // to the gutter; label columns are short and ragged.
    const width = gutter[0] - Math.min(...leftLines.map((l) => l.box.x));
    const full = leftLines.filter((l) => gutter[0] - right(l.box) < 0.08 * width).length;
    const wrappedLeft = leftLines.length >= 3 && full >= 0.6 * leftLines.length && width > 120;
    return !wrappedLeft;
};

/**
 * Zones of a set of items (text lines and tables; floating images don't take part in the flow), top to bottom.
 * `minGutter`: narrowest vertical gap that separates columns.
 */
export const segment = (items: Item[], minGutter: number, depth = 0): Zone[] => {
    if (!items.length) return [];
    const sorted = items.slice().sort((a, b) => a.box.y - b.box.y);
    // Raw bands: items that overlap vertically.
    const bands: Item[][] = [];
    let bandBottom = -Infinity;
    for (const it of sorted) {
        const band = bands[bands.length - 1];
        // Touching lines (tight leading, descenders into the next line) still start a new band when they only overlap
        // by a sliver.
        if (band && it.box.y < bandBottom - Math.min(2, 0.25 * it.box.height)) {
            band.push(it);
            bandBottom = Math.max(bandBottom, bottom(it.box));
        } else {
            bands.push([it]);
            bandBottom = bottom(it.box);
        }
    }
    // Zones: consecutive bands with the same gutters. A gutter only exists where content sits on both sides of it at
    // the same height (within one band); later bands may narrow it but not close it.
    type Acc = { items: Item[]; gutters: [number, number][] };
    const zones: Acc[] = [];
    const narrow = (gs: [number, number][], band: Item[]): [number, number][] | null => {
        const out: [number, number][] = [];
        for (const [a0, b0] of gs) {
            let a = a0;
            let b = b0;
            for (const it of band) {
                const s = it.box.x;
                const e = right(it.box);
                if (e <= a + 0.5 || s >= b - 0.5) continue;
                if (s <= a + 0.5 && e >= b - 0.5) return null;
                if (s <= a + 0.5) a = e;
                else if (e >= b - 0.5) b = s;
                else return null;
            }
            if (b - a < minGutter) return null;
            out.push([a, b]);
        }
        return out;
    };
    for (const band of bands) {
        const g = gutters(band, minGutter);
        const z = zones[zones.length - 1];
        if (z) {
            if (!z.gutters.length && !g.length) {
                z.items.push(...band);
                continue;
            }
            if (z.gutters.length) {
                const narrowed = narrow(z.gutters, band);
                if (narrowed) {
                    z.items.push(...band);
                    z.gutters = narrowed;
                    continue;
                }
            }
        }
        zones.push({ items: band.slice(), gutters: g });
    }
    // Merge consecutive gutter-less zones (single flows split by an item that briefly opened a gutter).
    const out: Zone[] = [];
    for (const z of zones) {
        const box = bounds(z.items);
        // Gutters between the pieces of tabbed rows stay inside one region; the others split the zone.
        const hard = z.gutters.filter((gt) => !isRowStructure(z.items, gt));
        if (!hard.length) {
            const kind = z.gutters.length ? "rows" : "single";
            const prev = out[out.length - 1];
            if (prev && (prev.kind === "single" || prev.kind === "rows") && (kind === "single" || kind === "rows")) {
                prev.regions[0].items.push(...z.items);
                prev.regions[0].box = bounds(prev.regions[0].items);
                prev.bottom = Math.max(prev.bottom, bottom(box));
                if (kind === "rows") prev.kind = "rows";
                continue;
            }
            out.push({ top: box.y, bottom: bottom(box), kind, regions: [{ box, items: z.items }] });
            continue;
        }
        // Split at the hard gutters into parts, left to right.
        const cuts = hard.map((gt) => (gt[0] + gt[1]) / 2);
        const parts: Item[][] = cuts.map(() => []);
        parts.push([]);
        for (const it of z.items) {
            const cx = it.box.x + it.box.width / 2;
            let k = 0;
            while (k < cuts.length && cx > cuts[k]) k++;
            parts[k].push(it);
        }
        const regions = parts.filter((p) => p.length).map((p) => ({ box: bounds(p), items: p }));
        // Text columns: several parts, each with a few lines, of similar widths.
        const widths = regions.map((r) => r.box.width);
        const lineCounts = regions.map((r) => r.items.filter((i) => i.line).length);
        const similar = Math.max(...widths) <= 1.35 * Math.min(...widths);
        const kind = regions.length >= 2 && regions.length <= 4 && similar && lineCounts.every((n) => n >= 3) ? "columns" : "blocks";
        out.push({ top: box.y, bottom: bottom(box), kind, regions });
    }
    // Inside side-by-side blocks there may be more structure (a key/value box next to an address).
    if (depth < 2) {
        for (const z of out) {
            if (z.kind !== "blocks") continue;
            for (const r of z.regions) {
                const sub = segment(r.items, minGutter, depth + 1);
                if (sub.length > 1 || sub.some((s) => s.kind === "blocks" || s.kind === "columns")) (r as Region & { zones?: Zone[] }).zones = sub;
            }
        }
    }
    return out;
};

/** Regions of a zone in reading order, expanding nested structure of blocks. */
export const readingRegions = (zone: Zone): Region[] => {
    const out: Region[] = [];
    for (const r of zone.regions) {
        const nested = (r as Region & { zones?: Zone[] }).zones;
        if (nested) for (const z of nested) out.push(...readingRegions(z));
        else out.push(r);
    }
    return out;
};
