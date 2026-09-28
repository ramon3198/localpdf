"use client";

/**
 * Single pipeline that turns the editor's items into a PDF — shared by the live preview and "Aplicar
 * cambios", so what the user sees is exactly what they download.
 *
 *  1. Text edits go through the content-stream engine (true in-place replacement, same font/colour,
 *     background untouched, no ghost text).
 *  2. Runs the engine can't edit natively (e.g. the invisible OCR layer of a scanned page) fall back to
 *     the overlay path: cover the original with the sampled background and draw the new text on top.
 *  3. Added content (text, notes, shapes, drawings, images) is placed through the page viewport so it lands
 *     correctly on rotated pages and pages with an offset CropBox. Added text uses the same faces the editor
 *     shows (Inter + a wide-coverage face), so any character can be written; characters no bundled face has
 *     (emoji, CJK…) are drawn as an image of the text instead of failing.
 */
import { BlendMode, type PDFDocument, type PDFFont, type PDFPage, StandardFonts, degrees, rgb } from "pdf-lib";
import type { PageViewport } from "pdfjs-dist";
import { type ExtractedFontBinary, resolveBestFont } from "@/lib/font-extractor";
import { type DocTextEdit, type FallbackRequest, applyTextEdits, resolvePackFace, resolveUniversalFace } from "@/lib/pdf-text-engine";
import { loadPdfForEditing } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import {
    ADDED_TEXT_LINE_HEIGHT,
    EDITOR_CSS_WIDTH,
    type EditorItem,
    HIGHLIGHT_OPACITY,
    NOTE_PADDING,
    type TextEditItem,
    type TextItem,
    noteBorderColor,
    textEditIsNoop,
} from "./editor-types";
import {
    addedTextFont,
    addedTextFontFiles,
    baselineInLine,
    canvasToUrl,
    getAddedTextMetrics,
    loadFontPackManifest,
    loadPackFace,
    measureTextWidth,
} from "./render-utils";

/** "clipped": rewritten natively, but part of the new text falls outside its clip (a table cell) and is hidden. */
export type EditMode = "native" | "clipped" | "overlay" | "failed";
export type BuildStats = {
    native: number;
    overlay: number;
    failed: { id: string; reason: string }[];
    modes: Record<string, EditMode>;
    /** Added texts drawn as an image because no bundled face has some of their characters. */
    rasterizedText: number;
};

type Fontkit = { create: (b: Uint8Array) => unknown };
type FkFont = { hasGlyphForCodePoint?: (cp: number) => boolean };

const hexToRgb01 = (hex: string) => {
    const m = hex.replace("#", "").match(/.{2}/g);
    if (!m) return rgb(0, 0, 0);
    const [r, g, b] = m.map((h) => parseInt(h, 16) / 255);
    return rgb(r, g, b);
};
const hexToTuple = (hex: string): [number, number, number] => {
    const m = hex.replace("#", "").match(/.{2}/g) ?? ["00", "00", "00"];
    return [parseInt(m[0], 16) / 255, parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255];
};

const standardFor = (family: "helvetica" | "times" | "courier", bold: boolean, italic: boolean): StandardFonts => {
    if (family === "times")
        return bold && italic
            ? StandardFonts.TimesRomanBoldItalic
            : bold
              ? StandardFonts.TimesRomanBold
              : italic
                ? StandardFonts.TimesRomanItalic
                : StandardFonts.TimesRoman;
    if (family === "courier")
        return bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
              ? StandardFonts.CourierBold
              : italic
                ? StandardFonts.CourierOblique
                : StandardFonts.Courier;
    return bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
          ? StandardFonts.HelveticaBold
          : italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
};

// ── Page geometry: editor CSS px ↔ PDF user space ──────────────────────────────────────────────────

