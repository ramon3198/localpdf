"use client";

import { type FontPackManifest, resolveUniversalFace } from "@/lib/pdf-text-engine";

/** Pixel density used to rasterise pages in the editor: at least 2× so zooming and HiDPI stay crisp, capped at 3×. */
export const renderPixelRatio = () => Math.min(3, Math.max(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));

/** Encode a canvas as an object URL (much faster and lighter than a PNG data URL for large renders). */
export const canvasToUrl = (canvas: HTMLCanvasElement): Promise<string> =>
    new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error("No se pudo rasterizar la página"))), "image/png");
    });

// ── Font pack (public/fonts/pack) ───────────────────────────────────────────────────────────────────

let manifestPromise: Promise<FontPackManifest | null> | null = null;
export const loadFontPackManifest = () =>
    (manifestPromise ??= fetch("/fonts/pack/manifest.json")
        .then((r) => (r.ok ? (r.json() as Promise<FontPackManifest>) : null))
        .catch(() => null));

const faceBytes = new Map<string, Promise<Uint8Array | null>>();
export const loadPackFace = (file: string) => {
    let p = faceBytes.get(file);
    if (!p) {
        p = fetch(`/fonts/pack/${file}`)
            .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
            .catch(() => null);
        faceBytes.set(file, p);
    }
    return p;
};

// ── Added text ("Añadir texto", notes) ──────────────────────────────────────────────────────────────
// The same two faces are used on screen and in the PDF, so what the user places is what they get:
// Inter for Latin text and the wide-coverage universal face (DejaVu) for everything Inter lacks (→ ✓ Ω α ≥ …).

const ADDED_FAMILY = "LocalPDF Added";
const ADDED_SYMBOLS_FAMILY = "LocalPDF Added Symbols";
export const ADDED_TEXT_FONT_STACK = `"${ADDED_FAMILY}", "${ADDED_SYMBOLS_FAMILY}", sans-serif`;

export const addedTextFontFiles = async () => {
    const manifest = await loadFontPackManifest();
    const latin = manifest?.families?.inter?.faces?.["400"] ?? "inter-400.ttf";
    const universal = (manifest && resolveUniversalFace(manifest, { weight: 400, italic: false, serif: false, mono: false })) ?? "universal-sans-400.ttf";
    return { latin, universal };
};

let facesPromise: Promise<void> | null = null;
/** Register the added-text faces once. The symbols face is only downloaded when a character needs it. */
export const ensureAddedTextFonts = (): Promise<void> => {
    if (typeof document === "undefined" || !document.fonts || typeof FontFace === "undefined") return Promise.resolve();
    return (facesPromise ??= (async () => {
        const { latin, universal } = await addedTextFontFiles();
        const main = new FontFace(ADDED_FAMILY, `url(/fonts/pack/${latin})`);
        const symbols = new FontFace(ADDED_SYMBOLS_FAMILY, `url(/fonts/pack/${universal})`);
        document.fonts.add(main);
        document.fonts.add(symbols);
        await main.load().catch(() => undefined);
    })());
};

/** Inter's own ascent/descent (hhea), used until the browser has measured the loaded face. */
const DEFAULT_METRICS = { ascent: 0.96875, descent: 0.2421875 };
let metrics: { ascent: number; descent: number } | null = null;

/** Ascent/descent (relative to the font size) the browser uses to lay out added text: the PDF places each baseline
 *  exactly where the editor shows it. */
export const getAddedTextMetrics = async () => {
    if (metrics) return metrics;
    try {
        await ensureAddedTextFonts();
        await document.fonts.load(`100px "${ADDED_FAMILY}"`);
        const ctx = document.createElement("canvas").getContext("2d");
        if (ctx) {
            ctx.font = `100px "${ADDED_FAMILY}"`;
            const m = ctx.measureText("Hg");
            if (m.fontBoundingBoxAscent > 0 && m.fontBoundingBoxDescent >= 0) {
                metrics = { ascent: m.fontBoundingBoxAscent / 100, descent: m.fontBoundingBoxDescent / 100 };
            }
        }
    } catch {
        /* fall back to the font's own metrics */
    }
    return metrics ?? DEFAULT_METRICS;
};

/** Distance from the top of a line box to the baseline, for a given font size and line height (CSS px). */
export const baselineInLine = (fontSize: number, lineHeight: number, m: { ascent: number; descent: number }) =>
    (lineHeight - (m.ascent + m.descent) * fontSize) / 2 + m.ascent * fontSize;

let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = () => {
    if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
    return measureCtx;
};

/** Width (CSS px) of the widest line of `text` in the given CSS font, without kerning (the PDF has none either). */
export const measureTextWidth = (text: string, font: string) => {
    const ctx = getMeasureCtx();
    const lines = text.split("\n");
    if (!ctx) return Math.max(...lines.map((l) => l.length)) * 8;
    ctx.font = font;
    (ctx as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning = "none";
    return Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
};

export const addedTextFont = (fontSize: number) => `${fontSize}px ${ADDED_TEXT_FONT_STACK}`;
