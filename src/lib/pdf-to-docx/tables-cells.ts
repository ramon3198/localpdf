// From a grid (column / row boundaries and which edges are drawn) and the page's text to a Table: text lines are cut
// at drawn column lines and assigned to grid cells; cells merge across edges that are not drawn when the text says so
// (it runs across, it is centred on the wider span, a lone label heads a cell spanning several rows); borders come
// from the rules, shading from the fills, and each cell's lines become paragraphs.
import type { ToParagraphs } from "./tables";
import type { Edge, Grid } from "./tables-lattice";
import { cellColumns } from "./tables-stream";
import { bottom, hasText, inkSpan, median, right, splitLineAt, textRows } from "./tables-text";
import type { FilledRect, PageContent, Rect, RuleSegment, Table, TableCell, TableRow, TextLine } from "./types";

/** Word's default cell margins (left / right), so paragraph indents are measured from where Word puts text. */
export const CELL_MARGIN = 5.4;

type Assignment = {
    /** Lines (or pieces of lines) per grid cell. */
    cells: TextLine[][][];
    /** crossV[r][i]: text runs across vertical boundary i in row r. */
    crossV: boolean[][];
    /** crossH[j][c]: text runs across horizontal boundary j in column c. */
    crossH: boolean[][];
    /** Original lines taken by the table. */
    used: Set<TextLine>;
    /** Lines that overlap the table but reach well outside it. */
    intruders: number;
};

const rowOf = (ys: number[], y: number) => {
    for (let r = 0; r + 1 < ys.length; r++) if (y < ys[r + 1]) return r;
    return ys.length - 2;
};
const colOf = (xs: number[], x: number) => {
    for (let c = 0; c + 1 < xs.length; c++) if (x < xs[c + 1]) return c;
    return xs.length - 2;
};

const insideTable = (grid: Grid, l: TextLine) => {
    const x0 = grid.xs[0];
    const x1 = grid.xs[grid.xs.length - 1];
    const y0 = grid.ys[0];
    const y1 = grid.ys[grid.ys.length - 1];
    const mx = l.box.x + l.box.width / 2;
    const my = l.box.y + l.box.height / 2;
    return mx >= x0 - 1 && mx <= x1 + 1 && my >= y0 - 1 && my <= y1 + 1;
};

/** Lines usable in tables: horizontal text with something visible in it. */
export const tableLines = (lines: TextLine[]) => lines.filter((l) => !l.rotation && hasText(l));

// ── Rows of text inside tall rows ──────────────────────────────────────────────────────────────────────────────────

/**
 * Splits grid rows that hold several table rows (rows added below a header without separators, bodies without row
 * lines) at the text: a new row starts with a line of text in two or more columns, or after a gap wider than the
 * spacing of wrapped lines inside a cell.
 */
