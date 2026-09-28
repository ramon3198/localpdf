// Justified text as Word will set it.
//
// Word 2013+ (compatibility mode 15), InDesign and TeX also SHRINK word spaces (Word by up to ~24 %) to fit one more
// word on a justified line; Word 2010 and older, browsers and most report generators only stretch them. Word 2013+
// layout on text set the classic way pulls words up and reflows justified paragraphs (and the reverse), so when no
// justified line of the PDF was shrunk the document is written in mode 14 (Word 2010 layout, which renders everything
// else the writer uses the same way), otherwise in mode 15.
//
// The evidence is the extraction's word-gap measurement (text-lines: gap / natural space width per line), available
// when the models come from the pipeline in the same run; models built elsewhere get mode 15 and no retuning.
import { rowsOf } from "./docx-paragraph";
import { lineNatural, lineStretch } from "./text-lines";
import type { Block, PageModel, Paragraph } from "./types";

/** Word shrinks justified word spaces by up to about this share of their width (measured: 23.9 % fits, 25 % not). */
const WORD_SHRINK = 0.24;

export type Tuning = {
    /** Word compatibility mode for the document. */
    compat: 14 | 15;
    /** The models, with paragraphs retuned where needed (copies; the input is not changed). */
    pages: PageModel[];
    /**
     * Justified paragraphs whose PDF lines can't all come from Word's line breaking, with the lines after which the
     * PDF broke although the next word fitted: only there does the paragraph get a line break (Word wraps the rest
     * at the same words by itself, and a manual break is a paragraph break to anyone editing or indexing the text).
     */
    keepRows: WeakMap<Paragraph, ReadonlySet<number>>;
};

const median = (values: number[]) => {
    const s = values.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

const eachParagraph = (pages: PageModel[], visit: (p: Paragraph) => void) => {
    for (const page of pages)
        for (const b of page.blocks) {
            if (b.kind === "paragraph") visit(b);
            else if (b.kind === "table") for (const row of b.rows) for (const cell of row.cells) cell.paragraphs.forEach(visit);
        }
};

/** Word-gap stretch of each row (gap / natural space; 1 = natural), for rows made of one source line. */
const rowStretch = (p: Paragraph) => rowsOf(p).map((r) => (r.pieces.length === 1 ? lineStretch.get(r.pieces[0]) : undefined));

export const tuneForWord = (pages: PageModel[]): Tuning => {
    const keepRows = new WeakMap<Paragraph, ReadonlySet<number>>();
    // Natural spacing as measured on this document (space glyphs, or an estimate when the PDF positions words).
    const natural: number[] = [];
    eachParagraph(pages, (p) => {
        if (p.alignment === "justify" || p.keepLineBreaks) return;
        for (const s of rowStretch(p)) if (s !== undefined) natural.push(s);
    });
    const reference = natural.length >= 5 ? (median(natural) ?? 1) : 1;
    const shrunk = (s: number | undefined) => s !== undefined && s < 0.92 * reference;

    let shrinkEvidence = 0;
    let justifiedMeasured = 0;
    eachParagraph(pages, (p) => {
        if (p.keepLineBreaks) return;
        const stretch = rowStretch(p);
        const rows = p.alignment === "justify" ? stretch.slice(0, -1) : stretch;
        for (const s of rows) {
            if (s === undefined) continue;
            if (p.alignment === "justify") justifiedMeasured++;
            if (shrunk(s) && (p.alignment === "justify" || p.alignment === "left")) shrinkEvidence++;
        }
    });
    const compat: 14 | 15 = shrinkEvidence === 0 && justifiedMeasured > 0 ? 14 : 15;

    // Retune paragraphs: a shrunk line in a "left" paragraph was justified in the source (a single or last line, set
    // tighter than natural): as justified text Word shrinks it the same way instead of wrapping it. Justified lines
    // that broke although the next word fitted ("early") can't come from Word's line breaking: keep them.
    const retune = (p: Paragraph): Paragraph => {
        if (p.keepLineBreaks) return p;
        const stretch = rowStretch(p);
        let out = p;
        if (compat === 15 && p.alignment === "left" && stretch.some(shrunk)) out = { ...p, alignment: "justify" };
        if (out.alignment === "justify") {
            const early = earlyBreaks(out, compat);
            if (early.size) keepRows.set(out, early);
        }
        return out;
    };
    const retuneBlock = (b: Block): Block => {
        if (b.kind === "paragraph") return retune(b);
        if (b.kind !== "table") return b;
        let changed = false;
        const rows = b.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => {
                const paragraphs = cell.paragraphs.map(retune);
                if (paragraphs.some((q, i) => q !== cell.paragraphs[i])) changed = true;
                return { ...cell, paragraphs };
            }),
        }));
        return changed ? { ...b, rows } : b;
    };
    const tuned = pages.map((page) => {
        const blocks = page.blocks.map(retuneBlock);
        return blocks.some((b, i) => b !== page.blocks[i]) ? { ...page, blocks } : page;
    });
    return { compat, pages: tuned, keepRows };
};

/** A line ending in a hyphen (hyphen-minus, soft hyphen, hyphen) that splits a word. */
const HYPHEN_END = /\p{L}[-\u00AD\u2010]$/u;

/**
 * The lines of the justified paragraph that broke although the next word would have fitted (in Word's terms: natural
 * width + space + next word within the column, allowing Word's shrinking in mode 15), and those ending in a hyphen
 * that splits a word (the paragraph's text joins the word again, so Word would not break there).
 */
const earlyBreaks = (p: Paragraph, compat: 14 | 15): Set<number> => {
    const early = new Set<number>();
    const rows = rowsOf(p);
    if (rows.length < 2) return early;
    // Each line has the room from its own start (indents, hanging lists) to the justified right edge.
    const right = Math.max(...rows.map((r) => r.x1));
    for (let i = 0; i < rows.length - 1; i++) {
        const row = rows[i];
        const natural = row.pieces.length === 1 ? lineNatural.get(row.pieces[0]) : undefined;
        const next = rows[i + 1];
        const text = row.runs
            .map((r) => r.text)
            .join("")
            .trimEnd();
        const nextText = next.runs
            .map((r) => r.text)
            .join("")
            .trimStart();
        if (HYPHEN_END.test(text) && /^\p{Ll}/u.test(nextText)) {
            early.add(i);
            continue;
        }
        if (natural === undefined || next.firstWord <= 0) continue;
        const size = row.pieces[0].fontSize || 10;
        const space = 0.3 * size;
        const gaps =
            row.runs
                .map((r) => r.text)
                .join("")
                .trim()
                .match(/\s+/g)?.length ?? 0;
        const allowance = compat === 15 ? WORD_SHRINK * 0.25 * size * (gaps + 1) : 0;
        if (natural + space + next.firstWord - allowance <= right - row.x0 - 1) early.add(i);
    }
    return early;
};
