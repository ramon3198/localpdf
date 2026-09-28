// PDF → Word (.docx), entirely on the device. Environment-agnostic: runs in the browser and in Node (tests); anything
// that needs a canvas or OCR comes from the ConvertEnvironment the host provides.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { FontRegistry } from "../pdf-text-engine/font-model";
import { PROTECTED_PDF_MESSAGE, UserFacingError } from "../pdf-utils";
import { extractPageGraphics } from "./extract-graphics";
import { extractPageText, linesFromOcr } from "./extract-text";
import { type VectorCrops, applyVectorArt, artUnderText, cropDpi, planVectorArt } from "./graphics-crops";
import { buildParagraphs, chooseMode, documentContext, layoutPage } from "./layout";
import { pageGeometry } from "./page-geometry";
import { pdfWithoutText } from "./strip-text";
import { detectTables, placeTableMarks } from "./tables";
import type { ConvertEnvironment, ConvertOptions, ConvertResult, PageContent, PageModel } from "./types";
import { writeDocx } from "./write-docx";

export type * from "./types";

const OCR_DPI = 300;
const BACKGROUND_DPI = 150;

const aborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Conversión cancelada", "AbortError");
};

/** Let the host paint progress and handle "Cancelar" between pages (matters when not running in a worker). */
const yieldToHost = () =>
    new Promise<void>((resolve) => {
        if (typeof MessageChannel === "undefined") return void setTimeout(resolve, 0);
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });

export const convertPdfToDocx = async (pdf: Uint8Array, env: ConvertEnvironment = {}, options: ConvertOptions = {}): Promise<ConvertResult> => {
    const { signal, onProgress } = options;
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    } catch {
        throw new UserFacingError("El archivo no es un PDF válido o está dañado.");
    }
    if (doc.isEncrypted) throw new UserFacingError(PROTECTED_PDF_MESSAGE);

    const create = (env.fontkit ?? ((bytes: Uint8Array) => fontkit.create(bytes))) as (bytes: Uint8Array) => unknown;
    const registry = new FontRegistry(doc.context, (bytes) => create(bytes) as never);
    const all = doc.getPages();
    const indices = (options.pages ?? all.map((_, i) => i)).filter((i) => i >= 0 && i < all.length);
    const useOcr = (options.ocr ?? true) && !!env.ocr && !!env.renderPage;
    const warnings: string[] = [];
    let ocrPages = 0;

    // 1. Read every page: text lines and graphics (OCR for pages without real text).
    const contents: PageContent[] = [];
    for (const [n, i] of indices.entries()) {
        aborted(signal);
        onProgress?.({ page: n + 1, pages: indices.length, stage: "reading" });
        await yieldToHost();
        const geometry = pageGeometry(all[i]);
        let lines = extractPageText(doc, i, registry, geometry);
        const graphics = await extractPageGraphics(doc, i, geometry);
        const hasText = lines.some((l) => l.runs.some((r) => r.text.trim()));
        // Without real text, anything drawn may be a scan or text turned into outlines: images (also the ones we
        // can't decode, like JBIG2/CCITT black-and-white scans), glyphs without Unicode, vector lettering.
        const looksScanned = graphics.images.length > 0 || (graphics.skippedImages?.length ?? 0) > 0 || graphics.hasComplexVector || lines.length > 0;
        if (!hasText && useOcr && looksScanned) {
            onProgress?.({ page: n + 1, pages: indices.length, stage: "ocr" });
            const image = await env.renderPage!(pdf, i, OCR_DPI);
            aborted(signal);
            const words = await env.ocr!(image, options.ocrLanguages ?? ["spa", "eng"], signal);
            lines = linesFromOcr(words, image, geometry);
            if (lines.length) ocrPages++;
        } else if (!hasText && looksScanned) {
            warnings.push(`La página ${i + 1} no tiene texto seleccionable (parece escaneada): se incluye como imagen.`);
        }
        contents.push({ index: i, width: geometry.width, height: geometry.height, lines, graphics });
    }

    // 2. Layout: tables, paragraphs, reading order; layout-mode pages get their graphics as a background.
    const context = documentContext(contents);
    const models: PageModel[] = [];
    let stripped: Uint8Array | null = null;
    for (const [n, content] of contents.entries()) {
        aborted(signal);
        onProgress?.({ page: n + 1, pages: contents.length, stage: "analysing" });
        await yieldToHost();
        const { tables, rest } = detectTables(content, (lines, cell) => buildParagraphs(lines, cell, context));
        const mode = chooseMode(content, tables, options.mode ?? "auto");
        // Vector art on a flowing page (logos, charts, icons) becomes pictures cut from the page rendered without text.
        const art = mode === "flow" && env.renderPage ? planVectorArt(content, tables) : null;
        let crops: VectorCrops = { page: new Set(), cells: [] };
        if (art) {
            try {
                stripped ??= await pdfWithoutText(pdf);
                crops = applyVectorArt(content, art, await env.renderPage!(stripped, content.index, cropDpi(content)), tables);
            } catch (err) {
                // Without the rendering the art is left out, as before; only a cancellation stops the conversion.
                if (signal?.aborted) throw err;
            }
        }
        const model = layoutPage(content, rest, tables, mode, context);
        if (mode === "flow") {
            artUnderText(model, content, crops.page);
            placeTableMarks(model, content, tables, crops.cells);
        }
        if (mode === "layout" && env.renderPage) {
            stripped ??= await pdfWithoutText(pdf);
            const image = await env.renderPage(stripped, content.index, BACKGROUND_DPI);
            model.background = { ...image, box: { x: 0, y: 0, width: content.width, height: content.height } };
        }
        models.push(model);
    }

    // 3. Word document.
    aborted(signal);
    onProgress?.({ page: contents.length, pages: contents.length, stage: "writing" });
    await yieldToHost();
    const docx = await writeDocx(models, { title: doc.getTitle() ?? undefined, loadFont: env.loadFont });

    const blocks = models.flatMap((m) => m.blocks);
    return {
        docx,
        stats: {
            pages: models.length,
            paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
            tables: blocks.filter((b) => b.kind === "table").length,
            images: blocks.filter((b) => b.kind === "image").length,
            ocrPages,
            layoutPages: models.filter((m) => m.mode === "layout").length,
            warnings,
        },
    };
};
