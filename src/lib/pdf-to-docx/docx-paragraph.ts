// One model paragraph → one Word paragraph: alignment, indents, exact spacing, lists, headings, shading, frames.
// Also the geometry the page writers need: Word's line boxes and the width range that keeps the PDF's line breaks.
import {
    AlignmentType,
    BorderStyle,
    Paragraph as DocxParagraph,
    FrameAnchorType,
    FrameWrap,
    HeadingLevel,
    type IParagraphOptions,
    LeaderType,
    LineRuleType,
    type ParagraphChild,
    ShadingType,
    type TabStopDefinition,
    TabStopType,
} from "docx";
import type { Advances } from "./docx-fonts";
import type { ListPlanner } from "./docx-lists";
import { EXACT_BASELINE, type LineBox, hasSingleMetrics, isCommonFont, lineBox } from "./docx-metrics";
import { type RunDefaults, type RunPiece, buildRunChildren, piecesFromRows, piecesFromRuns, runStyleOptions } from "./docx-text";
import { eighths, hexColor, twip } from "./docx-units";
import { runCharX } from "./text-lines";
import type { Paragraph, TextLine, TextStyle } from "./types";

export type WriterContext = {
    defaults: RunDefaults;
    lists: ListPlanner;
    /** Paragraphs to write with their PDF lines kept, and the lines that end in a break (see docx-justify.ts). */
    keepRows?: WeakMap<Paragraph, ReadonlySet<number>>;
    /** Word compatibility mode of the document (tables are placed differently in 14 and 15). */
    compat?: 14 | 15;
    /** Non-Office families embedded in the document: Word has them wherever it is opened, like its own fonts. */
    fonts?: ReadonlySet<string>;
    /** Advance widths of the embedded face Word will use for a family and style (see docx-fit.ts). */
    advances?: (family: string, bold: boolean, italic: boolean) => Advances | undefined;
};

/** Whether Word will set text in this family with the PDF's glyph widths: an Office font, or one embedded. */
export const hasFont = (ctx: Pick<WriterContext, "fonts">, family: string): boolean => isCommonFont(family) || !!ctx.fonts?.has(family);

/** Indents in points, relative to the paragraph's container (column, cell or frame). */
export type Indents = { left: number; right: number; firstLine: number };

export type Placement = {
    indents: Indents;
    /** Points above / below the paragraph. */
    before: number;
    after: number;
    /** Absolute position on the page (layout mode). */
    frame?: { x: number; y: number; width: number };
    /** Write the PDF's visual lines with explicit breaks instead of letting Word wrap the runs. */
    keepRows?: boolean;
    /** With keepRows: only the lines (indices) after which a break goes; the others are joined by a space. */
    breaks?: ReadonlySet<number>;
    /** Added to the model's tab stop positions (model origin → this paragraph's container edge). */
    tabShift?: number;
    /** "Multiple" line spacing (w:line in 240ths) instead of exact: the first baseline sits at the font's ascent. */
    autoLine?: number;
    /** Stretch the last line too (justifyLastLine): a final line break, which adds an empty line. Default: the model's. */
    stretchLast?: boolean;
};

/**
 * Whether the paragraph ends with a line break so Word justifies its last line too: the model says the paragraph
 * goes on in the next column or page, and its last line does reach the right edge like the others.
 */
export const stretchesLast = (p: Paragraph, placement?: { stretchLast?: boolean }): boolean => {
    if (placement?.stretchLast !== undefined) return placement.stretchLast;
    if (p.justifyLastLine !== true || p.alignment !== "justify") return false;
    const rows = rowsOf(p);
    if (rows.length < 2) return true;
    const edge = Math.max(...rows.slice(0, -1).map((r) => r.x1));
    return rows[rows.length - 1].x1 >= edge - 2;
};

const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED } as const;
const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;

type ModelRun = TextLine["runs"][number];

/** A visual line of the paragraph: the source lines (pieces) on one baseline, left to right. */
export type Row = { pieces: TextLine[]; baseline: number; x0: number; x1: number; firstWord: number; space: number; runs: ModelRun[] };