type PageMapper = {
    scale: number;
    rotate: number;
    pt: (x: number, y: number) => [number, number];
    /** CSS box (top-left, y down) → pdf-lib placement (bottom-left origin + rotation). */
    box: (x: number, y: number, w: number, h: number) => { x: number; y: number; width: number; height: number; rotate: ReturnType<typeof degrees> };
};

const makeMapper = (vp: PageViewport, rotate: number): PageMapper => {
    const scale = vp.scale;
    const pt = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
    return {
        scale,
        rotate,
        pt,
        box: (x, y, w, h) => {
            const [px, py] = pt(x, y + h);
            return { x: px, y: py, width: w / scale, height: h / scale, rotate: degrees(rotate) };
        },
    };
};

// ── Build ───────────────────────────────────────────────────────────────────────────────────────────

export const buildEditedPdf = async (
    source: ArrayBuffer | Uint8Array,
    items: EditorItem[],
    fontBinaries: Map<string, ExtractedFontBinary>,
): Promise<{ bytes: Uint8Array; stats: BuildStats }> => {
    const src = source instanceof Uint8Array ? source : new Uint8Array(source);
    const doc = await loadPdfForEditing(src);
    const fontkitMod = await import("@pdf-lib/fontkit");
    const fontkit = (fontkitMod.default ?? fontkitMod) as unknown as Fontkit;
    doc.registerFontkit(fontkit as Parameters<typeof doc.registerFontkit>[0]);
    const stats: BuildStats = { native: 0, overlay: 0, failed: [], modes: {}, rasterizedText: 0 };

    // Page mappers from pdfjs (same scale the editor renders at).
    const pdfjs = await getPdfjs();
    const jsDoc = await pdfjs.getDocument({ data: src.slice() }).promise;
    const mappers = new Map<number, PageMapper>();
    for (const p of new Set(items.map((it) => it.page))) {
        const page = await jsDoc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        mappers.set(p, makeMapper(page.getViewport({ scale: EDITOR_CSS_WIDTH / base.width }), page.rotate));
    }

    // 1) Native text edits.
    const textEdits = items.filter((it): it is TextEditItem => it.type === "textEdit" && !textEditIsNoop(it));
    const fallbackFonts = new Map<string, PDFFont>();
    const embedPackFace = async (file: string, subset = true): Promise<PDFFont | null> => {
        const hit = fallbackFonts.get(file);
        if (hit) return hit;
        const bytes = await loadPackFace(file);
        if (!bytes) return null;
        try {
            const f = await doc.embedFont(bytes, { subset });
            fallbackFonts.set(file, f);
            return f;
        } catch {
            return null;
        }
    };
    const fallback = async (r: FallbackRequest): Promise<PDFFont | null> => {
        if (r.universal) {
            // Characters no Latin face has (→ ✓ Ω α ≥): one wide-coverage face of the same class and style.
            const manifest = await loadFontPackManifest();
            const file = manifest ? resolveUniversalFace(manifest, r) : null;
            // Embedded whole: fontkit's subsetter loses DejaVu's glyph outlines.
            return file ? embedPackFace(file, false) : null;
        }
        const manifest = r.standardOnly ? null : await loadFontPackManifest();
        const face = manifest ? resolvePackFace(manifest, r.baseFont, { weight: r.weight, italic: r.italic, family: r.family }) : null;
        if (face) {
            const f = await embedPackFace(face.file);
            if (f) return f;
        }
        const key = standardFor(r.mono ? "courier" : r.serif ? "times" : "helvetica", r.bold, r.italic);
        let f = fallbackFonts.get(key);
        if (!f) {
            f = await doc.embedFont(key);
            fallbackFonts.set(key, f);
        }
        return f;
    };
    const engineEdits: DocTextEdit[] = textEdits.map((it) => ({
        pageIndex: it.page - 1,
        target: { transform: it.pdfTransform, width: it.pdfWidth, str: it.str },
        newText: it.newText,
        style: {
            color: it.textColor.toLowerCase() !== it.origTextColor.toLowerCase() ? hexToTuple(it.textColor) : null,
            sizeScale: Math.abs(it.cssFontSize - it.origCssFontSize) > 0.01 ? it.cssFontSize / it.origCssFontSize : null,
            forceStyle: it.bold !== it.origBold || it.italic !== it.origItalic ? { bold: it.bold, italic: it.italic } : null,
        },
    }));
    const results = await applyTextEdits(doc, engineEdits, {
        fallback,
        fontkitFactory: (b) => fontkit.create(b) as never,
        // Scanned pages: rewrite the invisible OCR layer too, so search/copy return the new text.
        allowInvisible: true,
    });

    // 2) Overlay fallback for the runs the engine could not rewrite.
    const overlay = new OverlayPainter(doc, fontBinaries, fontkit);
    for (let i = 0; i < textEdits.length; i++) {
        const it = textEdits[i];
        const r = results[i];
        if (r?.ok && !r.invisible) {
            stats.native++;
            stats.modes[it.id] = r.clipped ? "clipped" : "native";
            continue;
        }
        const mapper = mappers.get(it.page);
        if (!mapper) continue;
        try {
            // Scanned page whose OCR layer was rewritten natively: the visible change belongs in the image layer
            // (like the rest of the scan) so the text isn't extracted twice.
            await overlay.paint(doc.getPage(it.page - 1), it, mapper, { rasterText: !!(r?.ok && r.invisible) });
            stats.overlay++;
            // Scanned pages are edited as faithfully as the medium allows — not flagged as approximate.
            stats.modes[it.id] = r?.ok && r.invisible ? "native" : "overlay";
        } catch (err) {
            stats.failed.push({ id: it.id, reason: err instanceof Error ? err.message : String(err) });
            stats.modes[it.id] = "failed";
        }
        if (typeof console !== "undefined")
            console.info(`[editor] overlay for "${it.str}": ${r?.ok ? "visible pixels are an image (OCR layer rewritten)" : r?.reason}`);
    }

    // 3) Added content. One broken item (an unreadable image…) must not cost the user every other change.
    const added = new AddedTextPainter(doc, fontkit);
    for (const it of items) {
        if (it.type === "textEdit") continue;
        const mapper = mappers.get(it.page);
        if (!mapper) continue;
        const page = doc.getPage(it.page - 1);
        const s = mapper.scale;
        try {
            if (it.type === "text") {
                if ((await added.draw(page, it, mapper)) === "raster") stats.rasterizedText++;
            } else if (it.type === "rectangle") {
                // CSS draws the border inside the box; PDF strokes are centred on the path.
                const inset = it.strokeWidth / 2;
                page.drawRectangle({
                    ...mapper.box(it.x + inset, it.y + inset, Math.max(0, it.width - it.strokeWidth), Math.max(0, it.height - it.strokeWidth)),
                    borderColor: hexToRgb01(it.stroke),
                    borderWidth: it.strokeWidth / s,
                    color: it.fill ? hexToRgb01(it.fill) : undefined,
                });
            } else if (it.type === "highlight") {
                page.drawRectangle({
                    ...mapper.box(it.x, it.y, it.width, it.height),
                    color: hexToRgb01(it.color),
                    opacity: HIGHLIGHT_OPACITY,
                    blendMode: BlendMode.Multiply,
                });
            } else if (it.type === "drawing") {
                for (let k = 1; k < it.points.length; k++) {
                    const [ax, ay] = mapper.pt(it.points[k - 1].x, it.points[k - 1].y);
                    const [bx, by] = mapper.pt(it.points[k].x, it.points[k].y);
                    page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: it.width / s, color: hexToRgb01(it.color), lineCap: 1 });
                }
            } else if (it.type === "image") {
                const bytes = await (await fetch(it.dataUrl)).arrayBuffer();
                const img = it.isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
                page.drawImage(img, mapper.box(it.x, it.y, it.width, it.height));
            }
        } catch (err) {
            stats.failed.push({ id: it.id, reason: err instanceof Error ? err.message : String(err) });
            if (typeof console !== "undefined") console.warn("[editor] could not add item", it.type, err);
        }
    }

    const bytes = await doc.save();
    void jsDoc.destroy();
    return { bytes, stats };
};

