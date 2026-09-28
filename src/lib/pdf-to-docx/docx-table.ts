// Model tables → Word tables: fixed layout, exact column grid, row heights that put every rule where the PDF had it,
// shading, per-edge borders, merges, vertical alignment, zero cell margins with paragraphs placed by their lines.
import {
    BorderStyle,
    type Paragraph as DocxParagraph,
    Table as DocxTable,
    TableCell as DocxTableCell,
    TableRow as DocxTableRow,
    HeightRule,
    type IBorderOptions,
    type ITableFloatOptions,
    ShadingType,
    TableAnchorType,
    TableBorders,
    TableLayoutType,
    VerticalAlignTable,
    VerticalMergeType,
    WidthType,
} from "docx";
import { type Backdrop, shadingMatches } from "./docx-backdrop";
import { fitLineLengths, hasExactLengths } from "./docx-fit";
import {
    type Indents,
    type WriterContext,
    buildParagraph,
    firstBaseline,
    firstLineBox,
    firstLinePlacement,
    fitIndents,
    needsKeptRows,
    paragraphHeight,
    rowsOf,
    tabOrigin,
    tinyParagraph,
} from "./docx-paragraph";
import { eighths, hexColor, twip } from "./docx-units";
import type { Paragraph, RuleSegment, Table, TableCell } from "./types";

type Slot = { cell: TableCell; row: number; col: number; rowSpan: number; colSpan: number };

export type TableBuild = {
    table: DocxTable;
    /** Where Word's table starts and ends on the page (outer edges of the top / bottom borders). */
    top: number;
    bottom: number;
};

const NO_BORDER: IBorderOptions = { style: BorderStyle.NIL, size: 0, color: "auto" };

const border = (rule: RuleSegment | undefined): IBorderOptions => {
    const color = rule && hexColor(rule.color);
    if (!rule || !color || !(rule.width > 0)) return NO_BORDER;
    return { style: BorderStyle.SINGLE, size: eighths(rule.width), color, space: 0 };
};

/** Width Word gives a border (what it adds to row heights): eighths of a point, 1/4–12 pt. */
const borderWidth = (rule: RuleSegment | undefined) => (rule && rule.width > 0 && hexColor(rule.color) ? eighths(rule.width) / 8 : 0);

/** Places cells on the column grid (HTML-like: row by row, first free slot, spans), helped by the cells' x. */
const placeCells = (t: Table): (Slot | undefined)[][] => {
    const cols = t.columnWidths.length;
    const edges = [t.box.x];
    for (const w of t.columnWidths) edges.push(edges[edges.length - 1] + w);
    const nearest = (x: number) => edges.slice(0, cols).reduce((best, e, i) => (Math.abs(e - x) < Math.abs(edges[best] - x) ? i : best), 0);
    const grid: (Slot | undefined)[][] = t.rows.map(() => Array<Slot | undefined>(cols).fill(undefined));
    t.rows.forEach((row, r) => {
        let c = 0;
        for (const cell of row.cells) {
            while (c < cols && grid[r][c]) c++;
            const byBox = nearest(cell.box.x);
            if (byBox > c && !grid[r][byBox]) c = byBox;
            if (c >= cols) break;
            let colSpan = Math.max(1, Math.min(Math.round(cell.colSpan) || 1, cols - c));
            while (colSpan > 1 && grid[r].slice(c, c + colSpan).some(Boolean)) colSpan--;
            const rowSpan = Math.max(1, Math.min(Math.round(cell.rowSpan) || 1, t.rows.length - r));
            const slot: Slot = { cell, row: r, col: c, rowSpan, colSpan };
            for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) grid[r + dr][c + dc] ??= slot;
            c += colSpan;
        }
    });
    return grid;
};

/** How a cell's paragraphs are written (`paragraphs`: the originals, or copies with a tighter single-line spacing). */
type CellPlan = { paragraphs: Paragraph[]; befores: number[]; heights: number[]; autoLines: (number | undefined)[] };

/** Vertical placement of a cell's paragraphs from the content top: gaps from the PDF baselines (first one too if `fromTop`). */
const planCell = (paragraphs: Paragraph[], contentTop: number, fromTop: boolean): CellPlan => {
    const plan: CellPlan = { paragraphs: [], befores: [], heights: [], autoLines: [] };
    let cursor = contentTop;
    paragraphs.forEach((source, i) => {
        let p = source;
        let before = 0;
        let autoLine: number | undefined;
        if (fromTop || i > 0) {
            const first = firstLinePlacement(source, cursor);
            if (first) ({ p, before, autoLine } = first);
            else if (i > 0) before = Math.max(0, source.spaceBefore);
        }
        const height = paragraphHeight(p, { before: 0, after: 0, autoLine });
        plan.paragraphs.push(p);
        plan.befores.push(before);
        plan.heights.push(height);
        plan.autoLines.push(autoLine);
        cursor += before + height;
    });
    return plan;
};

