import { ocrLines } from "./extract-text";
import { applyDecorations, decorationGraphics } from "./layout-decorations";
import { ASCENT_SHARE, type ParagraphContext, paragraphsOf, regionLeftOf, wrapCue } from "./layout-paragraphs";
import { solidImage } from "./layout-png";
import { type Item, type Zone, readingRegions, segment } from "./layout-regions";
import { lineStructure } from "./text-structure";
import type { Block, FilledRect, FloatingImage, PageContent, PageModel, Paragraph, PlacedImage, Rect, RuleSegment, Table, TextLine, TextStyle } from "./types";

/** Document-wide facts the page layout needs. */
export type LayoutContext = {
    /** Most common font size of body text in the whole document (headings are measured against it). */
    bodyFontSize: number;
    /** Typical baseline distance / font size of body text (single-line paragraphs get this line spacing). */
    leadingRatio?: number;
    /** Text styles used for headings in this document, most prominent first (level 1, 2, 3). */
    headingStyles?: HeadingStyle[];
    /** Tagged PDF: headings and paragraph boundaries come from its structure (see text-structure.ts). */
    tagged?: boolean;
};

export type HeadingStyle = { size: number; bold: boolean; italic?: boolean; family: string; color: string; level: 1 | 2 | 3 };

const chars = (l: TextLine) => l.runs.reduce((n, r) => n + r.text.replace(/\s/g, "").length, 0);
const right = (b: Rect) => b.x + b.width;
const bottom = (b: Rect) => b.y + b.height;
const area = (b: Rect) => Math.max(0, b.width) * Math.max(0, b.height);
const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const contains = (outer: Rect, inner: Rect, tol = 1) =>
    inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Relative luminance of a hex colour (0 black – 1 white). */
const luminance = (hex: string) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

/**
 * Document-wide facts for the layout: body size, leading, heading styles. It also turns the rules and bars drawn as
 * underline / strikethrough into run formatting on every page first (tables and paragraphs are built after this).
 */
export const documentContext = (pages: PageContent[]): LayoutContext => {
    try {
        return documentContextOf(pages);
    } catch {
        return { bodyFontSize: 11, leadingRatio: 1.2 };
    }
};

const documentContextOf = (pages: PageContent[]): LayoutContext => {
    for (const p of pages) applyDecorations(p);
    const hist = new Map<number, number>();
    const count = (invisible: boolean) => {
        for (const p of pages)
            for (const l of p.lines) {
                if (!!l.invisible !== invisible || l.rotation) continue;
                for (const r of l.runs) {
                    if (r.style.verticalAlign) continue;
                    const k = Math.round(r.style.fontSize * 2) / 2;
                    hist.set(k, (hist.get(k) ?? 0) + r.text.replace(/\s/g, "").length);
                }
            }
    };
    count(false);
    if (!hist.size) count(true);
    let body = 11;
    let best = -1;
    for (const [k, n] of hist) if (n > best || (n === best && k < body)) [body, best] = [k, n];
    // Leading of body text: baseline distances between consecutive lines of body size in the same column, where the
    // upper line certainly runs on into the lower one (paragraph spacing must not pass for leading).
    const ratios = new Map<number, number>();
    const textOf = (l: TextLine) => l.runs.map((r) => r.text).join("");
    for (const p of pages) {
        const ls = p.lines.filter((l) => !l.rotation && Math.abs(l.fontSize - body) <= 0.6).sort((a, b) => a.baseline - b.baseline);
        for (let i = 1; i < ls.length; i++) {
            const a = ls[i - 1];
            const b = ls[i];
            if (Math.abs(a.box.x - b.box.x) > 2 || !wrapCue(textOf(a), textOf(b))) continue;
            const r = Math.round(((b.baseline - a.baseline) / body) * 50) / 50;
            if (r >= 0.95 && r <= 2.4) ratios.set(r, (ratios.get(r) ?? 0) + 1);
        }
    }
    let leading = 1.2;
    let n = 0;
    for (const [r, c] of ratios) if (c > n) [leading, n] = [r, c];
    // A tagged PDF: (nearly) all of its text belongs to structure elements or is marked as page furniture — and its
    // elements are paragraphs, not lines (a sentence that visibly runs on into the next line stays in one element) nor
    // whole pages (a page of text in one or two elements says nothing about its paragraphs and headings).
    let taggedChars = 0;
    let allChars = 0;
    let runOns = 0;
    let splitRunOns = 0;
    let lumped = false;
    for (const p of pages) {
        const flat = p.lines.filter((l) => !l.invisible && !l.rotation);
        const ids = new Set<number>();
        let taggedLines = 0;
        for (const l of flat) {
            const k = chars(l);
            allChars += k;
            const s = lineStructure.get(l);
            if (s) taggedChars += k;
            if (s?.tag?.block) {
                ids.add(s.tag.id);
                taggedLines++;
            }
        }
        if (taggedLines >= 12 && ids.size <= 2) lumped = true;
        const sorted = flat.slice().sort((a, b) => a.baseline - b.baseline);
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            const size = Math.max(a.fontSize, b.fontSize);
            if (Math.abs(a.box.x - b.box.x) > 2 || b.baseline - a.baseline > 1.8 * size || Math.abs(a.fontSize - b.fontSize) > 0.1 * size) continue;
            if (!wrapCue(textOf(a), textOf(b))) continue;
            runOns++;
            const ta = lineStructure.get(a)?.tag;
            const tb = lineStructure.get(b)?.tag;
            if (ta?.block && tb?.block && ta.id !== tb.id) splitRunOns++;
        }
    }
    const tagged = allChars > 0 && taggedChars >= 0.6 * allChars && !(runOns >= 3 && splitRunOns >= 0.5 * runOns) && !lumped;
    return { bodyFontSize: body, leadingRatio: leading, headingStyles: tagged ? [] : headingStyles(pages, body), ...(tagged ? { tagged } : {}) };
};

