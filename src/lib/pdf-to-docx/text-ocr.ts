// OCR words → text lines. Tesseract reports word boxes and which words form a line; everything else is measured on
// the words' ink. The family is the core face (Times New Roman, Arial, Courier New) whose width proportions explain the
// words of each line with a single size — a letter set in Times comes back in Times, not in Arial that runs 10 % longer
// and wraps at other words. Sizes come from those widths (blur and specks change widths far less than heights), bold
// from lines whose words are as much wider than their height says as the bold face is; sizes are then snapped to the
// few a page is set in. The baseline is where words without descenders end; a slightly rotated scan is straightened.
import { FontNames } from "@pdf-lib/standard-fonts";
import { StandardFontEmbedder } from "pdf-lib";
import { lineNatural, lineStretch, runCharX } from "./text-lines";
import { type GreyImage, type WordInk, greyImage, measureWord } from "./text-ocr-ink";
import type { OcrWord, RenderedImage, TextLine, TextRun } from "./types";

/** A recognised word in page points. */
type Word = {
    text: string;
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    confidence: number;
    /** The word's box in the image's pixels (before straightening). */
    px: { x: number; y: number; width: number; height: number };
    /** How far straightening moved it down (points). */
    dy: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
};

type Family = "Times New Roman" | "Arial" | "Courier New";

/**
 * The faces a scan is matched against: their standard-font metrics (regular and bold widths), and the heights of their
 * glyphs as drawn — capitals, ascenders (with the accents and dots of lowercase letters, which reach about as high),
 * x-height — and the width of a space, in em.
 */
type Face = { cap: number; asc: number; x: number; space: number; regular: FontNames; bold: FontNames };
const FACES: Record<Family, Face> = {
    "Times New Roman": { cap: 0.662, asc: 0.693, x: 0.448, space: 0.25, regular: FontNames.TimesRoman, bold: FontNames.TimesRomanBold },
    Arial: { cap: 0.716, asc: 0.716, x: 0.519, space: 0.278, regular: FontNames.Helvetica, bold: FontNames.HelveticaBold },
    "Courier New": { cap: 0.571, asc: 0.613, x: 0.423, space: 0.6, regular: FontNames.Courier, bold: FontNames.CourierBold },
};
const FAMILIES = Object.keys(FACES) as Family[];
/** Before the family is known: between the serif and sans figures. */
const ANY = { cap: 0.69, asc: 0.705, x: 0.49 };

/** Letters whose ink goes well below the baseline (and brackets, which do in most faces). */
const DESC = /[gjpqyQJçµ()[\]{}|@$§¿¡]/;
/** Commas and semicolons dip a little below the baseline. */
const DIP = /[,;]/;
/** Capitals and digits reach the cap line, ascenders and lowercase accents and dots the ascender line. */
const TALL = /[A-Z0-9bdfhklßáéíóúàèìòùâêîôûäëïöüñij]/;
const ASCENDER = /[bdfhklßáéíóúàèìòùâêîôûäëïöüñij]/;
/** Accented capitals go above both. */
const OVER = /[ÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÑÇ]/;
const XONLY = /^[acemnorsuvwxz]+[.,:;!?]?$/;

const median = (v: number[]) => {
    if (!v.length) return NaN;
    const s = v.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Baseline of a line of words: where the words without descenders end — with fewer than three of them, the median of
 * every word's estimate (its bottom less the depth of what hangs below: ≈ 0.21 em for descenders, 0.13 em for a comma,
 * the em taken from the word's height), so that one word a speck made taller can't move the line.
 */
const baselineOf = (ws: Word[]) => {
    const flat = ws.filter((w) => !DESC.test(w.text) && !DIP.test(w.text) && /[\p{L}\p{N}]/u.test(w.text)).map((w) => w.bottom);
    if (flat.length >= 3) return median(flat);
    return median(
        ws
            .filter((w) => /[\p{L}\p{N}]/u.test(w.text))
            .map((w) => {
                const h = w.bottom - w.top;
                const above = TALL.test(w.text) ? ANY.asc : ANY.x;
                const depth = DESC.test(w.text) ? 0.21 : DIP.test(w.text) ? 0.13 : 0;
                return w.bottom - (h * depth) / (above + depth);
            }),
    );
};

/**
 * Font size (points) of a line from its words' heights over the baseline, for the given face metrics. `px`: one
 * image pixel in points (anti-aliased edges make every word about half a pixel taller).
 */
const sizeOf = (ws: Word[], baseline: number, face: { cap: number; asc: number; x: number }, px: number) => {
    const tall = ws
        .filter((w) => TALL.test(w.text) && !OVER.test(w.text) && baseline - w.top > px)
        .map((w) => (baseline - w.top - 0.5 * px) / (ASCENDER.test(w.text) ? face.asc : face.cap));
    if (tall.length) return median(tall);
    const low = ws.filter((w) => XONLY.test(w.text) && baseline - w.top > px).map((w) => (baseline - w.top - 0.5 * px) / face.x);
    if (low.length) return median(low);
    return median(ws.map((w) => w.bottom - w.top)) / 0.9;
};

/** Sizes documents are usually set in. */
const COMMON = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72];

