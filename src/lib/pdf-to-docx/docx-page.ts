// One PDF page → Word content ending in a section break, so every PDF page is exactly one Word page.
//  - flow pages: flowing paragraphs and tables, vertical gaps derived from the PDF baselines, columns as sections;
//  - layout pages: every paragraph in its own frame at its PDF position, graphics as a background picture.
// Pictures and rotated text float, positioned on the page, anchored in a paragraph of that page.
import {
    Column,
    ColumnBreak,
    type Paragraph as DocxParagraph,
    type FileChild,
    HorizontalPositionRelativeFrom,
    type ISectionPropertiesOptions,
    PageOrientation,
    type ParagraphChild,
    SectionType,
    TextWrappingType,
    VerticalAnchor,
    VerticalPositionRelativeFrom,
    WpsShapeRun,
} from "docx";
import { type Backdrop, backdropOf } from "./docx-backdrop";
import { fitLineLengths } from "./docx-fit";
import { floatingImage, isWritableImage } from "./docx-image";
import { SCRIPT_SCALE } from "./docx-metrics";
import {
    type Indents,
    type Placement,
    type WriterContext,
    buildParagraph,
    firstBaseline,
    firstLineBox,
    firstLinePlacement,
    fitIndents,
    hasFont,
    lineStarts,
    needsKeptRows,
    paragraphHeight,
    rowsOf,
    spacerParagraph,
    stretchesLast,
    tabOrigin,
    tinyParagraph,
    wrapRange,
} from "./docx-paragraph";
import { buildTable, tableExtent } from "./docx-table";
import { clamp, drawingPixels, emu, twip } from "./docx-units";
import type { Block, PageModel, Paragraph, Table } from "./types";

export type PageContext = WriterContext & {
    /** Next drawing z-order value (later objects in front). */
    z: () => number;
};

/** Word content of one page part: blocks, the paragraph that will carry the section break, the section's settings. */
export type PageChunk = { children: FileChild[]; carrier: DocxParagraph; properties: ISectionPropertiesOptions };

type Margins = PageModel["margins"];
type Region = { x: number; width: number };

/** Word columns of a part: where each starts, its width, the space after it, and where its text starts in the PDF. */
type ColumnsLayout = { count: number; gap: number; starts: number[]; widths: number[]; spaces: number[]; textLefts: number[]; equal: boolean };

const hasText = (p: Paragraph) => p.runs.some((r) => r.text.trim()) || p.lines.some((l) => l.runs.some((r) => r.text.trim()));
const isVisibleParagraph = (p: Paragraph) => hasText(p) || !!p.shading || !!p.borderBottom;

/** Clockwise angle in (-180, 180]; 0 when the paragraph isn't rotated. */
const angleOf = (p: Paragraph) => {
    const a = ((((p.rotation ?? 0) % 360) + 540) % 360) - 180;
    return Math.abs(a) < 0.5 ? 0 : a;
};

/** The page with a usable size: Word lays out pages of at least 0.5 in (smaller ones spread text over pages). */
const usablePage = (page: PageModel): PageModel => {
    const dim = (v: number, fallback: number) => (Number.isFinite(v) && v > 0 ? Math.max(36, v) : fallback);
    const width = dim(page.width, 612);
    const height = dim(page.height, 792);
    return width === page.width && height === page.height ? page : { ...page, width, height };
};

const saneMargins = (page: PageModel): Margins => {
    const m = page.margins ?? { top: 72, right: 72, bottom: 72, left: 72 };
    const fix = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 72);
    let { top, right, bottom, left } = { top: fix(m.top), right: fix(m.right), bottom: fix(m.bottom), left: fix(m.left) };
    if (left + right > page.width - 18) left = right = Math.max(0, (page.width - 18) / 2);
    if (top + bottom > page.height - 18) top = bottom = Math.max(0, (page.height - 18) / 2);
    return { top, right, bottom, left };
};

