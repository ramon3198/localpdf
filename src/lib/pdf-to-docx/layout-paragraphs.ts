// Lines → paragraphs. Lines on one baseline form a row (pieces set apart by a wide gap become tab-separated parts of
// it; typed dot leaders become leader tabs). Rows join into paragraphs when they share font size, leading and an edge
// (left, first-line indent, hanging list text, centre or right) and the upper row wrapped: no room was left for the
// next row's first word at the wrap edge, a word was split with a hyphen, or a long line's sentence runs on in
// lowercase. The wrap edge is the text's own (justified, or where ragged lines gather) when narrower than the region.
// Short lines under each other at body leading stay one paragraph with line breaks (addresses). Each paragraph gets
// alignment, indents (the right one chosen so Word breaks at the same words, from the lines' natural widths), spacing,
// list marker, heading level and tab stops as Word needs them.
import { lineNatural, lineStretch, runCharX } from "./text-lines";
import { type StructTag, headingLevelOfRole, lineStructure } from "./text-structure";
import type { Paragraph, ParagraphAlignment, Rect, TextLine, TextRun, TextStyle } from "./types";

export type ParagraphContext = {
    /** Body text size of the document (headings are measured against it). */
    bodyFontSize: number;
    /** Typical baseline distance / font size of body text, for single-line paragraphs. */
    leadingRatio: number;
    /** Paragraphs of a table cell: never headings. */
    inCell?: boolean;
    /** The document's heading styles (see layout.ts documentContext); without them headings go by size alone. */
    headingStyles?: { size: number; bold: boolean; italic?: boolean; family: string; color: string; level: 1 | 2 | 3 }[];
    /**
     * The document is a tagged PDF (its text carries the author's structure, see text-structure): headings are the
     * elements tagged as headings, and text of two different paragraphs never joins.
     */
    tagged?: boolean;
};

/** Part of the line box above the baseline that Word gives a line with exact spacing L (≈ 0.8 L). */
export const ASCENT_SHARE = 0.8;

/** Left edge of the region each paragraph was measured against (indents and tab stops are relative to it). */
export const regionLeftOf = new WeakMap<Paragraph, number>();

type Marker = {
    kind: "bullet" | "number";
    marker: string;
    markerX: number;
    textX: number;
    /** Set apart from the text by a measured gap (its own piece or run); weak markers need a sibling to count. */
    strong: boolean;
};

type RowTab = { x: number; alignment: "left" | "right" | "center"; leader?: "dot" | "hyphen" | "underscore"; box?: Rect };

type Row = {
    lines: TextLine[];
    runs: TextRun[];
    /** Absolute x of each tab's target, how the text after it aligns, its leader, and the piece it moves. */
    tabs: RowTab[];
    baseline: number;
    size: number;
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    text: string;
    marker?: Marker;
    /** x where the row's text starts (after a list marker). */
    textX: number;
    firstWord: number;
    /** `firstWord` was measured on character positions (not estimated from average widths). */
    firstWordExact: boolean;
    bold: boolean;
    italic: boolean;
    family: string;
    /** Tagged PDFs: the element the row's text belongs to; `artifact`: page furniture. */
    tag?: StructTag;
    artifact?: boolean;
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (v: number[]) => {
    if (!v.length) return 0;
    const s = v.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};

/** Style that sets (nearly) all the text of the runs, or null when several share it. */
const dominantStyle = (runs: TextRun[]): TextStyle | null => {
    let total = 0;
    const acc: { style: TextStyle; n: number }[] = [];
    for (const r of runs) {
        const n = r.text.replace(/\s/g, "").length;
        total += n;
        const hit = acc.find(
            (a) =>
                a.style.fontFamily === r.style.fontFamily &&
                a.style.bold === r.style.bold &&
                a.style.color === r.style.color &&
                Math.abs(a.style.fontSize - r.style.fontSize) < 0.25,
        );
        if (hit) hit.n += n;
        else acc.push({ style: r.style, n });
    }
    const best = acc.sort((a, b) => b.n - a.n)[0];
    return best && best.n >= 0.85 * total ? best.style : null;
};

const cloneRun = (r: TextRun): TextRun => ({ text: r.text, style: { ...r.style }, box: { ...r.box }, baseline: r.baseline });

export const sameRunStyle = (a: TextStyle, b: TextStyle) =>
    a.fontFamily === b.fontFamily &&
    Math.abs(a.fontSize - b.fontSize) < 0.25 &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.color === b.color &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    a.verticalAlign === b.verticalAlign &&
    (a.characterSpacing ?? 0) === (b.characterSpacing ?? 0) &&
    (a.horizontalScale ?? 100) === (b.horizontalScale ?? 100) &&
    a.link === b.link &&
    !!a.outline === !!b.outline &&
    a.fallbackFamily === b.fallbackFamily;

/**
 * Appends `run` to `runs`, merging it into the last run when the style is the same — on one line only when it sits on
 * the same baseline (text lifted by a rise stays apart, so the writer can raise it); `newLine`: `run` starts the next
 * line of the paragraph.
 */
const pushRun = (runs: TextRun[], run: TextRun, newLine = false) => {
    const last = runs[runs.length - 1];
    const level = !!last && (newLine || !Number.isFinite(run.baseline) || Math.abs(last.baseline - run.baseline) <= Math.max(0.5, 0.05 * run.style.fontSize));
    if (last && level && sameRunStyle(last.style, run.style)) {
        last.text += run.text;
        const x0 = Math.min(last.box.x, run.box.x);
        const x1 = Math.max(last.box.x + last.box.width, run.box.x + run.box.width);
        const y0 = Math.min(last.box.y, run.box.y);
        const y1 = Math.max(last.box.y + last.box.height, run.box.y + run.box.height);
        last.box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    } else runs.push(cloneRun(run));
};

const lineSize = (l: TextLine) => l.fontSize || l.runs[0]?.style.fontSize || 10;

/**
 * Width of the first word of a row's text, measured on the source runs' character positions (after `skip` characters
 * of a list marker); falls back to the average advance per character.
 */
const firstWordOf = (runs: TextRun[], skip: number): number | null => {
    let start: number | null = null;
    for (const r of runs) {
        const xs = runCharX.get(r);
        for (let i = 0; i < r.text.length; i++) {
            if (skip > 0) {
                skip--;
                continue;
            }
            const space = /\s/.test(r.text[i]);
            if (start === null) {
                if (space) continue;
                if (!xs) return null;
                start = xs[i];
            } else if (space) return xs ? xs[i] - start : null;
        }
        if (start !== null && !xs) return null;
        if (start !== null && xs) {
            const end = xs[r.text.length];
            // The word may go on in the next run (a style change inside it).
            const next = runs[runs.indexOf(r) + 1];
            if (!next || /^\s/.test(next.text)) return end - start;
        }
    }
    return null;
};

/** Width of the first word of a set of runs (average advance per character of the run it starts in). */
const firstWordWidth = (runs: TextRun[]) => {
    let width = 0;
    for (const r of runs) {
        const t = r.text;
        const perChar = t.length ? r.box.width / t.length : 0;
        const m = /^\S*/.exec(t);
        const n = m ? m[0].length : 0;
        width += n * perChar;
        if (n < t.length) break;
    }
    return width;
};

// ── List markers ──────────────────────────────────────────────────────────────────────────────────

const BULLET_CHARS = "•◦▪▫‣⁃●○■□◆◇►▶▸▹➢➤➣➔→⇒✓✔✗✘❖❑❒⦿⦾∙·*–—-";
const NUMBER_RE = /^(\(?(\d{1,3}(?:\.\d{1,3})*|[a-zA-Z]|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})[.)]|\((\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})\))$/;

