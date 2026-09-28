// Tables without lines, found in the text: consecutive rows of text whose pieces sit in the same columns, separated
// by gutters that no piece crosses. Only clearly columnar text qualifies — three or more columns (or two with cells
// that wrap), several rows — so tabbed lines, key–value lists, bullet lists and multi-column article layouts stay
// paragraphs. Also extends a ruled header (a shaded bar with column titles) over the plain rows printed below it.
import type { Edge, Grid } from "./tables-lattice";
import { bottom, inkSpan, lineText, median, right, splitLineAtColumnGaps, textRows } from "./tables-text";
import type { PageContent, Rect, RuleSegment, TextLine } from "./types";

const MIN_GUTTER = 6;
const MARKER = /^([•·▪◦‣∙●○■□➢➤►–—-]|\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])$/;

type Block = { rows: TextLine[][]; x0: number; x1: number; gutters: [number, number][] };

/** Free horizontal bands (≥ MIN_GUTTER wide) between the ink of all pieces, inside [x0, x1]. */
const gutters = (rows: TextLine[][], x0: number, x1: number): [number, number][] => {
    const spans = rows
        .flat()
        .map(inkSpan)
        .sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let end = x0;
    for (const [a, b] of spans) {
        if (a - end >= MIN_GUTTER && end > x0) out.push([end, a]);
        end = Math.max(end, b);
    }
    return out.filter(([a, b]) => a > x0 && b < x1);
};

const columnOf = (gs: [number, number][], x: number) => {
    let k = 0;
    while (k < gs.length && x > (gs[k][0] + gs[k][1]) / 2) k++;
    return k;
};

const insideAny = (l: TextLine, rects: Rect[]) =>
    rects.some((r) => {
        const mx = l.box.x + l.box.width / 2;
        const my = l.box.y + l.box.height / 2;
        return mx >= r.x && mx <= r.x + r.width && my >= r.y && my <= r.y + r.height;
    });

/** Grows a block of columnar rows from row `i`. */
const grow = (rows: TextLine[][], i: number): Block | null => {
    if (rows[i].length < 2) return null;
    let block: TextLine[][] = [rows[i]];
    let x0 = Math.min(...rows[i].map((l) => inkSpan(l)[0]));
    let x1 = Math.max(...rows[i].map((l) => inkSpan(l)[1]));
    let gs = gutters(block, x0, x1);
    if (!gs.length) return null;
    for (let k = i + 1; k < rows.length; k++) {
        const prev = block[block.length - 1];
        const row = rows[k];
        const size = median([...prev, ...row].map((l) => l.fontSize)) || 10;
        if (row[0].baseline - prev[0].baseline > 2.8 * size) break;
        // A heading or a footnote (much bigger or smaller text on its own) ends the table.
        const body = median(block.flat().map((l) => l.fontSize)) || size;
        const rs = median(row.map((l) => l.fontSize));
        if (row.length === 1 && (rs >= 1.25 * body || rs <= 0.75 * body)) break;
        const nx0 = Math.min(x0, ...row.map((l) => inkSpan(l)[0]));
        const nx1 = Math.max(x1, ...row.map((l) => inkSpan(l)[1]));
        // Pieces of the new row must not run across the columns found so far.
        const crosses = row.some((l) => {
            const [a, b] = inkSpan(l);
            return gs.some(([g0, g1]) => a < g0 + 1 && b > g1 - 1);
        });
        if (crosses) break;
        const next = gutters([...block, row], nx0, nx1);
        // Every existing gutter must survive (possibly narrower).
        const kept = gs.every(([g0, g1]) => next.some(([n0, n1]) => n0 < g1 && n1 > g0));
        if (!kept) break;
        block = [...block, row];
        x0 = nx0;
        x1 = nx1;
        gs = next;
    }
    return { rows: block, x0, x1, gutters: gs };
};

/**
 * Gutters that only exist because a header is aligned differently from its column (a left-aligned "Cantidad" over
 * right-aligned numbers) leave a column with text in just one or two rows: that column joins the neighbour it does
 * not collide with (two pieces of one row can't share a column).
 */