const perChar = (r: ModelRun) => r.box.width / Math.max(1, r.text.length);

const rowOf = (pieces: TextLine[]): Row => {
    const sorted = pieces.slice().sort((a, b) => a.box.x - b.box.x);
    const runs = sorted.flatMap((l) => l.runs);
    const ink = runs.filter((r) => r.text.trim());
    const size = Math.max(...pieces.map((l) => l.fontSize || 0), 1);
    if (!ink.length) {
        const x0 = Math.min(...sorted.map((l) => l.box.x));
        return {
            pieces: sorted,
            baseline: sorted[0].baseline,
            x0,
            x1: Math.max(...sorted.map((l) => l.box.x + l.box.width)),
            firstWord: 0,
            space: size * 0.25,
            runs,
        };
    }
    // Ink extent: the advance of leading / trailing spaces doesn't count.
    const x0 = Math.min(...ink.map((r) => r.box.x + (r.text.length - r.text.trimStart().length) * perChar(r)));
    const x1 = Math.max(...ink.map((r) => r.box.x + r.box.width - (r.text.length - r.text.trimEnd().length) * perChar(r)));
    const first = ink.reduce((a, b) => (b.box.x < a.box.x ? b : a));
    const baseline = sorted.map((l) => l.baseline).sort((a, b) => a - b)[Math.floor(sorted.length / 2)];
    return { pieces: sorted, baseline, x0, x1: Math.max(x0, x1), firstWord: firstWordWidth(first), space: first.style.fontSize * 0.25, runs };
};

/**
 * Width of a run's first word: exact from the extraction's character positions when it has them (runs of a
 * justified line spread their spaces, so the run's average character width would be too wide or too narrow).
 */
const firstWordWidth = (run: ModelRun): number => {
    const lead = run.text.length - run.text.trimStart().length;
    const word = run.text.trimStart().split(/\s/)[0] ?? "";
    const xs = runCharX.get(run);
    if (xs && xs.length === run.text.length + 1) {
        const width = xs[lead + word.length] - xs[lead];
        if (Number.isFinite(width) && width > 0) return width;
    }
    return perChar(run) * word.length;
};

const rowCache = new WeakMap<Paragraph, Row[]>();

/** The paragraph's visual lines: consecutive source lines on the same baseline form one row. */
export const rowsOf = (p: Paragraph): Row[] => {
    const cached = rowCache.get(p);
    if (cached) return cached;
    const groups: TextLine[][] = [];
    for (const line of p.lines) {
        if (!Number.isFinite(line.baseline) || !line.runs.length) continue;
        const group = groups[groups.length - 1];
        const ref = group?.[0];
        const tol = ref ? 0.3 * Math.max(1, Math.min(ref.fontSize || 1, line.fontSize || 1)) : 0;
        const overlaps = group?.some((o) => Math.min(o.box.x + o.box.width, line.box.x + line.box.width) - Math.max(o.box.x, line.box.x) > 1);
        if (group && Math.abs(line.baseline - ref.baseline) <= tol && !overlaps) group.push(line);
        else groups.push([line]);
    }
    const rows = groups.map(rowOf);
    rowCache.set(p, rows);
    return rows;
};

const inkStyles = (runs: ModelRun[]) => runs.filter((r) => r.text.trim()).map((r) => r.style);

const firstStyles = (p: Paragraph) => {
    const row = rowsOf(p)[0];
    const styles = row ? inkStyles(row.runs) : inkStyles(p.runs);
    return styles.length ? styles : p.runs.map((r) => r.style);
};

/** Word's box for the paragraph's first line (exact spacing, or single spacing of its runs). */
export const firstLineBox = (p: Paragraph): LineBox => lineBox(p.lineSpacing, firstStyles(p));

/** Lines Word will print (the PDF's, assuming the same line breaks). */
export const lineCount = (p: Paragraph, placement?: { stretchLast?: boolean }): number => Math.max(1, rowsOf(p).length) + (stretchesLast(p, placement) ? 1 : 0);

