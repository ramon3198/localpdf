"use client";

import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";

export type ExtractedFontFamily = "helvetica" | "times" | "courier";

export type ExtractedText = {
    /** Stable id within the page: page + index. */
    id: string;
    page: number;
    /** Original text content. */
    str: string;
    /** Bbox in CSS pixels of the rendered canvas. */
    cssX: number;
    cssY: number;
    cssWidth: number;
    cssHeight: number;
    /** Baseline y in CSS pixels (useful for replacement). */
    cssBaselineY: number;
    /** Approximate font size in CSS px (= PDF pt scaled to viewport). */
    cssFontSize: number;
    /** PDF coords (bottom-left origin) — used when writing back to the document. */
    pdfX: number;
    pdfY: number;
    pdfWidth: number;
    pdfHeight: number;
    pdfFontSize: number;
    /** pdfjs TextItem.transform in PDF user space — lets the content-stream engine find the exact glyphs. */
    pdfTransform: number[];
    /** CSS-ready font family from pdfjs. */
    cssFontFamily: string;
    /** Approximated mapping to a pdf-lib StandardFont family. */
    family: ExtractedFontFamily;
    bold: boolean;
    italic: boolean;
    /** Sampled text color (hex) — robust against dark backgrounds via k-means. */
    textColor: string;
    /** Sampled background color (hex) — the cluster with more pixels in the bbox. */
    bgColor: string;
    /** Background color sampled in the LEFT / RIGHT half of the run — used to reproduce a horizontal
     *  gradient under the cover so a shaded banner doesn't show a flat rectangular patch. */
    bgLeft: string;
    bgRight: string;
    /** Actual vertical ink extent of the original glyphs (CSS px, absolute), so the cover hugs the
     *  text instead of the full ascent/descent box. null when no ink was detected. */
    inkTop: number | null;
    inkBottom: number | null;
    /** pdfjs internal font id (e.g. "g_d0_f1"). */
    pdfjsFontName: string;
    /** PostScript name resolved via pdfjs commonObjs (e.g. "LiberationSans-Bold-2000"). */
    psFontName: string | null;
};

/** Binary font data extracted from the PDF, keyed by pdfjs internal font name.
 *  Allows us to register the exact font with fontkit and produce vector text. */
export type FontBinaryCache = Map<string, { bytes: Uint8Array; mimetype?: string; psName?: string }>;

const isBoldFromName = (name: string) => /bold|black|heavy|semibold|demi|[ -]?700|[ -]?800|[ -]?900/i.test(name);
const isItalicFromName = (name: string) => /italic|oblique/i.test(name);

const familyFromName = (name: string): ExtractedFontFamily => {
    const n = name.toLowerCase();
    // Monospace first (most specific).
    if (/(courier|mono|consol|menlo|monaco|inconsolata|code)/.test(n)) return "courier";
    // Sans BEFORE serif — critical because the string "sans-serif" CONTAINS "serif".
    if (
        /(sans|arial|helvetica|verdana|tahoma|segoe|roboto|calibri|inter|lato|montserrat|gothic|grotesk|frutiger|univers|franklin|futura|avenir|nunito|poppins|raleway|ubuntu|dejavu ?sans|liberation ?sans)/.test(
            n,
        )
    )
        return "helvetica";
    // Serif.
    if (/(times|serif|georgia|garamond|cambria|book|roman|minion|palatino|baskerville|caslon|didot|merriweather|liberation ?serif)/.test(n)) return "times";
    return "helvetica";
};