const sectionProperties = (
    page: PageModel,
    margins: Margins,
    options: { type?: (typeof SectionType)[keyof typeof SectionType]; columns?: ColumnsLayout } = {},
): ISectionPropertiesOptions => {
    const landscape = page.width > page.height;
    const cols = options.columns;
    return {
        ...(options.type ? { type: options.type } : {}),
        page: {
            size: landscape
                ? { width: twip(page.height), height: twip(page.width), orientation: PageOrientation.LANDSCAPE }
                : { width: twip(page.width), height: twip(page.height), orientation: PageOrientation.PORTRAIT },
            margin: {
                top: twip(margins.top),
                right: twip(margins.right),
                bottom: twip(margins.bottom),
                left: twip(margins.left),
                header: twip(Math.min(36, margins.top)),
                footer: twip(Math.min(36, margins.bottom)),
                gutter: 0,
            },
        },
        ...(cols
            ? {
                  column: cols.equal
                      ? { count: cols.count, space: twip(cols.gap), equalWidth: true }
                      : {
                            count: cols.count,
                            space: twip(cols.gap),
                            equalWidth: false,
                            children: cols.widths.map((w, i) => new Column({ width: twip(w), ...(i < cols.count - 1 ? { space: twip(cols.spaces[i]) } : {}) })),
                        },
              }
            : {}),
    };
};

/** Largest (non-script) font size on the paragraph's first line. */
const mainSize = (p: Paragraph) => {
    const runs = (rowsOf(p)[0]?.runs ?? p.runs).filter((r) => r.text.trim());
    const sizes = runs.map((r) => (r.style.verticalAlign ? r.style.fontSize / SCRIPT_SCALE : r.style.fontSize));
    return sizes.length ? Math.max(...sizes) : 12;
};

/** Positioned text gets exact spacing, so its baselines land exactly (single spacing depends on font metrics). */
const withExactSpacing = (p: Paragraph): Paragraph => (p.lineSpacing > 0 ? p : { ...p, lineSpacing: Math.round(mainSize(p) * 1.2 * 20) / 20 });

/**
 * Rotated paragraph → a borderless text box of its (unrotated) frame, rotated about the text's centre. A single line
 * is centred in a box with room to spare on both sides, so Word never wraps it and its centre stays put.
 */
const rotatedTextBox = (source: Paragraph, ctx: PageContext): ParagraphChild | undefined => {
    let p = fitLineLengths(withExactSpacing(source), ctx);
    const s = lineStarts(p);
    const baseline = firstBaseline(p);
    if (!s || baseline === undefined) return undefined;
    const pad = 2;
    const textTop = baseline - firstLineBox(p).baseline;
    const textBottom = textTop + paragraphHeight(p, { before: 0, after: 0 });
    const { min } = wrapRange(p, p.alignment === "left" || p.alignment === "justify" ? s.firstLine : 0);
    const cx = p.box.x + p.box.width / 2;
    const cy = (Math.min(p.box.y, textTop) + Math.max(p.box.y + p.box.height, textBottom)) / 2;
    const single = rowsOf(p).length === 1 && !stretchesLast(p);
    if (single) p = { ...p, alignment: "center" };
    const width = single ? min + 2 * spareWidth(p, min) + 2 * pad : Math.max(p.box.width, min) * 1.03 + 2 * pad;
    const height = Math.max(p.box.y + p.box.height, textBottom) - Math.min(p.box.y, textTop) + 2 * pad;
    const x = cx - width / 2;
    const y = cy - height / 2;
    const leftmost = Math.min(s.first, s.left);
    let indents: Indents;
    if (p.alignment === "right") indents = { left: 0, right: Math.max(0, x + width - s.right), firstLine: 0 };
    else if (p.alignment === "center") {
        const offset = 2 * ((leftmost + s.right) / 2 - x) - width;
        indents = { left: Math.max(0, offset), right: Math.max(0, -offset), firstLine: 0 };
    } else indents = { left: Math.max(0, s.left - x), right: 0, firstLine: s.first - s.left };
    const paragraph = buildParagraph(
        p,
        { indents, before: Math.max(0, textTop - y), after: 0, keepRows: rowsOf(p).length > 1, tabShift: tabOrigin(p, leftmost) - x },
        ctx,
    );
    return new WpsShapeRun({
        type: "wps",
        children: [paragraph],
        transformation: { width: drawingPixels(width), height: drawingPixels(height), rotation: angleOf(source) },
        floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(x) },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(y) },
            wrap: { type: TextWrappingType.NONE },
            allowOverlap: true,
            behindDocument: false,
            lockAnchor: true,
            layoutInCell: false,
            zIndex: ctx.z(),
        },
        bodyProperties: { margins: { top: 0, bottom: 0, left: 0, right: 0 }, verticalAnchor: VerticalAnchor.TOP, noAutoFit: true },
        outline: { type: "noFill" },
        altText: { name: "Texto girado", description: "Texto girado" },
    });
};