export const splitTallRows = (grid: Grid, lines: TextLine[]): Grid => {
    const { xs } = grid;
    const cols = xs.length - 1;
    let ys = [...grid.ys];
    let v = grid.v.map((r) => [...r]);
    let h = grid.h.map((r) => [...r]);
    let inherited = [...grid.inherited];
    let virtualY = [...grid.virtualY];
    const rowHeights = ys.slice(1).map((y, i) => y - ys[i]);
    for (let r = ys.length - 2; r >= 0; r--) {
        const inRow = lines.filter((l) => {
            const my = l.box.y + l.box.height / 2;
            return my >= ys[r] && my < ys[r + 1] && l.box.x + l.box.width / 2 >= xs[0] && l.box.x + l.box.width / 2 <= xs[cols];
        });
        // Only rows without lines of their own: in drawn rows, several lines of text are one cell (two-line headers,
        // wrapped descriptions) and the drawing, not the text, says where rows end.
        if (!inherited[r]) continue;
        const trs = textRows(inRow);
        if (trs.length < 2) continue;
        const colsOf = (tr: TextLine[]) => new Set(tr.map((l) => colOf(xs, l.box.x + l.box.width / 2))).size;
        const starts: number[] = [];
        for (let k = 1; k < trs.length; k++) {
            const prev = trs[k - 1];
            const cur = trs[k];
            const size = median(cur.map((l) => l.fontSize)) || 10;
            const pitch = cur[0].baseline - prev[0].baseline;
            if (colsOf(cur) >= 2 || pitch > 1.45 * size) starts.push(k);
        }
        if (!starts.length) continue;
        const cuts = starts.map((k) => (Math.max(...trs[k - 1].map((l) => bottom(l.box))) + Math.min(...trs[k].map((l) => l.box.y))) / 2);
        const noEdge: Edge = { present: false, rule: null };
        ys = [...ys.slice(0, r + 1), ...cuts, ...ys.slice(r + 1)];
        v = [...v.slice(0, r + 1), ...cuts.map(() => [...v[r]]), ...v.slice(r + 1)];
        h = [...h.slice(0, r + 1), ...cuts.map(() => new Array<Edge>(cols).fill(noEdge)), ...h.slice(r + 1)];
        inherited = [...inherited.slice(0, r + 1), ...cuts.map(() => inherited[r]), ...inherited.slice(r + 1)];
        virtualY = [...virtualY.slice(0, r + 1), ...cuts.map(() => true), ...virtualY.slice(r + 1)];
    }
    return { ...grid, ys, v, h, inherited, virtualY };
};

// ── Columns inside a cell ──────────────────────────────────────────────────────────────────────────────────────────

type Refinement = { r: number; c: number; xs: number[]; ys: number[] };

/**
 * Inserts the refinements' boundaries into the grid. Inside the refined cell they are soft (no line drawn, cells stay
 * apart unless text crosses); everywhere else they are no boundary at all (`join`), so other cells span them.
 */
const subdivide = (grid: Grid, refs: Refinement[]): Grid => {
    const xs = [...new Set([...grid.xs, ...refs.flatMap((f) => f.xs)])].sort((a, b) => a - b);
    const ys = [...new Set([...grid.ys, ...refs.flatMap((f) => f.ys)])].sort((a, b) => a - b);
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const origRow = (r: number) => rowOf(grid.ys, (ys[r] + ys[r + 1]) / 2);
    const origCol = (c: number) => colOf(grid.xs, (xs[c] + xs[c + 1]) / 2);
    const soft: Edge = { present: false, rule: null, soft: true };
    const join: Edge = { present: false, rule: null, join: true };
    const v: Edge[][] = [];
    for (let r = 0; r < rows; r++) {
        const or = origRow(r);
        v.push(
            xs.map((x) => {
                const oi = grid.xs.indexOf(x);
                if (oi >= 0) return grid.v[or][oi];
                const oc = colOf(grid.xs, x);
                return refs.some((f) => f.r === or && f.c === oc && f.xs.includes(x)) ? soft : join;
            }),
        );
    }
    const h: Edge[][] = ys.map((y) => {
        const oj = grid.ys.indexOf(y);
        const or = rowOf(grid.ys, y);
        const row: Edge[] = [];
        for (let c = 0; c < cols; c++) {
            const oc = origCol(c);
            if (oj >= 0) row.push(grid.h[oj][oc]);
            else row.push(refs.some((f) => f.r === or && f.c === oc && f.ys.includes(y)) ? soft : join);
        }
        return row;
    });
    return {
        xs,
        ys,
        v,
        h,
        inherited: ys.slice(0, -1).map((_, r) => grid.inherited[origRow(r)]),
        virtualY: ys.map((y) => {
            const oj = grid.ys.indexOf(y);
            return oj >= 0 ? grid.virtualY[oj] : false;
        }),
        virtualX: xs.map((x) => {
            const oi = grid.xs.indexOf(x);
            return oi >= 0 ? grid.virtualX[oi] : false;
        }),
        freeFills: grid.freeFills,
    };
};