const BORDER_SPACE = 1;

/** Height Word gives the paragraph, spacing included. */
export const paragraphHeight = (p: Paragraph, placement: { before: number; after: number; autoLine?: number; stretchLast?: boolean }): number => {
    const rows = rowsOf(p);
    const lines = lineCount(p, placement);
    let height = 0;
    if (placement.autoLine) height = lines * (placement.autoLine / 240) * lineBox(0, firstStyles(p)).height;
    else {
        const box = firstLineBox(p);
        height = box.height;
        for (let i = 1; i < lines; i++) {
            const row = rows[i];
            height += p.lineSpacing > 0 || !row ? box.height : lineBox(0, inkStyles(row.runs)).height;
        }
    }
    if (p.borderBottom) height += p.borderBottom.width + BORDER_SPACE;
    return placement.before + height + placement.after;
};

/** Target baseline of the first line in the PDF, if the paragraph has source lines. */
export const firstBaseline = (p: Paragraph): number | undefined => rowsOf(p)[0]?.baseline;

/**
 * Space before the paragraph so its first baseline lands where the PDF has it, Word's cursor being at `cursor`.
 * Exact spacing puts the baseline 0.8·L below the line top: when the gap above is tighter than that, a single line
 * takes a tighter exact spacing (returned as a copy of the paragraph), and several lines (1.5 or double spacing
 * under a heading) "multiple" spacing, which keeps the baseline at the font's ascent.
 * Undefined when the paragraph starts above the cursor (it isn't below the previous block).
 */
export const firstLinePlacement = (p: Paragraph, cursor: number): { p: Paragraph; before: number; autoLine?: number } | undefined => {
    const baseline = firstBaseline(p);
    if (baseline === undefined || baseline < cursor) return undefined;
    const gap = baseline - firstLineBox(p).baseline - cursor;
    if (gap >= -1) return { p, before: Math.max(0, gap) };
    const styles = firstStyles(p);
    const size = Math.max(1, ...styles.filter((s) => !s.verticalAlign).map((s) => s.fontSize));
    const tight = Math.floor(((baseline - cursor) / EXACT_BASELINE) * 20) / 20;
    // 0.88 of the size above the baseline keeps capitals and most accents unclipped.
    if (rowsOf(p).length === 1 && tight >= 1.1 * size) return { p: { ...p, lineSpacing: tight }, before: 0 };
    const single = lineBox(0, styles);
    if (p.lineSpacing <= 0 || !styles.every((s) => hasSingleMetrics(s.fontFamily)) || p.lineSpacing <= single.height * 1.05) return { p, before: 0 };
    return { p, before: Math.max(0, baseline - single.baseline - cursor), autoLine: Math.round((240 * p.lineSpacing) / single.height) };
};

/** Paragraphs with tabs are laid out by their tab stops, not by wrapping. */
const hasTabs = (p: Paragraph) => p.runs.some((r) => r.text.includes("\t"));

// ---- horizontal geometry --------------------------------------------------------------------------------------

/**
 * The container width range [min, max] for which Word breaks the paragraph's lines where the PDF did: every line
 * fits (min) and no line can take the next line's first word (max). `firstLine` is the first line's extra indent.
 */
export const wrapRange = (p: Paragraph, firstLine: number): { min: number; max: number } => {
    const rows = rowsOf(p);
    if (!rows.length) return { min: 0, max: Infinity };
    let min = 0;
    let max = Infinity;
    rows.forEach((s, i) => {
        const width = s.x1 - s.x0 + (i === 0 ? firstLine : 0);
        min = Math.max(min, width);
        const next = rows[i + 1];
        if (next && !p.keepLineBreaks && next.firstWord > 0) max = Math.min(max, width + s.space + next.firstWord);
    });
    return { min, max };
};

/**
 * A ragged paragraph whose lines can't all come from wrapping at one width: some line broke although the next
 * word would have fitted in the widest line (an address "CIF…" / "Calle…" joined into one paragraph). Word keeps
 * such lines only with explicit breaks. (Justified text is judged with its natural widths, in docx-justify.ts.)
 */
