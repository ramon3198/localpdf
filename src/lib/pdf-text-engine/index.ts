/**
 * pdf-text-engine — in-place PDF text editing at the content-stream level.
 *
 * Usage:
 *   const results = await applyTextEdits(doc, edits, { fallback, fontkitFactory });
 * Each result says whether the edit was applied natively (original glyphs replaced inside the
 * content stream) or must be handled by the caller's fallback path.
 */
import type { PDFDocument } from "pdf-lib";
import { FontRegistry, type FontkitFactory } from "./font-model";
import { type EditResult, type EditStyle, type FallbackProvider, PageTextEditor, type RunTarget } from "./page-text-editor";
import { interpretPage } from "./text-interpreter";

export { describeFont, PageTextEditor } from "./page-text-editor";
export type { EditRequest, EditResult, EditStyle, FallbackProvider, FallbackRequest, RunTarget } from "./page-text-editor";
export { FontRegistry } from "./font-model";
export { familyCandidates, resolvePackFace, resolveUniversalFace, wantedStyle } from "./font-pack";
export type { FontPackManifest } from "./font-pack";
export type { FontkitFactory } from "./font-model";

export type DocTextEdit = { pageIndex: number; target: RunTarget; newText: string; style?: EditStyle };

export type ApplyOptions = {
    fallback: FallbackProvider;
    fontkitFactory?: FontkitFactory | null;
    /** Pages scanned up-front to learn which glyphs each subset font really contains. */
    prescanPageLimit?: number;
    /** Also rewrite invisible (OCR) text layers — the caller must still paint the visible change. */
    allowInvisible?: boolean;
    /** Diagnostics sink. */
    debug?: (msg: string) => void;
};

export const applyTextEdits = async (doc: PDFDocument, edits: DocTextEdit[], opts: ApplyOptions): Promise<EditResult[]> => {
    const results: EditResult[] = new Array(edits.length);
    if (!edits.length) return results;
    const registry = new FontRegistry(doc.context, opts.fontkitFactory ?? null);

    // Glyph availability for subset fonts is learned from the codes the document draws. The edited page is
    // always interpreted; the rest of the document is scanned lazily, only if a glyph is missing there.
    const pages = doc.getPages();
    const limit = Math.min(pages.length, opts.prescanPageLimit ?? 400);
    let scanned = false;
    const scanDocument = () => {
        if (scanned) return false;
        scanned = true;
        for (let i = 0; i < limit; i++) {
            try {
                const node = pages[i].node;
                interpretPage(doc.context, node, node.Resources() ?? null, registry);
            } catch {
                /* a broken page must not block edits elsewhere */
            }
        }
        registry.documentScanned = limit === pages.length;
        return true;
    };

    const byPage = new Map<number, number[]>();
    edits.forEach((e, i) => {
        if (!byPage.has(e.pageIndex)) byPage.set(e.pageIndex, []);
        byPage.get(e.pageIndex)!.push(i);
    });
    for (const [pageIndex, idxs] of byPage) {
        try {
            const editor = new PageTextEditor(doc, pageIndex, registry, opts.fallback, scanDocument);
            editor.debug = opts.debug ?? null;
            const res = await editor.applyAll(
                idxs.map((i) => ({ target: edits[i].target, newText: edits[i].newText, style: edits[i].style })),
                { allowInvisible: opts.allowInvisible },
            );
            idxs.forEach((i, k) => (results[i] = res[k]));
            editor.commit();
        } catch (err) {
            for (const i of idxs) results[i] ??= { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
    }
    registry.writeAdditions();
    return results;
};