/**
 * Drawn cells whose text is set in columns (label / value pairs in a framed box) are split into borderless
 * sub-cells, so every label and value gets a cell of its own instead of one cell of tab-separated lines.
 */
export const refineCells = (grid: Grid, lines: TextLine[]): Grid => {
    const { xs, ys } = grid;
    const refs: Refinement[] = [];
    for (let r = 0; r + 1 < ys.length; r++) {
        if (grid.inherited[r]) continue;
        for (let c = 0; c + 1 < xs.length; c++) {
            const inCell = lines.filter((l) => {
                const [a, b] = inkSpan(l);
                const my = l.box.y + l.box.height / 2;
                return my >= ys[r] && my < ys[r + 1] && a >= xs[c] - 2 && b <= xs[c + 1] + 2;
            });
            if (inCell.length < 6) continue;
            const found = cellColumns(inCell);
            if (!found) continue;
            const nx = found.xs.filter((x) => x > xs[c] + 3 && x < xs[c + 1] - 3 && !xs.some((e) => Math.abs(e - x) < 3));
            const ny = found.ys.filter((y) => y > ys[r] + 2 && y < ys[r + 1] - 2 && !ys.some((e) => Math.abs(e - y) < 2));
            if (nx.length) refs.push({ r, c, xs: nx, ys: ny });
        }
    }
    return refs.length ? subdivide(grid, refs) : grid;
};

// ── Assignment ─────────────────────────────────────────────────────────────────────────────────────────────────────

const assign = (grid: Grid, lines: TextLine[]): Assignment => {
    const { xs, ys } = grid;
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const cells: TextLine[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => []));
    const crossV = Array.from({ length: rows }, () => new Array<boolean>(cols + 1).fill(false));
    const crossH = Array.from({ length: rows + 1 }, () => new Array<boolean>(cols).fill(false));
    const used = new Set<TextLine>();
    let intruders = 0;
    for (const line of lines) {
        if (!insideTable(grid, line)) {
            // Overlapping the table without belonging to it.
            if (line.box.x < xs[cols] && right(line.box) > xs[0] && line.box.y < ys[rows] && bottom(line.box) > ys[0]) {
                const ov =
                    (Math.min(right(line.box), xs[cols]) - Math.max(line.box.x, xs[0])) * (Math.min(bottom(line.box), ys[rows]) - Math.max(line.box.y, ys[0]));
                if (ov > 0.3 * line.box.width * line.box.height) intruders++;
            }
            continue;
        }
        const [ix0, ix1] = inkSpan(line);
        if (ix0 < xs[0] - 8 || ix1 > xs[cols] + 8) {
            intruders++;
            continue;
        }
        used.add(line);
        const r = rowOf(ys, line.box.y + line.box.height / 2);
        const queue = [line];
        while (queue.length) {
            const l = queue.shift()!;
            const [a, b] = inkSpan(l);
            let split = false;
            for (let i = 1; i < cols && !split; i++) {
                const x = xs[i];
                if (x <= a + 2 || x >= b - 2) continue;
                const e = grid.v[r][i];
                const drawn = e.present && !grid.virtualX[i];
                if (!drawn && !grid.inherited[r] && !grid.virtualX[i] && !e.soft) continue;
                const parts = splitLineAt(l, x);
                if (parts) {
                    queue.push(parts[0], parts[1]);
                    split = true;
                }
            }
            if (split) continue;
            const c = colOf(xs, (a + b) / 2);
            cells[r][c].push(l);
            for (let i = 1; i < cols; i++) if (xs[i] > a + 2 && xs[i] < b - 2) crossV[r][i] = true;
            // Lines straddling a row boundary.
            for (let j = 1; j < rows; j++) {
                const y = ys[j];
                const above = y - l.box.y;
                const below = bottom(l.box) - y;
                if (above > 0.3 * l.box.height && below > 0.3 * l.box.height)
                    for (let k = colOf(xs, a + 0.1); k <= colOf(xs, b - 0.1); k++) crossH[j][k] = true;
            }
        }
    }
    return { cells, crossV, crossH, used, intruders };
};