/** Paragraphs of one cell, placed by their lines inside the cell's content box, and the vertical alignment to use. */
const cellParagraphs = (
    cell: TableCell,
    content: { x: number; y: number; width: number; height: number },
    ctx: WriterContext,
    keepLines = false,
): { children: DocxParagraph[]; verticalAlign: "top" | "center" | "bottom" } => {
    const paragraphs = cell.paragraphs.filter((p) => p.runs.some((r) => r.text.trim()) || p.lines.some((l) => l.runs.some((r) => r.text.trim())));
    if (!paragraphs.length) return { children: [tinyParagraph([], 1)], verticalAlign: cell.verticalAlign ?? "top" };
    // Centred / bottom cells keep their alignment when Word, centring the content, puts the first baseline where the
    // PDF has it; otherwise the text is placed from the top (exact position, same look).
    let verticalAlign = cell.verticalAlign ?? "top";
    let plan = planCell(paragraphs, content.y, verticalAlign === "top");
    if (verticalAlign !== "top") {
        const total = plan.befores.reduce((a, b) => a + b, 0) + plan.heights.reduce((a, b) => a + b, 0);
        const free = Math.max(0, content.height - total);
        const target = firstBaseline(paragraphs[0]);
        const predicted = content.y + (verticalAlign === "center" ? free / 2 : free) + firstLineBox(paragraphs[0]).baseline;
        if (target === undefined || Math.abs(predicted - target) > 0.75) {
            verticalAlign = "top";
            plan = planCell(paragraphs, content.y, true);
        }
    }
    const { befores, heights, autoLines } = plan;
    // Keep the content inside the row height the PDF had (Word would grow the row otherwise): trim the gaps.
    let excess = befores.reduce((a, b) => a + b, 0) + heights.reduce((a, b) => a + b, 0) - content.height;
    for (let i = 0; i < befores.length && excess > 0; i++) {
        const cut = Math.min(befores[i], excess);
        befores[i] -= cut;
        excess -= cut;
    }
    // Still taller (exact spacing a little more than the row, common in one-line rows): tighter line spacing, down to
    // what keeps capitals and accents unclipped. A row that grew would move every row below it.
    for (let i = plan.paragraphs.length - 1; i >= 0 && excess > 0.05; i--) {
        const p = plan.paragraphs[i];
        if (!(p.lineSpacing > 0) || autoLines[i]) continue;
        const lines = Math.max(1, rowsOf(p).length);
        const size = Math.max(1, ...p.runs.filter((r) => r.text.trim() && !r.style.verticalAlign).map((r) => r.style.fontSize));
        const spacing = Math.max(1.1 * size, p.lineSpacing - excess / lines);
        if (spacing >= p.lineSpacing - 0.05) continue;
        const tighter = { ...p, lineSpacing: Math.floor(spacing * 20) / 20 };
        excess -= (p.lineSpacing - tighter.lineSpacing) * lines;
        plan.paragraphs[i] = tighter;
        heights[i] = paragraphHeight(tighter, { before: 0, after: 0 });
    }
    ctx.lists.close();
    const children = plan.paragraphs.map((source, i) => {
        // A designed page's cell keeps its lines: at the PDF's length, too.
        const p = keepLines ? fitLineLengths(source, ctx) : source;
        const base: Indents = { left: Math.max(0, p.indentLeft), right: Math.max(0, p.indentRight), firstLine: p.firstLineIndent };
        const all = needsKeptRows(p) || (keepLines && rowsOf(p).length > 1);
        const breaks = all ? undefined : ctx.keepRows?.get(paragraphs[i]);
        const keepRows = all || !!breaks;
        const placement = {
            indents: fitIndents(p, content, base, false, keepRows, keepLines && hasExactLengths(p)),
            before: befores[i],
            after: 0,
            autoLine: autoLines[i],
            keepRows,
            breaks,
            tabShift: tabOrigin(p, cell.box.x) - content.x,
        };
        return buildParagraph(p, placement, ctx);
    });
    ctx.lists.close();
    return { children, verticalAlign };
};