/**
 * Heading styles of an untagged document: styles of short lines that stand out from body text and never set long
 * running text — clearly larger (x1.3), or larger and bold or in an accent colour, or bold / an accent colour in
 * another face at about body size — and that set only a few lines (a style on every other line is the text of a menu
 * or a list, not its headings). Italic lines of a light weight are subtitles, captions and taglines. Ranked by size,
 * then weight: level 1, 2, 3.
 */
const headingStyles = (pages: PageContent[], body: number): HeadingStyle[] => {
    type Acc = HeadingStyle & { short: number; long: number };
    const styles = new Map<string, Acc>();
    const bodyFaces = new Map<string, number>();
    let lineCount = 0;
    const lineStyle = (l: TextLine) => {
        const count = new Map<string, { n: number; style: TextLine["runs"][number]["style"] }>();
        for (const r of l.runs) {
            if (r.style.verticalAlign) continue;
            const k = [Math.round(r.style.fontSize * 2) / 2, r.style.bold, r.style.italic, r.style.fontFamily, r.style.color].join("|");
            const e = count.get(k);
            const n = r.text.replace(/\s/g, "").length;
            if (e) e.n += n;
            else count.set(k, { n, style: r.style });
        }
        let bestKey = "";
        let best: { n: number; style: TextLine["runs"][number]["style"] } | null = null;
        let total = 0;
        for (const [k, e] of count) {
            total += e.n;
            if (!best || e.n > best.n) [bestKey, best] = [k, e];
        }
        // One style must set (almost) the whole line.
        return best && best.n >= 0.85 * total ? { key: bestKey, style: best.style, chars: total } : null;
    };
    const textOf = (l: TextLine) => l.runs.map((r) => r.text).join("");
    for (const p of pages) {
        const sorted = p.lines.filter((l) => !l.invisible && !l.rotation).sort((a, b) => a.baseline - b.baseline);
        lineCount += sorted.length;
        sorted.forEach((l, i) => {
            const s = lineStyle(l);
            if (!s) return;
            // A line the sentence above runs on into is part of a paragraph, whatever its size.
            const above = sorted
                .slice(0, i)
                .reverse()
                .find((o) => Math.min(right(o.box), right(l.box)) - Math.max(o.box.x, l.box.x) > 0);
            const continuation = !!above && l.baseline - above.baseline < 2.2 * Math.max(above.fontSize, l.fontSize) && wrapCue(textOf(above), textOf(l));
            const face = s.style.fontFamily + "|" + s.style.color;
            if (Math.abs(s.style.fontSize - body) <= 0.6 && !s.style.bold) bodyFaces.set(face, (bodyFaces.get(face) ?? 0) + s.chars);
            let e = styles.get(s.key);
            if (!e) {
                e = {
                    size: Math.round(s.style.fontSize * 2) / 2,
                    bold: s.style.bold,
                    italic: s.style.italic,
                    family: s.style.fontFamily,
                    color: s.style.color,
                    level: 3,
                    short: 0,
                    long: 0,
                };
                styles.set(s.key, e);
            }
            if (continuation || s.chars > 90) e.long++;
            else e.short++;
        });
    }
    let bodyFace = "";
    let most = -1;
    for (const [k, v] of bodyFaces) if (v > most) [bodyFace, most] = [k, v];
    const [bodyFamily, bodyColor] = bodyFace.split("|");
    const chroma = (hex: string) => {
        const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
        return Math.max(...c) - Math.min(...c);
    };
    const candidates = [...styles.values()].filter((e) => {
        if (!e.short || e.long > 0 || e.short > Math.max(4, 0.2 * lineCount)) return false;
        const ratio = e.size / body;
        if (ratio >= 1.3) return true;
        if (e.italic && !e.bold) return false;
        // An accent: a colour (not black or grey) other than the body text's.
        const accent = chroma(e.color) >= 40 && e.color !== bodyColor;
        if (ratio >= 1.12) return e.bold || accent;
        if (ratio >= 1.08 && e.bold) return true;
        // About the size of body text: bold in another face or an accent colour, or another face in an accent colour.
        if (ratio >= 0.95) return (e.bold && (e.family !== bodyFamily || accent)) || (e.family !== bodyFamily && accent);
        return false;
    });
    candidates.sort((a, b) => b.size - a.size || Number(b.bold) - Number(a.bold));
    // Levels: distinct sizes (and weights) in order; very close styles share a level.
    const out: HeadingStyle[] = [];
    let level = 0;
    let prev: Acc | null = null;
    for (const c of candidates) {
        if (!prev || Math.abs(prev.size - c.size) > 0.6 || prev.bold !== c.bold) level++;
        if (level > 3) break;
        out.push({ size: c.size, bold: c.bold, italic: c.italic, family: c.family, color: c.color, level: level as 1 | 2 | 3 });
        prev = c;
    }
    return out;
};