// ── Added text (Inter + universal face, image fallback) ─────────────────────────────────────────────

type Face = { font: PDFFont; fk: FkFont };

class AddedTextPainter {
    private latin: Promise<Face | null> | null = null;
    private universalFk: Promise<FkFont | null> | null = null;
    private universalFont: Promise<PDFFont | null> | null = null;

    constructor(
        private readonly doc: PDFDocument,
        private readonly fontkit: Fontkit,
    ) {}

    private loadLatin() {
        return (this.latin ??= (async () => {
            const { latin } = await addedTextFontFiles();
            const bytes = await loadPackFace(latin);
            if (!bytes) return null;
            try {
                const fk = this.fontkit.create(bytes) as FkFont;
                const font = await this.doc.embedFont(bytes, { subset: true });
                return { font, fk };
            } catch {
                return null;
            }
        })());
    }

    private loadUniversalFk() {
        return (this.universalFk ??= (async () => {
            const { universal } = await addedTextFontFiles();
            const bytes = await loadPackFace(universal);
            try {
                return bytes ? (this.fontkit.create(bytes) as FkFont) : null;
            } catch {
                return null;
            }
        })());
    }

    private loadUniversalFont() {
        return (this.universalFont ??= (async () => {
            const { universal } = await addedTextFontFiles();
            const bytes = await loadPackFace(universal);
            try {
                // Embedded whole: fontkit's subsetter loses DejaVu's glyph outlines.
                return bytes ? await this.doc.embedFont(bytes, { subset: false }) : null;
            } catch {
                return null;
            }
        })());
    }