type TableGeometry = {
    grid: (Slot | undefined)[][];
    /** Width of the horizontal border above row r (index rowCount: below the last row), as Word draws it. */
    hBorder: number[];
    leftBorder: number;
    /** Column edges and row tops in page points (PDF positions of the rules). */
    edges: number[];
    rowTops: number[];
    /** Row heights for Word (atLeast): Word stacks each row's top border above the content. */
    specs: number[];
};

const tableGeometry = (t: Table): TableGeometry => {
    const grid = placeCells(t);
    const rowCount = t.rows.length;
    const slotsStarting = (r: number) => grid[r].filter((s, c): s is Slot => !!s && s.row === r && s.col === c);
    const slotsEnding = (r: number) => grid[r].filter((s, c): s is Slot => !!s && s.row + s.rowSpan - 1 === r && s.col === c);
    const hBorder: number[] = [];
    for (let r = 0; r <= rowCount; r++) {
        const tops = r < rowCount ? slotsStarting(r).map((s) => borderWidth(s.cell.borders.top)) : [];
        const bottoms = r > 0 ? slotsEnding(r - 1).map((s) => borderWidth(s.cell.borders.bottom)) : [];
        hBorder.push(Math.max(0, ...tops, ...bottoms));
    }
    const leftBorder = Math.max(0, ...grid.map((row) => (row[0] && row[0].col === 0 ? borderWidth(row[0].cell.borders.left) : 0)));
    const edges = [t.box.x];
    for (const w of t.columnWidths) edges.push(edges[edges.length - 1] + w);
    const rowTops = [t.box.y];
    for (const row of t.rows) rowTops.push(rowTops[rowTops.length - 1] + row.height);
    // Half of the borders above and below a row are drawn inside the PDF row: the rest is content height.
    const specs = t.rows.map((row, r) => Math.max(1, row.height - (hBorder[r] + hBorder[r + 1]) / 2));
    return { grid, hBorder, leftBorder, edges, rowTops, specs };
};

/** Where Word will print the table's outer top / bottom edges (page points), without building it. */
export const tableExtent = (t: Table): { top: number; bottom: number } => {
    const g = tableGeometry(t);
    return { top: t.box.y - g.hBorder[0] / 2, bottom: g.rowTops[t.rows.length] + g.hBorder[t.rows.length] / 2 };
};

/** Whether a rule runs along the whole of a cell's edge (a rule inset from the cell's corners is only part of it). */
const coversEdge = (rule: RuleSegment, side: "top" | "right" | "bottom" | "left", box: TableCell["box"]): boolean => {
    const tolerance = 1.5;
    const horizontal = side === "top" || side === "bottom";
    const [a, b] = horizontal ? [Math.min(rule.x1, rule.x2), Math.max(rule.x1, rule.x2)] : [Math.min(rule.y1, rule.y2), Math.max(rule.y1, rule.y2)];
    const [from, to] = horizontal ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
    return a <= from + tolerance && b >= to - tolerance;
};

/**
 * The table with only the borders that run along whole cell edges. Over the page's picture, a Word border drawn along
 * a whole edge where the PDF's rule stops short (a separator inset by the padding, the edge of an inset band) would
 * stick out of it; the picture draws those rules as they are.
 */
const wholeEdgeBorders = (t: Table): Table => ({
    ...t,
    rows: t.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => {
            const borders: TableCell["borders"] = {};
            for (const side of ["top", "right", "bottom", "left"] as const) {
                const rule = cell.borders[side];
                if (rule && coversEdge(rule, side, cell.box)) borders[side] = rule;
            }
            return { ...cell, borders };
        }),
    })),
});

export type TableOptions = {
    /** Position the table on the page (tblpPr) instead of in the text column. */
    float?: { x: number; y: number };
    /** The cells keep the PDF's line breaks (a designed page: a line Word wraps differently grows the row off the picture). */
    keepLines?: boolean;
    /** The table lies over the page's picture: borders the PDF didn't draw along whole cell edges are left to it. */
    overPicture?: boolean;
    /** That picture's pixels: cell shading that wouldn't look like it is left to the picture too. */
    backdrop?: Backdrop;
};

/**
 * A Word table reproducing `t`. `originX` is the left edge of the text column the table sits in (unused when the
 * table floats).
 */
