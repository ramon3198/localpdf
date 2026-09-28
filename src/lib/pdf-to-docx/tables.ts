// Tables of a page. Ruled tables come from the drawing (rules and filled cells, see tables-lattice); borderless
// tables from text that is clearly set in columns (tables-stream). Each becomes a Word table with real rows, cells,
// merged cells, borders and shading, and the text inside is handed to the paragraph builder cell by cell.
import { decorationGraphics } from "./layout-decorations";
import { solidImage } from "./layout-png";
import { type TableBuild, buildTable, tableLines } from "./tables-cells";
import { latticeGrids } from "./tables-lattice";
import { extendDown, streamGrids } from "./tables-stream";
import type {
    Block,
    FilledRect,
    FloatingImage,
    Hex,
    PageContent,
    PageModel,
    Paragraph,
    PlacedImage,
    Rect,
    RuleSegment,
    Table,
    TableCell,
    TextLine,
} from "./types";

/** Turns the text lines inside one table cell into paragraphs (layout.ts provides it). */
export type ToParagraphs = (lines: TextLine[], cell: Rect) => Paragraph[];

const area = (r: Rect) => r.width * r.height;
const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const contains = (outer: Rect, inner: Rect, tol: number) =>
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.height <= outer.y + outer.height + tol;

/** The fills each detected table reproduces as the shading of its cells. */
const tableBackgrounds = new WeakMap<Table, Set<FilledRect>>();

/** Whether a ruled grid really is a table (and not a frame around the page, a chart, a figure or a text box). */
const acceptRuled = (b: TableBuild, content: PageContent): boolean => {
    const box = b.table.box;
    if (!b.filled) return false;
    if (b.intruders > Math.max(2, 0.3 * b.used.size)) return false;
    if (area(box) > 0.85 * content.width * content.height && b.cells <= 2) return false;
    // Bars and marks that are not cells, with little text among them: a chart.
    if (b.freeFills >= 3 && b.coverage < 0.4) return false;
    // Columns too narrow to hold text (stripes of a painted gradient, hatching).
    const widths = [...b.table.columnWidths].sort((p, q) => p - q);
    if (widths.length > 2 && widths[Math.floor(widths.length / 2)] < 10) return false;
    if (b.cols >= 2 && b.rows >= 2) return b.filled >= 2;
    if (b.cols >= 2) return b.filled >= 2 && (b.framed >= 3 || b.shadedRows > 0);
    // One column: a framed box, or a box with a shaded header band — not a framed figure.
    if (box.height > 0.6 * content.height || box.width < 40 || b.freeFills > 0) return false;
    if (b.rows >= 2) return b.framed >= 3 || (b.shadedRows > 0 && b.shadedRows < b.rows);
    return b.framed === 4;
};

/** Tables found on the page; `rest` are the text lines that are not inside any table. */
export const detectTables = (content: PageContent, toParagraphs: ToParagraphs): { tables: Table[]; rest: TextLine[] } => {
    const lines = tableLines(content.lines);
    const tables: Table[] = [];
    const used = new Set<TextLine>();
    const taken: Rect[] = [];
    const take = (built: TableBuild) => {
        const table = built.materialise(toParagraphs);
        tables.push(table);
        tableBackgrounds.set(table, built.backgrounds);
        built.used.forEach((l) => used.add(l));
        taken.push(built.table.box);
    };
    try {
        const ruled = latticeGrids(content, lines).sort((a, b) => area(b.box) - area(a.box));
        for (const { grid, box } of ruled) {
            if (taken.some((t) => overlap(t, box) > 0.2 * Math.min(area(t), area(box)))) continue;
            const free = lines.filter((l) => !used.has(l));
            const built = buildTable(extendDown(grid, free), free, content);
            if (built && acceptRuled(built, content)) take(built);
        }
        for (const { grid } of streamGrids(
            content,
            lines.filter((l) => !used.has(l)),
            taken,
        )) {
            const built = buildTable(
                grid,
                lines.filter((l) => !used.has(l)),
                content,
            );
            if (built && built.filled >= 4) take(built);
        }
    } catch {
        // A table that cannot be analysed stays as text.
    }
    tables.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    return { tables, rest: content.lines.filter((l) => !used.has(l)) };
};

/** Something drawn inside a table that the table itself does not reproduce, as the picture that shows it. */
export type TableMark = { image: PlacedImage; table: Table; cell?: TableCell; underText: boolean };

/** Pictures of vector art inside table cells (graphics-crops), to place with the table's other marks. */
export type CellArt = { image: PlacedImage; table: Table; cell: TableCell };

const MAX_MARKS = 300;

const cellOf = (t: Table, b: Rect): TableCell | undefined => {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    for (const row of t.rows)
        for (const c of row.cells) if (cx >= c.box.x && cx <= c.box.x + c.box.width && cy >= c.box.y && cy <= c.box.y + c.box.height) return c;
    return undefined;
};

/** Text of the table lies on the box (a word on a badge, not a value beside a bar). */
const textOn = (t: Table, b: Rect) =>
    t.rows.some((row) => row.cells.some((c) => c.paragraphs.some((p) => p.lines.some((l) => overlap(l.box, b) > 0.2 * area(l.box)))));

const luminance = (hex: string) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

/**
 * Graphics inside a table that are not the table's own (cell backgrounds, borders on its grid lines): progress bars,
 * status badges, colour swatches, marks and separators inside cells. The table can't hold them and the flow layout
 * drops whatever lies inside a table, so they are placed as shapes. `underText`: text of the table sits on it.
 */