export const needsKeptRows = (p: Paragraph): boolean => {
    if (p.keepLineBreaks || p.alignment === "justify" || rowsOf(p).length < 2 || hasTabs(p)) return false;
    // Only left-aligned lines start at an indent; right / centred ones start where their width puts them.
    const s = lineStarts(p);
    const { min, max } = wrapRange(p, p.alignment === "left" && s ? s.firstLine : 0);
    return max < min + 0.5;
};

/** Where the PDF lines start and end: first line start, body lines start (if several lines), rightmost ink. */
export const lineStarts = (p: Paragraph): { first: number; body?: number; left: number; firstLine: number; right: number } | undefined => {
    const rows = rowsOf(p);
    if (!rows.length) return undefined;
    const body = rows.length > 1 ? Math.min(...rows.slice(1).map((s) => s.x0)) : undefined;
    const left = body ?? rows[0].x0;
    return { first: rows[0].x0, body, left, firstLine: rows[0].x0 - left, right: Math.max(...rows.map((s) => s.x1)) };
};

const TOLERANCE = 2;

/**
 * Indents for the paragraph inside `region` (a text column, a cell): the model's indents, corrected where they
 * disagree with where the PDF lines really are (the model may measure from another origin), then widened / narrowed
 * so Word breaks the lines where the PDF did.
 */
export const fitIndents = (p: Paragraph, region: { x: number; width: number }, base: Indents, allowNegative: boolean, kept = false, exact = false): Indents => {
    const s = lineStarts(p);
    const ind = { ...base };
    const right = region.x + region.width;
    if (s) {
        if (p.alignment === "right") {
            if (Math.abs(right - ind.right - s.right) > TOLERANCE) ind.right = right - s.right;
        } else if (p.alignment === "center") {
            const center = (Math.min(s.first, s.left) + s.right) / 2;
            const modelCenter = region.x + ind.left + (region.width - ind.left - ind.right) / 2;
            if (Math.abs(modelCenter - center) > TOLERANCE) {
                const offset = 2 * (center - region.x) - region.width;
                ind.left = Math.max(0, offset);
                ind.right = Math.max(0, -offset);
                ind.firstLine = 0;
            }
        } else {
            if (s.body !== undefined && Math.abs(region.x + ind.left - s.body) > TOLERANCE) ind.left = s.body - region.x;
            const keepHanging = !!p.list && base.firstLine < 0;
            if (!keepHanging && Math.abs(region.x + ind.left + ind.firstLine - s.first) > TOLERANCE) {
                if (s.body === undefined && ind.firstLine === 0) ind.left = s.first - region.x;
                else ind.firstLine = s.first - region.x - ind.left;
            }
        }
    }
    return guardWrap(p, region.width, ind, allowNegative, kept, exact);
};

/**
 * Adjusts indents inside a container of `width` so Word keeps the PDF's line breaks: widens the text column when a
 * line wouldn't fit, narrows it when a line could pull up the next line's first word (not when the lines are `kept`
 * with explicit breaks). `exact`: Word's lines are as long as the PDF's (see docx-fit.ts), a trace of room is enough.
 * Returns new indents.
 */