// ── Merging ────────────────────────────────────────────────────────────────────────────────────────────────────────

const inkOf = (lines: TextLine[]): [number, number, number, number] => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const l of lines) {
        const [a, b] = inkSpan(l);
        x0 = Math.min(x0, a);
        x1 = Math.max(x1, b);
        y0 = Math.min(y0, l.box.y);
        y1 = Math.max(y1, bottom(l.box));
    }
    return [x0, y0, x1, y1];
};

/** The fill behind a box: the topmost fill covering most of it (page-sized backgrounds excluded). */
const backgroundOf = (fills: FilledRect[], box: Rect, tableArea: number): FilledRect | undefined => {
    let found: FilledRect | undefined;
    const area = box.width * box.height;
    for (const f of fills) {
        if (f.width * f.height > 4 * tableArea) continue;
        const ov = Math.max(0, Math.min(right(f), right(box)) - Math.max(f.x, box.x)) * Math.max(0, Math.min(bottom(f), bottom(box)) - Math.max(f.y, box.y));
        // Most of the cell (bands inset by the cell padding still shade the cell).
        if (ov >= 0.55 * area) found = f;
    }
    return found;
};

/** Shading colour of a box (white paper is no shading). */
const shadingOf = (fills: FilledRect[], box: Rect, tableArea: number): string | undefined => {
    const found = backgroundOf(fills, box, tableArea);
    return found && found.color !== "FFFFFF" ? found.color : undefined;
};

class UF {
    p: number[];
    constructor(n: number) {
        this.p = Array.from({ length: n }, (_, i) => i);
    }
    find(i: number): number {
        while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
        return i;
    }
    union(a: number, b: number) {
        this.p[this.find(b)] = this.find(a);
    }
}

type Group = { r0: number; c0: number; r1: number; c1: number; lines: TextLine[] };
type RootedGroup = Group & { root: number; n: number };

const groupsOf = (uf: UF, rows: number, cols: number, cells: TextLine[][][]): { groups: RootedGroup[]; rect: boolean } => {
    const map = new Map<number, RootedGroup>();
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const k = uf.find(r * cols + c);
            const g = map.get(k);
            if (g) {
                g.r0 = Math.min(g.r0, r);
                g.c0 = Math.min(g.c0, c);
                g.r1 = Math.max(g.r1, r + 1);
                g.c1 = Math.max(g.c1, c + 1);
                g.lines.push(...cells[r][c]);
                g.n++;
            } else map.set(k, { r0: r, c0: c, r1: r + 1, c1: c + 1, lines: [...cells[r][c]], n: 1, root: k });
        }
    const groups = [...map.values()];
    return { groups, rect: groups.every((g) => g.n === (g.r1 - g.r0) * (g.c1 - g.c0)) };
};

/** Whether the text of two vertically adjacent cells reads as one block (a paragraph cut by a row line). */
const continuous = (upper: TextLine[], lower: TextLine[]) => {
    const u = [...upper].sort((a, b) => a.baseline - b.baseline);
    const l = [...lower].sort((a, b) => a.baseline - b.baseline);
    const last = u[u.length - 1];
    const first = l[0];
    const gap = first.box.y - bottom(last.box);
    const size = Math.min(last.fontSize, first.fontSize);
    // Up to a paragraph gap: a cell's heading and its text, a label over its value.
    return gap <= 1.2 * Math.max(size, 6);
};

