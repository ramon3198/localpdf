// Glyphs → visual lines → runs. A line is a stretch of text on one baseline and in one direction, without column-sized
// gaps (table cells, tab stops and columns side by side become separate lines). Superscripts and subscripts join the
// line they belong to; spaces come from space glyphs and from positional word gaps, never doubled.
import type { Glyph } from "./text-glyphs";
import { type StructTag, lineStructure } from "./text-structure";
import type { TextLine, TextRun, TextStyle } from "./types";

/** Line with the geometry the layout needs beyond the contract: direction and rotation. */
export type BuiltLine = TextLine & {
    /** Baseline direction (unit vector, display space). */
    dir: [number, number];
};

/**
 * How much wider the line's word gaps are than natural spaces (median ratio; 1 = unstretched). Justified lines are
 * stretched, so a paragraph of two lines can still be told justified. Only set for lines with two word gaps or more.
 */
export const lineStretch = new WeakMap<TextLine, number>();

/**
 * Width the line's text would take with natural word spaces (justification stretch removed): what Word needs to
 * break a justified paragraph at the same words.
 */
export const lineNatural = new WeakMap<TextLine, number>();

/** x where each character of a horizontal run starts, plus the run's end (for splitting runs at exact positions). */
export const runCharX = new WeakMap<TextRun, number[]>();

type Chunk = {
    glyphs: Glyph[];
    dx: number;
    dy: number;
    invisible: boolean;
    /** Main baseline (v + rise of the largest glyphs) and size. */
    base: number;
    size: number;
    u0: number;
    u1: number;
};

const sameDir = (a: { dx: number; dy: number }, b: { dx: number; dy: number }) => Math.abs(a.dx - b.dx) < 2e-3 && Math.abs(a.dy - b.dy) < 2e-3;

/** The editor's onSameLine: same baseline after rise, or a smaller glyph raised / lowered next to bigger text. */
const onSameLine = (prev: Glyph, g: Glyph) => {
    const off = g.v + g.rise - (prev.v + prev.rise);
    const big = Math.max(g.size, prev.size);
    if (Math.abs(off) <= 0.12 * (prev.size || 1)) return true;
    return Math.min(g.size, prev.size) <= 0.85 * big && Math.abs(off) <= 0.6 * big;
};

const isInk = (g: Glyph) => !g.ws && g.text !== "";

const chunkOf = (glyphs: Glyph[]): Chunk => {
    const first = glyphs[0];
    let size = 0;
    for (const g of glyphs) if (!g.ws && g.size > size) size = g.size;
    if (!size) size = first.size;
    const bases: number[] = [];
    for (const g of glyphs) if (!g.ws && g.size >= 0.9 * size) bases.push(g.v + g.rise);
    bases.sort((a, b) => a - b);
    const base = bases.length ? bases[Math.floor(bases.length / 2)] : first.v + first.rise;
    let u0 = Infinity;
    let u1 = -Infinity;
    for (const g of glyphs) {
        if (g.ws) continue;
        u0 = Math.min(u0, g.u);
        u1 = Math.max(u1, g.u + Math.max(g.ink, 0));
    }
    if (u0 === Infinity) {
        u0 = first.u;
        u1 = glyphs[glyphs.length - 1].u + glyphs[glyphs.length - 1].adv;
    }
    return { glyphs, dx: first.dx, dy: first.dy, invisible: first.invisible, base, size, u0, u1 };
};

/**
 * How the page's generator writes word spaces. "Spaced" pages draw a space glyph between words (Word, browsers,
 * most HTML/office converters): there a wide gap WITHOUT a space glyph is a column or tab gap, not a word gap.
 * Other pages (pdfTeX, some typesetters) position words, so only much wider gaps separate columns.
 */