    /** Split a line into runs per face, like the browser's per-character font fallback. null = some character has no face. */
    private segment(line: string, latin: FkFont, universal: FkFont | null) {
        const runs: { face: "latin" | "universal"; text: string }[] = [];
        for (const ch of line) {
            const cp = ch.codePointAt(0) ?? 0;
            let face: "latin" | "universal" | null = latin.hasGlyphForCodePoint?.(cp) ? "latin" : universal?.hasGlyphForCodePoint?.(cp) ? "universal" : null;
            if (!face) return null;
            // Keep spaces in the current run (both faces have them) so runs don't fragment.
            if (/\s/.test(ch) && runs.length) face = runs[runs.length - 1].face;
            const last = runs[runs.length - 1];
            if (last && last.face === face) last.text += ch;
            else runs.push({ face, text: ch });
        }
        return runs;
    }

    async draw(page: PDFPage, it: TextItem, m: PageMapper): Promise<"vector" | "raster" | "empty"> {
        if (!it.text.trim()) return "empty";
        const lines = it.text.split("\n");
        const fs = it.fontSize;
        const lh = fs * ADDED_TEXT_LINE_HEIGHT;
        const baseOff = baselineInLine(fs, lh, await getAddedTextMetrics());
        const size = fs / m.scale;

        const latin = await this.loadLatin();
        const needsUniversal = latin ? lines.some((l) => [...l].some((ch) => !latin.fk.hasGlyphForCodePoint?.(ch.codePointAt(0) ?? 0))) : false;
        const universalFk = needsUniversal ? await this.loadUniversalFk() : null;
        const segments = latin ? lines.map((l) => this.segment(l, latin.fk, universalFk)) : null;
        const vector = !!latin && !!segments && segments.every(Boolean);
        const universal = vector && segments!.some((runs) => runs!.some((r) => r.face === "universal")) ? await this.loadUniversalFont() : null;
        const canDrawVector = vector && (!needsUniversal || !!universal);

        // Width of the widest line (CSS px) — sizes the note's paper.
        let textW: number;
        if (canDrawVector) {
            textW = Math.max(
                0,
                ...segments!.map(
                    (runs) => runs!.reduce((w, r) => w + (r.face === "latin" ? latin!.font : universal!).widthOfTextAtSize(r.text, size), 0) * m.scale,
                ),
            );
        } else {
            textW = measureTextWidth(it.text, addedTextFont(fs));
        }

        if (it.note) {
            const bg = it.background ?? "#fef08a";
            page.drawRectangle({
                ...m.box(it.x - NOTE_PADDING.x, it.y - NOTE_PADDING.y, textW + NOTE_PADDING.x * 2, lines.length * lh + NOTE_PADDING.y * 2),
                color: hexToRgb01(bg),
                borderColor: hexToRgb01(noteBorderColor(bg)),
                borderWidth: 1 / m.scale,
            });
        }

        if (!canDrawVector) {
            await this.raster(page, it, m, lines, textW, lh, baseOff);
            return "raster";
        }

        // Baseline direction on the page (handles /Rotate): one CSS px to the right, in PDF units.
        const [ox, oy] = m.pt(0, 0);
        const [dx, dy] = m.pt(100, 0);
        const len = Math.hypot(dx - ox, dy - oy) || 1;
        const ux = (dx - ox) / len;
        const uy = (dy - oy) / len;
        const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
        const color = hexToRgb01(it.color);
        segments!.forEach((runs, i) => {
            let [x, y] = m.pt(it.x, it.y + i * lh + baseOff);
            for (const r of runs!) {
                const font = r.face === "latin" ? latin!.font : universal!;
                page.drawText(r.text, { x, y, size, font, color, rotate: degrees(angle) });
                const w = font.widthOfTextAtSize(r.text, size);
                x += w * ux;
                y += w * uy;
            }
        });
        return "vector";
    }

    /** Characters no bundled face has: draw the text with the browser's fonts into an image, exactly as on screen. */
    private async raster(page: PDFPage, it: TextItem, m: PageMapper, lines: string[], textW: number, lh: number, baseOff: number) {
        const up = 4;
        const w = Math.max(1, Math.ceil(textW + 2));
        const h = Math.max(1, Math.ceil(lines.length * lh));
        const canvas = document.createElement("canvas");
        canvas.width = w * up;
        canvas.height = h * up;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas no disponible");
        const font = addedTextFont(it.fontSize);
        try {
            await document.fonts.load(font, it.text);
        } catch {
            /* system fonts */
        }
        ctx.scale(up, up);
        ctx.font = font;
        (ctx as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning = "none";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = it.color;
        lines.forEach((line, i) => ctx.fillText(line, 0, i * lh + baseOff));
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
        if (!blob) throw new Error("No se pudo dibujar el texto");
        const img = await this.doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
        page.drawImage(img, m.box(it.x, it.y, w, h));
    }
}

// ── Overlay fallback (cover + redraw) ───────────────────────────────────────────────────────────────

class OverlayPainter {
    private embedded = new Map<string, PDFFont | null>();
    private fkFonts = new Map<string, FkFont | null>();
    private std = new Map<StandardFonts, PDFFont>();

    constructor(
        private readonly doc: PDFDocument,
        private readonly fontBinaries: Map<string, ExtractedFontBinary>,
        private readonly fontkit: Fontkit,
    ) {}

    private async sourceFont(ps: string | null) {
        if (!ps) return null;
        if (this.embedded.has(ps)) return this.embedded.get(ps) ?? null;
        const info = resolveBestFont(this.fontBinaries, ps);
        let f: PDFFont | null = null;
        if (info) {
            try {
                f = await this.doc.embedFont(info.bytes, { subset: false });
            } catch {
                f = null;
            }
        }
        this.embedded.set(ps, f);
        return f;
    }