const paragraphContext = (context: LayoutContext): ParagraphContext => ({
    bodyFontSize: context.bodyFontSize || 11,
    leadingRatio: context.leadingRatio && context.leadingRatio > 0.9 && context.leadingRatio < 2.5 ? context.leadingRatio : 1.2,
    headingStyles: context.headingStyles,
    tagged: context.tagged,
});

/** Paragraphs (with alignment, indents, spacing, lists, headings) for the given lines inside `region`. */
export const buildParagraphs = (lines: TextLine[], region: Rect, context: LayoutContext): Paragraph[] => {
    // The pipeline calls this for table cells (layoutPage builds its own regions): no headings inside cells.
    try {
        return paragraphsOf(lines, region, { ...paragraphContext(context), inCell: true });
    } catch {
        return lineParagraphs(lines, region, paragraphContext(context));
    }
};

/** Last resort when the analysis fails on unexpected input: one left-aligned paragraph per line, in place. */
const lineParagraphs = (lines: TextLine[], region: Rect, ctx: ParagraphContext): Paragraph[] => {
    const sorted = lines.filter((l) => l.runs.some((r) => r.text.trim())).sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
    let prev: number | null = null;
    return sorted.map((l) => {
        const lineSpacing = r2((l.fontSize || ctx.bodyFontSize) * ctx.leadingRatio);
        const top = l.baseline - ASCENT_SHARE * lineSpacing;
        const p: Paragraph = {
            kind: "paragraph",
            lines: [l],
            runs: l.runs.map((r) => ({ ...r, style: { ...r.style }, box: { ...r.box } })),
            box: { ...l.box },
            alignment: "left",
            indentLeft: r2(Math.max(0, l.box.x - region.x)),
            indentRight: 0,
            firstLineIndent: 0,
            spaceBefore: r2(Math.max(0, top - (prev ?? region.y))),
            lineSpacing,
        };
        prev = l.baseline + (1 - ASCENT_SHARE) * lineSpacing;
        return p;
    });
};

// ── Page analysis ─────────────────────────────────────────────────────────────────────────────────

type Analysis = {
    /** Lines to lay out (the OCR layer made visible when the page is a scan with invisible text). */
    lines: TextLine[];
    flat: TextLine[];
    rotated: TextLine[];
    /** Text came from OCR (or an invisible OCR layer): the scan is dropped. */
    ocr: boolean;
    scans: Set<PlacedImage>;
    body: number;
    zones: Zone[];
};

const analyse = (content: PageContent, lines: TextLine[], tables: Table[], context?: LayoutContext): Analysis => {
    const pageArea = content.width * content.height;
    const visible = lines.filter((l) => !l.invisible);
    const invisible = lines.filter((l) => l.invisible);
    const visibleChars = visible.reduce((n, l) => n + chars(l), 0);
    const invisibleChars = invisible.reduce((n, l) => n + chars(l), 0);
    const bigImages = content.graphics.images.filter((im) => area(im.box) >= 0.5 * pageArea);
    const fromOcr = lines.some((l) => ocrLines.has(l));
    const ocrLayer = !fromOcr && invisibleChars > 0 && invisibleChars >= 2 * visibleChars && bigImages.length > 0;
    let use: TextLine[] = visible;
    if (fromOcr) use = lines;
    else if (ocrLayer) use = [...visible, ...invisible.map((l) => ({ ...l, invisible: undefined }))];
    const scans = new Set<PlacedImage>(fromOcr || ocrLayer ? content.graphics.images.filter((im) => area(im.box) >= 0.6 * pageArea) : []);
    const flat = use.filter((l) => !l.rotation);
    const rotated = use.filter((l) => !!l.rotation);
    // Body size of this page (headings, gutters are measured against it).
    const hist = new Map<number, number>();
    for (const l of flat) hist.set(Math.round(l.fontSize * 2) / 2, (hist.get(Math.round(l.fontSize * 2) / 2) ?? 0) + chars(l));
    let body = context?.bodyFontSize ?? 11;
    let best = -1;
    for (const [k, v] of hist) if (v > best) [body, best] = [k, v];
    const items: Item[] = [...flat.map((l) => ({ box: l.box, line: l })), ...tables.map((t) => ({ box: t.box, table: t }))];
    const zones = segment(items, Math.max(9, 1.2 * body));
    return { lines: use, flat, rotated, ocr: fromOcr || ocrLayer, scans, body, zones };
};