const merge = (grid: Grid, asg: Assignment, fills: FilledRect[], tableArea: number): Group[] => {
    const { xs, ys } = grid;
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const { cells } = asg;
    const shade = (r: number, c: number) => shadingOf(fills, { x: xs[c], y: ys[r], width: xs[c + 1] - xs[c], height: ys[r + 1] - ys[r] }, tableArea) ?? "";
    type Pair = { a: number; b: number; vertical: boolean; forced: boolean };
    const forced: Pair[] = [];
    const optional: Pair[] = [];
    // Text flush against a boundary (within 8 pt) is aligned to it: its cell does not extend past that boundary.
    const flush = (lines: TextLine[], x: number) => lines.some((l) => Math.min(Math.abs(inkSpan(l)[1] - x), Math.abs(inkSpan(l)[0] - x)) <= 8);
    // Across vertical boundaries (cells side by side).
    for (let r = 0; r < rows; r++)
        for (let i = 1; i < cols; i++) {
            const e = grid.v[r][i];
            const pair = { a: r * cols + i - 1, b: r * cols + i, vertical: false };
            if (e.join) {
                forced.push({ ...pair, forced: true });
                continue;
            }
            if (e.present && !grid.virtualX[i]) continue;
            const A = cells[r][i - 1];
            const B = cells[r][i];
            if (asg.crossV[r][i]) {
                forced.push({ ...pair, forced: true });
                continue;
            }
            // In drawn rows a missing line means merged cells; in rows that only inherit the columns it means nothing.
            const soft = grid.inherited[r] || grid.virtualX[i] || e.soft;
            if (soft || (A.length && B.length) || shade(r, i - 1) !== shade(r, i)) continue;
            if ((A.length && flush(A, xs[i])) || (B.length && flush(B, xs[i]))) continue;
            optional.push({ ...pair, forced: false });
        }
    // Across horizontal boundaries (cells above one another).
    for (let j = 1; j < rows; j++)
        for (let c = 0; c < cols; c++) {
            const e = grid.h[j][c];
            const pair = { a: (j - 1) * cols + c, b: j * cols + c, vertical: true };
            if (e.join) {
                forced.push({ ...pair, forced: true });
                continue;
            }
            if (e.present && !grid.virtualY[j]) continue;
            if (asg.crossH[j][c]) {
                forced.push({ ...pair, forced: true });
                continue;
            }
            if (grid.virtualY[j] || e.soft || shade(j - 1, c) !== shade(j, c)) continue;
            optional.push({ ...pair, forced: false });
        }
    // Merges happen one by one; two groups that both hold text only join when their text reads as one block.
    const run = (pairs: Pair[]): UF => {
        const uf = new UF(rows * cols);
        const text = new Map<number, TextLine[]>();
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) text.set(r * cols + c, [...cells[r][c]]);
        for (const p of pairs) {
            const ga = uf.find(p.a);
            const gb = uf.find(p.b);
            if (ga === gb) continue;
            const ta = text.get(ga) ?? [];
            const tb = text.get(gb) ?? [];
            if (!p.forced && ta.length && tb.length && !(p.vertical && continuous(ta, tb))) continue;
            uf.union(ga, gb);
            text.set(uf.find(ga), [...ta, ...tb]);
        }
        return uf;
    };
    // Merged areas must be rectangles: drop vertical merges of irregular groups, then horizontal ones.
    let allowed = [...forced, ...optional.filter((p) => !p.vertical), ...optional.filter((p) => p.vertical)];
    for (let attempt = 0; attempt < 3; attempt++) {
        const uf = run(allowed);
        const { groups, rect } = groupsOf(uf, rows, cols, cells);
        if (rect) return groups;
        const bad = new Set<number>();
        for (const g of groups) {
            if (g.n === (g.r1 - g.r0) * (g.c1 - g.c0)) continue;
            for (let r = g.r0; r < g.r1; r++) for (let c = g.c0; c < g.c1; c++) if (uf.find(r * cols + c) === g.root) bad.add(r * cols + c);
        }
        // First keep only the side-by-side merges of the irregular groups, then give them up entirely.
        allowed = allowed.filter((p) => !(bad.has(p.a) || bad.has(p.b)) || (attempt === 0 && !p.vertical));
    }
    const uf = new UF(rows * cols);
    return groupsOf(uf, rows, cols, cells).groups;
};

