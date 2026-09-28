// The .docx writer: page models → WordprocessingML with docx. Every PDF page becomes exactly one Word page (a section
// per page, the section break riding on the page's last paragraph), flow pages as editable flowing text, layout
// pages as positioned frames and floating tables over their graphics. Non-Office fonts are embedded (docx-fonts.ts).
import {
    Document,
    type Paragraph as DocxParagraph,
    type FileChild,
    type ISectionPropertiesOptions,
    LineRuleType,
    OnOffElement,
    Packer,
    SectionProperties,
} from "docx";
import { type FontPlan, embeddedAdvances, fontTableXml, planFonts } from "./docx-fonts";
import { tuneForWord } from "./docx-justify";
import { ListPlanner } from "./docx-lists";
import { type PageChunk, type PageContext, writeFlowPage, writeLayoutPage } from "./docx-page";
import { tinyParagraph } from "./docx-paragraph";
import type { RunDefaults } from "./docx-text";
import { halfPoints, hexColor } from "./docx-units";
import type { ConvertEnvironment, PageModel, Paragraph } from "./types";

const FALLBACK: RunDefaults = { fontFamily: "Calibri", fontSize: 11, color: "000000" };

/** What docx takes as a font file (typed as Node's Buffer; any Uint8Array works, also in a browser worker). */
type FontData = NonNullable<ConstructorParameters<typeof Document>[0]["fonts"]>[number]["data"];

/** Every paragraph of the document, table cells included. */
const allParagraphs = (pages: PageModel[]): Paragraph[] =>
    pages.flatMap((page) =>
        page.blocks.flatMap((b) => (b.kind === "paragraph" ? [b] : b.kind === "table" ? b.rows.flatMap((r) => r.cells.flatMap((c) => c.paragraphs)) : [])),
    );

const mostCommon = <T>(counts: Map<T, number>, fallback: T): T => {
    let best = fallback;
    let n = -1;
    for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
    return best;
};

/** Default font, size and colour: the most common run style of the document, weighted by characters. */
export const documentDefaults = (pages: PageModel[]): RunDefaults => {
    const fonts = new Map<string, number>();
    const sizes = new Map<number, number>();
    const colors = new Map<string, number>();
    const add = <T>(m: Map<T, number>, k: T, n: number) => m.set(k, (m.get(k) ?? 0) + n);
    for (const p of allParagraphs(pages)) {
        const runs = p.runs.length ? p.runs : p.lines.flatMap((l) => l.runs);
        for (const r of runs) {
            const n = r.text.replace(/\s/g, "").length;
            if (!n || r.style.verticalAlign) continue;
            if (r.style.fontFamily?.trim()) add(fonts, r.style.fontFamily.trim(), n);
            if (r.style.fontSize > 0) add(sizes, Math.round(r.style.fontSize * 2) / 2, n);
            add(colors, hexColor(r.style.color) ?? "000000", n);
        }
    }
    return {
        fontFamily: mostCommon(fonts, FALLBACK.fontFamily),
        fontSize: mostCommon(sizes, FALLBACK.fontSize),
        color: mostCommon(colors, FALLBACK.color),
    };
};

/** Puts a section break (the settings of the section that ends here) into the paragraph's properties. */
const attachSection = (paragraph: DocxParagraph, properties: ISectionPropertiesOptions) => {
    const pPr = (paragraph as unknown as { properties?: { push?: (item: unknown) => void } }).properties;
    if (typeof pPr?.push !== "function") throw new Error("writeDocx: la versión de docx no permite insertar saltos de sección");
    pPr.push(new SectionProperties(properties));
};

/**
 * Word keeps the embedded fonts when the user saves the document again (w:embedTrueTypeFonts). It goes right after
 * w:displayBackgroundShape, where the schema wants it; if docx ever builds its settings differently, it is skipped
 * (Word still uses the embedded fonts, only a re-save would drop them).
 */
const keepEmbeddedFonts = (doc: Document) => {
    const root = (doc.Settings as unknown as { root?: { rootKey?: string }[] }).root;
    const at = root?.findIndex((c) => c?.rootKey === "w:displayBackgroundShape") ?? -1;
    if (root && at >= 0) root.splice(at + 1, 0, new OnOffElement("w:embedTrueTypeFonts", true) as unknown as { rootKey?: string });
};

/** docx's obfuscation keys of the embedded faces, in the order they were given. */
const fontKeys = (doc: Document, plan: FontPlan): string[] => {
    const withKeys = (doc.FontTable as unknown as { fontOptionsWithKey?: { fontKey?: string }[] }).fontOptionsWithKey ?? [];
    return plan.faces.map((_, i) => withKeys[i]?.fontKey ?? "");
};

/** A .docx (bytes) reproducing the pages: one Word page per PDF page, flow or positioned layout per page. */
export const writeDocx = async (source: PageModel[], meta: { title?: string; loadFont?: ConvertEnvironment["loadFont"] }): Promise<Uint8Array> => {
    // Justified text as Word will set it: compatibility mode and retuned paragraphs (see docx-justify.ts).
    const { compat, pages, keepRows } = tuneForWord(source);
    const defaults = documentDefaults(pages);
    // Fonts first: the layout of the text depends on whether Word will have the PDF's fonts.
    const fonts = await planFonts(pages, meta.loadFont);
    let z = 0;
    const ctx: PageContext = {
        defaults,
        lists: new ListPlanner("lista"),
        keepRows,
        compat,
        fonts: fonts.embedded,
        advances: (family, bold, italic) => embeddedAdvances(fonts, family, bold, italic),
        z: () => (z += 1),
    };

    const chunks: PageChunk[] = [];
    for (const page of pages) chunks.push(...(page.mode === "layout" ? writeLayoutPage(page, ctx) : writeFlowPage(page, ctx)));
    if (!chunks.length) {
        const carrier = tinyParagraph();
        chunks.push({ children: [carrier], carrier, properties: {} });
    }
    const body: FileChild[] = [];
    chunks.forEach((chunk, i) => {
        body.push(...chunk.children);
        if (i < chunks.length - 1) attachSection(chunk.carrier, chunk.properties);
    });

    const font = { ascii: defaults.fontFamily, hAnsi: defaults.fontFamily, cs: defaults.fontFamily, eastAsia: defaults.fontFamily };
    const neutralHeading = (level: number) => ({ run: {}, paragraph: { outlineLevel: level } });
    const title = meta.title?.trim();
    const doc = new Document({
        ...(title ? { title } : {}),
        creator: "LocalPDF",
        lastModifiedBy: "LocalPDF",
        styles: {
            default: {
                document: {
                    run: { font, size: halfPoints(defaults.fontSize), sizeComplexScript: halfPoints(defaults.fontSize), color: defaults.color },
                    // Word's own template adds 8 pt after and 1.08 lines: neutral spacing so the layout matches the PDF.
                    paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } },
                },
                // Headings keep their outline level (navigation pane, TOC) but not Word's blue/large look: the runs
                // carry the PDF's own font, size and colour.
                title: { run: {} },
                heading1: neutralHeading(0),
                heading2: neutralHeading(1),
                heading3: neutralHeading(2),
            },
        },
        // Word 2010 layout when the PDF's justified text never shrinks spaces (see docx-justify.ts).
        compatabilityModeVersion: compat,
        numbering: { config: ctx.lists.config() },
        // Embedded faces (docx obfuscates them as Word does); the font table naming them is written below.
        ...(fonts.faces.length ? { fonts: fonts.faces.map((f) => ({ name: f.family, data: f.data as unknown as FontData })) } : {}),
        sections: [{ properties: chunks[chunks.length - 1].properties, children: body }],
    });
    if (fonts.faces.length) keepEmbeddedFonts(doc);
    // docx's own font table embeds every face as the "regular" of its own entry: one entry per family instead, with
    // the faces in their slots and the substitute for the families that aren't embedded.
    const overrides = fonts.families.length ? [{ path: "word/fontTable.xml", data: fontTableXml(fonts, fontKeys(doc, fonts)) }] : [];
    return Packer.pack(doc, "uint8array", false, overrides);
};