/** Floating Word object for a non-flow block (picture, rotated text), or undefined for flow blocks. */
const floatingOf = (b: Block, ctx: PageContext): ParagraphChild | undefined => {
    if (b.kind === "image") return isWritableImage(b.image) ? floatingImage(b.image, { behind: b.behindText, z: ctx.z(), name: "Imagen" }) : undefined;
    if (b.kind === "paragraph" && angleOf(b) !== 0 && hasText(b)) return rotatedTextBox(b, ctx);
    return undefined;
};

// ---- flow pages -----------------------------------------------------------------------------------------------

type FlowBlock = Paragraph | Table;

const isFlow = (b: Block): b is FlowBlock =>
    (b.kind === "paragraph" && isVisibleParagraph(b) && angleOf(b) === 0) || (b.kind === "table" && b.rows.length > 0 && b.columnWidths.length > 0);

/** A run of consecutive page blocks written as one section: `column[i]` is the column of page.blocks[i]. */
type Part = { from: number; to: number; columns?: ColumnsLayout; column: Map<number, number> };

const leftOf = (b: FlowBlock) => {
    if (b.kind === "table") return b.box.x;
    const s = lineStarts(b);
    return s ? Math.min(s.first, s.left) : b.box.x;
};
const rightOf = (b: FlowBlock) => (b.kind === "table" ? b.box.x + b.box.width : (lineStarts(b)?.right ?? b.box.x + b.box.width));

/** Word columns reproducing the PDF's: each Word column starts where its text does (the first at the margin). */
const columnsLayout = (page: PageModel, margins: Margins, groups: FlowBlock[][], count: number, gap: number, widths?: number[]): ColumnsLayout => {
    const pageRight = page.width - margins.right;
    const equalWidth = (pageRight - margins.left - gap * (count - 1)) / count;
    const equal = (): ColumnsLayout => {
        const starts = Array.from({ length: count }, (_, i) => margins.left + i * (equalWidth + gap));
        return { count, gap, starts, widths: starts.map(() => equalWidth), spaces: starts.map(() => gap), textLefts: starts.slice(), equal: true };
    };
    if (groups.length !== count || groups.some((g) => !g.length)) return equal();
    const textLefts = groups.map((g) => Math.min(...g.map(leftOf)));
    const textWidths = groups.map((g, i) => widths?.[i] ?? Math.max(...g.map(rightOf)) - textLefts[i]);
    const starts = textLefts.map((x, i) => (i === 0 ? Math.min(margins.left, x) : x));
    const colWidths = starts.map((x, i) => (i < count - 1 ? textLefts[i] + textWidths[i] - x : pageRight - x));
    const spaces = starts.map((x, i) => (i < count - 1 ? starts[i + 1] - (x + colWidths[i]) : 0));
    const sane = colWidths.every((w) => w >= 36) && spaces.every((s) => s >= 0) && colWidths[count - 1] >= textWidths[count - 1] - 2;
    if (!sane) return equal();
    const same = colWidths.slice(0, -1).every((w) => Math.abs(w - colWidths[0]) <= 1) && Math.abs(colWidths[count - 1] - colWidths[0]) <= 1;
    const sameGap = spaces.slice(0, -1).every((s) => Math.abs(s - spaces[0]) <= 1);
    return { count, gap: spaces[0] ?? gap, starts, widths: colWidths, spaces, textLefts, equal: same && sameGap };
};