// ── Table ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const majorityRule = (edges: Edge[]): RuleSegment | undefined => {
    const drawn = edges.filter((e) => e.rule);
    if (!drawn.length || drawn.length < edges.length / 2) return undefined;
    return drawn[0].rule ?? undefined;
};

/** Removes grid lines that every cell spans (all merged across them). */
const normalise = (grid: Grid, groups: Group[]): { grid: Grid; groups: Group[] } => {
    let { xs, ys } = grid;
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    const keepY = ys.map((_, j) => j === 0 || j === rows || groups.some((g) => g.r0 === j || g.r1 === j));
    const keepX = xs.map((_, i) => i === 0 || i === cols || groups.some((g) => g.c0 === i || g.c1 === i));
    if (keepY.every(Boolean) && keepX.every(Boolean)) return { grid, groups };
    const mapY = ys.map((_, j) => keepY.slice(0, j).filter(Boolean).length);
    const mapX = xs.map((_, i) => keepX.slice(0, i).filter(Boolean).length);
    const ri = ys.map((_, j) => j).filter((j) => keepY[j]);
    const ci = xs.map((_, i) => i).filter((i) => keepX[i]);
    xs = ci.map((i) => grid.xs[i]);
    ys = ri.map((j) => grid.ys[j]);
    // Edges of a merged row / column: the first original row or column they cover stands for them.
    const v = ri.slice(0, -1).map((j) => ci.map((i) => grid.v[j][i]));
    const h = ri.map((j) => ci.slice(0, -1).map((i) => grid.h[j][i]));
    const out: Grid = {
        xs,
        ys,
        v,
        h,
        inherited: ri.slice(0, -1).map((j) => grid.inherited[j]),
        virtualY: ri.map((j) => grid.virtualY[j]),
        virtualX: ci.map((i) => grid.virtualX[i]),
    };
    return { grid: out, groups: groups.map((g) => ({ ...g, r0: mapY[g.r0], r1: mapY[g.r1], c0: mapX[g.c0], c1: mapX[g.c1] })) };
};

const verticalAlign = (lines: TextLine[], box: Rect): TableCell["verticalAlign"] => {
    if (!lines.length) return undefined;
    const [, y0, , y1] = inkOf(lines);
    const top = y0 - box.y;
    const bot = bottom(box) - y1;
    if (Math.abs(top - bot) <= Math.max(2, 0.2 * (top + bot))) return "center";
    return top < bot ? "top" : "bottom";
};

const sortLines = (lines: TextLine[]) =>
    [...lines].sort((a, b) => (Math.abs(a.baseline - b.baseline) > 0.3 * Math.min(a.fontSize, b.fontSize) ? a.baseline - b.baseline : a.box.x - b.box.x));

export type TableBuild = {
    /** The Word table; cell paragraphs are built by `materialise` once the table is accepted. */
    table: Table;
    used: Set<TextLine>;
    cells: number;
    filled: number;
    intruders: number;
    cols: number;
    rows: number;
    framed: number;
    shadedRows: number;
    /** Share of grid cells (before merging) that hold text. */
    coverage: number;
    /** Filled shapes inside the grid that are not cells (see tables-lattice). */
    freeFills: number;
    /** Fills the table reproduces as cell shading (the backgrounds of its cells). */
    backgrounds: Set<FilledRect>;
    materialise: (toParagraphs: ToParagraphs) => Table;
};