const toHex = (r: number, g: number, b: number) => {
    const h = (n: number) =>
        Math.max(0, Math.min(255, Math.round(n)))
            .toString(16)
            .padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
};

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const distSq = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Simple 2-cluster k-means over RGB pixels. Returns [bg, text] (bigger cluster first = background). */
const kmeans2 = (pixels: number[][], iterations = 6): { center: number[]; count: number }[] => {
    if (pixels.length === 0)
        return [
            { center: [255, 255, 255], count: 0 },
            { center: [0, 0, 0], count: 0 },
        ];

    // Seed centroids by luminance extremes — converges in 2-3 iterations.
    let minLum = Infinity;
    let maxLum = -Infinity;
    let darkSeed = pixels[0];
    let lightSeed = pixels[0];
    for (const p of pixels) {
        const l = luminance(p[0], p[1], p[2]);
        if (l < minLum) {
            minLum = l;
            darkSeed = p;
        }
        if (l > maxLum) {
            maxLum = l;
            lightSeed = p;
        }
    }
    let a = darkSeed.slice();
    let b = lightSeed.slice();
    let countA = 0;
    let countB = 0;

    for (let iter = 0; iter < iterations; iter++) {
        const sumA = [0, 0, 0];
        const sumB = [0, 0, 0];
        countA = 0;
        countB = 0;
        for (const p of pixels) {
            if (distSq(p, a) < distSq(p, b)) {
                sumA[0] += p[0];
                sumA[1] += p[1];
                sumA[2] += p[2];
                countA++;
            } else {
                sumB[0] += p[0];
                sumB[1] += p[1];
                sumB[2] += p[2];
                countB++;
            }
        }
        if (countA > 0) a = [sumA[0] / countA, sumA[1] / countA, sumA[2] / countA];
        if (countB > 0) b = [sumB[0] / countB, sumB[1] / countB, sumB[2] / countB];
    }
    return [
        { center: a, count: countA },
        { center: b, count: countB },
    ].sort((x, y) => y.count - x.count);
};

/** Snap to nearest pure tone (white/black) when within threshold — avoids visible patches over flat fills. */
const snapToPure = (rgb: number[]): number[] => {
    const SNAP = 10; // within 10 RGB units → snap exact
    // Only snap LOW-CHROMA colors so tinted page fills (cream/eggshell, warm grays) are preserved
    // and the cover rectangle blends instead of becoming a brighter/cooler patch.
    const chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    if (chroma < 8) {
        const whiteDist = Math.hypot(255 - rgb[0], 255 - rgb[1], 255 - rgb[2]);
        const blackDist = Math.hypot(rgb[0], rgb[1], rgb[2]);
        if (whiteDist < SNAP) return [255, 255, 255];
        if (blackDist < SNAP) return [0, 0, 0];
    }
    return rgb;
};

/** Sample colors inside the bbox using k-means with edge weighting: majority cluster = background, minority = text.
 *  For the TEXT color we return the most-extreme (darkest if bg is light, lightest if bg is dark) pixel
 *  in the text cluster — NOT the centroid — because the centroid is contaminated by anti-aliased pixels
 *  along glyph edges, which would yield a washed-out mid-gray instead of the actual glyph color. */
const sampleBgAndText = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    baselineY: number,
): { bg: string; text: string; bgLeft: string; bgRight: string; inkTop: number | null; inkBottom: number | null } => {
    const xi = Math.max(0, Math.floor(x));
    const yi = Math.max(0, Math.floor(y));
    const wi = Math.max(1, Math.min(Math.floor(w), ctx.canvas.width - xi));
    const hi = Math.max(1, Math.min(Math.floor(h), ctx.canvas.height - yi));
    let data: Uint8ClampedArray;
    try {
        data = ctx.getImageData(xi, yi, wi, hi).data;
    } catch {
        return { bg: "#ffffff", text: "#000000", bgLeft: "#ffffff", bgRight: "#ffffff", inkTop: null, inkBottom: null };
    }
    const stride = Math.max(1, Math.floor(Math.sqrt((wi * hi) / 1200)));
    // pixels store [r, g, b, x, y] so we can recover a horizontal gradient AND the vertical ink extent.
    const pixels: number[][] = [];
    const edgeMargin = Math.max(2, Math.floor(Math.min(wi, hi) * 0.15));
    for (let py = 0; py < hi; py += stride) {
        for (let px = 0; px < wi; px += stride) {
            const idx = (py * wi + px) * 4;
            if (data[idx + 3] < 64) continue;
            const isEdge = py < edgeMargin || py > hi - edgeMargin || px < 2 || px > wi - 3;
            const px5 = [data[idx], data[idx + 1], data[idx + 2], px, py];
            pixels.push(px5);
            if (isEdge) pixels.push(px5);
        }
    }
    if (pixels.length === 0) return { bg: "#ffffff", text: "#000000", bgLeft: "#ffffff", bgRight: "#ffffff", inkTop: null, inkBottom: null };

    const clusters = kmeans2(pixels);
    const bgC = snapToPure(clusters[0].center);

    // Background gradient (left vs right) AND a per-row ink histogram — the latter lets us isolate THIS
    // line's vertical ink band (seeded at the baseline) from neighbouring lines whose pixels leak into
    // the sample region on tightly-spaced layouts.
    const accumL = [0, 0, 0, 0];
    const accumR = [0, 0, 0, 0];
    const rowCount = Math.ceil(hi / stride) + 1;
    const rowInk = new Array(rowCount).fill(0);
    for (const p of pixels) {
        const isText = distSq(p, clusters[0].center) > distSq(p, clusters[1].center);
        if (isText) {
            rowInk[Math.floor(p[4] / stride)]++;
            continue;
        }
        const side = p[3] < wi / 2 ? accumL : accumR;
        side[0] += p[0];
        side[1] += p[1];
        side[2] += p[2];
        side[3] += 1;
    }
    const sideColor = (acc: number[]) => (acc[3] > 0 ? snapToPure([acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]]) : bgC);
    const bgLeftC = sideColor(accumL);
    const bgRightC = sideColor(accumR);

    // Ink band: seed at the baseline row, then expand up/down while rows have ink, stopping at the
    // first vertical gap large enough to be the inter-line space. This excludes the next/previous line.
    const baselineRow = Math.round((baselineY - yi) / stride);
    const hasInk = (r: number) => r >= 0 && r < rowCount && rowInk[r] >= 1;
    let seed = -1;
    const seedSpan = Math.max(3, Math.round(8 / stride));
    for (let off = 0; off <= seedSpan && seed < 0; off++) {
        if (hasInk(baselineRow - off)) seed = baselineRow - off;
        else if (hasInk(baselineRow + off)) seed = baselineRow + off;
    }
    let inkTop: number | null = null;
    let inkBottom: number | null = null;
    if (seed >= 0) {
        const gapTolRows = 1; // a single empty sampled row ends the band — keeps adjacent lines separate
        let top = seed;
        for (let r = seed, gap = 0; r >= 0; r--) {
            if (hasInk(r)) {
                top = r;
                gap = 0;
            } else if (++gap > gapTolRows) break;
        }
        let bot = seed;
        for (let r = seed, gap = 0; r < rowCount; r++) {
            if (hasInk(r)) {
                bot = r;
                gap = 0;
            } else if (++gap > gapTolRows) break;
        }
        inkTop = yi + top * stride;
        inkBottom = yi + (bot + 1) * stride; // inclusive of the last inky row
    }

    // Pick the text color from the EXTREME of the text cluster, not the average.
    // - If bg is light (lum > 128), text pixels should be darker → take the min-luminance pixel
    // - If bg is dark, text pixels should be lighter → take the max-luminance pixel
    const bgLum = luminance(bgC[0], bgC[1], bgC[2]);
    // Compare the two CLUSTERS, not an absolute threshold: take the darkest text pixel only when the
    // text cluster is darker than the background — so white/light text on a medium or colored
    // background samples the correct light extreme instead of a washed mid-gray.
    const textLum = luminance(clusters[1].center[0], clusters[1].center[1], clusters[1].center[2]);
    const wantsDarkest = textLum < bgLum;
    let extreme = clusters[1].center.slice();
    let extremeLum = wantsDarkest ? Infinity : -Infinity;
    // Re-assign each pixel to its cluster and find the extreme in the text cluster.
    for (const p of pixels) {
        const dA = distSq(p, clusters[0].center);
        const dB = distSq(p, clusters[1].center);
        // Belongs to text cluster (the smaller one)
        if (dB < dA) {
            const lum = luminance(p[0], p[1], p[2]);
            if ((wantsDarkest && lum < extremeLum) || (!wantsDarkest && lum > extremeLum)) {
                extremeLum = lum;
                extreme = p;
            }
        }
    }
    // Near-black small text only reaches ~#0b due to anti-aliasing of thin strokes; treat it as pure
    // black so the re-rendered glyphs match the (truly black) original neighbors exactly.
    let textC = snapToPure(extreme);
    if (luminance(textC[0], textC[1], textC[2]) < 40 && Math.max(textC[0], textC[1], textC[2]) - Math.min(textC[0], textC[1], textC[2]) < 18) {
        textC = [0, 0, 0];
    }
    return {
        bg: toHex(bgC[0], bgC[1], bgC[2]),
        text: toHex(textC[0], textC[1], textC[2]),
        bgLeft: toHex(bgLeftC[0], bgLeftC[1], bgLeftC[2]),
        bgRight: toHex(bgRightC[0], bgRightC[1], bgRightC[2]),
        inkTop,
        inkBottom,
    };
};

/** Try to read the binary font data pdfjs has loaded for a given fontName.
 *  pdfjs stores parsed/converted fonts on the page's `commonObjs` cache; once rendered,
 *  each font object exposes `.data` (Uint8Array of OpenType/TrueType bytes), `.mimetype`,
 *  and `.name` (PostScript name). This is the only way to get the font binary in-browser
 *  without parsing the PDF ourselves. */
/** Resolve the PostScript name that pdfjs assigns to a given internal font id.
 *  Used to map pdfjs's `item.fontName` (e.g. "g_d0_f1") to a real font name like
 *  "LiberationSans-Bold-2000" so we can look up the binary in pdf-lib's extracted cache. */
export const resolveFontPsName = (page: PDFPageProxy, pdfjsFontName: string): string | null => {
    try {
        const obj = (page as unknown as { commonObjs: { has: (k: string) => boolean; get: (k: string) => unknown } }).commonObjs;
        if (!obj || !obj.has(pdfjsFontName)) return null;
        const info = obj.get(pdfjsFontName) as { name?: string };
        return info?.name ?? null;
    } catch {
        return null;
    }
};

/** Extract every text item from a single page, enriched with style + color. */
export const extractTextItems = async (page: PDFPageProxy, pageNumber: number, cssWidth: number, sourceCanvas: HTMLCanvasElement): Promise<ExtractedText[]> => {
    const baseVp = page.getViewport({ scale: 1 });
    const scale = cssWidth / baseVp.width;
    const vp = page.getViewport({ scale });
    const content = await page.getTextContent();
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    // The canvas may be rendered at a higher pixel density than the CSS layout (crisp display on zoom/HiDPI).
    const pr = sourceCanvas.width / cssWidth || 1;
    const out: ExtractedText[] = [];

    const items = content.items.filter((it): it is TextItem => "str" in it);
    const styles = content.styles as Record<string, TextStyle>;
    const V = vp.transform as number[];
    // Row-vector product: item matrix (user space) followed by the viewport (CSS px, y down). This handles
    // /Rotate pages and offset CropBoxes: what matters is how the run looks ON SCREEN.
    const toScreen = (m: number[]) => [
        m[0] * V[0] + m[1] * V[2],
        m[0] * V[1] + m[1] * V[3],
        m[2] * V[0] + m[3] * V[2],
        m[2] * V[1] + m[3] * V[3],
        m[4] * V[0] + m[5] * V[2] + V[4],
        m[4] * V[1] + m[5] * V[3] + V[5],
    ];

    items.forEach((it, idx) => {
        if (!it.str.trim()) return;
        const [a, b, c, d, e, f] = it.transform;
        const [sa, sb, sc, sd, se, sf] = toScreen(it.transform);
        // Only runs that read left-to-right, horizontally, on screen get an inline chip (the editing UI is an
        // axis-aligned input). The PDF itself may be rotated — the engine works in user space regardless.
        const sx = Math.hypot(sa, sb);
        if (!(sa > 0) || Math.abs(sb) > 1e-3 * sx || Math.abs(sc) > 1e-3 * Math.hypot(sc, sd)) return;
        const pdfFontSize = Math.hypot(c, d) || Math.hypot(a, b) || 12;
        const pdfX = e;
        const pdfY = f; // baseline y in PDF user space
        const pdfWidth = it.width;
        const pdfHeight = it.height || pdfFontSize;
        const cssFontSize = Math.hypot(sc, sd) || pdfFontSize * scale;
        const cssBaselineY = sf;
        const cssX = se;
        const cssWidthPx = pdfWidth * (sx / (Math.hypot(a, b) || 1));

        const style = styles[it.fontName];
        // Use real ascent/descent ratios from pdfjs to position the chip accurately.
        // Type3 fonts report NaN/0 metrics: fall back to typical Latin proportions.
        const asc = style?.ascent;
        const desc = style?.descent;
        const ascentRatio = typeof asc === "number" && Number.isFinite(asc) && asc > 0.2 && asc < 2 ? asc : 0.75;
        const descentRatio = typeof desc === "number" && Number.isFinite(desc) && Math.abs(desc) < 1 ? Math.abs(desc) : 0.25;
        const cssAscent = cssFontSize * ascentRatio;
        const cssDescent = cssFontSize * descentRatio;
        const cssHeightPx = cssAscent + cssDescent;
        const cssY = cssBaselineY - cssAscent;

        const styleName = style?.fontFamily || "";
        const psResolved = resolveFontPsName(page, it.fontName);
        const psClean = psResolved ? psResolved.replace(/^[A-Z]{6}\+/, "") : null;
        // Build a CSS font-family that tries (in order):
        //   1. "LocalPDF-<psName>" — our re-registered FontFace from the PDF binary (PIXEL PERFECT)
        //   2. The pdfjs-internal name (loaded as @font-face by pdfjs)
        //   3. The generic family pdfjs reported
        //   4. sans-serif
        const families = [psClean ? `"LocalPDF-${psClean}"` : null, it.fontName ? `"${it.fontName}"` : null, styleName || null, "sans-serif"].filter(Boolean);
        const cssFontFamily = families.join(", ");
        // Prefer the specific PostScript name (e.g. "Arial-BoldMT", "Roboto-Bold") for family/weight/style
        // detection — pdfjs's generic CSS family is often just "sans-serif"/"serif", and "sans-serif"
        // contains the substring "serif" which would mis-detect a sans font as Times.
        const nameForStyle = psResolved || styleName;
        const family = familyFromName(nameForStyle);
        const bold = isBoldFromName(nameForStyle) || isBoldFromName(styleName);
        const italic = isItalicFromName(nameForStyle) || isItalicFromName(styleName);

        const sampleX = Math.max(0, cssX - 2) * pr;
        const sampleY = Math.max(0, cssY - cssHeightPx * 0.1) * pr;
        const sampleW = Math.min(ctx.canvas.width - sampleX, (cssWidthPx + 4) * pr);
        const sampleH = Math.min(ctx.canvas.height - sampleY, cssHeightPx * 1.2 * pr);
        const sampled = sampleBgAndText(ctx, sampleX, sampleY, sampleW, sampleH, cssBaselineY * pr);
        const { bg, text, bgLeft, bgRight } = sampled;
        const inkTop = sampled.inkTop === null ? null : sampled.inkTop / pr;
        const inkBottom = sampled.inkBottom === null ? null : sampled.inkBottom / pr;

        out.push({
            id: `${pageNumber}-${idx}`,
            page: pageNumber,
            str: it.str,
            cssX,
            cssY,
            cssWidth: cssWidthPx,
            cssHeight: cssHeightPx,
            cssBaselineY,
            cssFontSize,
            pdfX,
            pdfY,
            pdfWidth,
            pdfHeight,
            pdfFontSize,
            pdfTransform: Array.from(it.transform),
            cssFontFamily,
            family,
            bold,
            italic,
            textColor: text,
            bgColor: bg,
            bgLeft,
            bgRight,
            inkTop,
            inkBottom,
            pdfjsFontName: it.fontName,
            psFontName: psResolved,
        });
    });

    return out;
};