export const guardWrap = (p: Paragraph, width: number, indents: Indents, allowNegative: boolean, kept = false, exact = false): Indents => {
    if (!p.lines.length || hasTabs(p)) return indents;
    const range = wrapRange(p, indents.firstLine);
    const min = range.min;
    const max = kept ? Infinity : range.max;
    let target = width - indents.left - indents.right;
    if (p.alignment === "justify") {
        // Justified lines are stretched to the column: the column is the width the lines fill in the PDF (wider, Word
        // would stretch them further and could pull the next word up; narrower, they would not fit). Indents within a
        // point of it are kept as they are.
        if (rowsOf(p).length > 1 ? Math.abs(target - min) > 1 : target < min + 0.05) target = min + 0.05;
    } else {
        // Room for Word setting the text a little wider than the PDF (no kerning, a substituted font); a line with no
        // next word to pull up gets more.
        const wanted = exact ? min + 0.5 : rowsOf(p).length > 1 && !kept ? min * 1.012 + 0.5 : min * 1.03 + 2;
        if (target < wanted) target = wanted;
        // Narrow the column only if some width keeps every line (otherwise the lines are kept explicitly), staying
        // clear of the width that would pull the next word up: Word's words are rarely exactly as wide as the PDF's.
        if (max > min + 0.5) {
            const margin = Math.max(0.3, Math.min(0.35 * (max - min), 0.02 * max + 1));
            if (target > max - margin) target = max - margin;
            if (target < min + 0.1) target = Math.min(wanted, (min + max) / 2);
        }
    }
    const delta = width - indents.left - indents.right - target;
    if (Math.abs(delta) < 0.05) return indents;
    const out = { ...indents };
    if (p.alignment === "right") out.left += delta;
    else if (p.alignment === "center") {
        out.left += delta / 2;
        out.right += delta / 2;
    } else out.right += delta;
    if (!allowNegative) {
        if (out.left < 0) {
            out.right += out.left;
            out.left = 0;
        }
        // No room on the right: the text starts a little further left rather than wrapping.
        if (out.right < 0) {
            out.left = Math.max(0, out.left + out.right);
            out.right = 0;
        }
    }
    return out;
};

/** The model's tab stops are measured from its region's edge: find that edge from where tabbed pieces start. */
export const tabOrigin = (p: Paragraph, fallback: number): number => {
    if (!p.tabStops?.length) return fallback;
    const candidates: number[] = [];
    for (const row of rowsOf(p))
        for (const piece of row.pieces.slice(1))
            for (const t of p.tabStops) {
                const edge =
                    t.alignment === "right" ? piece.box.x + piece.box.width : t.alignment === "center" ? piece.box.x + piece.box.width / 2 : piece.box.x;
                candidates.push(edge - t.position);
            }
    let best = fallback;
    let votes = 0;
    for (const c of candidates) {
        const n = candidates.filter((o) => Math.abs(o - c) <= 1.5).length + (Math.abs(c - fallback) <= 1.5 ? 0.5 : 0);
        if (n > votes) [best, votes] = [c, n];
    }
    return best;
};

// ---- paragraph construction -----------------------------------------------------------------------------------

/**
 * Text pieces of the paragraph: its runs (lines kept with "\n" when keepLineBreaks), or — with `keepRows`, or when
 * there are no runs — its visual lines with breaks. A justified paragraph cut by the page end gets a final break so
 * Word stretches its last line too.
 */
export const paragraphPieces = (p: Paragraph, keepRows = false, stretchLast = stretchesLast(p), breaks?: ReadonlySet<number>): RunPiece[] => {
    const rows = rowsOf(p);
    const pieces =
        keepRows || !p.runs.length
            ? piecesFromRows(rows, keepRows ? breaks : undefined)
            : piecesFromRuns(
                  p.runs,
                  rows.map((r) => r.baseline),
              );
    if (stretchLast) {
        const style = [...pieces].reverse().find((x) => "text" in x)?.style;
        if (style) pieces.push({ lineBreak: true, style });
    }
    return pieces;
};

const TAB_TYPE = { left: TabStopType.LEFT, right: TabStopType.RIGHT, center: TabStopType.CENTER } as const;
const LEADER = { dot: LeaderType.DOT, hyphen: LeaderType.HYPHEN, underscore: LeaderType.UNDERSCORE } as const;

/** Word tab stops from the model's (positions measured from the model's origin; `shift` moves them to the container). */
const tabStopsOf = (p: Paragraph, shift: number): TabStopDefinition[] =>
    (p.tabStops ?? [])
        .filter((t) => Number.isFinite(t.position))
        .map((t) => ({
            type: TAB_TYPE[t.alignment] ?? TabStopType.LEFT,
            position: Math.max(0, twip(t.position + shift)),
            ...(t.leader && LEADER[t.leader] ? { leader: LEADER[t.leader] } : {}),
        }));