const pruneColumns = (b: Block): Block => {
    let gs = [...b.gutters];
    for (let guard = 0; guard < 20 && gs.length; guard++) {
        const cols = gs.length + 1;
        const colsOfRow = b.rows.map((r) => r.map((l) => columnOf(gs, (inkSpan(l)[0] + inkSpan(l)[1]) / 2)));
        const support = new Array(cols).fill(0);
        colsOfRow.forEach((cs) => new Set(cs).forEach((c) => support[c]++));
        const weak = support
            .map((n, c) => ({ n, c }))
            .filter(({ n }) => n <= Math.max(1, 0.25 * b.rows.length))
            .sort((p, q) => p.n - q.n);
        let merged = false;
        for (const { c } of weak) {
            const collide = (d: number) => colsOfRow.some((cs) => cs.includes(c) && cs.includes(d));
            const options: { d: number; width: number }[] = [];
            // Merging with the left neighbour removes gutter c - 1; with the right one, gutter c.
            if (c > 0 && !collide(c - 1)) options.push({ d: c - 1, width: gs[c - 1][1] - gs[c - 1][0] });
            if (c < cols - 1 && !collide(c + 1)) options.push({ d: c + 1, width: gs[c][1] - gs[c][0] });
            if (!options.length) continue;
            options.sort((p, q) => support[q.d] - support[p.d] || p.width - q.width);
            const d = options[0].d;
            gs = gs.filter((_, k) => k !== (d < c ? c - 1 : c));
            merged = true;
            break;
        }
        if (!merged) break;
    }
    return { ...b, gutters: gs };
};

/** Rows of the block grouped into table rows: a row with pieces in two columns, or after a wider gap, starts one. */
const logicalRows = (b: Block): TextLine[][][] => {
    const out: TextLine[][][] = [];
    for (let k = 0; k < b.rows.length; k++) {
        const row = b.rows[k];
        const cols = new Set(row.map((l) => columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2))).size;
        const prev = b.rows[k - 1];
        const size = median(row.map((l) => l.fontSize)) || 10;
        const wide = prev && row[0].baseline - prev[0].baseline > 1.45 * size;
        if (!out.length || cols >= 2 || wide) out.push([row]);
        else out[out.length - 1].push(row);
    }
    return out;
};

const accept = (b: Block, content: PageContent): boolean => {
    const cols = b.gutters.length + 1;
    const multi = b.rows.filter((r) => new Set(r.map((l) => columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2))).size >= 2).length;
    if (multi < 3) return false;
    const groups = logicalRows(b);
    const wrapped = groups.some((g) => g.length > 1);
    if (cols < 2) return false;
    if (cols === 2) {
        // Two columns are usually tab stops (labels and values, a price list with leaders); only a real two-column
        // grid — cells that wrap, several rows, no leaders drawn across the gutter — becomes a table.
        if (!wrapped || multi < 4) return false;
        const [g0, g1] = b.gutters[0];
        const leaders = (content.graphics.rules as (RuleSegment & { style?: string })[]).some(
            (r) =>
                r.style === "dotted" &&
                Math.min(r.x1, r.x2) < g1 &&
                Math.max(r.x1, r.x2) > g0 &&
                (r.y1 + r.y2) / 2 >= b.rows[0][0].box.y &&
                (r.y1 + r.y2) / 2 <= bottom(b.rows[b.rows.length - 1][0].box) + 4,
        );
        if (leaders) return false;
    }
    // Each column must hold text in several rows.
    const perCol = new Array(cols).fill(0);
    for (const g of groups) {
        const seen = new Set<number>();
        for (const l of g.flat()) seen.add(columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2));
        seen.forEach((c) => perCol[c]++);
    }
    if (perCol.some((n) => n < Math.min(2, groups.length))) return false;
    // A first column of list markers is a list.
    const first = b.rows.flat().filter((l) => columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2) === 0);
    if (first.length && first.every((l) => MARKER.test(lineText(l).trim()))) return false;
    // Columns of running text (a multi-column article) fill their width line after line.
    const bounds = [b.x0, ...b.gutters.map(([g0, g1]) => (g0 + g1) / 2), b.x1];
    let prose = 0;
    for (let c = 0; c < cols; c++) {
        const w = bounds[c + 1] - bounds[c];
        const ls = b.rows.flat().filter((l) => columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2) === c);
        const fill = median(ls.map((l) => (inkSpan(l)[1] - inkSpan(l)[0]) / Math.max(w, 1)));
        if (w >= 150 && fill >= 0.8 && ls.length >= 3) prose++;
    }
    if (prose >= 2 || (prose >= 1 && cols === 2)) return false;
    return b.x1 - b.x0 <= content.width;
};