/** Splits the page into sections: text before the columns, the columns, text after (the model says where). */
const planParts = (page: PageModel, margins: Margins): Part[] => {
    const n = page.blocks.length;
    const cols = page.columns;
    const single = (from: number, to: number): Part => ({ from, to, column: new Map() });
    if (!cols || cols.count < 2 || !n) return [single(0, n - 1)];
    const flow = page.blocks.map((b, i) => (isFlow(b) ? i : -1)).filter((i) => i >= 0);
    let first = cols.first;
    let last = cols.last;
    let columnOf: (i: number) => number;
    const breaks = (cols.breaks ?? []).slice().sort((a, b) => a - b);
    if (breaks.length && first !== undefined && last !== undefined) {
        columnOf = (i) => Math.min(cols.count - 1, breaks.filter((b) => b <= i).length);
    } else {
        // No structure from the model: columns from where the blocks sit.
        const gap = Math.max(0, cols.gap);
        const width = (page.width - margins.left - margins.right - gap * (cols.count - 1)) / cols.count;
        if (width < 36) return [single(0, n - 1)];
        const lefts = Array.from({ length: cols.count }, (_, i) => margins.left + i * (width + gap));
        const tolerance = Math.max(4, gap / 2);
        const inColumn = (i: number) => {
            const b = page.blocks[i] as FlowBlock;
            return lefts.findIndex((l) => b.box.x >= l - tolerance && b.box.x + b.box.width <= l + width + tolerance);
        };
        const columned = flow.filter((i) => inColumn(i) >= 0);
        if (!columned.length) return [single(0, n - 1)];
        first = columned[0];
        last = columned[columned.length - 1];
        if (flow.some((i) => i > first! && i < last! && inColumn(i) < 0)) return [single(0, n - 1)];
        let current = 0;
        const assigned = new Map<number, number>();
        for (const i of columned) assigned.set(i, (current = Math.max(current, inColumn(i))));
        columnOf = (i) => assigned.get(i) ?? current;
    }
    first = clamp(first, 0, n - 1);
    last = clamp(last, first, n - 1);
    const parts: Part[] = [];
    if (first > 0) parts.push(single(0, first - 1));
    const column = new Map<number, number>();
    for (let i = first; i <= last; i++) column.set(i, columnOf(i));
    const groups: FlowBlock[][] = Array.from({ length: cols.count }, () => []);
    for (let i = first; i <= last; i++) if (isFlow(page.blocks[i])) groups[column.get(i)!].push(page.blocks[i] as FlowBlock);
    parts.push({ from: first, to: last, column, columns: columnsLayout(page, margins, groups, cols.count, Math.max(0, cols.gap), cols.widths) });
    if (last < n - 1) parts.push(single(last + 1, n - 1));
    return parts;
};

type Item =
    | { kind: "paragraph"; p: Paragraph; placement: Placement; anchors: ParagraphChild[] }
    | { kind: "table"; t: Table; region: Region }
    | { kind: "spacer"; height: number }
    | { kind: "columnBreak" };

/** Model indents (measured from the page margins, or from a column's edge) as indents inside `region`. */
const regionIndents = (p: Paragraph, region: Region, page: PageModel, margins: Margins): Indents => {
    let left = p.indentLeft;
    let right = p.indentRight;
    const offLeft = region.x - margins.left;
    const offRight = page.width - margins.right - (region.x + region.width);
    if (offLeft > 1 && left - offLeft >= -2) left -= offLeft;
    if (offRight > 1 && right - offRight >= -2) right -= offRight;
    return { left, right, firstLine: p.firstLineIndent };
};

/** Top of the block as Word will print it (first line box of a paragraph, top border of a table). */
const wordTop = (b: FlowBlock): number => {
    if (b.kind === "table") return tableExtent(b).top;
    const baseline = firstBaseline(b);
    return baseline === undefined ? b.box.y : baseline - firstLineBox(b).baseline;
};