    private covers(text: string, ps: string | null) {
        if (!ps) return false;
        let fk = this.fkFonts.get(ps);
        if (fk === undefined) {
            const info = resolveBestFont(this.fontBinaries, ps);
            try {
                fk = info ? (this.fontkit.create(info.bytes) as FkFont) : null;
            } catch {
                fk = null;
            }
            this.fkFonts.set(ps, fk ?? null);
        }
        if (!fk?.hasGlyphForCodePoint) return false;
        for (const ch of text) {
            if (ch === " ") continue;
            const cp = ch.codePointAt(0);
            if (cp === undefined || !fk.hasGlyphForCodePoint(cp)) return false;
        }
        return true;
    }

    private async standard(key: StandardFonts) {
        let f = this.std.get(key);
        if (!f) {
            f = await this.doc.embedFont(key);
            this.std.set(key, f);
        }
        return f;
    }

    /** Cover the run with a left→right gradient patch feathered on its left/right edges, optionally with the new
     *  text rasterised into the same image (used on scanned pages). */
    private async cover(page: PDFPage, it: TextEditItem, m: PageMapper, x: number, y: number, w: number, h: number, text?: { font: string; baseline: number }) {
        const feather = 2;
        const totalW = w + feather * 2;
        const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
        const c = canvas?.getContext("2d") ?? null;
        if (canvas && c) {
            const up = 4;
            canvas.width = Math.max(2, Math.ceil(totalW * up));
            canvas.height = Math.max(2, Math.ceil(h * up));
            c.scale(up, up);
            const grad = c.createLinearGradient(0, 0, totalW, 0);
            grad.addColorStop(0, it.bgLeft || it.bgColor);
            grad.addColorStop(1, it.bgRight || it.bgColor);
            c.fillStyle = grad;
            c.fillRect(0, 0, totalW, h);
            c.globalCompositeOperation = "destination-out";
            const ramp = (x0: number, x1: number) => {
                const g = c.createLinearGradient(x0, 0, x1, 0);
                g.addColorStop(0, "rgba(0,0,0,1)");
                g.addColorStop(1, "rgba(0,0,0,0)");
                return g;
            };
            c.fillStyle = ramp(0, feather);
            c.fillRect(0, 0, feather, h);
            c.fillStyle = ramp(totalW, totalW - feather);
            c.fillRect(totalW - feather, 0, feather, h);
            c.globalCompositeOperation = "source-over";
            if (text) {
                if (document.fonts) {
                    try {
                        await document.fonts.load(text.font);
                    } catch {
                        /* system font */
                    }
                }
                c.font = text.font;
                c.textBaseline = "alphabetic";
                c.fillStyle = it.textColor;
                c.fillText(it.newText, feather + 1, text.baseline);
            }
            const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
            if (blob) {
                const img = await this.doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
                page.drawImage(img, m.box(x - feather, y, totalW, h));
                return;
            }
        }
        page.drawRectangle({ ...m.box(x, y, w, h), color: hexToRgb01(it.bgColor) });
    }