const noEdge: Edge = { present: false, rule: null };

/** A grid of text-only boundaries: gutter centres and the gaps between table rows. */
const gridOfBlock = (b: Block, margin: number): Grid => {
    const groups = logicalRows(b);
    const xs = [b.x0 - margin, ...b.gutters.map(([g0, g1]) => (g0 + g1) / 2), b.x1 + margin];
    const tops = groups.map((g) => Math.min(...g.flat().map((l) => l.box.y)));
    const bots = groups.map((g) => Math.max(...g.flat().map((l) => bottom(l.box))));
    const ys = [tops[0] - 2, ...tops.slice(1).map((t, k) => (t + bots[k]) / 2), bots[bots.length - 1] + 2];
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    return {
        xs,
        ys,
        v: Array.from({ length: rows }, () => new Array<Edge>(cols + 1).fill(noEdge)),
        h: Array.from({ length: rows + 1 }, () => new Array<Edge>(cols).fill(noEdge)),
        inherited: new Array<boolean>(rows).fill(true),
        virtualY: ys.map((_, j) => j > 0 && j < rows),
        virtualX: xs.map((_, i) => i > 0 && i < cols),
    };
};

/**
 * Horizontal rules across a borderless table (top and bottom rules, a line under the header — the classic
 * "booktabs" look) become its borders, moving the nearest row boundary onto the rule.
 */
const withRules = (grid: Grid, content: PageContent): Grid => {
    const { xs } = grid;
    const ys = [...grid.ys];
    const h = grid.h.map((r) => [...r]);
    const x0 = xs[0];
    const x1 = xs[xs.length - 1];
    const w = x1 - x0;
    for (const r of content.graphics.rules as (RuleSegment & { style?: string })[]) {
        if (Math.abs(r.y2 - r.y1) > 0.5 || r.style === "dotted") continue;
        const a = Math.min(r.x1, r.x2);
        const b = Math.max(r.x1, r.x2);
        // Spans the table (text-based bounds are a little narrower than the drawn rules).
        if (Math.min(b, x1 + 12) - Math.max(a, x0 - 12) < 0.85 * w || a < x0 - 0.2 * w || b > x1 + 0.2 * w) continue;
        const y = (r.y1 + r.y2) / 2;
        // Outer rules may sit a row padding away from the text.
        const pad = Math.max(10, median(ys.slice(1).map((v, k) => v - ys[k])));
        let best = -1;
        for (let j = 0; j < ys.length; j++) {
            const lo = j > 0 ? (ys[j - 1] + ys[j]) / 2 : ys[0] - pad;
            const hi = j < ys.length - 1 ? (ys[j] + ys[j + 1]) / 2 : ys[ys.length - 1] + pad;
            if (y >= lo && y <= hi) best = j;
        }
        if (best < 0) continue;
        ys[best] = y;
        h[best] = h[best].map(() => ({ present: true, rule: r }));
    }
    // Boundaries must stay in order.
    for (let j = 1; j < ys.length; j++) if (ys[j] <= ys[j - 1]) return grid;
    return { ...grid, ys, h, virtualY: grid.virtualY.map((v, j) => v && !h[j].some((e) => e.present)) };
};