/** Analyses the table of a grid (null when no text falls inside); paragraphs come later, from `materialise`. */
export const buildTable = (grid0: Grid, lines: TextLine[], content: PageContent): TableBuild | null => {
    const inside = lines.filter((l) => insideTable(grid0, l));
    if (!inside.length) return null;
    const split = refineCells(splitTallRows(grid0, inside), inside);
    const asg = assign(split, lines);
    const box0: Rect = {
        x: split.xs[0],
        y: split.ys[0],
        width: split.xs[split.xs.length - 1] - split.xs[0],
        height: split.ys[split.ys.length - 1] - split.ys[0],
    };
    const baseCells = (split.xs.length - 1) * (split.ys.length - 1);
    const withText = asg.cells.reduce((n, row) => n + row.filter((c) => c.length).length, 0);
    const merged = merge(split, asg, content.graphics.fills, box0.width * box0.height);
    const { grid, groups } = normalise(split, merged);
    const { xs, ys } = grid;
    const rowsN = ys.length - 1;
    const colsN = xs.length - 1;
    const tableArea = box0.width * box0.height;
    const rows: TableRow[] = ys.slice(0, -1).map((y, r) => ({ height: ys[r + 1] - y, cells: [] }));
    const pending: { cell: TableCell; lines: TextLine[]; inner: Rect }[] = [];
    let filled = 0;
    const shadedRowSet = new Set<number>();
    const backgrounds = new Set<FilledRect>();
    for (const g of [...groups].sort((p, q) => p.r0 - q.r0 || p.c0 - q.c0)) {
        const box: Rect = { x: xs[g.c0], y: ys[g.r0], width: xs[g.c1] - xs[g.c0], height: ys[g.r1] - ys[g.r0] };
        const cellLines = sortLines(g.lines);
        if (cellLines.length) filled++;
        const inset = Math.min(CELL_MARGIN, box.width * 0.25);
        const inner: Rect = { x: box.x + inset, y: box.y, width: Math.max(1, box.width - 2 * inset), height: box.height };
        const tops: Edge[] = [];
        const bottoms: Edge[] = [];
        for (let c = g.c0; c < g.c1; c++) {
            tops.push(grid.h[g.r0][c]);
            bottoms.push(grid.h[g.r1][c]);
        }
        const lefts: Edge[] = [];
        const rights: Edge[] = [];
        for (let r = g.r0; r < g.r1; r++) {
            lefts.push(grid.v[r][g.c0]);
            rights.push(grid.v[r][g.c1]);
        }
        const background = backgroundOf(content.graphics.fills, box, tableArea);
        if (background) backgrounds.add(background);
        const shading = background && background.color !== "FFFFFF" ? background.color : undefined;
        if (shading) for (let r = g.r0; r < g.r1; r++) shadedRowSet.add(r);
        const cell: TableCell = {
            box,
            paragraphs: [],
            rowSpan: g.r1 - g.r0,
            colSpan: g.c1 - g.c0,
            borders: { top: majorityRule(tops), right: majorityRule(rights), bottom: majorityRule(bottoms), left: majorityRule(lefts) },
            verticalAlign: verticalAlign(cellLines, box),
        };
        if (shading) cell.shading = shading;
        rows[g.r0].cells.push(cell);
        if (cellLines.length) pending.push({ cell, lines: cellLines, inner });
    }
    // Outer frame: how many sides of the table are drawn.
    const sides = [
        grid.h[0].every((e) => e.rule),
        grid.h[rowsN].every((e) => e.rule),
        grid.v.every((r) => r[0].rule),
        grid.v.every((r) => r[colsN].rule),
    ].filter(Boolean).length;
    const table: Table = { kind: "table", box: box0, columnWidths: xs.slice(1).map((x, i) => x - xs[i]), rows };
    return {
        table,
        used: asg.used,
        cells: groups.length,
        filled,
        intruders: asg.intruders,
        cols: colsN,
        rows: rowsN,
        framed: sides,
        shadedRows: shadedRowSet.size,
        coverage: baseCells ? withText / baseCells : 0,
        freeFills: grid0.freeFills ?? 0,
        backgrounds,
        materialise: (toParagraphs) => {
            for (const p of pending) p.cell.paragraphs = toParagraphs(p.lines, p.inner);
            return table;
        },
    };
};