export const looseTableGraphics = (content: PageContent, tables: Table[]): TableMark[] => {
    const out: TableMark[] = [];
    if (!tables.length) return out;
    const grid = new Map<Table, { xs: number[]; ys: number[] }>();
    for (const t of tables) {
        const xs = [t.box.x];
        for (const w of t.columnWidths) xs.push(xs[xs.length - 1] + w);
        const ys = [t.box.y];
        for (const r of t.rows) ys.push(ys[ys.length - 1] + r.height);
        grid.set(t, { xs, ys });
    }
    const onGrid = (t: Table, horizontal: boolean, pos: number) => (horizontal ? grid.get(t)!.ys : grid.get(t)!.xs).some((v) => Math.abs(v - pos) <= 2.5);
    const add = (t: Table, box: Rect, color: Hex, opacity: number) => {
        const mark: TableMark = { image: solidImage(color, opacity, box), table: t, underText: textOn(t, box) };
        const cell = cellOf(t, box);
        if (cell) mark.cell = cell;
        out.push(mark);
    };
    for (const f of content.graphics.fills) {
        const t = tables.find((tb) => contains(tb.box, f, 1.5));
        if (!t || tableBackgrounds.get(t)?.has(f) || decorationGraphics.has(f)) continue;
        if (f.opacity < 0.03 || area(f) < 2 || (luminance(f.color) > 0.985 && f.opacity > 0.9)) continue;
        // A box on the grid lines on all four sides is a cell's background (or hidden under one).
        if (onGrid(t, false, f.x) && onGrid(t, false, f.x + f.width) && onGrid(t, true, f.y) && onGrid(t, true, f.y + f.height)) continue;
        add(t, { x: f.x, y: f.y, width: f.width, height: f.height }, f.color, f.opacity);
    }
    for (const r of content.graphics.rules as (RuleSegment & { style?: string })[]) {
        // Broken lines (leaders, dashed separators) would come out solid.
        if (r.style || decorationGraphics.has(r)) continue;
        const horizontal = Math.abs(r.y1 - r.y2) < 0.5;
        const vertical = Math.abs(r.x1 - r.x2) < 0.5;
        if (!horizontal && !vertical) continue;
        const box: Rect = horizontal
            ? { x: Math.min(r.x1, r.x2), y: r.y1 - r.width / 2, width: Math.abs(r.x2 - r.x1), height: Math.max(0.25, r.width) }
            : { x: r.x1 - r.width / 2, y: Math.min(r.y1, r.y2), width: Math.max(0.25, r.width), height: Math.abs(r.y2 - r.y1) };
        const t = tables.find((tb) => contains(tb.box, box, 1.5));
        // Lines on the table's grid are its borders.
        if (!t || onGrid(t, horizontal, horizontal ? r.y1 : r.x1)) continue;
        add(t, box, r.color, 1);
    }
    return out;
};

/**
 * Flow pages: the loose graphics of the tables (see looseTableGraphics) and the pictures of the art inside their cells
 * as shapes on the page — behind the text when text sits on them (a badge), in front of it otherwise (a bar beside
 * its value) — each placed before the first block below its top edge, where the writer anchors it. Word paints cell
 * shading with the text, over anything behind the text: a shaded cell with a badge gets its shading as a shape too,
 * under the badge.
 */
export const placeTableMarks = (model: PageModel, content: PageContent, tables: Table[], art: CellArt[] = []): void => {
    let marks: TableMark[] = [];
    try {
        const pictures = art.map((a): TableMark => ({ image: a.image, table: a.table, cell: a.cell, underText: textOn(a.table, a.image.box) }));
        // A shape the picture of the art already shows is not drawn again.
        const shown = (b: Rect) => pictures.some((p) => contains(p.image.box, b, 0.5));
        marks = [...looseTableGraphics(content, tables).filter((m) => !shown(m.image.box)), ...pictures];
        // Hatching and the like: past a few hundred shapes the biggest ones are enough.
        if (marks.length > MAX_MARKS) marks = marks.sort((p, q) => area(q.image.box) - area(p.image.box)).slice(0, MAX_MARKS);
    } catch {
        return;
    }
    if (!marks.length) return;
    const topOf = (b: Block) => (b.kind === "image" ? b.image.box.y : b.box.y);
    type Shape = { float: FloatingImage; y: number; rank: number };
    const shapes: Shape[] = [];
    const moved = new Set<TableCell>();
    for (const m of marks) {
        const cell = m.cell;
        if (!m.underText || !cell?.shading || moved.has(cell)) continue;
        moved.add(cell);
        shapes.push({ float: { kind: "image", image: solidImage(cell.shading, 1, cell.box), behindText: true }, y: cell.box.y, rank: 0 });
        delete cell.shading;
    }
    for (const m of marks) shapes.push({ float: { kind: "image", image: m.image, behindText: m.underText }, y: m.image.box.y, rank: 1 });
    // Top to bottom; a moved cell background before the marks on it (it goes under them).
    const floats = shapes.sort((p, q) => p.y - q.y || p.rank - q.rank).map((s) => s.float);
    for (const f of floats) {
        const at = model.blocks.findIndex((b) => b.kind !== "image" && topOf(b) >= f.image.box.y - 1);
        if (at < 0) {
            model.blocks.push(f);
            continue;
        }
        model.blocks.splice(at, 0, f);
        const cols = model.columns;
        if (!cols) continue;
        if (cols.breaks) cols.breaks = cols.breaks.map((k) => (k >= at ? k + 1 : k));
        if (cols.first !== undefined && cols.first >= at) cols.first++;
        if (cols.last !== undefined && cols.last >= at) cols.last++;
    }
};