    async paint(page: PDFPage, it: TextEditItem, m: PageMapper, opts: { rasterText?: boolean } = {}) {
        const inkT = it.inkTop != null ? Math.max(it.inkTop, it.cssY) : it.cssY;
        const inkB = it.inkBottom != null ? Math.min(it.inkBottom, it.cssY + it.cssHeight) : it.cssY + it.cssHeight;
        const size = it.cssFontSize / m.scale;

        if (opts.rasterText) {
            const cssFont = `${it.italic ? "italic " : ""}${it.bold ? 700 : 400} ${it.cssFontSize}px ${
                it.family === "times"
                    ? '"Times New Roman", Tinos, serif'
                    : it.family === "courier"
                      ? '"Courier New", Cousine, monospace'
                      : "Arial, Arimo, Helvetica, sans-serif"
            }`;
            const measure = document.createElement("canvas").getContext("2d");
            let newW = it.cssWidth;
            if (measure) {
                measure.font = cssFont;
                newW = measure.measureText(it.newText).width;
            }
            // Cover the whole line box so ascenders/descenders of the new text fit.
            const top = Math.min(inkT, it.cssY) - 1;
            const bottom = Math.max(inkB, it.cssY + it.cssHeight) + 1;
            await this.cover(page, it, m, it.cssX - 1, top, Math.max(it.cssWidth, newW) + 3, bottom - top, { font: cssFont, baseline: it.cssBaselineY - top });
            return;
        }

        const coverTop = inkT - 1;
        const coverH = Math.max(2, inkB - inkT + 2);
        const [bx, by] = m.pt(it.cssX, it.cssBaselineY);
        const color = hexToRgb01(it.textColor);
        let font = (await this.sourceFont(it.psFontName)) && this.covers(it.newText, it.psFontName) ? await this.sourceFont(it.psFontName) : null;
        if (!font) {
            const std = await this.standard(standardFor(it.family, it.bold, it.italic));
            try {
                std.encodeText(it.newText);
                font = std;
            } catch {
                font = null;
            }
        }
        if (!font) {
            // No PDF font has these characters (e.g. CJK): draw them with the browser's fonts into the patch.
            await this.paint(page, it, m, { rasterText: true });
            return;
        }
        const newW = font.widthOfTextAtSize(it.newText, size) * m.scale;
        await this.cover(page, it, m, it.cssX - 1, coverTop, Math.max(it.cssWidth, newW) + 2, coverH);
        page.drawText(it.newText, { x: bx, y: by, size, font, color, rotate: degrees(m.rotate) });
    }
}

// ── Live preview ────────────────────────────────────────────────────────────────────────────────────

/** A text run of the rendered preview page, in editor CSS px — lets the editor outline an edited run where the
 *  engine actually placed it (right-aligned and centred runs move when their text changes). */
export type PreviewRun = { str: string; x: number; w: number; baseline: number; size: number };

/** Render one page of a PDF at the editor's canvas scale, plus the positions of its text runs. */
export const renderPreviewPage = async (bytes: Uint8Array, pageNumber: number, pixelRatio = 1): Promise<{ url: string; runs: PreviewRun[] }> => {
    const pdfjs = await getPdfjs();
    const jsDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    try {
        const page = await jsDoc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const scale = EDITOR_CSS_WIDTH / base.width;
        const vp = page.getViewport({ scale: scale * pixelRatio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("Canvas no disponible");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        const url = await canvasToUrl(canvas);

        const runs: PreviewRun[] = [];
        try {
            const V = page.getViewport({ scale }).transform as number[];
            const content = await page.getTextContent();
            for (const item of content.items) {
                if (!("str" in item) || !item.str.trim()) continue;
                const [a, b, c, d, e, f] = item.transform as number[];
                const sa = a * V[0] + b * V[2];
                const sb = a * V[1] + b * V[3];
                const sc = c * V[0] + d * V[2];
                const sd = c * V[1] + d * V[3];
                const sx = Math.hypot(sa, sb);
                if (!(sa > 0) || Math.abs(sb) > 1e-3 * sx) continue;
                runs.push({
                    str: item.str,
                    x: e * V[0] + f * V[2] + V[4],
                    w: item.width * (sx / (Math.hypot(a, b) || 1)),
                    baseline: e * V[1] + f * V[3] + V[5],
                    size: Math.hypot(sc, sd),
                });
            }
        } catch {
            /* outlines fall back to the original run's box */
        }
        return { url, runs };
    } finally {
        void jsDoc.destroy();
    }
};

/** Render one page of a PDF to an image URL at the editor's canvas scale. */
export const renderPageDataUrl = async (bytes: Uint8Array, pageNumber: number, pixelRatio = 1): Promise<string> =>
    (await renderPreviewPage(bytes, pageNumber, pixelRatio)).url;