const spacingStats = (glyphs: Glyph[]) => {
    let spaceGaps = 0;
    let positional = 0;
    const spaceEm: number[] = [];
    let prevInk: Glyph | null = null;
    let sawSpace = false;
    for (const g of glyphs) {
        if (g.ws) {
            sawSpace = true;
            if (g.size > 0 && g.adv > 0) spaceEm.push(g.adv / g.size);
            continue;
        }
        if (!isInk(g)) continue;
        if (prevInk && sameDir(prevInk, g) && onSameLine(prevInk, g)) {
            const gap = g.u - (prevInk.u + prevInk.ink);
            if (gap > -0.3 * g.size && gap < 1.5 * g.size) {
                if (sawSpace) spaceGaps++;
                else if (gap > 0.2 * g.size) positional++;
            }
        }
        prevInk = g;
        sawSpace = false;
    }
    spaceEm.sort((a, b) => a - b);
    const em = spaceEm.length ? spaceEm[Math.floor(spaceEm.length / 2)] : 0.28;
    const spaced = spaceGaps >= 8 && spaceGaps >= 4 * positional;
    // Column gap threshold in em: a bit less than two spaces on spaced pages, one em elsewhere.
    return { spaced, limit: spaced ? Math.max(0.45, Math.min(1.0, 1.8 * Math.min(em, 0.5))) : 1.0 };
};

/** Glyphs drawn one after the other on the same line, in content order. */
const contentChunks = (glyphs: Glyph[], limit: number): Chunk[] => {
    const out: Chunk[] = [];
    let cur: Glyph[] = [];
    let prev: Glyph | null = null;
    // Recent gaps between letters of the chunk: letter-spaced text has regular wide gaps that aren't column gaps.
    let gaps: number[] = [];
    const flush = () => {
        if (cur.length) out.push(chunkOf(cur));
        cur = [];
        gaps = [];
    };
    for (const g of glyphs) {
        if (prev) {
            const size = Math.max(prev.size, g.size);
            const gap = g.u - (prev.u + prev.adv);
            let tracking = 0;
            if (gaps.length >= 2) {
                const s = gaps.slice(-8).sort((a, b) => a - b);
                tracking = Math.max(0, s[Math.floor(s.length / 2)]);
            }
            // Justification may add a wide positional offset after a space glyph (Word); such lines split here and are
            // joined again by joinWordSpacedRows (regular gaps), which keeps table cells apart.
            const joins =
                sameDir(prev, g) &&
                prev.invisible === g.invisible &&
                onSameLine(prev, g) &&
                gap >= -Math.max(0.6 * size, prev.adv + 0.1 * size) &&
                (gap - tracking <= limit * size || (prev.ws && gap <= 0.1 * size));
            if (!joins) flush();
            else if (!prev.ws && !g.ws) gaps.push(gap);
        }
        cur.push(g);
        prev = g;
    }
    flush();
    return out;
};

/** Ink-to-ink gaps between words on a piece of line (positional gaps and space glyphs alike). */
const wordGaps = (glyphs: Glyph[], size: number): number[] => {
    const out: number[] = [];
    let prevInk: Glyph | null = null;
    let sawSpace = false;
    for (const g of glyphs) {
        if (g.ws) {
            sawSpace = true;
            continue;
        }
        if (!isInk(g)) continue;
        if (prevInk) {
            const gap = g.u - (prevInk.u + prevInk.ink);
            if (sawSpace || gap > 0.15 * size) out.push(gap);
        }
        prevInk = g;
        sawSpace = false;
    }
    return out;
};

type Line = { chunks: Chunk[]; dx: number; dy: number; invisible: boolean; base: number; size: number; u0: number; u1: number };

const lineFrom = (c: Chunk): Line => ({ chunks: [c], dx: c.dx, dy: c.dy, invisible: c.invisible, base: c.base, size: c.size, u0: c.u0, u1: c.u1 });

const addChunk = (l: Line, c: Chunk) => {
    l.chunks.push(c);
    l.chunks.sort((a, b) => a.u0 - b.u0);
    if (c.size > l.size * 1.05) {
        l.base = c.base;
        l.size = c.size;
    }
    l.u0 = Math.min(l.u0, c.u0);
    l.u1 = Math.max(l.u1, c.u1);
};