/** `cleanScan`: a layout page's background will have the OCR'd text painted out (see text-ocr-ink cleanScanBackground). */
export type ModeOptions = { cleanScan?: boolean };

/** Why a page needs positioned layout (empty: it flows). Exposed for diagnostics. */
export const layoutReasons = (content: PageContent, tables: Table[], options: ModeOptions = {}): string[] => {
    const inTable = (l: TextLine) => tables.some((t) => contains(t.box, l.box, 2));
    const a = analyse(
        content,
        content.lines.filter((l) => !inTable(l)),
        tables,
    );
    const reasons: string[] = [];
    // A scan read with OCR (or carrying an OCR layer) flows: its text replaces the scan, which a positioned page would
    // draw behind that text a second time as its background — unless the host cleans the text off that background
    // (text-ocr-ink cleanScanBackground).
    if (a.ocr && !options.cleanScan) return reasons;
    const all = [...a.lines.filter((l) => !inTable(l))];
    const total = all.reduce((n, l) => n + chars(l), 0) + tables.length * 20;
    if (!total) return reasons;
    const pageArea = content.width * content.height;
    // Rotated text can only be drawn in place.
    const rotated = a.rotated.reduce((n, l) => n + chars(l), 0);
    if (rotated > 0.1 * total || (rotated && a.rotated.some((l) => l.fontSize >= 1.3 * a.body))) reasons.push(`rotated text (${rotated} chars)`);
    // Text over pictures (not a scan being replaced by its OCR text).
    const pictures = content.graphics.images.filter((im) => !a.scans.has(im) && area(im.box) > 0.01 * pageArea);
    const overPicture = a.flat.filter((l) => pictures.some((im) => overlap(im.box, l.box) > 0.3 * area(l.box))).reduce((n, l) => n + chars(l), 0);
    if (overPicture > 0.08 * total || overPicture > 60) reasons.push(`text over images (${overPicture} chars)`);
    // Light text only reads on its background: flowing text could drift off it.
    const light = a.flat.filter((l) => !inTable(l) && l.runs.some((r) => r.text.trim() && luminance(r.style.color) > 0.6)).reduce((n, l) => n + chars(l), 0);
    if (light > 0.03 * total || light > 30) reasons.push(`light text on dark backgrounds (${light} chars)`);
    // Side-by-side text blocks and multi-column text that doesn't cover the page.
    const blockZones = a.zones.filter((z) => z.kind === "blocks" && z.regions.filter((r) => r.items.some((i) => i.line)).length >= 2);
    const blockChars = blockZones.reduce((n, z) => n + z.regions.reduce((m, r) => m + r.items.reduce((k, i) => k + (i.line ? chars(i.line) : 0), 0), 0), 0);
    if (blockChars > 0.15 * total || blockZones.some((z) => z.regions.filter((r) => r.items.filter((i) => i.line).length >= 2).length >= 2))
        reasons.push(`side-by-side blocks (${blockZones.length} zones)`);
    const columnZones = a.zones.filter((z) => z.kind === "columns");
    if (columnZones.length > 1 || (columnZones.length === 1 && zoneChars(columnZones[0]) < 0.7 * total)) reasons.push("columns mixed with other layouts");
    // Vector art (logos, charts, gradients) is only kept by the page background.
    if (content.graphics.hasComplexVector) {
        const paragraphish = a.flat.filter((l) => l.box.width > 0.4 * content.width).reduce((n, l) => n + chars(l), 0);
        if (paragraphish < 0.6 * total) reasons.push("vector artwork");
    }
    // Display typography: many sizes, some huge.
    const sizes = new Set(a.flat.map((l) => Math.round(l.fontSize)));
    const maxSize = Math.max(0, ...a.flat.map((l) => l.fontSize));
    if (sizes.size >= 8 && maxSize >= 3.5 * a.body) reasons.push(`display typography (${sizes.size} sizes up to ${maxSize}pt)`);
    return reasons;
};

const zoneChars = (z: Zone) => z.regions.reduce((m, r) => m + r.items.reduce((k, i) => k + (i.line ? chars(i.line) : 0), 0), 0);