/**
 * Bands painted across a borderless table (a header bar, zebra stripes, a panel behind it) set the rows they shade:
 * a covered row takes the band's top and bottom when they fall in the gaps between rows of text, and the table takes
 * the band's width — so Word paints the shading where the PDF did.
 */
const withFills = (grid: Grid, content: PageContent, tops: number[], bots: number[]): Grid => {
    const xs = [...grid.xs];
    const ys = [...grid.ys];
    const last = xs.length - 1;
    const rows = ys.length - 1;
    const W = xs[last] - xs[0];
    for (const f of content.graphics.fills) {
        const fx1 = f.x + f.width;
        const fy1 = f.y + f.height;
        if (f.x > xs[0] + 20 || fx1 < xs[last] - 20 || f.width > 1.25 * W) continue;
        const covered: number[] = [];
        for (let r = 0; r < rows; r++) if (tops[r] >= f.y - 1 && bots[r] <= fy1 + 1) covered.push(r);
        if (!covered.length) continue;
        const r0 = covered[0];
        const r1 = covered[covered.length - 1];
        if (r0 === 0) ys[0] = Math.min(ys[0], f.y);
        else if (f.y > bots[r0 - 1]) ys[r0] = f.y;
        if (r1 === rows - 1) ys[rows] = Math.max(ys[rows], fy1);
        else if (fy1 < tops[r1 + 1]) ys[r1 + 1] = fy1;
        xs[0] = Math.min(xs[0], f.x);
        xs[last] = Math.max(xs[last], fx1);
    }
    for (let j = 1; j < ys.length; j++) if (ys[j] <= ys[j - 1]) return grid;
    return { ...grid, xs, ys };
};

/**
 * Columns and rows of text set in columns inside one drawn cell — label / value pairs in a framed box, a small
 * listing under a shaded title — as the x of the gutters and the y between rows, or null when the cell's text is
 * not clearly columnar. Two columns are enough here: the box already is a table.
 */
export const cellColumns = (lines: TextLine[]): { xs: number[]; ys: number[] } | null => {
    const rows = textRows(lines);
    if (rows.length < 3) return null;
    const start = rows.findIndex((r) => r.length >= 2);
    if (start < 0) return null;
    const grown = grow(rows, start);
    if (!grown) return null;
    const b = pruneColumns(grown);
    const cols = b.gutters.length + 1;
    if (cols < 2 || b.rows.flat().length < 0.8 * lines.length) return null;
    const colOfLine = (l: TextLine) => columnOf(b.gutters, (inkSpan(l)[0] + inkSpan(l)[1]) / 2);
    const multi = b.rows.filter((r) => new Set(r.map(colOfLine)).size >= 2).length;
    if (multi < 3) return null;
    const groups = logicalRows(b);
    const perCol = new Array(cols).fill(0);
    for (const g of groups) new Set(g.flat().map(colOfLine)).forEach((c) => perCol[c]++);
    if (perCol.some((n) => n < 2)) return null;
    const first = b.rows.flat().filter((l) => colOfLine(l) === 0);
    if (first.every((l) => MARKER.test(lineText(l).trim()))) return null;
    const xs = b.gutters.map(([g0, g1]) => (g0 + g1) / 2);
    const tops = groups.map((g) => Math.min(...g.flat().map((l) => l.box.y)));
    const bots = groups.map((g) => Math.max(...g.flat().map((l) => bottom(l.box))));
    const ys = tops.slice(1).map((t, k) => (t + bots[k]) / 2);
    // Text above the columns (a title inside the cell) gets a row of its own.
    if (start > 0) ys.unshift((Math.max(...rows[start - 1].map((l) => bottom(l.box))) + tops[0]) / 2);
    // Text below the columns likewise.
    const after = rows.slice(start + b.rows.length);
    if (after.length) ys.push((bots[bots.length - 1] + Math.min(...after[0].map((l) => l.box.y))) / 2);
    return { xs, ys };
};

