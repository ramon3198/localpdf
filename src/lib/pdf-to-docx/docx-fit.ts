// Letter-spacing that makes Word set a line as long as the PDF did. On a designed page every line keeps its place and
// its breaks, so what can still differ is its length: Word prints sizes in half points (9.75 pt → 10 pt) and doesn't
// kern, and a web font's letter-spacing may not have been measured. With the advance widths of the face Word will use
// (an embedded one), or for Office's own fonts the size rounding alone, the difference goes into the spacing of the
// line's characters (w:spacing): the line ends where the PDF's does and doesn't run into what comes after it.
import { isCommonFont } from "./docx-metrics";
import { type WriterContext, rowsOf } from "./docx-paragraph";
import { wordFontSize } from "./docx-text";
import { halfPoints, twip } from "./docx-units";
import type { Paragraph, TextLine, TextRun } from "./types";

const r2 = (v: number) => Math.round(v * 100) / 100;
const isSpace = (ch: string) => /\s/.test(ch);

/** Word's size and letter-spacing for a style, rounded as Word stores them. */
const printed = (run: TextRun) => ({
    size: halfPoints(wordFontSize(run.style)) / 2,
    spacing: run.style.characterSpacing ? twip(run.style.characterSpacing) / 20 : 0,
});

/** `exact`: measured with the advance widths of the very face Word will use (else an estimate). */
type Measure = { length: number; gaps: number; spaces: number; exact: boolean };

/**
 * Word's length of a line (first to last visible character), its letter gaps and its spaces between words, or
 * undefined when it can't be known: a font Word will substitute, scripts, a mix of embedded and Office fonts, or an
 * Office font at a size Word keeps (the PDF's widths are then the best guess there is).
 */
const wordLength = (runs: TextRun[], pdfLength: number, ctx: Pick<WriterContext, "advances">): Measure | undefined => {
    const chars: { ch: string; run: TextRun }[] = [];
    for (const run of runs) for (const ch of run.text) chars.push({ ch, run });
    let a = 0;
    let b = chars.length - 1;
    while (a <= b && isSpace(chars[a].ch)) a++;
    while (b >= a && isSpace(chars[b].ch)) b--;
    if (b - a < 1) return undefined;
    const visible = chars.slice(a, b + 1);
    if (visible.some(({ run }) => run.style.verticalAlign || run.text.includes("\t"))) return undefined;
    const spaces = visible.filter(({ ch }) => isSpace(ch)).length;
    const faces = visible.map(({ run }) => ctx.advances?.(run.style.fontFamily, !!run.style.bold, !!run.style.italic));
    if (faces.every(Boolean)) {
        let length = 0;
        for (let i = 0; i < visible.length; i++) {
            const em = faces[i]!(visible[i].ch.codePointAt(0) ?? 0);
            if (em === undefined) return undefined;
            const { size, spacing } = printed(visible[i].run);
            length += em * size + (i < visible.length - 1 ? spacing : 0);
        }
        return { length, gaps: visible.length - 1, spaces, exact: true };
    }
    // Office's fonts: Word has the PDF's font (or a metric twin), so only the size rounding (9.75 pt → 10 pt) changes
    // the length much; the PDF's own widths may be off by a little (a browser rounds advances to pixels).
    if (faces.some(Boolean) || !visible.every(({ run }) => isCommonFont(run.style.fontFamily))) return undefined;
    let tracking = 0;
    let pdfTracking = 0;
    let ratio = 0;
    for (let i = 0; i < visible.length; i++) {
        const { run } = visible[i];
        const { size, spacing } = printed(run);
        if (i < visible.length - 1) {
            tracking += spacing;
            pdfTracking += run.style.characterSpacing ?? 0;
        }
        ratio += size / Math.max(0.5, run.style.fontSize);
    }
    ratio /= visible.length;
    if (Math.abs(ratio - 1) < 0.01) return undefined;
    return { length: (pdfLength - pdfTracking) * ratio + tracking, gaps: visible.length - 1, spaces, exact: false };
};