export const buildTable = (source: Table, originX: number, ctx: WriterContext, options: TableOptions = {}): TableBuild => {
    const { float, keepLines = false, backdrop, overPicture = false } = options;
    const t = overPicture ? wholeEdgeBorders(source) : source;
    const cols = t.columnWidths.length;
    const rowCount = t.rows.length;
    const { grid, hBorder, leftBorder, edges, rowTops, specs } = tableGeometry(t);

    const rows = t.rows.map((_, r) => {
        const cells: DocxTableCell[] = [];
        for (let c = 0; c < cols; c++) {
            const slot = grid[r][c];
            if (!slot) {
                cells.push(
                    new DocxTableCell({
                        children: [tinyParagraph([], 1)],
                        width: { size: twip(t.columnWidths[c]), type: WidthType.DXA },
                        borders: nilBorders(),
                    }),
                );
                continue;
            }
            if (slot.col !== c) continue;
            const { cell } = slot;
            const width = edges[slot.col + slot.colSpan] - edges[slot.col];
            const lastRow = slot.row + slot.rowSpan - 1;
            const isOrigin = slot.row === r;
            const cellBox = { x: edges[slot.col], y: rowTops[slot.row], width, height: rowTops[lastRow + 1] - rowTops[slot.row] };
            const shading = hexColor(cell.shading) && (!backdrop || shadingMatches(backdrop, cellBox, cell.shading!)) ? hexColor(cell.shading) : undefined;
            const borders = {
                top: isOrigin ? border(cell.borders.top) : NO_BORDER,
                bottom: r === lastRow ? border(cell.borders.bottom) : NO_BORDER,
                left: border(cell.borders.left),
                right: border(cell.borders.right),
            };
            let children: DocxParagraph[] = [tinyParagraph([], 1)];
            let verticalAlign: "top" | "center" | "bottom" = "top";
            if (isOrigin) {
                const bl = borderWidth(cell.borders.left);
                const br = borderWidth(cell.borders.right);
                const contentTop = rowTops[r] + hBorder[r] / 2;
                const contentHeight = specs.slice(r, lastRow + 1).reduce((a, b) => a + b, 0) + hBorder.slice(r + 1, lastRow + 1).reduce((a, b) => a + b, 0);
                ({ children, verticalAlign } = cellParagraphs(
                    cell,
                    { x: edges[slot.col] + bl / 2, y: contentTop, width: Math.max(1, width - (bl + br) / 2), height: contentHeight },
                    ctx,
                    keepLines,
                ));
            }
            cells.push(
                new DocxTableCell({
                    children,
                    width: { size: twip(width), type: WidthType.DXA },
                    ...(slot.colSpan > 1 ? { columnSpan: slot.colSpan } : {}),
                    ...(slot.rowSpan > 1 ? { verticalMerge: isOrigin ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE } : {}),
                    ...(shading ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: shading } } : {}),
                    borders,
                    ...(verticalAlign !== "top" ? { verticalAlign: verticalAlign === "center" ? VerticalAlignTable.CENTER : VerticalAlignTable.BOTTOM } : {}),
                }),
            );
        }
        return new DocxTableRow({ children: cells, height: { value: twip(specs[r]), rule: HeightRule.ATLEAST }, cantSplit: true });
    });

    const floatOptions: ITableFloatOptions | undefined = float && {
        horizontalAnchor: TableAnchorType.PAGE,
        verticalAnchor: TableAnchorType.PAGE,
        absoluteHorizontalPosition: twip(float.x - leftBorder / 2),
        absoluteVerticalPosition: twip(float.y - hBorder[0] / 2),
        leftFromText: 0,
        rightFromText: 0,
        topFromText: 0,
        bottomFromText: 0,
    };
    const table = new DocxTable({
        rows,
        columnWidths: t.columnWidths.map((w) => twip(w)),
        width: { size: twip(edges[cols] - edges[0]), type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        borders: TableBorders.NONE,
        margins: { marginUnitType: WidthType.DXA, top: 0, bottom: 0, left: 0, right: 0 },
        // Word 2013+ measures the indent to the table's outer border edge; Word 2010 layout to the text of the first
        // cell, drawing the border left of it (measured): either way the PDF's rule stays centred on the box edge.
        ...(floatOptions
            ? { float: floatOptions }
            : { indent: { size: twip(t.box.x - originX + (ctx.compat === 14 ? leftBorder / 2 : -leftBorder / 2)), type: WidthType.DXA } }),
    });
    return { table, top: t.box.y - hBorder[0] / 2, bottom: rowTops[rowCount] + hBorder[rowCount] / 2 };
};

const nilBorders = () => ({ top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER });
