import type { PDFDocument } from "pdf-lib";
import type { FontRegistry } from "../pdf-text-engine/font-model";
import type { PageGeometry } from "./page-geometry";
import { readGlyphs } from "./text-glyphs";
import { groupLines, toTextLine } from "./text-lines";
import { ocrTextLines } from "./text-ocr";
import type { OcrWord, RenderedImage, TextLine } from "./types";

/** Reading order of lines: horizontal text top to bottom then left to right; rotated text after, by position. */
const byPosition = (a: TextLine, b: TextLine) => {
    const ra = a.rotation ? 1 : 0;
    const rb = b.rotation ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const dy = a.baseline - b.baseline;
    if (Math.abs(dy) > 0.2 * Math.min(a.fontSize, b.fontSize)) return dy;
    return a.box.x - b.box.x;
};

/**
 * Every text line of a page in display space, left to right and top to bottom, with Word-ready styles (family,
 * size, bold, italic, colour, super/subscript, letter-spacing, links from Link annotations). Lines drawn invisibly
 * (render mode 3, OCR layers) are included with `invisible: true`.
 */
export const extractPageText = (doc: PDFDocument, pageIndex: number, registry: FontRegistry, geometry: PageGeometry): TextLine[] => {
    const page = doc.getPage(pageIndex);
    let glyphs;
    try {
        glyphs = readGlyphs(doc, page, registry, geometry);
    } catch {
        // A page whose content can't be interpreted contributes no text (its graphics may still be converted).
        return [];
    }
    const lines: TextLine[] = [];
    try {
        for (const group of groupLines(glyphs)) {
            const line = toTextLine(group);
            if (line) lines.push(line);
        }
    } catch {
        // Unexpected glyph data: keep the lines built so far rather than failing the conversion.
    }
    return lines.sort(byPosition);
};

/** Lines that came from OCR (the layout drops the scan they were read from). */
export const ocrLines = new WeakSet<TextLine>();

/** Lines built from OCR words of a rendered page (image pixels → page points), in reading order (see text-ocr). */
export const linesFromOcr = (words: OcrWord[], image: RenderedImage, page: { width: number; height: number }): TextLine[] => {
    let lines: TextLine[] = [];
    try {
        lines = ocrTextLines(words, image, page);
    } catch {
        // Unexpected OCR output: the page keeps its scan.
        lines = [];
    }
    for (const l of lines) ocrLines.add(l);
    return lines.sort(byPosition);
};