export const writeFlowPage = (source: PageModel, ctx: PageContext): PageChunk[] => {
    const page = usablePage(source);
    const margins = saneMargins(page);
    const parts = planParts(page, margins);
    const firstFlow = page.blocks.find(isFlow);
    const top = clamp(Math.min(margins.top, firstFlow ? wordTop(firstFlow) : margins.top), 0, Math.max(0, page.height - 18));
    const fullRegion: Region = { x: margins.left, width: page.width - margins.left - margins.right };

    // 1. Vertical plan: where Word's cursor is after each block, gaps taken from the PDF geometry.
    let cursor = top;
    let pending: ParagraphChild[] = [];
    let lastParagraph: Extract<Item, { kind: "paragraph" }> | undefined;
    const plans: Item[][] = [];
    for (const part of parts) {
        const items: Item[] = [];
        const partTop = cursor;
        let bottom = cursor;
        let column = 0;
        let prevLineSpacing = 0;
        let lastKind: Item["kind"] | undefined;
        for (let i = part.from; i <= part.to; i++) {
            const block = page.blocks[i];
            const floating = floatingOf(block, ctx);
            if (floating) {
                pending.push(floating);
                continue;
            }
            if (!isFlow(block)) continue;
            let region = fullRegion;
            let origin = margins.left;
            if (part.columns) {
                const c = part.column.get(i) ?? column;
                if (c > column) {
                    for (; column < c; column++) items.push({ kind: "columnBreak" });
                    bottom = Math.max(bottom, cursor);
                    cursor = partTop;
                    lastKind = "columnBreak";
                    prevLineSpacing = 0;
                }
                region = { x: part.columns.starts[column], width: part.columns.widths[column] };
                origin = part.columns.textLefts[column];
            }
            if (block.kind === "paragraph") {
                // Gap from the PDF baselines; when the paragraph isn't below the flow (reading order jumps up), the
                // model's spacing, corrected for Word's exact-spacing line boxes.
                const { p, before, autoLine } = firstLinePlacement(block, cursor) ?? {
                    p: block,
                    before: Math.max(0, block.spaceBefore + (block.lineSpacing > 0 && prevLineSpacing > 0 ? 0.2 * (block.lineSpacing - prevLineSpacing) : 0)),
                };
                const breaks = ctx.keepRows?.get(block);
                const keepRows = !!breaks || needsKeptRows(p);
                const indents = fitIndents(p, region, regionIndents(p, region, page, margins), true, keepRows);
                const placement: Placement = { indents, before, autoLine, after: 0, tabShift: tabOrigin(p, origin) - region.x, keepRows, breaks };
                // The extra line of a stretched last line must not push the page's end onto a new page.
                if (stretchesLast(p, placement) && cursor + paragraphHeight(p, placement) > page.height - 1) placement.stretchLast = false;
                const item: Item = { kind: "paragraph", p, placement, anchors: pending };
                pending = [];
                items.push(item);
                lastParagraph = item;
                cursor += paragraphHeight(p, placement);
                prevLineSpacing = p.lineSpacing;
            } else {
                const measure = tableExtent(block);
                const gap = measure.top - cursor;
                const last = items[items.length - 1];
                if (lastKind === "table") {
                    items.push({ kind: "spacer", height: Math.max(0.05, gap) });
                    cursor += Math.max(0.05, gap);
                } else if (gap > 0.3) {
                    if (last?.kind === "paragraph") last.placement.after += gap;
                    else items.push({ kind: "spacer", height: gap });
                    cursor += gap;
                }
                items.push({ kind: "table", t: block, region });
                cursor += measure.bottom - measure.top;
                prevLineSpacing = 0;
            }
            lastKind = items[items.length - 1].kind;
        }
        cursor = Math.max(bottom, cursor);
        plans.push(items);
    }
    // Floating objects after the last paragraph anchor in it (or in the page's closing paragraph).
    if (pending.length && lastParagraph) {
        lastParagraph.anchors.push(...pending);
        pending = [];
    }
    const contentBottom = cursor;
    // Room below the content, so a slightly taller Word rendering doesn't spill onto an extra page.
    const slack = Math.max(18, page.height * 0.04);
    const bottomMargin = clamp(Math.min(margins.bottom, page.height - contentBottom - slack), 0, margins.bottom);

    // 2. Word objects.
    const chunks: PageChunk[] = [];
    plans.forEach((items, index) => {
        const part = parts[index];
        const children: FileChild[] = [];
        let carrier: DocxParagraph | undefined;
        for (const item of items) {
            if (item.kind === "paragraph") {
                carrier = buildParagraph(item.p, item.placement, ctx, item.anchors);
                children.push(carrier);
            } else if (item.kind === "table") {
                ctx.lists.close();
                children.push(buildTable(item.t, item.region.x, ctx).table);
                carrier = undefined;
            } else if (item.kind === "spacer") {
                carrier = spacerParagraph(item.height);
                children.push(carrier);
            } else {
                // A column break in its own hairline paragraph: at the end of a text paragraph it would carry the
                // paragraph mark into the next column as an empty line.
                carrier = tinyParagraph([new ColumnBreak()]);
                children.push(carrier);
            }
        }
        const isLast = index === plans.length - 1;
        if (!carrier || (isLast && pending.length)) {
            carrier = tinyParagraph(isLast ? pending : []);
            children.push(carrier);
        }
        const cols = part.columns;
        const properties = sectionProperties(
            page,
            {
                ...margins,
                top,
                bottom: bottomMargin,
                // Word's first column starts at the left margin and the columns fill the width between the margins.
                ...(cols ? { left: cols.starts[0], right: Math.max(0, page.width - (cols.starts[cols.count - 1] + cols.widths[cols.count - 1])) } : {}),
            },
            { type: index === 0 ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS, ...(part.columns ? { columns: part.columns } : {}) },
        );
        chunks.push({ children, carrier, properties });
    });
    // Lists stay open across the page break: a list that goes on ("4.", "5.") keeps Word's numbering.
    return chunks;
};

