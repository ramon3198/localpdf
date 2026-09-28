// A copy of the PDF with every text object removed — from the page content streams and from the Form XObjects they
// paint — so a renderer draws only the page's graphics (backgrounds for layout-mode pages, behind positioned text).
// Operators inside BT…ET that change the graphics state (colour, ExtGState, line width, marked content…) are kept:
// the state they set outlives the text object and may colour later drawing.
import { type PDFContext, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";
import { type ContentOp, parseContentStream } from "../pdf-text-engine/content-lexer";
import { streamBytes } from "../pdf-text-engine/font-model";
import { pageContentBytes } from "../pdf-text-engine/text-interpreter";

const N = (s: string) => PDFName.of(s);

/** Text-object delimiters, text positioning and text showing (§9.4); text state operators are harmless and kept. */
const TEXT_OPS = new Set(["BT", "ET", "Tj", "TJ", "'", '"', "Td", "TD", "Tm", "T*"]);
const SHOW_OPS = new Set(["Tj", "TJ", "'", '"']);

/**
 * Content without text. Returns null when the stream has no text. Text drawn in a clipping render mode (Tr 4–7)
 * would have limited later painting to the glyph shapes; without the glyphs nothing of that painting shows, so an
 * empty clip takes its place.
 */
export const stripTextOps = (bytes: Uint8Array): Uint8Array | null => {
    const ops: ContentOp[] = parseContentStream(bytes);
    if (!ops.some((o) => TEXT_OPS.has(o.op))) return null;
    const parts: Uint8Array[] = [];
    let size = 0;
    const push = (b: Uint8Array) => {
        parts.push(b, NEWLINE);
        size += b.length + 1;
    };
    let tr = 0;
    const trStack: number[] = [];
    let clipText = false;
    for (const op of ops) {
        switch (op.op) {
            case "q":
                trStack.push(tr);
                break;
            case "Q":
                if (trStack.length) tr = trStack.pop()!;
                break;
            case "Tr":
                if (op.args[0]?.t === "num") tr = op.args[0].v;
                break;
            case "BT":
                clipText = false;
                break;
        }
        if (SHOW_OPS.has(op.op) && tr >= 4 && tr <= 7) clipText = true;
        if (op.op === "ET" && clipText) {
            push(EMPTY_CLIP);
            clipText = false;
        }
        if (TEXT_OPS.has(op.op)) continue;
        push(bytes.subarray(op.start, op.end));
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};

const NEWLINE = new Uint8Array([0x0a]);
const EMPTY_CLIP = new Uint8Array([...("0 0 0 0 re W n" as string)].map((c) => c.charCodeAt(0)));

/** Copies a stream's dictionary without its encoding entries, for a re-encoded replacement. */
const plainDict = (stream: PDFStream): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of stream.dict.entries()) {
        const key = k.decodeText();
        if (key === "Filter" || key === "DecodeParms" || key === "Length" || key === "DL") continue;
        out[key] = v;
    }
    return out;
};

/** Strips text from every Form XObject reachable from `resources`, replacing each changed form in place. */
const stripForms = (context: PDFContext, resources: PDFDict | undefined, seen: Set<string>, depth: number) => {
    if (!resources || depth > 12) return;
    const xobjects = context.lookup(resources.get(N("XObject")));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
        const ref = value instanceof PDFRef ? value : null;
        const key = ref ? ref.toString() : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const stream = ref ? context.lookup(ref) : value;
        if (!(stream instanceof PDFStream)) continue;
        const subtype = stream.dict.get(N("Subtype"));
        if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Form") continue;
        try {
            const inner = context.lookup(stream.dict.get(N("Resources")));
            stripForms(context, inner instanceof PDFDict ? inner : resources, seen, depth + 1);
            const bytes = streamBytes(stream);
            const stripped = bytes && stripTextOps(bytes);
            if (!stripped) continue;
            const replacement = context.flateStream(stripped, plainDict(stream) as never);
            if (ref) context.assign(ref, replacement);
            else {
                for (const [k, v] of xobjects.entries()) if (v === value) xobjects.set(k, context.register(replacement));
            }
        } catch {
            /* this form keeps its text */
        }
    }
};

/** The same PDF with all text removed from every page (content streams and the forms they paint), for backgrounds. */
export const pdfWithoutText = async (pdf: Uint8Array): Promise<Uint8Array> => {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    const context = doc.context;
    const seen = new Set<string>();
    for (const page of doc.getPages()) {
        // A page (or form) that can't be rewritten keeps its content: its background shows the text too.
        try {
            const node = page.node;
            const bytes = pageContentBytes(context, node);
            const stripped = stripTextOps(bytes);
            if (stripped) node.set(N("Contents"), context.register(context.flateStream(stripped)));
            stripForms(context, node.Resources(), seen, 0);
        } catch {
            /* keep the page as it is */
        }
    }
    return doc.save();
};
