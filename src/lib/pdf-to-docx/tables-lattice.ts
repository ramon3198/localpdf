// Ruled table structure ("lattice"): the page's rules and the edges of its filled rectangles become horizontal and
// vertical segments; segments that touch form a component; each component becomes a grid (column and row boundaries)
// with a map of which grid edges are really drawn. Components stacked with the same width (zebra rows whose white
// stripes are not painted, a header bar followed by row separators) are joined into one grid.
import { splitsAtColumnGap } from "./tables-text";
import type { FilledRect, PageContent, Rect, RuleSegment, TextLine } from "./types";

export type LSeg = {
    horizontal: boolean;
    /** y of a horizontal segment, x of a vertical one. */
    pos: number;
    a: number;
    b: number;
    /** The visible line, when the segment is drawn (a border). */
    rule: RuleSegment | null;
    /** The filled rectangle whose edge this is, when it comes from a fill. */
    fill: FilledRect | null;
};

export type Edge = {
    present: boolean;
    rule: RuleSegment | null;
    /** A column / row boundary that only the text inside one cell implies: cells stay apart unless text crosses. */
    soft?: boolean;
    /** Not a boundary here at all (a subdivision of another cell passing by): the cells on both sides are one. */
    join?: boolean;
};

export type Grid = {
    xs: number[];
    ys: number[];
    /** v[r][i]: vertical boundary i (0..cols) inside row r. */
    v: Edge[][];
    /** h[j][c]: horizontal boundary j (0..rows) inside column c. */
    h: Edge[][];
    /** Rows that take their columns from the rest of the table (no vertical lines of their own). */
    inherited: boolean[];
    /** Horizontal boundaries that come from text, not from drawing. */
    virtualY: boolean[];
    /** Vertical boundaries that come from text, not from drawing. */
    virtualX: boolean[];
    /** Filled shapes inside the grid that are not cells (chart bars, marks in a framed figure). */
    freeFills?: number;
};

const TOUCH = 2.5;
const SNAP = 2;
const MAX_SEGMENTS = 4000;

const bboxOf = (segs: LSeg[]) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of segs) {
        const [sx0, sx1, sy0, sy1] = s.horizontal ? [s.a, s.b, s.pos, s.pos] : [s.pos, s.pos, s.a, s.b];
        x0 = Math.min(x0, sx0);
        x1 = Math.max(x1, sx1);
        y0 = Math.min(y0, sy0);
        y1 = Math.max(y1, sy1);
    }
    return { x0, y0, x1, y1 };
};

/** Segments of the page: rules (not dotted leaders) and the four edges of every reasonably sized fill. */
export const pageSegments = (content: PageContent): LSeg[] => {
    const segs: LSeg[] = [];
    const pageArea = content.width * content.height;
    for (const r of content.graphics.rules as (RuleSegment & { style?: string })[]) {
        if (r.style === "dotted") continue;
        const horizontal = Math.abs(r.y2 - r.y1) <= Math.abs(r.x2 - r.x1);
        const seg: LSeg = horizontal
            ? { horizontal, pos: (r.y1 + r.y2) / 2, a: Math.min(r.x1, r.x2), b: Math.max(r.x1, r.x2), rule: r, fill: null }
            : { horizontal, pos: (r.x1 + r.x2) / 2, a: Math.min(r.y1, r.y2), b: Math.max(r.y1, r.y2), rule: r, fill: null };
        if (seg.b - seg.a >= 4) segs.push(seg);
    }
    for (const f of content.graphics.fills) {
        if (f.width < 3 || f.height < 3 || f.width * f.height > 0.5 * pageArea) continue;
        const x1 = f.x + f.width;
        const y1 = f.y + f.height;
        segs.push(
            { horizontal: true, pos: f.y, a: f.x, b: x1, rule: null, fill: f },
            { horizontal: true, pos: y1, a: f.x, b: x1, rule: null, fill: f },
            { horizontal: false, pos: f.x, a: f.y, b: y1, rule: null, fill: f },
            { horizontal: false, pos: x1, a: f.y, b: y1, rule: null, fill: f },
        );
    }
    return segs.length > MAX_SEGMENTS ? [] : segs;
};