/** Marker at the start of a row: a bullet glyph or a list number followed by a gap. */
const detectMarker = (pieces: TextLine[], size: number): { marker: Marker; skipChars: number; skipPiece: boolean } | null => {
    const first = pieces[0];
    const run0 = first.runs[0];
    if (!run0) return null;
    const text = first.runs.map((r) => r.text).join("");
    const m = /^(\S+)(\s+)/.exec(text);
    const onlyToken = /^\S+$/.test(text.trim());
    const token = onlyToken ? text.trim() : m?.[1];
    if (!token) return null;
    const pua = (token.codePointAt(0) ?? 0) >= 0xe000 && (token.codePointAt(0) ?? 0) <= 0xf8ff;
    // Word's second-level bullet is "o" in Courier New; symbol fonts draw bullets with letters ("§" is a Wingdings square).
    const markFont = run0.style.fontFamily;
    const symbolFont = /^(Symbol|Wingdings|Webdings|Segoe UI Symbol)/.test(markFont);
    const textFont = (pieces[1]?.runs[0] ?? first.runs[1] ?? run0).style.fontFamily;
    const letterBullet = token.length === 1 && (symbolFont || (token === "o" && (onlyToken || markFont !== textFont)));
    const isBullet = token.length === 1 && (BULLET_CHARS.includes(token) || pua || letterBullet);
    const isNumber = !isBullet && NUMBER_RE.test(token);
    if (!isBullet && !isNumber) return null;
    // Where the text after the marker starts, and how wide the gap is.
    let textX: number;
    let measured = false;
    let gap = 0;
    let skipPiece = false;
    if (onlyToken) {
        const next = pieces[1];
        if (!next) return null;
        textX = next.box.x;
        gap = next.box.x - (first.box.x + first.box.width);
        skipPiece = true;
        measured = true;
    } else {
        // The marker is its own run (a symbol font) or shares the run: estimate from the run's boxes.
        const markerRun = run0.text.trim() === token ? run0 : null;
        if (markerRun && first.runs[1]) {
            textX = first.runs[1].box.x;
            gap = textX - (markerRun.box.x + markerRun.box.width);
            measured = true;
        } else {
            const perChar = run0.text.length ? run0.box.width / run0.text.length : 0.5 * size;
            textX = run0.box.x + (token.length + (m?.[2].length ?? 1)) * perChar;
        }
    }
    // Bullet glyphs need any gap; dashes, asterisks and numbers a clear one (not "A. García", "-5 %"). A marker
    // inside the text run can't be measured: it only counts when other rows carry the same kind of marker.
    const realBullet = isBullet && !"*–—-·o".includes(token) && !(letterBullet && !symbolFont);
    if (measured && !realBullet && gap < 0.45 * size) return null;
    if (measured && isNumber && /^[a-zA-Z][.)]$/.test(token) && gap < 0.6 * size) return null;
    if (letterBullet && !measured) return null;
    const kind = isBullet ? "bullet" : "number";
    const shown = pua
        ? "•"
        : symbolFont && token === "§"
          ? "▪"
          : symbolFont && token === "Ø"
            ? "➢"
            : symbolFont && token === "ü"
              ? "✓"
              : symbolFont && token === "v"
                ? "❖"
                : token;
    return {
        marker: { kind, marker: shown, markerX: first.box.x, textX, strong: measured || realBullet },
        skipChars: onlyToken ? 0 : token.length + (m?.[2].length ?? 0),
        skipPiece,
    };
};

/** Marker family for sibling checks: bullet char, or number style (decimal / letter / roman) and delimiter. */
const markerFamily = (m: Marker) => {
    if (m.kind === "bullet") return `b:${m.marker}`;
    const t = m.marker;
    const delim = t.endsWith(")") ? (t.startsWith("(") ? "()" : ")") : ".";
    const core = t.replace(/[().]/g, "");
    const style = /^\d/.test(core) ? "d" : /^[ivxlcdm]+$/.test(core) ? "r" : /^[IVXLCDM]+$/.test(core) ? "R" : /^[a-z]$/.test(core) ? "a" : "A";
    return `n:${style}${delim}`;
};

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

/** Lines on the same baseline, left to right. */
const groupRows = (lines: TextLine[]): TextLine[][] => {
    const sorted = lines.slice().sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
    const rows: TextLine[][] = [];
    for (const l of sorted) {
        const row = rows[rows.length - 1];
        if (row) {
            const ref = row[0];
            const tol = 0.3 * Math.min(lineSize(ref), lineSize(l));
            const overlapsX = row.some((o) => Math.min(o.box.x + o.box.width, l.box.x + l.box.width) - Math.max(o.box.x, l.box.x) > 1);
            if (Math.abs(l.baseline - ref.baseline) <= tol && !overlapsX) {
                row.push(l);
                continue;
            }
        }
        rows.push([l]);
    }
    for (const r of rows) r.sort((a, b) => a.box.x - b.box.x);
    return rows;
};