const withSpacing = (run: TextRun, delta: number): TextRun => {
    if (!delta) return run;
    const spacing = r2((run.style.characterSpacing ?? 0) + delta);
    return { ...run, style: { ...run.style, characterSpacing: Math.abs(spacing) >= 0.05 ? spacing : undefined } };
};

/** Splits runs so that spaces are runs of their own (their spacing can then differ from the letters'). */
const spacesApart = (runs: TextRun[]): TextRun[] =>
    runs.flatMap((r) =>
        /\S/.test(r.text) && /\s/.test(r.text)
            ? r.text
                  .split(/(\s+)/)
                  .filter(Boolean)
                  .map((text) => ({ ...r, text }))
            : [r],
    );

/**
 * The corrected runs of one line: the difference goes into the spaces when the model spread the line's words apart
 * (word spacing set on its spaces: that is what the PDF measures least well), else into every letter gap.
 */
const fitRuns = (runs: TextRun[], pdf: number, ctx: Pick<WriterContext, "advances">): { runs?: TextRun[]; exact: boolean } => {
    const measure = wordLength(runs, pdf, ctx);
    if (!measure) return { exact: false };
    const { exact } = measure;
    const excess = pdf - measure.length;
    if (Math.abs(excess) < Math.max(0.3, 0.002 * pdf)) return { exact };
    const size = Math.max(1, ...runs.filter((r) => r.text.trim()).map((r) => r.style.fontSize));
    const wordSpaced = runs.some((r) => !r.text.trim() && (r.style.characterSpacing ?? 0) > 0);
    if (wordSpaced && measure.spaces > 0) {
        const delta = excess / measure.spaces;
        if (Math.abs(delta) > 0.6 * size) return { exact: false };
        return { runs: spacesApart(runs).map((r) => (r.text.trim() ? r : withSpacing(r, delta))), exact };
    }
    const delta = excess / measure.gaps;
    if (Math.abs(delta) > 0.2 * size) return { exact: false };
    return { runs: runs.map((r) => withSpacing(r, delta)), exact };
};

const exactLengths = new WeakSet<Paragraph>();

/** Whether Word will set every line of this (fitted) paragraph exactly as long as the PDF's: no room needed for error. */
export const hasExactLengths = (p: Paragraph): boolean => exactLengths.has(p);

/**
 * The paragraph with letter-spacing that gives each of its lines the PDF's length, where Word's length is known and
 * differs by more than a trace. Only for text that keeps its lines (frames and cells of a designed page). A single
 * line is written from the paragraph's runs (which may carry word spacing the line's runs don't), several lines from
 * their source lines.
 */
export const fitLineLengths = (p: Paragraph, ctx: Pick<WriterContext, "advances">): Paragraph => {
    const rows = rowsOf(p);
    if (!rows.length || rows.some((r) => r.pieces.length !== 1)) return p;
    // Word stretches justified lines itself (all but the last, unless that one is stretched too).
    const stretched = (i: number) => p.alignment === "justify" && (i < rows.length - 1 || p.justifyLastLine === true);
    const exact = (q: Paragraph, known: boolean) => {
        if (known) exactLengths.add(q);
        return q;
    };
    if (rows.length === 1) {
        if (stretched(0)) return p;
        const { runs, exact: known } = fitRuns(p.runs, rows[0].x1 - rows[0].x0, ctx);
        return exact(runs ? { ...p, runs } : p, known);
    }
    const changed = new Map<TextLine, TextLine>();
    let known = true;
    for (const [i, row] of rows.entries()) {
        if (stretched(i)) continue;
        const line = row.pieces[0];
        const fit = fitRuns(line.runs, row.x1 - row.x0, ctx);
        known &&= fit.exact;
        if (fit.runs) changed.set(line, { ...line, runs: fit.runs });
    }
    return exact(changed.size ? { ...p, lines: p.lines.map((l) => changed.get(l) ?? l) } : p, known);
};