/**
 * Whether the page can be written as flowing text or needs positioned (layout) reproduction.
 *
 * Flow keeps text editable as Word expects (paragraphs, lists, tables, columns) and is chosen whenever everything
 * on the page has a flow equivalent: fills become paragraph shading or shapes behind text, rules become paragraph
 * borders or shapes, pictures float. Layout is chosen when flowing text would visibly break the design: rotated
 * text, text over pictures, light text that only reads on its dark background, side-by-side blocks, vector art that
 * only the rendered background keeps, or display typography with many sizes (see `layoutReasons`).
 */
export const chooseMode = (content: PageContent, tables: Table[], requested: "auto" | "flow" | "layout", options: ModeOptions = {}): "flow" | "layout" => {
    if (requested !== "auto") return requested;
    try {
        return layoutReasons(content, tables, options).length ? "layout" : "flow";
    } catch {
        return "flow";
    }
};

// ── Page model ────────────────────────────────────────────────────────────────────────────────────

const topOf = (b: Block) => (b.kind === "image" ? b.image.box.y : b.box.y);

/** Where a paragraph's text ends for Word: last baseline plus the part of the line below it. */
const wordBottom = (p: Paragraph) => {
    const last = Math.max(...p.lines.map((l) => l.baseline));
    return last + (1 - ASCENT_SHARE) * p.lineSpacing;
};

/** The page model: margins, columns, blocks in reading order (paragraphs, tables, floating images). */
export const layoutPage = (content: PageContent, lines: TextLine[], tables: Table[], mode: "flow" | "layout", context: LayoutContext): PageModel => {
    try {
        return pageModel(content, lines, tables, mode, context);
    } catch {
        // Unexpected input: every line as a paragraph in place, tables where they are; the page still converts.
        const ctx = paragraphContext(context);
        const area: Rect = { x: 72, y: 72, width: Math.max(1, content.width - 144), height: content.height };
        const blocks: Block[] = [
            ...lineParagraphs(
                lines.filter((l) => !l.invisible),
                area,
                ctx,
            ),
            ...tables,
        ].sort((p, q) => topOf(p) - topOf(q));
        return { index: content.index, width: content.width, height: content.height, margins: { top: 72, right: 72, bottom: 36, left: 72 }, blocks, mode };
    }
};