/**
 * Sizes of the lines snapped to the page's few sizes: sorted sizes less than 4 % apart from the next are one size
 * (their char-weighted median).
 */
const snapSizes = (sizes: number[], weights: number[]): number[] => {
    const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
    const out = sizes.slice();
    for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && sizes[order[j + 1]] <= sizes[order[j]] * 1.04 && sizes[order[j + 1]] <= sizes[order[i]] * 1.12) j++;
        const members = order.slice(i, j + 1);
        // Weighted median.
        const total = members.reduce((n, k) => n + weights[k], 0);
        let acc = 0;
        let value = sizes[members[0]];
        for (const k of members) {
            acc += weights[k];
            if (acc >= total / 2) {
                value = sizes[k];
                break;
            }
        }
        // Scans measure a little off: the usual sizes win when they are close.
        const usual = COMMON.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
        const snapped = Math.abs(usual - value) <= 0.035 * value ? usual : Math.max(4, Math.round(value * 2) / 2);
        for (const k of members) out[k] = snapped;
        i = j + 1;
    }
    return out;
};

// ── Word widths in the core faces (the PDF standard fonts' metrics: Times, Helvetica = Arial, Courier) ─────────────

const embedders = new Map<FontNames, StandardFontEmbedder>();
const charWidths = new Map<string, number | null>();

/** Advance width of `text` in em, or null when a character has no standard-font metrics. */
const emWidth = (font: FontNames, text: string): number | null => {
    let e = embedders.get(font);
    if (!e) embedders.set(font, (e = StandardFontEmbedder.for(font)));
    let w = 0;
    for (const ch of text) {
        const key = font + "|" + ch;
        let cw = charWidths.get(key);
        if (cw === undefined) {
            try {
                cw = e.widthOfTextAtSize(ch, 1);
            } catch {
                cw = null;
            }
            charWidths.set(key, cw);
        }
        if (cw === null) return null;
        w += cw;
    }
    return w;
};

/**
 * Sizes (points) at which the font's advance widths match each word's measured width (words of two letters or more the
 * recogniser is sure of). A word's ink lacks the side bearings of its first and last letters (≈ 0.05 em).
 */
const widthSizes = (ws: Word[], font: FontNames): number[] => {
    const out: number[] = [];
    for (const w of ws) {
        if (w.text.length < 2 || w.confidence < 60) continue;
        const em = emWidth(font, w.text);
        if (em !== null && em > 0.3) out.push((w.x1 - w.x0) / (em - 0.05));
    }
    return out;
};

/**
 * The page's family: the face whose width proportions explain the words of every line with one size — the spread of
 * the words' width sizes around their line's median (scale-free, so blur and size errors don't matter). Arial when the
 * page has too few words to tell.
 */
const pageFamily = (lines: Word[][]): Family => {
    const spreads: { family: Family; spread: number }[] = [];
    for (const f of FAMILIES) {
        const devs: number[] = [];
        for (const ws of lines) {
            const sizes = widthSizes(ws, FACES[f].regular);
            if (sizes.length < 2) continue;
            const m = median(sizes);
            for (const v of sizes) devs.push(Math.abs(Math.log(v / m)));
        }
        if (devs.length < 4) return "Arial";
        spreads.push({ family: f, spread: devs.reduce((x, y) => x + y, 0) / devs.length });
    }
    spreads.sort((a, b) => a.spread - b.spread);
    // Only a clear winner replaces the most common face.
    return spreads[1].spread >= 1.25 * spreads[0].spread ? spreads[0].family : "Arial";
};

/** Words of one OCR line split where a column-sized gap separates them (like PDF lines are). */
const splitPieces = (ws: Word[], size: number): Word[][] => {
    const pieces: Word[][] = [];
    for (const w of ws) {
        const last = pieces[pieces.length - 1];
        const prev = last?.[last.length - 1];
        if (prev && w.x0 - prev.x1 <= 1.6 * size) last.push(w);
        else pieces.push([w]);
    }
    return pieces;
};

/**
 * Slope of the scan's lines (a page fed at a slight angle): per line, the median slope between the bottoms of its
 * words without descenders (Theil–Sen); for the page, the median over the lines that show one.
 */
const pageSlope = (lines: Word[][]): number => {
    const slopes: number[] = [];
    for (const ws of lines) {
        const flat = ws.filter((w) => !DESC.test(w.text) && !DIP.test(w.text) && /[\p{L}\p{N}]/u.test(w.text));
        if (flat.length < 3 || flat[flat.length - 1].x1 - flat[0].x0 < 100) continue;
        const pair: number[] = [];
        for (let i = 0; i < flat.length; i++)
            for (let j = i + 1; j < flat.length; j++) {
                const dx = (flat[j].x0 + flat[j].x1) / 2 - (flat[i].x0 + flat[i].x1) / 2;
                if (Math.abs(dx) > 20) pair.push((flat[j].bottom - flat[i].bottom) / dx);
            }
        if (pair.length) slopes.push(median(pair));
    }
    return slopes.length >= 2 || (slopes.length === 1 && lines.length === 1) ? median(slopes) : 0;
};

/**
 * Lines built from OCR words of a rendered page (image pixels → page points), straightened when the scan is slightly
 * rotated, without the specks the recogniser took for marks.
 */
export const ocrTextLines = (words: OcrWord[], image: RenderedImage, page: { width: number; height: number }): TextLine[] => {
    const sx = page.width / (image.pixelWidth || 1);
    const sy = page.height / (image.pixelHeight || 1);
    const raw = new Map<string, { word: Word; confidence: number }[]>();
    for (const w of words) {
        const text = (w.text ?? "").replace(/\s+/g, " ").trim();
        if (!text || !(w.box.width > 0) || !(w.box.height > 0)) continue;
        // Very low confidence single marks are specks of the scan, not text.
        if (w.confidence < 25 && text.length <= 2 && !/[\p{L}\p{N}]/u.test(text)) continue;
        const key = `${w.paragraph}:${w.line}`;
        const word: Word = {
            text,
            x0: w.box.x * sx,
            x1: (w.box.x + w.box.width) * sx,
            top: w.box.y * sy,
            bottom: (w.box.y + w.box.height) * sy,
            confidence: w.confidence,
            px: { ...w.box },
            dy: 0,
        };
        const list = raw.get(key);
        if (list) list.push({ word, confidence: w.confidence });
        else raw.set(key, [{ word, confidence: w.confidence }]);
    }
    // Marks far smaller than the line's words, or unsure short "words" standing apart, are dirt on the scan.
    const cleaned: Word[][] = [];
    for (const list of raw.values()) {
        // The line's height from the words the recogniser is sure of (specks come in numbers on a dirty scan).
        const sure = list.filter((e) => e.confidence >= 60 && e.word.text.length >= 2).map((e) => e.word.bottom - e.word.top);
        const h = sure.length ? median(sure) : Math.max(...list.map((e) => e.word.bottom - e.word.top));
        const kept = list.filter((e, i) => {
            const wh = e.word.bottom - e.word.top;
            if (wh < 0.45 * h && e.confidence < 70) return false;
            if (wh < 0.15 * h && e.word.x1 - e.word.x0 < 0.15 * h) return false;
            if (e.confidence < 30 && e.word.text.length <= 2) {
                const near = list.some((o, k) => k !== i && Math.min(Math.abs(o.word.x0 - e.word.x1), Math.abs(e.word.x0 - o.word.x1)) < 1.5 * h);
                if (!near) return false;
            }
            return true;
        });
        if (kept.length) cleaned.push(kept.map((e) => e.word));
    }
    // Straighten a slightly rotated scan around the page centre.
    const slope = pageSlope(cleaned);
    if (Math.abs(slope) > 0.0008 && Math.abs(slope) < 0.08) {
        const cx = page.width / 2;
        const cy = page.height / 2;
        for (const ws of cleaned)
            for (const w of ws) {
                const mx = (w.x0 + w.x1) / 2;
                const my = (w.top + w.bottom) / 2;
                const dx = (my - cy) * slope;
                const dy = -(mx - cx) * slope;
                w.x0 += dx;
                w.x1 += dx;
                w.top += dy;
                w.bottom += dy;
                w.dy = dy;
            }
    }
    const family = pageFamily(cleaned);
    const face = FACES[family];
    const lines = cleaned
        .map((ws) => {
            ws.sort((x, y) => x.x0 - y.x0);
            const baseline = baselineOf(ws);
            return {
                ws,
                baseline,
                height: sizeOf(ws, baseline, face, sy),
                regular: median(widthSizes(ws, face.regular)),
                bold: median(widthSizes(ws, face.bold)),
                chars: ws.reduce((n, w) => n + w.text.length, 0),
            };
        })
        .filter((l) => Number.isFinite(l.baseline) && Number.isFinite(l.height) && l.height > 0);
    if (!lines.length) return [];
    // How much taller the ink measures than the widths say (blur thickens a scan's letters; a clean render measures
    // true): the page's calibration, from lines with enough letters to measure.
    const ratios = lines.filter((l) => Number.isFinite(l.regular)).map((l) => l.height / l.regular);
    const k = ratios.length >= 3 ? median(ratios) : 1;
    const expected = (l: (typeof lines)[number]) => l.height / (k > 0.8 && k < 1.3 ? k : 1);
    // Bold and italic from the ink of the words (their em from the regular widths for now); without a readable image,
    // lines whose words are wider than their height says, as much as the bold face is, are bold.
    const img = greyImage(image);
    const inked =
        !!img &&
        inkStyles(
            lines,
            lines.map((l) => (Number.isFinite(l.regular) ? l.regular : expected(l))),
            img,
            sy,
        );
    const styled = lines.map((l) => {
        if (!Number.isFinite(l.regular)) return { size: expected(l), bold: false };
        let bold: boolean;
        // Lines whose words could be measured (not light letters on a dark band) go by their ink.
        if (inked && l.ws.some((w) => w.bold !== undefined)) {
            const letters = (w: Word) => w.text.replace(/[^\p{L}]/gu, "").length;
            const heavy = l.ws.filter((w) => w.bold).reduce((n, w) => n + letters(w), 0);
            bold = heavy > 0.5 * l.ws.reduce((n, w) => n + letters(w), 0);
        } else {
            const off = Math.log(l.regular / expected(l));
            bold = Number.isFinite(l.bold) && off > 0.055 && Math.abs(Math.log(l.bold / expected(l))) < 0.5 * Math.abs(off);
            for (const w of l.ws) w.bold = bold;
        }
        // Sizes from the widths of the face the line is set in.
        return { size: bold && Number.isFinite(l.bold) ? l.bold : l.regular, bold };
    });
    const sizes = snapSizes(
        styled.map((l) => l.size),
        lines.map((l) => l.chars),
    );
    const out: TextLine[] = [];
    lines.forEach((l, i) => {
        for (const piece of splitPieces(l.ws, sizes[i])) out.push(buildLine(piece, l.baseline, sizes[i], family));
    });
    return out;
};

/**
 * Bold and italic of every word from its ink: stems ≥ 1.3 times the page's usual thickness are bold; words whose
 * columns of ink line up clearly better leaning (sheared back by 0.2–0.3) than upright are italic. Words too short to
 * judge take their neighbours' style. False when the page has too few measurable words to calibrate.
 */
const inkStyles = (lines: { ws: Word[]; baseline: number }[], sizes: number[], img: GreyImage, sy: number): boolean => {
    const all: { w: Word; ink: WordInk }[] = lines.flatMap((l, i) => {
        const em = sizes[i] / sy;
        // The line's baseline where the word sits in the image (a speck merged into a word box misplaces its bottom).
        return l.ws.flatMap((w) => {
            if (!/\p{L}.*\p{L}/u.test(w.text)) return [];
            const ink = measureWord(img, w.px, (l.baseline - w.dy) / sy, em);
            return ink ? [{ w, ink }] : [];
        });
    });
    if (all.length < 6) return false;
    // Most text is regular: the page's regular stem is the lower-middle of the words' stems.
    const stems = all.map((m) => m.ink.stem).sort((a, b) => a - b);
    const regular = stems[Math.floor(0.35 * stems.length)];
    for (const { w, ink } of all) {
        w.bold = ink.stem >= 1.3 * regular;
        const [, up, , lean2, lean3] = ink.sharpness;
        w.italic = up > 0 && Math.max(lean2, lean3) >= 1.06 * up;
    }
    // Colours: words sampled within a few levels of each other were printed in one colour (the page's palette).
    const palette: { sum: [number, number, number]; n: number; words: Word[] }[] = [];
    for (const { w, ink } of all) {
        if (!ink.color) continue;
        const c = ink.color;
        const hit = palette.find((p) => p.sum.every((v, i) => Math.abs(v / p.n - c[i]) <= 36));
        if (hit) {
            hit.sum = [hit.sum[0] + c[0], hit.sum[1] + c[1], hit.sum[2] + c[2]];
            hit.n++;
            hit.words.push(w);
        } else palette.push({ sum: [c[0], c[1], c[2]], n: 1, words: [w] });
    }
    for (const p of palette) {
        const color = inkColor([p.sum[0] / p.n, p.sum[1] / p.n, p.sum[2] / p.n]);
        for (const w of p.words) w.color = color;
    }
    return true;
};

/** Hex colour of a word's ink: black and near-black greys are black (scans are rarely quite black), others as sampled. */
const inkColor = ([r, g, b]: [number, number, number]): string => {
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma < 28 && Math.max(r, g, b) < 70) return "000000";
    const hex = (v: number) =>
        Math.round(Math.max(0, Math.min(255, v)))
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
    return hex(r) + hex(g) + hex(b);
};

const buildLine = (ws: Word[], baseline: number, size: number, family: Family): TextLine => {
    const x0 = ws[0].x0;
    const x1 = Math.max(...ws.map((w) => w.x1));
    const top = baseline - 0.9 * size;
    // Words too short to judge (or not measured) take the style of the word before them, else after them.
    const styles = ws.map((w) =>
        w.text.replace(/[^\p{L}]/gu, "").length >= 3 && w.bold !== undefined ? { bold: !!w.bold, italic: !!w.italic, color: w.color ?? "000000" } : null,
    );
    for (let k = 0; k < styles.length; k++)
        styles[k] ??= styles[k - 1] ?? styles.slice(k + 1).find((x) => x) ?? { bold: !!ws[k].bold, italic: !!ws[k].italic, color: ws[k].color ?? "000000" };
    const runs: TextRun[] = [];
    let last: TextRun | null = null;
    ws.forEach((w, k) => {
        const style = styles[k]!;
        if (last) {
            // The space between two words goes with the first.
            const xs = runCharX.get(last)!;
            xs.pop();
            xs.push(ws[k - 1].x1);
            last.text += " ";
            if (last.style.bold !== style.bold || last.style.italic !== style.italic || last.style.color !== style.color) {
                xs.push(w.x0);
                last = null;
            }
        }
        if (!last) {
            last = {
                text: "",
                style: { fontFamily: family, fontSize: size, bold: style.bold, italic: style.italic, color: style.color },
                box: { x: w.x0, y: top, width: 0, height: 1.12 * size },
                baseline,
            };
            runCharX.set(last, []);
            runs.push(last);
        }
        const xs = runCharX.get(last)!;
        const n = w.text.length;
        for (let c = 0; c < n; c++) xs.push(w.x0 + ((w.x1 - w.x0) * c) / n);
        xs.push(w.x1);
        last.text += w.text;
        last.box.width = w.x1 - last.box.x;
    });
    for (const r of runs) if (runCharX.get(r)?.length !== r.text.length + 1) runCharX.delete(r);
    const line: TextLine = { runs, box: { x: x0, y: top, width: x1 - x0, height: 1.12 * size }, baseline, fontSize: size };
    // Word gaps against the face's natural space: justified lines are stretched, and Word needs the natural width.
    const space = FACES[family].space * size;
    const gaps = ws.slice(1).map((w, k) => w.x0 - ws[k].x1);
    if (gaps.length >= 2) lineStretch.set(line, Math.round((median(gaps) / space) * 100) / 100);
    const excess = gaps.reduce((n, g) => n + Math.max(0, g - space), 0);
    lineNatural.set(line, Math.round((x1 - x0 - excess) * 100) / 100);
    return line;
};