// ---- layout pages ---------------------------------------------------------------------------------------------

/** Whether Word has every font of the paragraph's text (Office's, or embedded): then it sets the PDF's widths. */
const knowsFonts = (p: Paragraph, ctx: Pick<WriterContext, "fonts">) =>
    rowsOf(p).every((r) => r.runs.every((run) => !run.text.trim() || hasFont(ctx, run.style.fontFamily)));

/**
 * Room a kept line gets beyond its PDF width, so Word never breaks it again: Word's line may come out wider than the
 * PDF's (a substituted font, rounded sizes, letter-spacing the PDF tightened).
 */
const spareWidth = (p: Paragraph, width: number) => Math.max(0.15 * width, 1.5 * mainSize(p)) + 2;

/**
 * Frame geometry for a paragraph at its PDF position; the paragraph gets exact spacing so baselines land exactly.
 * Text in a frame must never wrap where the PDF's doesn't (the next line would print over what follows): a single line
 * gets a frame reaching the page edge on the side its alignment grows to, several lines keep the PDF's line breaks
 * and get room to spare. Justified lines are stretched to the frame, so their frame is exactly the PDF's column: kept
 * that way only when Word has the fonts (a wider substitute would break each line in two), else set left-aligned.
 */
export const framePlacement = (
    source: Paragraph,
    page: { width: number; height: number },
    tabFallback: number,
    ctx: Pick<WriterContext, "fonts" | "advances"> = {},
): { p: Paragraph; placement: Placement } => {
    let p = fitLineLengths(withExactSpacing(source), ctx);
    const s = lineStarts(p);
    const baseline = firstBaseline(p);
    const zero: Indents = { left: 0, right: 0, firstLine: 0 };
    if (!s || baseline === undefined) {
        const width = Math.max(10, p.box.width * 1.05 + 2);
        return { p, placement: { indents: zero, before: 0, after: 0, frame: { x: p.box.x, y: p.box.y, width } } };
    }
    const rows = rowsOf(p);
    const multi = rows.length > 1;
    const y = baseline - firstLineBox(p).baseline;
    const leftmost = Math.min(s.first, s.left);
    // Shading and rules fill the frame's width: such a paragraph keeps the width of its text.
    const decorated = !!p.shading || !!p.borderBottom;
    const stretched = p.alignment === "justify" && stretchesLast(p);
    if (p.alignment === "justify" && (multi || stretched) && !knowsFonts(p, ctx)) p = { ...p, alignment: "left", justifyLastLine: false };
    const alignment = p.alignment;
    // Only left-aligned (and justified) lines start at an indent; right / centred ones start where their width puts them.
    const firstLine = alignment === "left" || alignment === "justify" ? s.first - s.left : 0;
    const { min } = wrapRange(p, firstLine);
    const justified = alignment === "justify" && (multi || stretched);
    const keepRows = multi;

    let width = justified ? min + 0.05 : decorated ? min * 1.03 + 3 : min + spareWidth(p, min);
    let indents: Indents = alignment === "left" || alignment === "justify" ? { left: s.left - leftmost, right: 0, firstLine } : zero;
    let x: number;
    if (!multi && !justified && !decorated) {
        // One line: to the page edge (both edges for centred text, as far as the nearer one allows).
        if (alignment === "right") {
            x = 0;
            width = s.right + 0.2;
        } else if (alignment === "center") {
            const center = (leftmost + s.right) / 2;
            width = Math.max(width, 2 * Math.min(center, page.width - center));
            x = center - width / 2;
        } else {
            x = leftmost;
            width = Math.max(width, page.width - leftmost - indents.left);
        }
    } else if (alignment === "right") x = s.right + 0.2 - width;
    else if (alignment === "center") x = (leftmost + s.right) / 2 - width / 2;
    else x = leftmost;
    let frameWidth = indents.left + width;
    // Keep the frame on the page: give up slack first (on both sides for centred text, so its centre stays), then
    // shift it.
    const needed = indents.left + min + 0.2;
    if (alignment === "center") {
        const center = x + frameWidth / 2;
        const room = 2 * Math.min(center, page.width - center);
        if (frameWidth > room) {
            frameWidth = Math.max(needed, room);
            x = center - frameWidth / 2;
        }
    } else if (x + frameWidth > page.width) {
        const cut = Math.min(x + frameWidth - page.width, frameWidth - needed);
        if (cut > 0) {
            frameWidth -= cut;
            if (alignment === "right") x += cut;
        }
    }
    if (x + frameWidth > page.width) x = page.width - frameWidth;
    if (x < 0) {
        // A right-aligned frame keeps its right edge.
        if (alignment === "right") frameWidth = Math.max(needed, frameWidth + x);
        x = 0;
    }
    if (indents.left > frameWidth - min) indents = { ...indents, left: Math.max(0, frameWidth - min - 0.2) };
    const placement: Placement = { indents, before: 0, after: 0, frame: { x, y, width: frameWidth }, keepRows, tabShift: tabOrigin(p, tabFallback) - x };
    if (stretchesLast(p, placement) && y + paragraphHeight(p, placement) > page.height - 1) placement.stretchLast = false;
    return { p, placement };
};