/** Borderless tables among the lines that no ruled table took. */
export const streamGrids = (content: PageContent, lines: TextLine[], taken: Rect[]): { grid: Grid; box: Rect }[] => {
    const free = lines.filter((l) => !insideAny(l, taken));
    const rows = textRows(free);
    const out: { grid: Grid; box: Rect }[] = [];
    let i = 0;
    while (i < rows.length) {
        const grown = grow(rows, i);
        const b = grown && pruneColumns(grown);
        if (b && b.rows.length >= 3 && accept(b, content)) {
            const groups = logicalRows(b);
            const tops = groups.map((g) => Math.min(...g.flat().map((l) => l.box.y)));
            const bots = groups.map((g) => Math.max(...g.flat().map((l) => bottom(l.box))));
            const grid = withRules(withFills(gridOfBlock(b, 5.4), content, tops, bots), content);
            const box = { x: grid.xs[0], y: grid.ys[0], width: grid.xs[grid.xs.length - 1] - grid.xs[0], height: grid.ys[grid.ys.length - 1] - grid.ys[0] };
            // Not over something already found.
            if (!taken.some((t) => t.x < box.x + box.width && t.x + t.width > box.x && t.y < box.y + box.height && t.y + t.height > box.y)) {
                out.push({ grid, box });
                i += b.rows.length;
                continue;
            }
        }
        i++;
    }
    return out;
};

/**
 * A ruled header without drawn rows below it (a shaded title bar, then plain rows): the text rows right under it
 * that sit in its columns become rows of the same table, without borders.
 */
export const extendDown = (grid: Grid, lines: TextLine[]): Grid => {
    const { xs, ys } = grid;
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    if (cols < 2) return grid;
    const bottomDrawn = grid.h[rows].every((e) => e.rule);
    if (bottomDrawn && rows > 1) return grid;
    const x0 = xs[0];
    const x1 = xs[cols];
    const y1 = ys[rows];
    const below = lines.filter((l) => l.box.y >= y1 - 1 && l.box.x >= x0 - 4 && right(l.box) <= x1 + 4);
    const trs = textRows(below);
    const lastH = ys[rows] - ys[rows - 1];
    const taken: TextLine[][] = [];
    let prevBottom = y1;
    for (const tr of trs) {
        const size = median(tr.map((l) => l.fontSize)) || 10;
        const top = Math.min(...tr.map((l) => l.box.y));
        const gap = top - prevBottom;
        if (gap > (taken.length ? 1.6 * size : Math.max(0.8 * lastH, 1.2 * size))) break;
        // Anything on this band of the page outside the table ends it.
        const band = lines.filter((l) => Math.abs(l.baseline - tr[0].baseline) <= 0.3 * size && !tr.includes(l));
        if (band.length) break;
        // Cells the text extractor kept on one line count apart when a column boundary falls in a column-wide gap.
        const pieces = tr.flatMap((l) => splitLineAtColumnGaps(l, xs.slice(1, -1)));
        const fits = pieces.every((l) => {
            const [a, b] = inkSpan(l);
            return !xs.slice(1, -1).some((x) => x > a + 2 && x < b - 2);
        });
        if (!fits) break;
        if (!taken.length && new Set(pieces.map((l) => xs.findIndex((x, k) => k < cols && inkSpan(l)[0] >= x - 2 && inkSpan(l)[1] <= xs[k + 1] + 2))).size < 2)
            break;
        taken.push(tr);
        prevBottom = Math.max(...tr.map((l) => bottom(l.box)));
    }
    if (taken.length < 1) return grid;
    const end = prevBottom + 2;
    return {
        xs,
        ys: [...ys, end],
        v: [...grid.v, new Array<Edge>(cols + 1).fill(noEdge)],
        h: [...grid.h, new Array<Edge>(cols).fill(noEdge)],
        inherited: [...grid.inherited, true],
        virtualY: [...grid.virtualY, false],
        virtualX: grid.virtualX,
        freeFills: grid.freeFills,
    };
};
