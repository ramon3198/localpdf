// Text helpers for table detection: line geometry, splitting a line at a column boundary (when the text extractor
// kept two cells on one line) and grouping lines into text rows.
import { runCharX } from "./text-lines";
import type { Rect, TextLine, TextRun } from "./types";

export const right = (r: Rect) => r.x + r.width;
export const bottom = (r: Rect) => r.y + r.height;
export const cx = (r: Rect) => r.x + r.width / 2;
export const cy = (r: Rect) => r.y + r.height / 2;

export const lineText = (l: TextLine) => l.runs.map((r) => r.text).join("");
export const hasText = (l: TextLine) => l.runs.some((r) => r.text.trim() !== "");

const unionRect = (rects: Rect[]): Rect => {
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map(right));
    const y1 = Math.max(...rects.map(bottom));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** Ink extent of a line without leading / trailing spaces (the extractor's run boxes include their spaces). */
export const inkSpan = (l: TextLine): [number, number] => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const r of l.runs) {
        const n = r.text.length;
        if (!n || !r.text.trim()) continue;
        const cw = r.box.width / n;
        const lead = r.text.length - r.text.trimStart().length;
        const trail = r.text.length - r.text.trimEnd().length;
        x0 = Math.min(x0, r.box.x + lead * cw);
        x1 = Math.max(x1, r.box.x + r.box.width - trail * cw);
    }
    return x0 === Infinity ? [l.box.x, right(l.box)] : [x0, x1];
};

const lineFrom = (template: TextLine, runs: TextRun[]): TextLine => {
    const box = unionRect(runs.map((r) => r.box));
    return { ...template, runs, box };
};

/**
 * Where each character of a run starts, plus the run's end (n + 1 values): exact when the text extractor recorded
 * them (a space then starts where the ink before it ends and spans the whole gap), else spread evenly over the box.
 */
const charXs = (r: TextRun): { xs: number[]; exact: boolean } => {
    const known = runCharX.get(r);
    if (known && known.length === r.text.length + 1) return { xs: known, exact: true };
    const n = r.text.length;
    const cw = n ? r.box.width / n : 0;
    return { xs: Array.from({ length: n + 1 }, (_, i) => r.box.x + i * cw), exact: false };
};

const sliceRun = (r: TextRun, from: number, to: number): TextRun | null => {
    const n = r.text.length;
    if (to <= from || n === 0) return null;
    const { xs, exact } = charXs(r);
    const piece: TextRun = { ...r, text: r.text.slice(from, to), box: { ...r.box, x: xs[from], width: Math.max(0, xs[to] - xs[from]) } };
    if (exact) runCharX.set(piece, xs.slice(from, to + 1));
    return piece;
};

/** A place to cut a line: the text before `end` (a character index over the whole line) and the text from `start`. */
type Cut = { end: number; start: number; left: number; right: number };

const isSpace = (c: string) => c === " " || c === "\t" || c === " ";

/**
 * Word boundaries of a line: every stretch of spaces and every change of run between two characters, with the ink
 * end of the text before it (`left`) and the ink start of the text after it (`right`).
 */
const cutsOf = (line: TextLine): Cut[] => {
    type Ch = { x0: number; x1: number; space: boolean; run: number };
    const chars: Ch[] = [];
    line.runs.forEach((r, ri) => {
        const { xs } = charXs(r);
        for (let i = 0; i < r.text.length; i++) chars.push({ x0: xs[i], x1: xs[i + 1], space: isSpace(r.text[i]), run: ri });
    });
    const cuts: Cut[] = [];
    let k = 1;
    while (k < chars.length) {
        const prev = chars[k - 1];
        if (prev.space) {
            k++;
            continue;
        }
        if (chars[k].space) {
            // A stretch of spaces: the cut drops it.
            let m = k;
            while (m < chars.length && chars[m].space) m++;
            if (m < chars.length) cuts.push({ end: k, start: m, left: prev.x1, right: chars[m].x0 });
            k = m + 1;
            continue;
        }
        if (chars[k].run !== prev.run) cuts.push({ end: k, start: k, left: prev.x1, right: chars[k].x0 });
        k++;
    }
    return cuts;
};