/** Chunk belongs on the line: compatible baseline (or a superscript beside it) and within a word gap of its ends. */
const fits = (l: Line, c: Chunk, maxGap: number): number | null => {
    if (!sameDir(l, c) || l.invisible !== c.invisible) return null;
    const big = Math.max(l.size, c.size);
    const small = Math.min(l.size, c.size);
    const off = c.base - l.base;
    const baseOk = Math.abs(off) <= 0.15 * small || (small <= 0.85 * big && Math.abs(off) <= 0.6 * big);
    if (!baseOk) return null;
    // Overlap with the line's chunks: a different line drawn over this one, or a copy.
    let best = Infinity;
    for (const k of l.chunks) {
        const overlap = Math.min(k.u1, c.u1) - Math.max(k.u0, c.u0);
        if (overlap > 0.3 * small) return null;
        const gap = c.u0 >= k.u0 ? c.u0 - k.u1 : k.u0 - c.u1;
        best = Math.min(best, Math.max(0, gap));
    }
    return best <= maxGap * big ? best : null;
};

/**
 * Visual lines of a page from its glyphs (content order). Chunks drawn out of order are merged by geometry;
 * justified lines whose word gaps are all wide stay whole; column-sized gaps split lines.
 */
export const groupLines = (glyphs: Glyph[]): Glyph[][] => {
    const { limit } = spacingStats(glyphs);
    const chunks = contentChunks(glyphs, limit).filter((c) => c.glyphs.some(isInk));
    // Geometric merge: by baseline, then left to right.
    const order = chunks.slice().sort((a, b) => (sameDir(a, b) ? a.base - b.base || a.u0 - b.u0 : a.dx - b.dx || a.dy - b.dy));
    const lines: Line[] = [];
    for (const c of order) {
        let target: Line | null = null;
        let bestGap = Infinity;
        for (let k = lines.length - 1; k >= 0; k--) {
            const l = lines[k];
            if (sameDir(l, c) && c.base - l.base > 0.7 * Math.max(l.size, c.size) + 2) break;
            const gap = fits(l, c, limit);
            if (gap !== null && gap < bestGap) {
                bestGap = gap;
                target = l;
            }
        }
        if (target) addChunk(target, c);
        else lines.push(lineFrom(c));
    }
    // Justified text set by positioning: pieces of one row whose separating gap is as wide as their word gaps.
    lines.sort((a, b) => (sameDir(a, b) ? a.base - b.base || a.u0 - b.u0 : a.dx - b.dx || a.dy - b.dy));
    const merged: Line[] = [];
    for (const l of lines) {
        const prev = merged[merged.length - 1];
        if (prev && sameDir(prev, l) && prev.invisible === l.invisible && Math.abs(prev.base - l.base) <= 0.15 * Math.min(prev.size, l.size)) {
            const size = Math.max(prev.size, l.size);
            const gap = l.u0 - prev.u1;
            if (gap > 0 && gap <= 4 * size && Math.abs(prev.size - l.size) <= 0.1 * size) {
                const gaps = [
                    ...wordGaps(
                        prev.chunks.flatMap((c) => c.glyphs),
                        size,
                    ),
                    ...wordGaps(
                        l.chunks.flatMap((c) => c.glyphs),
                        size,
                    ),
                ];
                if (gaps.length >= 2) {
                    gaps.sort((a, b) => a - b);
                    const med = gaps[Math.floor(gaps.length / 2)];
                    if (med >= gap / 1.35 && med <= gap * 1.35) {
                        for (const c of l.chunks) addChunk(prev, c);
                        continue;
                    }
                }
            }
        }
        merged.push(l);
    }
    return joinWordSpacedRows(merged).flatMap((l) => splitTabs(l.chunks.flatMap((c) => c.glyphs)));
};

/**
 * Word writes a tab as a space glyph followed by a jump to the tab stop. A jump that stands out on its line (other word
 * gaps don't have it; justified lines stretch every gap alike) separates tab pieces: "a)⇥logística", "Fecha:⇥15/09".
 */