export const writeLayoutPage = (source: PageModel, ctx: PageContext): PageChunk[] => {
    const page = usablePage(source);
    const margins = saneMargins(page);
    const children: FileChild[] = [];
    const floatingTables: FileChild[] = [];
    const anchorRuns: ParagraphChild[] = [];
    if (page.background && isWritableImage(page.background))
        anchorRuns.push(floatingImage(page.background, { behind: true, z: ctx.z(), name: "Fondo de página" }));
    const seen = new Set<string>();
    // The page's picture as pixels, decoded when a table needs it.
    let backdrop: Backdrop | null | undefined;
    const frame = (source: Paragraph, tabFallback: number) => {
        if (!hasText(source) && !source.shading) return;
        const { p, placement } = framePlacement(source, page, tabFallback, ctx);
        // Word merges consecutive frames with identical settings into one: keep every frame distinct.
        const f = placement.frame!;
        let key = `${twip(f.x)}:${twip(f.y)}:${twip(f.width)}`;
        while (seen.has(key)) {
            f.y += 0.05;
            key = `${twip(f.x)}:${twip(f.y)}:${twip(f.width)}`;
        }
        seen.add(key);
        children.push(buildParagraph(p, placement, ctx));
    };
    for (const block of page.blocks) {
        const floating = floatingOf(block, ctx);
        if (floating) anchorRuns.push(floating);
        else if (block.kind === "paragraph") frame(block, margins.left);
        else if (block.kind === "table" && block.rows.length && block.columnWidths.length) {
            ctx.lists.close();
            // A real, editable Word table positioned on the page, its text kept on the PDF's lines. It draws the rules
            // and fills that coincide with the picture's (same place, same colours: the table still looks right once
            // edited); rules inset from a cell's corners and fills that don't cover their cell are left to the picture.
            if (block.rows.some((row) => row.cells.some((cell) => cell.shading))) backdrop ??= backdropOf(page.background) ?? null;
            const options = { float: { x: block.box.x, y: block.box.y }, keepLines: true, overPicture: !!page.background, backdrop: backdrop ?? undefined };
            floatingTables.push(buildTable(block, 0, ctx, options).table, tinyParagraph());
        }
    }
    ctx.lists.close();
    const anchor = tinyParagraph(anchorRuns);
    children.push(anchor, ...floatingTables);
    const carrier = floatingTables.length ? (floatingTables[floatingTables.length - 1] as DocxParagraph) : anchor;
    return [{ children, carrier, properties: sectionProperties(page, margins, { type: SectionType.NEXT_PAGE }) }];
};