const buildRow = (pieces: TextLine[], region: Rect, allowMarker = true): Row => {
    const counts = new Map<number, number>();
    for (const l of pieces) for (const r of l.runs) counts.set(r.style.fontSize, (counts.get(r.style.fontSize) ?? 0) + r.text.length);
    let size = lineSize(pieces[0]);
    let best = -1;
    for (const l of pieces) {
        const n = counts.get(l.fontSize) ?? 0;
        if (n > best) [size, best] = [l.fontSize, n];
    }
    const found = allowMarker ? detectMarker(pieces, size) : null;
    const runs: TextRun[] = [];
    const tabs: Row["tabs"] = [];
    const regionRight = region.x + region.width;
    pieces.forEach((l, i) => {
        if (found?.skipPiece && i === 0) return;
        let lr = l.runs.map(cloneRun);
        if (found && i === 0 && found.skipChars) {
            let skip = found.skipChars;
            while (skip > 0 && lr.length) {
                const r = lr[0];
                if (r.text.length <= skip) {
                    skip -= r.text.length;
                    lr.shift();
                } else {
                    r.text = r.text.slice(skip);
                    skip = 0;
                }
            }
        }
        const prevPiece = i > 0 && !(found?.skipPiece && i === 1) ? pieces[i - 1] : null;
        if (prevPiece && runs.length) {
            const gap = l.box.x - (prevPiece.box.x + prevPiece.box.width);
            const last = runs[runs.length - 1];
            // Pieces a word gap apart are words of one phrase; wider gaps were tabs.
            if (gap <= 1.2 * size) {
                if (!/\s$/.test(last.text)) last.text += " ";
            } else {
                last.text = last.text.replace(/\s+$/, "") + "\t";
                const isLast = i === pieces.length - 1;
                const right = l.box.x + l.box.width;
                tabs.push(
                    isLast && Math.abs(right - regionRight) <= Math.max(3, 0.3 * size)
                        ? { x: right, alignment: "right", box: l.box }
                        : { x: l.box.x, alignment: "left", box: l.box },
                );
            }
        }
        for (const r of lr) pushRun(runs, r);
    });
    const kept = found?.skipPiece ? pieces.slice(1) : pieces;
    const x0 = pieces[0].box.x;
    const x1 = Math.max(...pieces.map((l) => l.box.x + l.box.width));
    // Leaders typed as characters ("Introducción ......... 3", "Nombre ________"): a right tab with that leader at the
    // end of the line, so Word draws the leader whatever the text's width.
    for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        const m = /\s*(?:[.·…]{5,}|(?:\. ){5,}\.?|_{5,}|-{6,})\s*/.exec(r.text);
        if (!m || (k === 0 && m.index === 0)) continue;
        const tail =
            r.text.slice(m.index + m[0].length) +
            runs
                .slice(k + 1)
                .map((o) => o.text)
                .join("");
        if (!tail.trim() || tail.length > 30 || tail.includes("\t")) continue;
        r.text = r.text.slice(0, m.index) + "\t" + r.text.slice(m.index + m[0].length);
        tabs.push({ x: x1, alignment: "right", leader: /_/.test(m[0]) ? "underscore" : /-/.test(m[0]) ? "hyphen" : "dot" });
        break;
    }
    const text = runs.map((r) => r.text).join("");
    const exactFirstWord = firstWordOf(found?.skipPiece ? pieces.slice(1).flatMap((l) => l.runs) : pieces.flatMap((l) => l.runs), found?.skipChars ?? 0);
    const inkChars = (pred: (s: TextStyle) => boolean) => runs.reduce((n, r) => n + (pred(r.style) ? r.text.replace(/\s/g, "").length : 0), 0);
    const total = Math.max(
        1,
        inkChars(() => true),
    );
    const fam = new Map<string, number>();
    for (const r of runs) fam.set(r.style.fontFamily, (fam.get(r.style.fontFamily) ?? 0) + r.text.length);
    const structure = pieces.map((l) => lineStructure.get(l));
    const tag = structure.find((s) => s?.tag)?.tag;
    const artifact = structure.length > 0 && structure.every((s) => s?.artifact);
    return {
        ...(tag ? { tag } : {}),
        ...(artifact ? { artifact } : {}),
        lines: pieces,
        runs,
        tabs,
        baseline: median(pieces.map((l) => l.baseline)),
        size,
        x0,
        x1,
        top: Math.min(...pieces.map((l) => l.box.y)),
        bottom: Math.max(...pieces.map((l) => l.box.y + l.box.height)),
        text,
        marker: found?.marker,
        textX: found ? found.marker.textX : (kept[0]?.box.x ?? x0),
        firstWord: exactFirstWord ?? firstWordWidth(runs),
        firstWordExact: exactFirstWord !== null,
        bold: inkChars((s) => s.bold) > 0.6 * total,
        italic: inkChars((s) => s.italic) > 0.6 * total,
        family: [...fam].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    };
};

// ── Paragraph grouping ────────────────────────────────────────────────────────────────────────────

type Group = { rows: Row[]; breaks: boolean };

const TERMINAL = /[.!?:;…»"”)]$/;

/**
 * Paragraphs (with alignment, indents, spacing, lists, headings) for the given lines inside `region`, top to bottom.
 * Rotated lines are laid out in their own frame (see TextLine.rotation).
 */
export const paragraphsOf = (lines: TextLine[], region: Rect, ctx: ParagraphContext): Paragraph[] => {
    const flat = lines.filter((l) => !l.rotation && l.runs.some((r) => r.text.trim()));
    const out = flat.length ? horizontalParagraphs(flat, region, ctx) : [];
    const rotated = lines.filter((l) => l.rotation && l.runs.some((r) => r.text.trim()));
    if (rotated.length) out.push(...rotatedParagraphs(rotated, ctx));
    return out;
};

const horizontalParagraphs = (lines: TextLine[], region: Rect, ctx: ParagraphContext): Paragraph[] => {
    const grouped = groupRows(lines);
    const rows = grouped.map((pieces) => buildRow(pieces, region));
    if (!rows.length) return [];
    // A marker that couldn't be measured ("V. EXENTAS", "- 5 %", a typed "1. Introducción") is text unless rows
    // marked the same way exist and the item wraps with a hanging indent (its next row starts under its text).
    rows.forEach((r, i) => {
        const m = r.marker;
        if (!m || m.strong) return;
        const fam = markerFamily(m);
        const sibling = rows.some((o, k) => k !== i && o.marker && markerFamily(o.marker) === fam && Math.abs(o.marker.markerX - m.markerX) <= 2);
        const next = rows[i + 1];
        const hanging = !!next && !next.marker && next.x0 > m.markerX + 0.5 * r.size && Math.abs(next.x0 - m.textX) <= 0.6 * r.size;
        if (!sibling || !hanging) rows[i] = buildRow(grouped[i], region, false);
    });
    // Tab columns: pieces after tabs that share their centre (or right edge) but not their left edge across rows were
    // set with a centre (right) tab.
    const tabbed = rows.flatMap((r) => r.tabs.filter((t) => t.box && t.alignment === "left"));
    for (const t of tabbed) {
        const b = t.box!;
        const centre = b.x + b.width / 2;
        const group = tabbed.filter((o) => Math.abs(o.box!.x + o.box!.width / 2 - centre) <= 1);
        if (group.length >= 2 && group.some((o) => Math.abs(o.box!.x - b.x) > 2)) {
            for (const o of group) [o.alignment, o.x] = ["center", centre];
            continue;
        }
        const edge = b.x + b.width;
        const rightGroup = tabbed.filter((o) => Math.abs(o.box!.x + o.box!.width - edge) <= 1);
        if (rightGroup.length >= 2 && rightGroup.some((o) => Math.abs(o.box!.x - b.x) > 2)) for (const o of rightGroup) [o.alignment, o.x] = ["right", edge];
    }
    // The column's text edges: region bounds, widened to the text actually there.
    const left = Math.min(region.x, ...rows.map((r) => r.x0));
    const textRight = Math.max(...rows.map((r) => r.x1));
    const right = Math.max(region.x + region.width, textRight);
    // Where lines wrap: the text's own right edge when rows gather there (justified or ragged text narrower than the
    // region), else the region's edge (short lines: addresses, verses).
    const wrapRight = wrapEdge(rows, left, right);
    // Typical leading between consecutive rows of the same size — measured only where the upper row certainly wraps
    // into the lower one (a sentence running on, a hyphenated word, a justified edge): paragraph gaps would otherwise
    // pass for leading.
    // A justified edge: several rows end exactly at the wrap edge (one long line proves nothing).
    const justifiedEdge = rows.filter((r) => Math.abs(r.x1 - wrapRight) <= 1.2).length >= 2;
    const leadingOf = (fullOnly: boolean) => {
        const gaps = new Map<number, number>();
        for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1];
            const b = rows[i];
            if (Math.abs(a.size - b.size) > 0.05 * a.size) continue;
            if (fullOnly && !(wrapCue(a.text, b.text) || (justifiedEdge && Math.abs(a.x1 - wrapRight) <= 1.2 && Math.abs(a.x0 - b.x0) <= 2))) continue;
            const g = Math.round(((b.baseline - a.baseline) / a.size) * 50) / 50;
            if (g > 0.8 && g < 2.5) gaps.set(g, (gaps.get(g) ?? 0) + 1);
        }
        let best = 0;
        let count = 0;
        for (const [g, n] of gaps) if (n > count || (n === count && g < best)) [best, count] = [g, n];
        return count ? best : 0;
    };
    const measured = leadingOf(true);
    const usualLeading = measured || ctx.leadingRatio;

    // Text of one style may wrap narrower than the region (a description column beside prices): its own edge counts
    // when some of its near-edge rows run on into a row of the same style right below.
    const styleKey = (r: Row) => `${r.family}|${Math.round(r.size * 2)}|${r.italic}|${r.bold}`;
    const byStyle = new Map<string, Row[]>();
    for (const r of rows) {
        const list = byStyle.get(styleKey(r));
        if (list) list.push(r);
        else byStyle.set(styleKey(r), [r]);
    }
    const wrapOf = new Map<Row, number>();
    for (const list of byStyle.values()) {
        if (list.length < 3) continue;
        const edge = wrapEdge(list, left, wrapRight);
        if (edge >= wrapRight - 0.5) continue;
        const evidence = rows.some((r, i) => {
            const next = rows[i + 1];
            if (!next || !list.includes(r) || styleKey(next) !== styleKey(r) || r.x1 < edge - 0.12 * (edge - left)) return false;
            const g = (next.baseline - r.baseline) / r.size;
            return g > 0.9 && g < 1.7 && Math.abs(next.x0 - r.x0) <= 2 && edge - r.x1 < next.firstWord + 0.28 * r.size;
        });
        if (evidence) for (const r of list) wrapOf.set(r, edge);
    }

    const grouping: Grouping = { tagged: !!ctx.tagged, stack: stacksOf(rows, left, wrapRight) };
    const groups: Group[] = [];
    let cur: Row[] = [];
    let curBreaks = false;
    for (const row of rows) {
        if (cur.length) {
            const verdict = continues(cur, row, left, wrapOf.get(cur[cur.length - 1]) ?? wrapRight, usualLeading, curBreaks, grouping);
            if (verdict === "wrap" && !curBreaks) {
                cur.push(row);
                continue;
            }
            if (verdict === "break-line" && (curBreaks || cur.length === 1)) {
                cur.push(row);
                curBreaks = true;
                continue;
            }
            groups.push({ rows: cur, breaks: curBreaks && cur.length > 1 });
        }
        cur = [row];
        curBreaks = false;
    }
    if (cur.length) groups.push({ rows: cur, breaks: curBreaks && cur.length > 1 });

    // Page-level vote: when most longer paragraphs are justified, two-line paragraphs with a full first line are too.
    const edgeOf = (g: Group) => wrapOf.get(g.rows[0]) ?? wrapRight;
    const justifiedVotes = groups.filter((g) => g.rows.length >= 3 && isJustified(g.rows, edgeOf(g))).length;
    const longGroups = groups.filter((g) => g.rows.length >= 3).length;
    const preferJustify = longGroups > 0 && justifiedVotes >= 0.5 * longGroups;

    // List levels from marker positions.
    const markerXs = [...new Set(groups.filter((g) => g.rows[0].marker).map((g) => Math.round(g.rows[0].marker!.markerX)))].sort((a, b) => a - b);
    const levelOf = (x: number) => {
        let level = 0;
        for (let i = 0; i < markerXs.length; i++) if (x >= markerXs[i] - 2) level = i;
        return Math.min(level, 8);
    };

    const paragraphs: Paragraph[] = [];
    let prevBaseline: number | null = null;
    for (const g of groups) {
        const stack = grouping.stack.get(g.rows[0]);
        const flushRight = stack !== undefined && g.rows.every((r) => grouping.stack.get(r) === stack);
        const p = toParagraph(g, { left, right, wrapRight: edgeOf(g), region, flushRight }, ctx, preferJustify, usualLeading);
        if (g.rows[0].marker) p.list = { kind: g.rows[0].marker.kind, marker: g.rows[0].marker.marker, level: levelOf(g.rows[0].marker.markerX) };
        // Gap above: from the previous paragraph's last baseline (or the region top) to this first line's box.
        const first = g.rows[0];
        const above = prevBaseline === null ? first.baseline - region.y - ASCENT_SHARE * p.lineSpacing : first.baseline - prevBaseline - p.lineSpacing;
        p.spaceBefore = r2(Math.max(0, above));
        prevBaseline = g.rows[g.rows.length - 1].baseline;
        paragraphs.push(p);
    }
    // The region ends inside a justified paragraph (it goes on in the next page or column): its last line is full and
    // stretched like the others. Page furniture below the running text (a page number, a line set far below) is not
    // where the text ends.
    for (let k = groups.length - 1; k >= 0; k--) {
        const g = groups[k];
        const p = paragraphs[k];
        const first = g.rows[0];
        const above = groups[k - 1];
        const gapAbove = above ? first.baseline - above.rows[above.rows.length - 1].baseline : 0;
        const furniture =
            g.rows.length === 1 && (PAGE_NUMBER.test(first.text.trim()) || (!!above && gapAbove > 2.5 * Math.max(first.size, above.rows[0].size)));
        if (furniture && k > 0) continue;
        const lastRow = g.rows[g.rows.length - 1];
        const full = Math.abs(lastRow.x1 - edgeOf(g)) <= 1.5;
        const justified = p.alignment === "justify" || (g.rows.length === 1 && stretched(lastRow));
        if (!g.breaks && !first.tabs.length && !first.marker && full && justified && !TERMINAL.test(lastRow.text.trim())) {
            p.alignment = "justify";
            p.justifyLastLine = true;
        }
        break;
    }
    return paragraphs;
};

/** "3", "- 3 -", "Página 3", "Page 3 of 10", "3 / 10": a page number. */
const PAGE_NUMBER = /^[-–—\s]*((p(á|a)g(ina)?|page|p\.|hoja|seite)\.?\s*)?\d{1,4}(\s*(de|of|\/|von)\s*\d{1,4})?[-–—\s]*$/i;