/** The line cut at `cut`: runs sliced at the character indices, empty pieces dropped. */
const cutLine = (line: TextLine, cut: Cut): [TextLine, TextLine] | null => {
    const left: TextRun[] = [];
    const rightRuns: TextRun[] = [];
    let offset = 0;
    for (const r of line.runs) {
        const n = r.text.length;
        // Runs wholly on one side stay as they are; the run the cut falls in is sliced.
        const a = offset + n <= cut.end ? r : sliceRun(r, 0, Math.max(0, Math.min(n, cut.end - offset)));
        const b = offset >= cut.start ? r : sliceRun(r, Math.max(0, Math.min(n, cut.start - offset)), n);
        if (a && a.text.trim()) left.push(a);
        if (b && b.text.trim()) rightRuns.push(b);
        offset += n;
    }
    if (!left.length || !rightRuns.length) return null;
    // The left piece must not end with spaces (a run may carry the space that separated it from the next one).
    const last = left[left.length - 1];
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed.length < last.text.length) left[left.length - 1] = sliceRun(last, 0, trimmed.length)!;
    return [lineFrom(line, left), lineFrom(line, rightRuns)];
};

/**
 * The word boundary whose gap holds display x `at` (the text before it ends left of `at`, the text after it starts
 * right of it, within `tol`): a cell edge drawn between two pieces of text that the extractor kept on one line.
 */
const gapCut = (line: TextLine, at: number, tol = 1): Cut | null => {
    let best: Cut | null = null;
    let bestD = Infinity;
    for (const c of cutsOf(line)) {
        if (c.left > at + tol || c.right < at - tol) continue;
        const d = Math.abs((c.left + c.right) / 2 - at);
        if (d < bestD) [best, bestD] = [c, d];
    }
    return best;
};

/**
 * The gap that holds x `at` when it is a column gap, not a word space: at least 0.6 em and twice the line's other
 * word gaps (their median). Two cells the text extractor kept on one line stand apart like that; the words of a
 * sentence that happens to run across a column boundary don't.
 */
const columnCut = (line: TextLine, at: number): Cut | null => {
    const c = gapCut(line, at);
    if (!c) return null;
    const others = cutsOf(line)
        .filter((o) => o.end !== c.end)
        .map((o) => o.right - o.left)
        .filter((g) => g > 0);
    const need = Math.max(0.6 * (line.fontSize || 10), others.length ? 2 * median(others) : 0);
    return c.right - c.left >= need ? c : null;
};

/** Whether a column boundary at x `at` falls in a column gap of the line (see columnCut). */
export const splitsAtColumnGap = (line: TextLine, at: number): boolean => columnCut(line, at) !== null;

/**
 * Splits a line at display x `at` on a word boundary: first the gap that holds `at` (exact character positions),
 * else the word boundary nearest to `at` within `slack` points (text that overruns its cell a little). Returns null
 * when a word straddles the boundary (the text really crosses it).
 */
export const splitLineAt = (line: TextLine, at: number, slack = 6): [TextLine, TextLine] | null => {
    const clean = gapCut(line, at);
    if (clean) {
        const parts = cutLine(line, clean);
        if (parts) return parts;
    }
    let best: Cut | null = null;
    let bestD = Infinity;
    for (const c of cutsOf(line)) {
        const d = Math.abs((c.left + c.right) / 2 - at);
        if (d <= slack && d < bestD) [best, bestD] = [c, d];
    }
    return best ? cutLine(line, best) : null;
};

/** Cuts a line at every x in `xs` that falls in one of its column gaps (see columnCut); pieces left to right. */
export const splitLineAtColumnGaps = (line: TextLine, xs: number[]): TextLine[] => {
    let pieces = [line];
    for (const x of [...xs].sort((a, b) => a - b)) {
        const next: TextLine[] = [];
        for (const p of pieces) {
            const [a, b] = inkSpan(p);
            const c = x > a + 1 && x < b - 1 ? columnCut(p, x) : null;
            const parts = c && cutLine(p, c);
            if (parts) next.push(...parts);
            else next.push(p);
        }
        pieces = next;
    }
    return pieces;
};

/** Lines grouped into rows of text that share a baseline band, top to bottom; each row sorted left to right. */
export const textRows = (lines: TextLine[]): TextLine[][] => {
    const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
    const rows: TextLine[][] = [];
    for (const l of sorted) {
        const row = rows[rows.length - 1];
        const ref = row?.[0];
        if (ref && Math.abs(l.baseline - ref.baseline) <= 0.35 * Math.min(l.fontSize, ref.fontSize) + 0.5) row.push(l);
        else rows.push([l]);
    }
    for (const r of rows) r.sort((a, b) => a.box.x - b.box.x);
    return rows;
};

export const median = (v: number[]) => {
    if (!v.length) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};