const touches = (p: LSeg, q: LSeg) => {
    if (p.horizontal !== q.horizontal) {
        const h = p.horizontal ? p : q;
        const v = p.horizontal ? q : p;
        return v.pos >= h.a - TOUCH && v.pos <= h.b + TOUCH && h.pos >= v.a - TOUCH && h.pos <= v.b + TOUCH;
    }
    // Collinear pieces that meet.
    return Math.abs(p.pos - q.pos) <= 1 && p.a <= q.b + 1 && q.a <= p.b + 1;
};

class UnionFind {
    parent: number[];
    constructor(n: number) {
        this.parent = Array.from({ length: n }, (_, i) => i);
    }
    find(i: number): number {
        while (this.parent[i] !== i) {
            this.parent[i] = this.parent[this.parent[i]];
            i = this.parent[i];
        }
        return i;
    }
    union(a: number, b: number) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) this.parent[rb] = ra;
    }
}

export type Component = { segs: LSeg[]; x0: number; y0: number; x1: number; y1: number };

const components = (segs: LSeg[]): Component[] => {
    const uf = new UnionFind(segs.length);
    const H = segs.map((s, i) => ({ s, i })).filter((x) => x.s.horizontal);
    const V = segs.map((s, i) => ({ s, i })).filter((x) => !x.s.horizontal);
    // Perpendicular contacts: verticals sorted by x, searched within each horizontal's extent.
    V.sort((p, q) => p.s.pos - q.s.pos);
    const firstAtLeast = (x: number) => {
        let lo = 0;
        let hi = V.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (V[mid].s.pos < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    for (const h of H) {
        for (let k = firstAtLeast(h.s.a - TOUCH); k < V.length && V[k].s.pos <= h.s.b + TOUCH; k++) {
            if (touches(h.s, V[k].s)) uf.union(h.i, V[k].i);
        }
    }
    // Collinear contacts: neighbours in (position, start) order.
    for (const list of [H, V]) {
        const sorted = [...list].sort((p, q) => p.s.pos - q.s.pos || p.s.a - q.s.a);
        for (let k = 0; k < sorted.length; k++)
            for (let m = k + 1; m < sorted.length && sorted[m].s.pos - sorted[k].s.pos <= 1; m++)
                if (touches(sorted[k].s, sorted[m].s)) uf.union(sorted[k].i, sorted[m].i);
    }
    const groups = new Map<number, LSeg[]>();
    segs.forEach((s, i) => {
        const r = uf.find(i);
        const g = groups.get(r);
        if (g) g.push(s);
        else groups.set(r, [s]);
    });
    return [...groups.values()].map((g) => ({ segs: g, ...bboxOf(g) }));
};

const verticalsOf = (c: Component) => c.segs.filter((s) => !s.horizontal);
const hasVerticalStructure = (c: Component) => {
    const vs = verticalsOf(c);
    // At least three distinct vertical lines (two columns) or two lines with a horizontal one between them.
    const xs = new Set(vs.map((s) => Math.round(s.pos)));
    return xs.size >= 2;
};

/**
 * Structures drawn inside a cell of another component without touching its lines (row separators inset by the
 * cell padding, shaded bands narrower than the cell) are snapped to that cell so they become part of its grid.
 */
const absorbInner = (comps: Component[], structural: Set<FilledRect>): Component[] => {
    const big = comps.filter((c) => hasVerticalStructure(c)).sort((p, q) => (q.x1 - q.x0) * (q.y1 - q.y0) - (p.x1 - p.x0) * (p.y1 - p.y0));
    const absorbed = new Set<Component>();
    for (const outer of big) {
        if (absorbed.has(outer)) continue;
        for (const inner of comps) {
            if (inner === outer || absorbed.has(inner)) continue;
            if (inner.x0 < outer.x0 - 1 || inner.x1 > outer.x1 + 1 || inner.y0 < outer.y0 - 1 || inner.y1 > outer.y1 + 1) continue;
            // The enclosing cell: nearest vertical lines of the outer component left and right of the inner bounds.
            const mid = (inner.y0 + inner.y1) / 2;
            const vs = verticalsOf(outer).filter((v) => v.a <= mid + TOUCH && v.b >= mid - TOUCH);
            const lefts = vs.filter((v) => v.pos <= inner.x0 + TOUCH).map((v) => v.pos);
            const rights = vs.filter((v) => v.pos >= inner.x1 - TOUCH).map((v) => v.pos);
            if (!lefts.length || !rights.length) continue;
            const L = Math.max(...lefts);
            const R = Math.min(...rights);
            const width = R - L;
            if (width <= 0 || inner.x1 - inner.x0 < 0.75 * width || inner.x0 - L > 24 || R - inner.x1 > 24) continue;
            // The cell's top and bottom lines: an inset band that starts or ends within a padding of them starts
            // or ends there (no sliver of empty row above or below it).
            const across = outer.segs.filter((s) => s.horizontal && s.a <= L + TOUCH && s.b >= R - TOUCH);
            const above = across.filter((s) => s.pos <= inner.y0 + TOUCH).map((s) => s.pos);
            const below = across.filter((s) => s.pos >= inner.y1 - TOUCH).map((s) => s.pos);
            const T = above.length ? Math.max(...above) : null;
            const B = below.length ? Math.min(...below) : null;
            const snapped: LSeg[] = [];
            for (const s of inner.segs) {
                if (s.horizontal) {
                    let pos = s.pos;
                    if (T !== null && Math.abs(s.pos - inner.y0) <= 1 && inner.y0 - T <= 12) pos = T;
                    if (B !== null && Math.abs(s.pos - inner.y1) <= 1 && B - inner.y1 <= 12) pos = B;
                    snapped.push({ ...s, pos, a: L, b: R });
                }
                // Vertical sides of an inset band duplicate the cell's own sides.
                else if (s.pos - L > 24 && R - s.pos > 24) snapped.push(s);
            }
            outer.segs.push(...snapped);
            absorbed.add(inner);
            for (const s of inner.segs) if (s.fill) structural.add(s.fill);
        }
    }
    return comps.filter((c) => !absorbed.has(c));
};

/**
 * Filled shapes inside a component that are not cells: edges that meet no line and no other cell (the bars of a
 * chart, a coloured mark inside a framed figure). Inset bands already snapped to their cells don't count.
 */
const freeFills = (c: Component, fills: FilledRect[], structural: Set<FilledRect>) => {
    const W = c.x1 - c.x0;
    const H = c.y1 - c.y0;
    let n = 0;
    for (const f of fills) {
        if (structural.has(f) || f.width * f.height < 20) continue;
        const mx = f.x + f.width / 2;
        const my = f.y + f.height / 2;
        if (mx < c.x0 || mx > c.x1 || my < c.y0 || my > c.y1) continue;
        const wide = f.width >= 0.9 * W;
        const tall = f.height >= 0.9 * H;
        if (wide && tall) continue;
        const aligned = (horizontal: boolean, pos: number, a: number, b: number) =>
            c.segs.some((s) => s.fill !== f && s.horizontal === horizontal && Math.abs(s.pos - pos) <= 1.5 && s.a <= b + 2 && s.b >= a - 2);
        let loose = 0;
        if (!wide) {
            if (!aligned(false, f.x, f.y, f.y + f.height)) loose++;
            if (!aligned(false, f.x + f.width, f.y, f.y + f.height)) loose++;
        }
        if (!tall) {
            if (!aligned(true, f.y, f.x, f.x + f.width)) loose++;
            if (!aligned(true, f.y + f.height, f.x, f.x + f.width)) loose++;
        }
        if (loose >= 2) n++;
    }
    return n;
};

/** Text lines whose centre lies inside a box. */
const linesIn = (lines: TextLine[], x0: number, y0: number, x1: number, y1: number) =>
    lines.filter((l) => {
        const cxv = l.box.x + l.box.width / 2;
        const cyv = l.box.y + l.box.height / 2;
        return cxv >= x0 && cxv <= x1 && cyv >= y0 && cyv <= y1;
    });

/** Column boundaries of a component (positions of its vertical lines). */
const columnLines = (c: Component) => cluster(verticalsOf(c).map((s) => ({ pos: s.pos, weight: s.b - s.a })));

/**
 * Joins components stacked on top of each other with the same left and right edges when the gap between them is
 * a plausible row: zebra tables whose white stripes are not painted, a header bar followed by row separators.
 */
const stack = (comps: Component[], lines: TextLine[]): Component[] => {
    const sorted = [...comps].sort((p, q) => p.y0 - q.y0);
    const out: Component[] = [];
    for (const c of sorted) {
        const prev = [...out].reverse().find((p) => Math.abs(p.x0 - c.x0) <= 4 && Math.abs(p.x1 - c.x1) <= 4 && c.y0 >= p.y1 - TOUCH);
        if (prev && (hasVerticalStructure(prev) || hasVerticalStructure(c))) {
            const gap = c.y0 - prev.y1;
            // Typical row height of what is already there.
            const hs = cluster(prev.segs.filter((s) => s.horizontal).map((s) => ({ pos: s.pos, weight: 1 }))).map((k) => k.pos);
            const rowH = hs.length >= 2 ? Math.max(...hs.slice(1).map((y, i) => y - hs[i])) : 30;
            const inGap = linesIn(lines, c.x0, prev.y1, c.x1, c.y0);
            const cols = columnLines(hasVerticalStructure(prev) ? prev : c).map((k) => k.pos);
            // Text in the gap must sit in the columns, not run across them like a paragraph (two cells the text
            // extractor kept on one line, a column-wide gap where the boundary runs, still sit in the columns).
            const crossing = inGap.some((l) =>
                cols.some((x) => x > l.box.x + 3 && x < l.box.x + l.box.width - 3 && x > c.x0 + 3 && x < c.x1 - 3 && !splitsAtColumnGap(l, x)),
            );
            // Nothing else between them (another table, a paragraph wider than the table).
            const outside = lines.some(
                (l) => l.box.y + l.box.height / 2 > prev.y1 && l.box.y + l.box.height / 2 < c.y0 && (l.box.x < c.x0 - 6 || l.box.x + l.box.width > c.x1 + 6),
            );
            // Two pieces with columns of their own must have the same columns (zebra stripes of one table).
            const inner = (k: Component) =>
                columnLines(k)
                    .map((q) => q.pos)
                    .filter((x) => x > k.x0 + 3 && x < k.x1 - 3);
            const pa = inner(prev);
            const pb = inner(c);
            const sameColumns = !pa.length || !pb.length || (pa.length === pb.length && pa.every((x, i) => Math.abs(x - pb[i]) <= 2.5));
            // An empty gap between two drawn pieces is a space between two tables, not a row.
            const rowInGap = gap < 3 || inGap.length > 0;
            if (gap <= Math.max(3.2 * rowH, 48) && rowInGap && sameColumns && !crossing && !outside && others(out, prev, c)) {
                prev.segs.push(...c.segs);
                prev.x0 = Math.min(prev.x0, c.x0);
                prev.x1 = Math.max(prev.x1, c.x1);
                prev.y1 = Math.max(prev.y1, c.y1);
                continue;
            }
        }
        out.push(c);
    }
    return out;
};

/**
 * No other component sits between `upper` and `lower` in the gap. Small drawings inside the columns (a progress bar,
 * a swatch in a row without lines of its own) belong to that row, they don't separate two tables.
 */
const others = (all: Component[], upper: Component, lower: Component) =>
    !all.some(
        (o) =>
            o !== upper &&
            o.y0 >= upper.y1 - 1 &&
            o.y1 <= lower.y0 + 1 &&
            o.x1 > upper.x0 &&
            o.x0 < upper.x1 &&
            !(o.x0 >= upper.x0 - 1 && o.x1 <= upper.x1 + 1 && o.x1 - o.x0 < 0.5 * (upper.x1 - upper.x0)),
    );

/** 1-D clustering of positions (within SNAP points), weighted mean. */
export const cluster = (items: { pos: number; weight: number }[], tol = SNAP): { pos: number; weight: number }[] => {
    const s = [...items].sort((p, q) => p.pos - q.pos);
    const out: { pos: number; weight: number; sum: number; last: number }[] = [];
    for (const it of s) {
        const cur = out[out.length - 1];
        if (cur && it.pos - cur.last <= tol) {
            cur.sum += it.pos * it.weight;
            cur.weight += it.weight;
            cur.last = it.pos;
            cur.pos = cur.sum / Math.max(cur.weight, 1e-9);
        } else out.push({ pos: it.pos, weight: it.weight, sum: it.pos * it.weight, last: it.pos });
    }
    return out.map(({ pos, weight }) => ({ pos, weight }));
};

/** Boundaries of a component along one axis: its lines, clustered, plus its outer edges; slivers removed. */
const boundaries = (segs: LSeg[], lo: number, hi: number): number[] => {
    // Visible rules decide the position of a boundary; fill edges only when no rule is there.
    const items = segs.map((s) => ({ pos: s.pos, weight: (s.b - s.a) * (s.rule ? 4 : 1) }));
    items.push({ pos: lo, weight: 1e-3 }, { pos: hi, weight: 1e-3 });
    const ks = cluster(items);
    // Slivers between two nearby lines (double borders, a border beside a fill edge): keep the stronger line.
    const out: { pos: number; weight: number }[] = [];
    for (const k of ks) {
        const last = out[out.length - 1];
        if (last && k.pos - last.pos < 5) {
            if (k.weight > last.weight) out[out.length - 1] = k;
            continue;
        }
        out.push(k);
    }
    return out.map((k) => k.pos);
};

const edgeOf = (segs: LSeg[], pos: number, a: number, b: number): Edge => {
    let covered = 0;
    let best: { rule: RuleSegment; overlap: number } | null = null;
    const spans: [number, number][] = [];
    for (const s of segs) {
        if (Math.abs(s.pos - pos) > TOUCH) continue;
        const lo = Math.max(a, s.a);
        const hi = Math.min(b, s.b);
        if (hi - lo <= 0) continue;
        spans.push([lo, hi]);
        if (s.rule && (!best || hi - lo > best.overlap)) best = { rule: s.rule, overlap: hi - lo };
    }
    spans.sort((p, q) => p[0] - q[0]);
    let end = -Infinity;
    for (const [lo, hi] of spans) {
        if (hi <= end) continue;
        covered += hi - Math.max(lo, end);
        end = hi;
    }
    const present = covered >= 0.6 * (b - a) - 0.5;
    const ruleCovered = best ? best.overlap >= 0.5 * (b - a) - 0.5 : false;
    return { present, rule: present && ruleCovered && best ? best.rule : null };
};

/** Builds the grid of a component. */
export const gridOf = (c: Component): Grid | null => {
    const hs = c.segs.filter((s) => s.horizontal);
    const vs = c.segs.filter((s) => !s.horizontal);
    const xs = boundaries(vs, c.x0, c.x1);
    const ys = boundaries(hs, c.y0, c.y1);
    if (xs.length < 2 || ys.length < 2) return null;
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const v: Edge[][] = [];
    for (let r = 0; r < rows; r++) v.push(xs.map((x) => edgeOf(vs, x, ys[r], ys[r + 1])));
    const h: Edge[][] = [];
    for (let j = 0; j <= rows; j++) {
        const row: Edge[] = [];
        for (let k = 0; k < cols; k++) row.push(edgeOf(hs, ys[j], xs[k], xs[k + 1]));
        h.push(row);
    }
    // Rows without any vertical line of their own — not even the outer sides — inherit the table's columns (rows
    // under a header bar, unpainted zebra stripes). A row framed at both sides but without inner lines is a merged row.
    const inherited = v.map((row) => cols > 1 && row.slice(1, -1).every((e) => !e.present) && !(row[0].present && row[cols].present));
    return { xs, ys, v, h, inherited, virtualY: ys.map(() => false), virtualX: xs.map(() => false) };
};

/**
 * Filled panels that partly cover one another (a price tag over a banner) are a designed layout: table cells tile
 * the table, and cell shading sits inside its cell.
 */
const overlappingFills = (c: Component) => {
    const fills = [...new Set(c.segs.map((s) => s.fill).filter((f): f is FilledRect => !!f))];
    for (let i = 0; i < fills.length; i++)
        for (let j = i + 1; j < fills.length; j++) {
            const p = fills[i];
            const q = fills[j];
            const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
            const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
            if (w <= 1 || h <= 1) continue;
            const inside = (a: FilledRect, b: FilledRect) =>
                a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
            if (!inside(p, q) && !inside(q, p)) return true;
        }
    return false;
};

/** Candidate ruled grids of the page with their bounds. */
export const latticeGrids = (content: PageContent, lines: TextLine[]): { grid: Grid; box: Rect }[] => {
    const segs = pageSegments(content);
    if (!segs.length) return [];
    const structural = new Set<FilledRect>();
    let comps = components(segs);
    comps = absorbInner(comps, structural);
    comps = stack(comps, lines);
    const out: { grid: Grid; box: Rect }[] = [];
    for (const c of comps) {
        if (c.x1 - c.x0 < 20 || c.y1 - c.y0 < 8) continue;
        if (overlappingFills(c)) continue;
        const grid = gridOf(c);
        if (grid) grid.freeFills = freeFills(c, content.graphics.fills, structural);
        if (grid)
            out.push({
                grid,
                box: { x: grid.xs[0], y: grid.ys[0], width: grid.xs[grid.xs.length - 1] - grid.xs[0], height: grid.ys[grid.ys.length - 1] - grid.ys[0] },
            });
    }
    return out;
};