const lastStyle = (pieces: RunPiece[], p: Paragraph): TextStyle | undefined =>
    [...pieces].reverse().find((x) => "text" in x && x.text.trim())?.style ?? p.runs[p.runs.length - 1]?.style ?? p.lines[0]?.runs[0]?.style;

/** Paragraph-mark run properties: like the last run, so Enter at the end keeps the look (and auto spacing agrees). */
const markOptions = (style: TextStyle | undefined, defaults: RunDefaults) => {
    if (!style) return undefined;
    const o = runStyleOptions({ ...style, link: undefined, verticalAlign: undefined, characterSpacing: undefined, underline: false, strike: false }, defaults);
    return Object.keys(o).length ? o : undefined;
};

export const buildParagraph = (p: Paragraph, placement: Placement, ctx: WriterContext, extra: ParagraphChild[] = []): DocxParagraph => {
    let pieces = paragraphPieces(p, placement.keepRows, stretchesLast(p, placement), placement.breaks);
    const { indents } = placement;
    const tabStops = tabStopsOf(p, placement.tabShift ?? 0);
    let numbering: IParagraphOptions["numbering"];
    if (p.list) {
        const hanging = Math.max(0, -indents.firstLine);
        const use = ctx.lists.use(p, pieces, { left: indents.left, hanging });
        if (use) {
            pieces = use.pieces;
            if (use.type === "numbering") numbering = { reference: use.reference, level: use.level };
        }
    } else if (p.heading) ctx.lists.close();
    const children = [...extra, ...buildRunChildren(pieces, ctx.defaults)];
    const shading = hexColor(p.shading);
    const border = p.borderBottom && hexColor(p.borderBottom.color);
    const mark = markOptions(lastStyle(pieces, p), ctx.defaults);
    const options: IParagraphOptions = {
        children,
        alignment: ALIGN[p.alignment] ?? AlignmentType.LEFT,
        ...(p.heading ? { heading: HEADING[p.heading] } : {}),
        ...(numbering ? { numbering } : {}),
        ...(tabStops.length ? { tabStops } : {}),
        indent: {
            left: twip(indents.left),
            right: twip(indents.right),
            ...(indents.firstLine < 0 ? { hanging: twip(-indents.firstLine) } : { firstLine: twip(indents.firstLine) }),
        },
        spacing: {
            before: Math.max(0, twip(placement.before)),
            after: Math.max(0, twip(placement.after)),
            ...(placement.autoLine
                ? { line: placement.autoLine, lineRule: LineRuleType.AUTO }
                : p.lineSpacing > 0
                  ? { line: Math.max(1, twip(p.lineSpacing)), lineRule: LineRuleType.EXACT }
                  : { line: 240, lineRule: LineRuleType.AUTO }),
        },
        ...(shading ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: shading } } : {}),
        ...(border && p.borderBottom
            ? { border: { bottom: { style: BorderStyle.SINGLE, size: eighths(p.borderBottom.width), color: border, space: BORDER_SPACE } } }
            : {}),
        ...(placement.frame
            ? {
                  frame: {
                      type: "absolute" as const,
                      position: { x: twip(placement.frame.x), y: twip(placement.frame.y) },
                      width: Math.max(20, twip(placement.frame.width)),
                      height: 0,
                      anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
                      wrap: FrameWrap.NONE,
                  },
              }
            : {}),
        ...(mark ? { run: mark } : {}),
    };
    return new DocxParagraph(options);
};

/** An almost zero-height empty paragraph (keeps tables apart, carries section breaks and anchors). */
export const tinyParagraph = (children: ParagraphChild[] = [], height = 0.05): DocxParagraph =>
    new DocxParagraph({
        children,
        spacing: { before: 0, after: 0, line: Math.max(1, twip(height)), lineRule: LineRuleType.EXACT },
        run: { size: 2 },
    });

/** A paragraph that is just vertical space of `height` points. */
export const spacerParagraph = (height: number): DocxParagraph => tinyParagraph([], height);