const pageModel = (content: PageContent, lines: TextLine[], tables: Table[], mode: "flow" | "layout", context: LayoutContext): PageModel => {
    const W = content.width;
    const H = content.height;
    const ctx = paragraphContext(context);
    const a = analyse(content, lines, tables, context);

    // Content bounds of the flow: the text (Word tables hang into the margin by their cell padding; floating pictures
    // and shapes don't push margins). Tables count when they are all there is, or reach well past the text.
    const textBoxes = a.flat.map((l) => l.box);
    const tx0 = textBoxes.length ? Math.min(...textBoxes.map((b) => b.x)) : Infinity;
    const tx1 = textBoxes.length ? Math.max(...textBoxes.map(right)) : -Infinity;
    const boxes = [...textBoxes, ...tables.map((t) => t.box).filter((b) => !textBoxes.length || b.x < tx0 - 8 || right(b) > tx1 + 8)];
    const x0 = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 72;
    const x1 = boxes.length ? Math.max(...boxes.map(right)) : W - 72;
    const left = x0 <= Math.max(90, 0.18 * W) ? Math.max(0, x0) : Math.min(72, x0);
    const rightMargin = W - x1 <= Math.max(90, 0.18 * W) ? Math.max(0, W - x1) : Math.min(72, W - x1);
    const margins = { top: 72, right: r2(rightMargin), bottom: 36, left: r2(left) };
    const textArea: Rect = { x: margins.left, y: 0, width: Math.max(1, W - margins.left - margins.right), height: H };

    // Blocks in reading order: zones top to bottom, regions left to right, paragraphs and tables by position.
    const tagged: { block: Block; zone: number; region: number; first: boolean }[] = [];
    let columnZone: Zone | null = null;
    let columnZoneIndex = -1;
    const totalChars = a.flat.reduce((n, l) => n + chars(l), 0);
    a.zones.forEach((zone, zi) => {
        const regions = readingRegions(zone);
        const isColumns = zone.kind === "columns" && mode === "flow" && zoneChars(zone) >= 0.6 * totalChars && !columnZone;
        if (isColumns) {
            columnZone = zone;
            columnZoneIndex = zi;
        }
        regions.forEach((region, ri) => {
            const regionLines = region.items.filter((i) => i.line).map((i) => i.line!);
            const regionTables = region.items.filter((i) => i.table).map((i) => i.table!);
            // Flowing single-column text measures alignment against the text area; columns and blocks against themselves.
            const rect: Rect =
                zone.kind === "single" || zone.kind === "rows"
                    ? { x: textArea.x, y: region.box.y, width: textArea.width, height: region.box.height }
                    : { ...region.box };
            const paras = regionLines.length ? paragraphsOf(regionLines, rect, ctx) : [];
            const merged: Block[] = [...paras, ...regionTables].sort((p, q) => topOf(p) - topOf(q));
            merged.forEach((block, k) => tagged.push({ block, zone: zi, region: ri, first: k === 0 }));
        });
    });
    const blocks: Block[] = tagged.map((t) => t.block);
    const breaks = tagged.flatMap((t, i) => (t.zone === columnZoneIndex && t.region > 0 && t.first ? [i] : []));
    const rotatedParas = a.rotated.length ? paragraphsOf(a.rotated, { x: 0, y: 0, width: W, height: H }, ctx) : [];

    const model: PageModel = { index: content.index, width: W, height: H, margins, blocks, mode };
    if (a.ocr) model.ocr = true;
    // A heading introduces what follows it: a big line with nothing under it on the page stands on its own (untagged
    // documents; a tagged one says what its headings are).
    if (!context.tagged)
        for (const b of blocks) {
            if (b.kind !== "paragraph" || !b.heading) continue;
            const end = b.box.y + b.box.height;
            if (!blocks.some((o) => o !== b && (o.kind === "table" || (o.kind === "paragraph" && !o.heading)) && topOf(o) >= end - 2)) delete b.heading;
        }

    if (mode === "layout") {
        // Positioned paragraphs: indents are relative to their own box; the background carries fills, rules, pictures.
        for (const b of blocks) if (b.kind === "paragraph") toOwnBox(b);
        // The page background keeps the drawn underlines and strokes: Word must not draw them again (runs and the lines
        // the writer may position are copies, the page's lines stay as they are).
        const plain = (s: TextStyle): TextStyle => {
            const { underline, strike, ...rest } = s;
            void underline;
            void strike;
            return rest;
        };
        const strip = (p: Paragraph) => {
            for (const r of p.runs) r.style = plain(r.style);
            p.lines = p.lines.map((l) => ({ ...l, runs: l.runs.map((r) => ({ ...r, style: plain(r.style) })) }));
        };
        for (const b of blocks) {
            if (b.kind === "paragraph") strip(b);
            // Tables stay tables on a designed page; their cells' text sits on the same background.
            else if (b.kind === "table") for (const row of b.rows) for (const cell of row.cells) cell.paragraphs.forEach(strip);
        }
        for (const p of rotatedParas) toOwnBox(p);
        blocks.push(...rotatedParas);
        const tops = blocks.map(topOf);
        if (tops.length) margins.top = r2(Math.max(0, Math.min(72, ...tops)));
        margins.bottom = r2(Math.max(0, Math.min(36, H - Math.max(...blocks.map((b) => (b.kind === "image" ? bottom(b.image.box) : bottom(b.box)))) - 2)));
        return model;
    }

    // ── Flow mode ──
    const used = { fills: new Set<FilledRect>(), rules: new Set<RuleSegment>() };
    const paragraphs = blocks.filter((b): b is Paragraph => b.kind === "paragraph");
    applyShading(paragraphs, content.graphics.fills, tables, used, textArea);
    applyLeaders(paragraphs, content.graphics.rules, used, textArea);
    applyBorders(paragraphs, content.graphics.rules, content.graphics.fills, tables, used, textArea);

    // Vertical rhythm: each block's gap above is measured from where the flow before it ends (Word's line boxes).
    // A new column starts at the top of the columns section; what follows the columns starts below the longest one.
    const firstTop = blocks.length ? Math.min(...blocks.map(topOfFlow)) : 72;
    margins.top = r2(Math.max(0, Math.min(firstTop, 72)));
    let flowBottom = margins.top;
    let sectionTop: number | null = null;
    let columnsBottom = -Infinity;
    let afterColumns = false;
    tagged.forEach((t) => {
        const b = t.block;
        if (b.kind === "image") return;
        let ref = flowBottom;
        if (t.zone === columnZoneIndex) {
            if (sectionTop === null) sectionTop = flowBottom;
            if (t.first && t.region > 0) ref = sectionTop;
        } else if (sectionTop !== null && !afterColumns) {
            afterColumns = true;
            ref = Math.max(columnsBottom, flowBottom);
        }
        if (b.kind === "paragraph") b.spaceBefore = r2(Math.max(0, topOfFlow(b) - ref));
        flowBottom = b.kind === "paragraph" ? wordBottom(b) : bottom(b.box);
        if (t.zone === columnZoneIndex) columnsBottom = Math.max(columnsBottom, flowBottom);
    });
    const lastBottom = blocks.length
        ? Math.max(...blocks.map((b) => (b.kind === "paragraph" ? wordBottom(b) : b.kind === "table" ? bottom(b.box) : 0)))
        : H - 72;
    // Generous room at the bottom: Word's lines may come out a little taller than the PDF's.
    margins.bottom = r2(Math.max(0, Math.min(48, (H - lastBottom) * 0.5)));

    let columns: NonNullable<PageModel["columns"]> | null = null;
    if (columnZone && breaks.length) {
        const cols = (columnZone as Zone).regions;
        const gap = cols.length > 1 ? Math.min(...cols.slice(1).map((c, i) => c.box.x - right(cols[i].box))) : 0;
        const inZone = tagged.flatMap((t, i) => (t.zone === columnZoneIndex ? [i] : []));
        columns = {
            count: cols.length,
            gap: r2(Math.max(0, gap)),
            breaks,
            widths: cols.map((c) => r2(c.box.width)),
            first: inZone[0],
            last: inZone[inZone.length - 1],
        };
        model.columns = columns;
    }

    // Floating content: pictures, and the fills and rules no paragraph or table took, as shapes behind the text.
    const floats: FloatingImage[] = [];
    const pageArea = W * H;
    for (const im of content.graphics.images) {
        if (a.scans.has(im)) continue;
        const behind = area(im.box) >= 0.8 * pageArea || a.flat.some((l) => overlap(l.box, im.box) > 0.2 * area(l.box));
        floats.push({ kind: "image", image: im, behindText: behind });
    }
    let shapes = 0;
    for (const f of content.graphics.fills) {
        if (used.fills.has(f) || decorationGraphics.has(f) || shapes > 400) continue;
        if (f.opacity < 0.03 || area(f) < 2) continue;
        if (luminance(f.color) > 0.985 && f.opacity > 0.9) continue; // white paper
        if (tables.some((t) => contains(t.box, f, 1.5))) continue; // cell shading belongs to the table
        floats.push({ kind: "image", image: solidImage(f.color, f.opacity, f), behindText: true });
        shapes++;
    }
    for (const r of content.graphics.rules) {
        if (used.rules.has(r) || decorationGraphics.has(r) || shapes > 400) continue;
        const horizontal = Math.abs(r.y1 - r.y2) < 0.5;
        const vertical = Math.abs(r.x1 - r.x2) < 0.5;
        if (!horizontal && !vertical) continue;
        const box: Rect = horizontal
            ? { x: Math.min(r.x1, r.x2), y: r.y1 - r.width / 2, width: Math.abs(r.x2 - r.x1), height: Math.max(0.25, r.width) }
            : { x: r.x1 - r.width / 2, y: Math.min(r.y1, r.y2), width: Math.max(0.25, r.width), height: Math.abs(r.y2 - r.y1) };
        if (tables.some((t) => contains(t.box, box, 1.5))) continue;
        floats.push({ kind: "image", image: solidImage(r.color, 1, box), behindText: true });
        shapes++;
    }
    // Floating objects go right before the first block below their top edge (the writer anchors them there).
    for (const f of floats.sort((p, q) => p.image.box.y - q.image.box.y)) {
        const at = blocks.findIndex((b) => b.kind !== "image" && topOf(b) >= f.image.box.y - 1);
        if (at < 0) blocks.push(f);
        else {
            blocks.splice(at, 0, f);
            for (let k = 0; k < breaks.length; k++) if (breaks[k] >= at) breaks[k]++;
            if (columns?.first !== undefined && columns.first >= at) columns.first++;
            if (columns?.last !== undefined && columns.last >= at) columns.last++;
        }
    }
    blocks.push(...rotatedParas);
    return model;
};