const splitTabs = (glyphs: Glyph[]): Glyph[][] => {
    const jumps: { at: number; extra: number; size: number }[] = [];
    let prevInk = -1;
    let lastWs = -1;
    glyphs.forEach((g, i) => {
        if (g.ws) {
            if (prevInk >= 0) lastWs = i;
            return;
        }
        if (!isInk(g)) return;
        if (prevInk >= 0 && lastWs > prevInk) {
            const ws = glyphs[lastWs];
            jumps.push({ at: i, extra: g.u - (ws.u + ws.adv), size: Math.max(g.size, glyphs[prevInk].size) });
        }
        prevInk = i;
    });
    if (!jumps.length) return [glyphs];
    const extras = jumps.map((j) => j.extra).sort((a, b) => a - b);
    const med = extras[Math.floor(extras.length / 2)];
    const tabs = jumps.filter((j) => j.extra > Math.max(0.3 * j.size, 2 * Math.max(0, med) + 0.1 * j.size));
    if (!tabs.length || (jumps.length > 2 && tabs.length > 0.5 * jumps.length)) return [glyphs];
    const out: Glyph[][] = [];
    let start = 0;
    for (const t of tabs) {
        out.push(glyphs.slice(start, t.at));
        start = t.at;
    }
    out.push(glyphs.slice(start));
    return out.filter((part) => part.some(isInk));
};

/**
 * Rows of single words set with wide, perfectly regular gaps (CSS word-spacing: "Tickets   anticipados   en") are one
 * line. A table row can look the same, so rows whose piece edges line up with pieces of nearby rows stay apart.
 */
const joinWordSpacedRows = (lines: Line[]): Line[] => {
    // Rows of pieces on one baseline, cut at column-sized gaps (text columns side by side share baselines).
    const rows: Line[][] = [];
    for (const l of lines) {
        const row = rows[rows.length - 1];
        const head = row?.[0];
        const last = row?.[row.length - 1];
        if (
            head &&
            last &&
            sameDir(head, l) &&
            head.invisible === l.invisible &&
            Math.abs(head.base - l.base) <= 0.15 * Math.min(head.size, l.size) &&
            Math.abs(head.size - l.size) <= 0.1 * head.size &&
            l.u0 - last.u1 <= 3 * Math.max(head.size, l.size)
        )
            row.push(l);
        else rows.push([l]);
    }
    const out: Line[] = [];
    rows.forEach((row, ri) => {
        if (row.length < 3) {
            out.push(...row);
            return;
        }
        const size = Math.max(...row.map((l) => l.size));
        const gaps = row.slice(1).map((l, i) => l.u0 - row[i].u1);
        const lo = Math.min(...gaps);
        const hi = Math.max(...gaps);
        const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        const regular = lo > 0 && hi <= 3 * size && hi - lo <= Math.max(0.06 * size, 0.08 * med);
        let tabular = false;
        if (regular) {
            // Edges shared with pieces of rows just above or below: columns of a table.
            const edges = row.slice(1).map((l) => l.u0);
            for (let rj = ri - 4; rj <= ri + 4 && !tabular; rj++) {
                const other = rows[rj];
                if (rj === ri || !other || !sameDir(other[0], row[0]) || Math.abs(other[0].base - row[0].base) > 5 * size) continue;
                let hits = 0;
                for (const o of other.slice(1)) if (edges.some((e) => Math.abs(e - o.u0) < 1.5)) hits++;
                if (hits >= 1 && other.length >= 2) tabular = true;
            }
        }
        if (!regular || tabular) {
            out.push(...row);
            return;
        }
        const first = row[0];
        for (const l of row.slice(1)) for (const c of l.chunks) addChunk(first, c);
        out.push(first);
    });
    return out;
};

// ── Runs ───────────────────────────────────────────────────────────────────────────────────────────