/**
 * The upper line certainly runs on into the lower one: it ends mid-sentence and the next starts in lowercase, or a
 * word is split with a hyphen.
 */
export const wrapCue = (upper: string, lower: string) => {
    const a = upper.trimEnd();
    const b = lower.trimStart();
    if (/\p{L}[-\u00AD\u2010]$/u.test(a) && /^\p{Ll}/u.test(b)) return true;
    return /^\p{Ll}/u.test(b) && !/[.!?:;…]["»”')\]]?$/.test(a);
};

/** Right edge wrapped lines reach. */
const wrapEdge = (rows: Row[], left: number, regionRight: number) => {
    const rights = rows.map((r) => r.x1).sort((a, b) => b - a);
    // The largest right edge, unless a single row pokes out far beyond an edge that several other rows share.
    const top = rights.length >= 3 && rights[0] - rights[1] > 20 && rights[1] - rights[2] <= 3 ? rights[1] : rights[0];
    if (regionRight - top <= Math.max(6, 0.03 * (regionRight - left))) return Math.max(top, regionRight);
    // Text narrower than the region wraps at its own edge when that edge is justified (several rows end exactly
    // there) or when rows near it run on into the next row (a ragged column).
    const width = top - left;
    const justified = rights.filter((x) => Math.abs(x - top) <= 1.2).length >= 2;
    const ragged = rows.some((r, i) => {
        const next = rows[i + 1];
        return !!next && r.x1 >= top - 0.12 * width && Math.abs(next.x0 - r.x0) <= 2 && wrapCue(r.text, next.text);
    });
    return justified || ragged ? top : Math.max(top, regionRight);
};

type Verdict = "wrap" | "break-line" | "break";

type Grouping = {
    /** The document is tagged: rows of two different block elements never join. */
    tagged: boolean;
    /** Right-aligned stack a row belongs to (see stacksOf). */
    stack: Map<Row, number>;
};

/** Rows of two different elements of a tagged PDF (paragraphs, headings, cells), or page furniture and text. */
const tagsApart = (a: Row, b: Row) => (!!a.tag?.block && !!b.tag?.block && a.tag.id !== b.tag.id) || !!a.artifact !== !!b.artifact;

/**
 * Right-aligned stacks: rows one under the other that end on one edge while their left edges vary, well clear of the
 * column's left edge, none wrapped into the next (its first word would have fitted in front of it): lines set flush
 * right one by one (a sender's address, a vendor block, a date, a signature).
 */
const stacksOf = (rows: Row[], left: number, right: number): Map<Row, number> => {
    const out = new Map<Row, number>();
    const width = Math.max(1, right - left);
    const pair = (a: Row, b: Row) => {
        const size = Math.max(a.size, b.size);
        if (a.marker || b.marker || a.tabs.length || b.tabs.length) return false;
        if (Math.abs(a.x1 - b.x1) > Math.max(1.5, 0.12 * size)) return false;
        const gap = b.baseline - a.baseline;
        if (gap < 0.7 * size || gap > 2.2 * size) return false;
        const clear = Math.max(3 * size, 0.15 * width);
        if (a.x0 - left < clear || b.x0 - left < clear) return false;
        return a.x0 - left > b.firstWord + 0.28 * a.size + Math.max(2, 0.35 * size);
    };
    let id = 0;
    for (let i = 0; i < rows.length; ) {
        let j = i;
        while (j + 1 < rows.length && pair(rows[j], rows[j + 1])) j++;
        const part = rows.slice(i, j + 1);
        const x0s = part.map((r) => r.x0);
        const size = Math.max(...part.map((r) => r.size));
        if (part.length >= 2 && Math.max(...x0s) - Math.min(...x0s) > Math.max(4, 0.6 * size) && part.every((r) => r.x1 - r.x0 <= 0.7 * width)) {
            id++;
            for (const r of part) out.set(r, id);
        }
        i = j + 1;
    }
    return out;
};

/** Does `row` continue the paragraph made of `cur`? "wrap": the previous row wrapped into it; "break-line": a block
 *  of short lines kept together (addresses); "break": a new paragraph. */
const continues = (cur: Row[], row: Row, left: number, wrapRight: number, usualLeading: number, inBreakBlock: boolean, grouping: Grouping): Verdict => {
    const last = cur[cur.length - 1];
    const size = Math.max(last.size, row.size);
    if (grouping.tagged && tagsApart(last, row)) return "break";
    if (row.marker) return "break";
    // A size change ends the paragraph, unless the sentence visibly runs on (a bigger word inside a paragraph).
    const runsOn = wrapCue(last.text, row.text);
    if (Math.abs(row.size - last.size) > 0.1 * size && !runsOn) return "break";
    const gap = row.baseline - last.baseline;
    if (gap < 0.7 * size) return "break";
    if (cur.length >= 2) {
        const lead = last.baseline - cur[cur.length - 2].baseline;
        if (Math.abs(gap - lead) > Math.max(1.2, 0.12 * size)) return "break";
    } else {
        // A single row: accept the usual leading of the region or normal spacing; 1.5-line and double spacing only when
        // the sentence visibly runs on.
        const ratio = gap / size;
        const usual = Math.abs(ratio - usualLeading) <= 0.12;
        if (!usual && ratio > 1.6 && !(runsOn && ratio <= 2.6)) return "break";
    }
    // Tab-separated rows are their own paragraphs, except a hanging layout ("Term⇥definition" whose next rows start
    // at the tab position).
    if (row.tabs.length) return "break";
    const tol = Math.max(1.5, 0.15 * size);
    const tabHang = last.tabs.length === 1 && cur.length === 1 && Math.abs(row.x0 - last.tabs[0].x) <= tol;
    if (last.tabs.length && !tabHang) return "break";
    if (cur.some((r) => r.tabs.length) && !tabHang && cur.length > 1 && Math.abs(row.x0 - cur[1].x0) > tol) return "break";

    // Lines set flush right one by one keep their lines (one paragraph while they share their style).
    const stack = grouping.stack.get(last);
    if (stack !== undefined && stack === grouping.stack.get(row))
        return last.bold === row.bold && last.italic === row.italic && Math.abs(last.size - row.size) < 0.05 * size ? "break-line" : "break";

    // Horizontal fit with the paragraph so far.
    const first = cur[0];
    const bodyLeft = cur.length >= 2 ? cur[1].x0 : null;
    const sameLeft = bodyLeft !== null ? Math.abs(row.x0 - bodyLeft) <= tol : Math.abs(row.x0 - last.x0) <= tol;
    const indentedFirst = cur.length === 1 && last.x0 - row.x0 >= 0.3 * size && last.x0 - row.x0 <= 8 * size;
    const hanging = (cur.length === 1 && first.marker && Math.abs(row.x0 - first.textX) <= tol) || tabHang;
    const listBody = cur.length >= 2 && first.marker && Math.abs(row.x0 - first.textX) <= tol;
    const centred = Math.abs((row.x0 + row.x1) / 2 - (last.x0 + last.x1) / 2) <= Math.max(2, 0.2 * size) && !sameLeft;
    const rightAligned = Math.abs(row.x1 - last.x1) <= Math.max(1.5, 0.15 * size) && !sameLeft;
    if (!(sameLeft || indentedFirst || hanging || listBody || centred || rightAligned)) return "break";
    if (cur.length >= 2 && !listBody && !sameLeft && !centred && !rightAligned && !tabHang) return "break";

    // Style: a bold (or differently set) lead line followed by plain text starts a new paragraph when it ended early.
    const space = 0.28 * last.size;
    let room: number;
    // Left-edge evidence first: justified lines also share their right edge.
    if (sameLeft || indentedFirst || hanging || listBody || tabHang) room = wrapRight - last.x1;
    else if (centred) room = wrapRight - left - (last.x1 - last.x0);
    else room = last.x0 - left;
    // The geometric test (no room for the next row's first word) misses text set narrower than the region; a word
    // split with a hyphen, or a long line whose sentence runs on in lowercase, wrapped all the same.
    const hyphenated = /\p{L}[-\u00AD\u2010]$/u.test(last.text.trimEnd()) && /^\p{Ll}/u.test(row.text.trimStart());
    const longLine = last.x1 - last.x0 >= 0.55 * (wrapRight - left);
    const slack = row.firstWordExact ? Math.max(1, 0.12 * size) : Math.max(2, 0.35 * size);
    const wrapped = room < row.firstWord + space + slack || hyphenated || (runsOn && longLine);
    if (wrapped && !inBreakBlock) {
        if (last.bold !== row.bold && cur.every((r) => r.bold) && TERMINAL.test(last.text.trim())) return "break";
        return "wrap";
    }
    // Short lines one under the other with body leading, same edge: an address or a list without markers.
    const tight = gap / size <= Math.max(1.35, usualLeading + 0.1);
    const sameEdge = sameLeft || rightAligned || centred;
    const lastShort = !wrapped;
    const rowShort = wrapRight - row.x1 > 0.12 * (wrapRight - left) || row.x1 - row.x0 < 0.6 * (wrapRight - left);
    if (tight && sameEdge && lastShort && rowShort && !indentedFirst && last.bold === row.bold && Math.abs(last.size - row.size) < 0.05 * size)
        return "break-line";
    return "break";
};

/** Width of the row's text with natural word spaces. */
const rowNatural = (r: Row) => (r.lines.length === 1 ? (lineNatural.get(r.lines[0]) ?? r.x1 - r.x0) : r.x1 - r.x0);

/** The row's word gaps are visibly wider than natural spaces (a justified line). */
const stretched = (r: Row) => r.lines.length === 1 && (lineStretch.get(r.lines[0]) ?? 1) >= 1.15;

const isJustified = (rows: Row[], wrapRight: number) => {
    if (rows.length < 2) return false;
    const body = rows.slice(0, -1);
    const tol = Math.max(1.2, 0.08 * rows[0].size);
    const rights = body.map((r) => r.x1);
    const maxR = Math.max(...rights);
    return body.every((r) => Math.abs(r.x1 - maxR) <= tol) && Math.abs(maxR - wrapRight) <= Math.max(3, 0.4 * rows[0].size);
};

/** `flushRight`: the rows are a right-aligned stack (see stacksOf). */
type Frame = { left: number; right: number; wrapRight: number; region: Rect; flushRight?: boolean };

const toParagraph = (g: Group, f: Frame, ctx: ParagraphContext, preferJustify: boolean, usualLeading: number): Paragraph => {
    const rows = g.rows;
    const first = rows[0];
    const size = median(rows.map((r) => r.size));
    const regionLeft = f.region.x;
    const regionRight = f.region.x + f.region.width;
    const tol = Math.max(1.5, 0.15 * size);

    // Alignment.
    let alignment: ParagraphAlignment = "left";
    const lefts = rows.map((r, i) => (i === 0 ? r.textX : r.x0));
    const bodyLefts = rows.length >= 2 ? lefts.slice(1) : lefts;
    const centres = rows.map((r) => (r.x0 + r.x1) / 2);
    const rightsAll = rows.map((r) => r.x1);
    if (rows.length >= 2) {
        // Left edge shared by the rows after the first; the first may be indented (or hang, for list items).
        const bodyAligned = bodyLefts.every((x) => Math.abs(x - bodyLefts[0]) <= tol);
        const firstOffset = lefts[0] - bodyLefts[0];
        // (A first-line indent is plausible from three rows on; a hanging first line, like "Artículo 1." before indented
        // lines, at any length.)
        const plausibleIndent =
            !!first.marker ||
            first.tabs.length > 0 ||
            (firstOffset > tol && firstOffset <= 8 * size && rows.length >= 3) ||
            (firstOffset < -tol && -firstOffset <= 12 * size);
        const leftAligned = bodyAligned && (Math.abs(firstOffset) <= tol || plausibleIndent);
        const centredRows = centres.every((c) => Math.abs(c - centres[0]) <= Math.max(2, 0.2 * size));
        const rightRows = rightsAll.every((x) => Math.abs(x - rightsAll[0]) <= tol);
        const leftsVary = !lefts.every((x) => Math.abs(x - lefts[0]) <= tol);
        // Every row, the last too, ends on one edge while the lefts vary: right-aligned (an indented, justified paragraph
        // only ends its last row there when the page cuts it).
        if (rightRows && leftsVary && !(leftAligned && Math.abs(firstOffset) > tol && rows.length >= 3)) alignment = "right";
        else if (!g.breaks && leftAligned && isJustified(rows, f.wrapRight) && (rows.length >= 3 || preferJustify || stretched(rows[0]))) alignment = "justify";
        else if (leftAligned && !(leftsVary && centredRows && !first.marker && !first.tabs.length)) alignment = "left";
        else if (centredRows && leftsVary) alignment = "center";
        else if (rightRows && leftsVary) alignment = "right";
        // Two-line paragraphs with a full first line on a page of justified text.
        if (alignment === "justify" && rows.length === 2 && !preferJustify && !stretched(rows[0])) alignment = "left";
    } else {
        const c = (first.x0 + first.x1) / 2;
        const width = regionRight - regionLeft;
        const mid = (regionLeft + regionRight) / 2;
        if (!first.marker && !first.tabs.length && Math.abs(c - mid) <= Math.max(2, 0.015 * width) && first.x0 - regionLeft > 0.04 * width)
            alignment = "center";
        // Flush with the right edge and clear of the left one: right-aligned (a left-indented line ending exactly at the
        // margin is rare).
        else if (!first.marker && !first.tabs.length && Math.abs(first.x1 - regionRight) <= 1.5 && first.x0 - regionLeft > Math.max(0.08 * width, 3 * size))
            alignment = "right";
    }
    // Lines set flush right one by one (a stack of them, see stacksOf) are right-aligned wherever their edge is.
    if (f.flushRight && !first.marker && !first.tabs.length) alignment = "right";

    // Indents.
    let indentLeft = 0;
    let indentRight = 0;
    let firstLineIndent = 0;
    const bodyLeft = rows.length >= 2 ? median(bodyLefts) : first.marker ? first.textX : first.x0;
    if (alignment === "left" || alignment === "justify") {
        indentLeft = Math.max(0, bodyLeft - regionLeft);
        if (first.marker) firstLineIndent = first.marker.markerX - bodyLeft;
        else if (first.tabs.length === 1 && rows.length >= 2 && Math.abs(bodyLeft - first.tabs[0].x) <= tol) firstLineIndent = first.x0 - bodyLeft;
        else firstLineIndent = first.x0 - bodyLeft;
        if (Math.abs(firstLineIndent) < 1) firstLineIndent = 0;
        // Right indent: Word must break where the PDF did. Each wrapped line fits the width with natural spaces and the
        // next row's first word does not: the width lies in [lo, hi]. Justified lines are measured without their
        // stretch (a loosely justified column would otherwise take more words per line in Word).
        if (alignment === "justify") indentRight = Math.max(0, regionRight - Math.max(...rows.slice(0, -1).map((r) => r.x1)));
        if (rows.length >= 2) {
            let lo = 0;
            let hi = Infinity;
            for (let i = 0; i + 1 < rows.length; i++) {
                const end = rows[i].x0 + rowNatural(rows[i]);
                lo = Math.max(lo, end);
                hi = Math.min(hi, end + 0.28 * rows[i].size + rows[i + 1].firstWord);
            }
            const edge = regionRight - indentRight;
            if (hi > lo && (edge < lo - 0.5 || edge > hi + 0.5)) {
                const target = hi === Infinity ? lo : Math.max(lo + 1, Math.min((lo + hi) / 2, hi - 1));
                indentRight = Math.max(0, regionRight - target);
            }
        }
    } else if (alignment === "center") {
        // Centred between the indents: they shift the centre where the text's is, and (for wrapped text) narrow the
        // width to one where Word breaks at the same words.
        const c = median(centres);
        const regionWidth = regionRight - regionLeft;
        let width = regionWidth;
        if (rows.length >= 2 && !g.breaks) {
            let lo = 0;
            let hi = Infinity;
            for (let i = 0; i + 1 < rows.length; i++) {
                lo = Math.max(lo, rowNatural(rows[i]));
                hi = Math.min(hi, rowNatural(rows[i]) + 0.28 * rows[i].size + rows[i + 1].firstWord);
            }
            if (hi > lo && (width < lo - 0.5 || width > hi + 0.5)) width = Math.max(lo + 1, Math.min((lo + hi) / 2, hi - 1));
        }
        width = Math.min(width, 2 * Math.min(c - regionLeft, regionRight - c));
        // Never narrower than the text itself (that would wrap a line the PDF kept whole).
        width = Math.max(width, Math.max(...rows.map((r) => r.x1 - r.x0)) + 2);
        indentLeft = Math.max(0, c - width / 2 - regionLeft);
        indentRight = Math.max(0, regionRight - (c + width / 2));
    } else if (alignment === "right") {
        indentRight = Math.max(0, regionRight - Math.max(...rightsAll));
    }

    // Line spacing: the baseline distance, or the body leading for single lines.
    const baselineGaps = rows.slice(1).map((r, i) => r.baseline - rows[i].baseline);
    const lineSpacing = baselineGaps.length ? median(baselineGaps) : size * (Math.abs(usualLeading - ctx.leadingRatio) < 0.3 ? usualLeading : ctx.leadingRatio);

    // Runs: rows joined by a space, by nothing after a word split with a hyphen, or by a line break.
    const runs: TextRun[] = [];
    rows.forEach((r, i) => {
        const rr = r.runs.map(cloneRun);
        if (i > 0 && runs.length && rr.length) {
            const last = runs[runs.length - 1];
            if (g.breaks) last.text = last.text.replace(/[ \t]+$/, "") + "\n";
            else {
                const prevText = last.text;
                const nextText = rr[0].text;
                if (/\p{L}[-\u00AD\u2010]$/u.test(prevText) && /^\p{Ll}/u.test(nextText)) last.text = prevText.slice(0, -1);
                else if (/\u00AD$/.test(prevText)) last.text = prevText.slice(0, -1);
                else if (!/\s$/.test(prevText)) last.text += " ";
            }
        }
        rr.forEach((run, k) => pushRun(runs, run, i > 0 && k === 0));
    });
    if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");

    // Wide, regular word spacing on a single line (CSS word-spacing): the extra width goes on its spaces as character
    // spacing, so the line keeps its length in Word.
    if (rows.length === 1 && alignment !== "justify" && !first.tabs.length && first.lines.length === 1) {
        const line = first.lines[0];
        const natural = lineNatural.get(line);
        const spaces = runs.reduce((n, r) => n + (r.text.match(/ /g)?.length ?? 0), 0);
        if (natural !== undefined && (lineStretch.get(line) ?? 1) >= 1.5 && spaces >= 1) {
            const extra = (first.x1 - first.x0 - natural) / spaces;
            if (extra >= 0.5) {
                const pieces: TextRun[] = [];
                for (const r of runs)
                    for (const part of r.text.split(/( )/)) {
                        if (!part) continue;
                        const style = part === " " ? { ...r.style, characterSpacing: r2((r.style.characterSpacing ?? 0) + extra) } : r.style;
                        pieces.push({ text: part, style, box: { ...r.box }, baseline: r.baseline });
                    }
                runs.length = 0;
                for (const p of pieces) pushRun(runs, p);
            }
        }
    }

    const x0 = Math.min(...rows.map((r) => r.x0));
    const x1 = Math.max(...rows.map((r) => r.x1));
    const y0 = Math.min(...rows.map((r) => r.top));
    const y1 = Math.max(...rows.map((r) => r.bottom));
    const para: Paragraph = {
        kind: "paragraph",
        lines: rows.flatMap((r) => r.lines),
        runs,
        box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        alignment,
        indentLeft: r2(indentLeft),
        indentRight: r2(indentRight),
        firstLineIndent: r2(firstLineIndent),
        spaceBefore: 0,
        lineSpacing: r2(lineSpacing),
    };
    if (g.breaks) para.keepLineBreaks = true;
    regionLeftOf.set(para, regionLeft);
    const tabs = rows.flatMap((r) => r.tabs);
    if (tabs.length) {
        const seen = new Set<number>();
        para.tabStops = tabs
            .map((t) => ({ position: r2(Math.max(0, t.x - regionLeft)), alignment: t.alignment, ...(t.leader ? { leader: t.leader } : {}) }))
            .filter((t) => (seen.has(Math.round(t.position)) ? false : (seen.add(Math.round(t.position)), true)))
            .sort((a, b) => a.position - b.position);
    }
    if (!ctx.inCell && !first.marker) {
        const level = ctx.tagged ? taggedHeading(rows) : looksLikeHeading(rows, runs, size, ctx);
        if (level) para.heading = level;
    }
    return para;
};

/** Tagged PDFs: the heading level of the element that holds the paragraph's text (never inside a table). */
const taggedHeading = (rows: Row[]): 1 | 2 | 3 | undefined => {
    let total = 0;
    const levels = new Map<number, number>();
    for (const r of rows) {
        const n = r.text.replace(/\s/g, "").length;
        total += n;
        const level = r.tag && !r.tag.table ? headingLevelOfRole(r.tag.role) : 0;
        if (level) levels.set(level, (levels.get(level) ?? 0) + n);
    }
    let best = 0;
    let most = 0;
    for (const [level, n] of levels) if (n > most) [best, most] = [level, n];
    return best && most >= 0.6 * total ? (Math.min(3, best) as 1 | 2 | 3) : undefined;
};

/** "IBAN: ES91 2100…", "Total: 1.234,56", "Email: a@b.es": a label and its value, not a title. */
const labelValue = (text: string, runs: TextRun[]) => {
    const m = /^([^:\t]{1,40}):\s*(\S.*)$/.exec(text);
    if (!m) return false;
    const value = m[2].replace(/\s/g, "");
    const digits = (value.match(/\d/g) ?? []).length;
    if (digits >= 0.25 * value.length || /@|https?:|www\./i.test(value)) return true;
    // A bold label before a plain value.
    const at = runs.findIndex((r) => r.text.includes(":"));
    const after = runs.slice(at + 1).find((r) => r.text.trim());
    return at >= 0 && !!after && runs[at].style.bold !== after.style.bold;
};

/**
 * Untagged PDFs: a heading is a standalone short phrase (one or two lines, no sentence inside it, not a label with its
 * value, not tabbed like a table row) set in one of the document's heading styles — clearly larger than body text, or
 * bold / coloured and larger (see layout.ts headingStyles) — or, without them, clearly bigger than body text.
 */
const looksLikeHeading = (rows: Row[], runs: TextRun[], size: number, ctx: ParagraphContext): 1 | 2 | 3 | undefined => {
    const text = runs
        .map((r) => r.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    // Numbered headings ("1. Resumen", "2.3 Costes", "IV. Anexo", "1.⇥Introducción") keep their number out of the test.
    const plain = text.replace(/^(\d{1,3}(\.\d{1,3})*|[A-Za-z]|[IVXLCivxlc]{1,6})[.)]?\s+/, "");
    const body = ctx.bodyFontSize || size;
    if (rows.length > (size >= 1.6 * body ? 3 : 2) || plain.length > 120 || !/\p{L}{2}/u.test(plain)) return undefined;
    if (/[.,;!]$/.test(plain) || /[.!?…]["»”)]?\s+\S/.test(plain)) return undefined;
    if (labelValue(plain, runs)) return undefined;
    const tabs = rows.flatMap((r) => r.tabs);
    if (tabs.length > 1 || (tabs.length === 1 && !/^\s*(\d{1,3}(\.\d{1,3})*\.?|[A-Za-z][.)]|[IVXLC]{1,6}\.)\t/.test(runs.map((r) => r.text).join(""))))
        return undefined;
    const main = dominantStyle(runs);
    if (!main) return undefined;
    if (ctx.headingStyles) {
        const hit = ctx.headingStyles.find(
            (h) =>
                Math.abs(h.size - main.fontSize) <= 0.6 &&
                h.bold === main.bold &&
                !!h.italic === main.italic &&
                h.family === main.fontFamily &&
                h.color === main.color,
        );
        return hit?.level;
    }
    const ratio = size / body;
    const bold = rows.every((r) => r.bold);
    if (ratio >= 1.6) return 1;
    if (ratio >= 1.3) return 2;
    if (ratio >= 1.15 && bold) return 3;
    return undefined;
};

// ── Rotated text ──────────────────────────────────────────────────────────────────────────────────

/** Rotated lines, grouped by angle, laid out in their own (u, v) frame, then mapped back (TextLine.rotation). */
const rotatedParagraphs = (lines: TextLine[], ctx: ParagraphContext): Paragraph[] => {
    const byAngle = new Map<number, TextLine[]>();
    for (const l of lines) {
        const key = Math.round((l.rotation ?? 0) * 2) / 2;
        const list = byAngle.get(key);
        if (list) list.push(l);
        else byAngle.set(key, [l]);
    }
    const out: Paragraph[] = [];
    for (const [angle, group] of byAngle) {
        const rad = (angle * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        // Each line's box is its unrotated frame centred on the text: move it into (u, v) coordinates.
        const toUV = (x: number, y: number): [number, number] => [dx * x + dy * y, -dy * x + dx * y];
        const flat = group.map((l) => {
            const cx = l.box.x + l.box.width / 2;
            const cy = l.box.y + l.box.height / 2;
            const [uc, vc] = toUV(cx, cy);
            const sx = uc - cx;
            const sy = vc - cy;
            const moved: TextLine = {
                runs: l.runs.map((r) => ({ ...cloneRun(r), box: { ...r.box, x: r.box.x + sx, y: r.box.y + sy }, baseline: r.baseline + sy })),
                box: { ...l.box, x: l.box.x + sx, y: l.box.y + sy },
                baseline: l.baseline + sy,
                fontSize: l.fontSize,
            };
            if (l.invisible) moved.invisible = true;
            return moved;
        });
        const x0 = Math.min(...flat.map((l) => l.box.x));
        const y0 = Math.min(...flat.map((l) => l.box.y));
        const x1 = Math.max(...flat.map((l) => l.box.x + l.box.width));
        const y1 = Math.max(...flat.map((l) => l.box.y + l.box.height));
        const region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        for (const p of horizontalParagraphs(flat, region, ctx)) {
            // Frame of the paragraph: centred where its text is on the page.
            const uc = p.box.x + p.box.width / 2;
            const vc = p.box.y + p.box.height / 2;
            const X = dx * uc - dy * vc;
            const Y = dy * uc + dx * vc;
            const sx = X - uc;
            const sy = Y - vc;
            const shift = (b: Rect): Rect => ({ x: b.x + sx, y: b.y + sy, width: b.width, height: b.height });
            p.box = shift(p.box);
            p.lines = p.lines.map((l) => ({
                ...l,
                box: shift(l.box),
                baseline: l.baseline + sy,
                runs: l.runs.map((r) => ({ ...r, box: shift(r.box), baseline: r.baseline + sy })),
                rotation: angle,
            }));
            p.runs = p.runs.map((r) => ({ ...r, box: shift(r.box), baseline: r.baseline + sy }));
            p.rotation = angle;
            p.spaceBefore = 0;
            out.push(p);
        }
    }
    return out;
};