const topOfFlow = (b: Block) => (b.kind === "paragraph" ? Math.min(...b.lines.map((l) => l.baseline)) - ASCENT_SHARE * b.lineSpacing : topOf(b));

/** Layout mode: indents relative to the paragraph's own box (the writer places the box). */
const toOwnBox = (p: Paragraph) => {
    const bodyLeft = p.lines.length > 1 ? Math.min(...p.lines.slice(1).map((l) => l.box.x)) : p.box.x;
    const first = p.lines[0];
    if (p.alignment === "left" || p.alignment === "justify") {
        p.indentLeft = r2(Math.max(0, (p.list ? p.box.x - p.firstLineIndent : bodyLeft) - p.box.x));
        if (!p.list) p.firstLineIndent = r2(first.box.x - bodyLeft);
    } else p.indentLeft = 0;
    p.indentRight = 0;
    p.spaceBefore = 0;
};

/** A fill that frames one paragraph across the text width (a shaded heading, a note band) becomes its shading. */
const applyShading = (paragraphs: Paragraph[], fills: FilledRect[], tables: Table[], used: { fills: Set<FilledRect> }, textArea: Rect) => {
    for (const f of fills) {
        if (f.opacity < 0.5 || luminance(f.color) > 0.985) continue;
        if (tables.some((t) => contains(t.box, f, 1.5))) continue;
        const inside = paragraphs.filter((p) => contains(f, p.box, 1.5));
        if (inside.length !== 1) continue;
        const p = inside[0];
        const lineH = p.lineSpacing || p.box.height;
        // Word shades from indent to indent over the paragraph's lines: the fill must match that area.
        const spansText = Math.abs(f.x - (textArea.x + p.indentLeft)) <= 4 && Math.abs(right(f) - (right(textArea) - p.indentRight)) <= 4;
        const tight = f.height <= p.box.height + 1.2 * lineH;
        if (!spansText || !tight || p.shading) continue;
        // Nothing else of the flow may sit on the fill.
        if (paragraphs.some((o) => o !== p && overlap(o.box, f) > 0.2 * area(o.box))) continue;
        p.shading = f.color;
        used.fills.add(f);
    }
};