const PUA = (s: string) => {
    const c = s.codePointAt(0) ?? 0;
    return c >= 0xe000 && c <= 0xf8ff;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

const sameStyle = (a: TextStyle, b: TextStyle) =>
    a.fontFamily === b.fontFamily &&
    Math.abs(a.fontSize - b.fontSize) < 0.25 &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.color === b.color &&
    a.verticalAlign === b.verticalAlign &&
    (a.characterSpacing ?? 0) === (b.characterSpacing ?? 0) &&
    (a.horizontalScale ?? 100) === (b.horizontalScale ?? 100) &&
    a.link === b.link &&
    !!a.outline === !!b.outline;

const percentile = (v: number[], p: number) => {
    if (!v.length) return 0;
    const s = v.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

/** Most common size by character count (ties → larger). */
const dominantSize = (glyphs: Glyph[]) => {
    const hist = new Map<number, number>();
    for (const g of glyphs) {
        if (!isInk(g)) continue;
        const k = Math.round(g.size * 4) / 4;
        hist.set(k, (hist.get(k) ?? 0) + g.text.length);
    }
    let best = 0;
    let count = -1;
    for (const [k, n] of hist) if (n > count || (n === count && k > best)) [best, count] = [k, n];
    return best || glyphs[0].size;
};

/**
 * One line's glyphs → TextLine with runs. Returns null for lines without visible characters.
 * Superscript / subscript runs carry the size their glyphs are drawn at (the writer derives Word's nominal size).
 */
export const toTextLine = (glyphs: Glyph[]): BuiltLine | null => {
    const inks = glyphs.filter(isInk);
    if (!inks.length) return null;
    const { dx, dy, invisible } = inks[0];
    const S = dominantSize(glyphs);
    const mains = inks.filter((g) => Math.abs(g.size - S) <= 0.12 * S);
    const ref = mains.length ? mains : inks;
    // A text rise (Ts) lifts part of a line off its baseline ("superíndice" at full size): the baseline is where the
    // unraised text sits, unless (nearly) the whole line is raised.
    const riseChars = new Map<number, number>();
    let riseTotal = 0;
    for (const g of ref) {
        const k = Math.round(g.rise * 4) / 4;
        const n = Math.max(1, g.text.length);
        riseChars.set(k, (riseChars.get(k) ?? 0) + n);
        riseTotal += n;
    }
    let baseRise = 0;
    if ((riseChars.get(0) ?? 0) < 0.3 * riseTotal) {
        let most = -1;
        for (const [k, n] of riseChars) if (n > most) [baseRise, most] = [k, n];
    }
    const B =
        percentile(
            ref.map((g) => g.v + g.rise),
            0.5,
        ) - baseRise;
    const valign = (g: Glyph): TextStyle["verticalAlign"] => {
        if (g.size > 0.88 * S) return undefined;
        const off = g.v - B;
        if (off < -0.12 * S) return "superscript";
        if (off > 0.08 * S) return "subscript";
        return undefined;
    };

    // Letter-spacing: the regular extra gap between consecutive letters (Tc, or glyphs placed one by one).
    const letterGaps: number[] = [];
    for (let i = 1; i < glyphs.length; i++) {
        const a = glyphs[i - 1];
        const b = glyphs[i];
        if (!isInk(a) || !isInk(b) || valign(a) || valign(b) || Math.abs(a.size - b.size) > 0.05 * S) continue;
        letterGaps.push(b.u - (a.u + a.ink));
    }
    let tracking = 0;
    if (letterGaps.length >= 3) {
        const base = percentile(letterGaps, 0.3);
        const near = letterGaps.filter((g) => Math.abs(g - base) <= 0.03 * S + 0.15 * Math.abs(base)).length;
        if (base > 0.04 * S && base < 1.5 * S && near >= 0.6 * letterGaps.length) tracking = base;
    }
    const wordGap = tracking + 0.11 * S;

    // A symbol-font glyph with a real Unicode character is shown with a Unicode font; PUA codes need the symbol font.
    const textFamily = (() => {
        const counts = new Map<string, number>();
        for (const g of inks) if (!g.face.symbolic) counts.set(g.face.family, (counts.get(g.face.family) ?? 0) + g.text.length);
        let best = "";
        let n = -1;
        for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
        return best || "Arial";
    })();

    const styleOf = (g: Glyph): TextStyle => {
        const va = valign(g);
        const family = g.face.symbolic && !PUA(g.text) ? (/[\u2190-\u2BFF\u2700-\u27BF]/.test(g.text) ? "Segoe UI Symbol" : textFamily) : g.face.family;
        const style: TextStyle = {
            fontFamily: family,
            fontSize: r2(g.size),
            bold: g.bold,
            italic: g.face.italic || g.oblique,
            color: g.color,
        };
        if (va) style.verticalAlign = va;
        if (tracking && !va) style.characterSpacing = r2(tracking);
        // Condensed or expanded glyphs (Tz): Word's character scale, in whole percent.
        const scale = Math.round(g.hscale);
        if (Math.abs(g.hscale - 100) >= 1.5 && scale >= 10 && scale <= 600) style.horizontalScale = scale;
        if (g.link) style.link = g.link;
        if (g.outline) style.outline = true;
        if (g.face.fallback && family === g.face.family) style.fallbackFamily = g.face.fallback;
        return style;
    };

    type Acc = { text: string; style: TextStyle; u0: number; u1: number; top: number; bottom: number; base: number; rise: number; xs: number[] };
    // Character starts: a glyph's characters share its advance (ligatures, ActualText); spaces start at the ink end.
    const charStarts = (g: Glyph) => Array.from({ length: g.text.length }, (_, k) => g.u + (k * g.ink) / Math.max(1, g.text.length));
    const runs: Acc[] = [];
    let pendingSpace = false;
    let prevInk: Glyph | null = null;
    for (const g of glyphs) {
        if (g.ws) {
            if (prevInk) pendingSpace = true;
            continue;
        }
        if (!g.text) {
            // Unmapped glyph or the tail of an ActualText span: it still occupies the line.
            const last = runs[runs.length - 1];
            if (last) last.u1 = Math.max(last.u1, g.u + g.ink);
            continue;
        }
        const spaceAt = prevInk ? prevInk.u + prevInk.ink : g.u;
        if (prevInk && !pendingSpace) {
            const gap = g.u - (prevInk.u + prevInk.ink);
            // A raised footnote mark right after a word never gets a space in front of it.
            const small = valign(g) || valign(prevInk);
            if (gap > (small ? Math.max(wordGap, 0.2 * S) : wordGap)) pendingSpace = true;
        }
        const style = styleOf(g);
        const last = runs[runs.length - 1];
        // The space after a raised or lowered mark is an ordinary space: it goes with the text that follows.
        let lead = "";
        if (pendingSpace && last && !last.text.endsWith(" ")) {
            const lifted = !!last.style.verticalAlign || Math.abs(last.rise - baseRise) > 0.05 * S;
            const newRun = !sameStyle(last.style, style) || Math.abs(g.rise - last.rise) > 0.05 * S;
            if (lifted && newRun) lead = " ";
            else {
                last.text += " ";
                last.xs.push(spaceAt);
            }
        }
        pendingSpace = false;
        const top = g.v - g.face.ascent * g.size;
        const bottom = g.v + g.face.descent * g.size;
        // Text raised or lowered by another rise is its own run (the writer lifts it with its baseline).
        if (last && sameStyle(last.style, style) && Math.abs(g.rise - last.rise) <= 0.05 * S) {
            last.text += g.text;
            last.xs.push(...charStarts(g));
            last.u1 = Math.max(last.u1, g.u + g.ink);
            last.top = Math.min(last.top, top);
            last.bottom = Math.max(last.bottom, bottom);
        } else {
            const xs = lead ? [spaceAt, ...charStarts(g)] : charStarts(g);
            runs.push({ text: lead + g.text, style, u0: lead ? spaceAt : g.u, u1: g.u + g.ink, top, bottom, base: g.v, rise: g.rise, xs });
        }
        prevInk = g;
    }
    if (!runs.length) return null;
    const lastRun = runs[runs.length - 1];
    lastRun.text = lastRun.text.replace(/\s+$/, "");
    lastRun.xs.length = lastRun.text.length;
    if (!runs.some((r) => r.text.trim())) return null;
    // Synthetic small capitals (browsers draw font-variant: small-caps as lowercase text at ~70 % after a capital):
    // capitals at that size look the same in Word.
    for (let i = 1; i < runs.length; i++) {
        const a = runs[i - 1].style;
        const b = runs[i].style;
        const ratio = b.fontSize / a.fontSize;
        if (ratio < 0.6 || ratio > 0.85 || a.fontFamily !== b.fontFamily || a.color !== b.color || a.verticalAlign || b.verticalAlign) continue;
        if (/\s$/.test(runs[i - 1].text) || !/\p{Lu}$/u.test(runs[i - 1].text) || /\p{Lu}/u.test(runs[i].text) || !/\p{Ll}/u.test(runs[i].text)) continue;
        const upper = runs[i].text.toUpperCase();
        if (upper.length === runs[i].text.length) runs[i].text = upper;
    }

    const top = Math.min(...runs.map((r) => r.top));
    const bottom = Math.max(...runs.map((r) => r.bottom));
    const u0 = runs[0].u0;
    const u1 = Math.max(...runs.map((r) => r.u1));
    // Horizontal text: (u, v) is display space. Rotated text: the unrotated frame, shifted so that its centre lands on
    // the centre of the text on the page (see TextLine.rotation).
    const horizontal = dx === 1 && dy === 0;
    const [tx, ty] = horizontal ? [0, 0] : frameShift(dx, dy, (u0 + u1) / 2, (top + bottom) / 2);
    const textRuns: TextRun[] = runs.map((r) => {
        const run: TextRun = {
            text: r.text,
            style: r.style,
            box: { x: r.u0 + tx, y: r.top + ty, width: r.u1 - r.u0, height: r.bottom - r.top },
            baseline: r.base + ty,
        };
        if (horizontal && r.xs.length === r.text.length) runCharX.set(run, [...r.xs, r.u1]);
        return run;
    });
    const line: BuiltLine = {
        runs: textRuns,
        box: { x: u0 + tx, y: top + ty, width: u1 - u0, height: bottom - top },
        baseline: B + ty,
        fontSize: r2(S),
        dir: [dx, dy],
    };
    if (invisible) line.invisible = true;
    if (!horizontal) line.rotation = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 100) / 100;
    // Word-gap stretch: actual gap between words over the natural width of the spaces in it; the natural line width
    // takes the stretch out.
    const ratios: number[] = [];
    let prev: Glyph | null = null;
    let natural = 0;
    let excess = 0;
    for (const g of glyphs) {
        if (g.ws) {
            natural += g.ink > 0 ? g.ink : 0.25 * g.size;
            continue;
        }
        if (!isInk(g)) continue;
        if (prev) {
            const gap = g.u - (prev.u + prev.ink) - tracking;
            if (natural > 0) {
                ratios.push(gap / natural);
                excess += Math.max(0, gap - natural);
            } else if (gap > wordGap) {
                ratios.push(gap / (0.25 * S));
                excess += Math.max(0, gap - 0.25 * S);
            }
        }
        prev = g;
        natural = 0;
    }
    if (ratios.length >= 2) lineStretch.set(line, Math.round(percentile(ratios, 0.5) * 100) / 100);
    if (horizontal) lineNatural.set(line, Math.round((u1 - u0 - excess) * 100) / 100);
    // Tagged PDFs: the element that holds most of the line's text, or page furniture.
    let artifactChars = 0;
    let allChars = 0;
    const byId = new Map<number, { tag: StructTag; n: number }>();
    for (const g of inks) {
        const n = g.text.length;
        allChars += n;
        if (g.struct === "artifact") artifactChars += n;
        else if (g.struct) {
            const e = byId.get(g.struct.id);
            if (e) e.n += n;
            else byId.set(g.struct.id, { tag: g.struct, n });
        }
    }
    if (artifactChars > 0.5 * allChars) lineStructure.set(line, { artifact: true });
    else if (byId.size) {
        let best: { tag: StructTag; n: number } | null = null;
        for (const e of byId.values()) if (!best || e.n > best.n) best = e;
        if (best && best.n >= 0.3 * allChars) lineStructure.set(line, { tag: best.tag });
    }
    return line;
};

/** Translation from (u, v) coordinates to the unrotated frame whose centre is the display position of (uc, vc). */
export const frameShift = (dx: number, dy: number, uc: number, vc: number): [number, number] => {
    const X = dx * uc - dy * vc;
    const Y = dy * uc + dx * vc;
    return [X - uc, Y - vc];
};