/** Dotted / dashed rules (or baseline underlines) filling the gap before a tab's text: the tab's leader. */
const applyLeaders = (paragraphs: Paragraph[], rules: RuleSegment[], used: { rules: Set<RuleSegment> }, textArea: Rect) => {
    const flat = rules.filter((r) => Math.abs(r.y1 - r.y2) < 0.5 && !used.rules.has(r) && !decorationGraphics.has(r));
    if (!flat.length) return;
    for (const p of paragraphs) {
        if (!p.tabStops?.length) continue;
        const lines = p.lines.slice().sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
        for (let i = 1; i < lines.length; i++) {
            const a = lines[i - 1];
            const b = lines[i];
            const size = Math.max(a.fontSize, b.fontSize);
            if (Math.abs(a.baseline - b.baseline) > 0.3 * size) continue;
            const g0 = right(a.box);
            const g1 = b.box.x;
            if (g1 - g0 <= 1.2 * size) continue;
            for (const r of flat) {
                if (used.rules.has(r)) continue;
                const y = (r.y1 + r.y2) / 2;
                const x0 = Math.min(r.x1, r.x2);
                const x1 = Math.max(r.x1, r.x2);
                const style = (r as RuleSegment & { style?: string }).style;
                const onBaseline = y >= a.baseline - 0.6 * size && y <= a.baseline + 0.4 * size;
                const inGap = x0 >= g0 - 3 && x1 <= g1 + 3 && x1 - x0 >= 0.5 * (g1 - g0);
                if (!onBaseline || !inGap) continue;
                if (!style && (y < a.baseline - 0.1 * size || r.width > 1.5)) continue; // a solid rule counts only as an underline
                const leader = style === "dotted" ? "dot" : style === "dashed" ? "hyphen" : "underscore";
                const origin = regionLeftOf.get(p) ?? textArea.x;
                const target = p.tabStops.find((t) => Math.abs(origin + t.position - b.box.x) <= 1.5 || Math.abs(origin + t.position - right(b.box)) <= 1.5);
                if (!target) continue;
                target.leader = leader;
                used.rules.add(r);
            }
        }
    }
};

/** A horizontal rule across the text width right under a paragraph becomes its bottom border. */
const applyBorders = (
    paragraphs: Paragraph[],
    rules: RuleSegment[],
    fills: FilledRect[],
    tables: Table[],
    used: { fills: Set<FilledRect>; rules: Set<RuleSegment> },
    textArea: Rect,
) => {
    type Candidate = { x0: number; x1: number; y: number; width: number; color: string; rule?: RuleSegment; fill?: FilledRect };
    const cands: Candidate[] = [];
    for (const r of rules) {
        if (Math.abs(r.y1 - r.y2) >= 0.5 || decorationGraphics.has(r)) continue;
        cands.push({ x0: Math.min(r.x1, r.x2), x1: Math.max(r.x1, r.x2), y: (r.y1 + r.y2) / 2, width: r.width, color: r.color, rule: r });
    }
    for (const f of fills) {
        if (f.height > 3 || f.width < 20 || f.opacity < 0.5 || used.fills.has(f) || decorationGraphics.has(f)) continue;
        cands.push({ x0: f.x, x1: right(f), y: f.y + f.height / 2, width: f.height, color: f.color, fill: f });
    }
    const sorted = paragraphs.slice().sort((p, q) => p.box.y - q.box.y);
    for (const c of cands) {
        if (tables.some((t) => c.y >= t.box.y - 1 && c.y <= bottom(t.box) + 1 && c.x0 >= t.box.x - 1 && c.x1 <= right(t.box) + 1)) continue;
        // The paragraph right above the rule.
        let host: Paragraph | null = null;
        for (const p of sorted) {
            const gapBelow = c.y - bottom(p.box);
            if (gapBelow >= -1 && gapBelow <= Math.max(6, 0.9 * (p.lineSpacing || p.box.height))) host = p;
        }
        if (!host || host.borderBottom) continue;
        const next = sorted[sorted.indexOf(host) + 1];
        if (next && next.box.y < c.y - 0.5) continue;
        const spans = Math.abs(c.x0 - (textArea.x + host.indentLeft)) <= 6 && Math.abs(c.x1 - (right(textArea) - host.indentRight)) <= 6;
        if (!spans) continue;
        host.borderBottom = { color: c.color, width: r2(Math.max(0.25, c.width)) };
        if (c.rule) used.rules.add(c.rule);
        if (c.fill) used.fills.add(c.fill);
    }
};
