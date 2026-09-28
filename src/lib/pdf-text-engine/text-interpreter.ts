/**
 * Content-stream interpreter focused on text (ISO 32000-1 §8.4, §9.3, §9.4).
 *
 * Walks the page (and nested Form XObjects) maintaining the graphics state that affects text —
 * CTM, text/line matrices, font, Tc/Tw/Tz/TL/Ts/Tr and the current fill/stroke colour — and emits
 * one Placement per rendered glyph with its exact user-space origin and advance. Those placements
 * are what the editor matches against pdfjs text items and what the verifier compares before/after
 * a rewrite.
 */
import { PDFArray, type PDFContext, PDFDict, PDFName, PDFNumber, type PDFObject, PDFRef, PDFStream } from "pdf-lib";
import { type ContentOp, type Operand, parseContentStream, serializeOp } from "./content-lexer";
import { type DecodingFont, type FontRegistry, type Glyph, nameOf, numOf, streamBytes } from "./font-model";

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Row-vector convention: mul(A, B) applies A first, then B. */
export const mul = (A: Matrix, B: Matrix): Matrix => [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
];
export const applyPt = (M: Matrix, x: number, y: number): [number, number] => [x * M[0] + y * M[2] + M[4], x * M[1] + y * M[3] + M[5]];

export type StreamCtx = {
    /** "page" or "form:<ref>@<n>" (the n-th painting of that form on the page) — stable across re-interpretations
     *  of rewritten bytes, since edits never add or remove Do operators. */
    key: string;
    kind: "page" | "form";
    bytes: Uint8Array;
    ops: ContentOp[];
    resources: PDFDict | null;
    formRef?: PDFRef;
    form?: PDFStream;
    parentKey?: string;
    /** XObject resource name the parent uses to paint this form. */
    nameInParent?: string;
    /** Index of the painting `Do` operator in the parent's operators. */
    doOpIndex?: number;
};

export type TextStateSnap = {
    font: DecodingFont;
    fontName: string;
    Tfs: number;
    Tc: number;
    Tw: number;
    Th: number;
    Tr: number;
    Ts: number;
    /** Serialized operators that restore the current fill / stroke colour. */
    fill: string;
    stroke: string;
    /** Line width (w) in force, and the CTM's scale — to stroke glyphs at a given thickness. */
    lineWidth: number;
    ctmScale: number;
};

export type Placement = {
    streamKey: string;
    opIndex: number;
    /** Index of the string element inside a TJ array (0 for Tj/'/"). */
    elem: number;
    /** Glyph index inside that string. */
    gi: number;
    /** Global content order. */
    seq: number;
    glyph: Glyph;
    origin: [number, number];
    xAxis: [number, number];
    yAxis: [number, number];
    sizeUser: number;
    /** Displacement in text space before horizontal scaling: w0·Tfs + Tc + Tw·isSpace. */
    advPre: number;
    /** Length of the displacement in user space (includes Th and all matrices). */
    advUser: number;
    state: TextStateSnap;
    /** Innermost marked-content sequence with /ActualText around the glyph (its BDC operator). */
    actualText?: { streamKey: string; opIndex: number };
    /** Axis-aligned bounds (user space) of the rectangular clip in force, when it is known. */
    clip?: [number, number, number, number];
    /** Text matrix before this glyph, line matrix and CTM — to place glyphs anew with an absolute Tm. */
    tm: Matrix;
    tlm: Matrix;
    ctm: Matrix;
};

export type Interpretation = {
    streams: Map<string, StreamCtx>;
    placements: Placement[];
};

type Colour = { cs: string | null; color: string };
type GState = {
    ctm: Matrix;
    font: DecodingFont | null;
    fontName: string;
    Tfs: number;
    Tc: number;
    Tw: number;
    Th: number;
    TL: number;
    Tr: number;
    Ts: number;
    fill: Colour;
    stroke: Colour;
    clip: [number, number, number, number] | null;
    lineWidth: number;
};

const N = (s: string) => PDFName.of(s);
const numArgs = (args: Operand[]) => args.map((a) => (a.t === "num" ? a.v : 0));
const colourStr = (c: Colour) => (c.cs ? c.cs + (c.color ? "\n" + c.color : "") : c.color);

export type StreamOverrides = Map<string, Uint8Array>;

/** Read the page content (all /Contents streams joined) as one byte buffer. */
export const pageContentBytes = (context: PDFContext, pageDict: PDFDict): Uint8Array => {
    const c = pageDict.lookup(N("Contents"));
    const parts: Uint8Array[] = [];
    if (c instanceof PDFArray) {
        for (let i = 0; i < c.size(); i++) {
            const s = c.lookup(i);
            const b = streamBytes(s as PDFObject);
            if (b) parts.push(b);
        }
    } else if (c) {
        const b = streamBytes(c);
        if (b) parts.push(b);
    }
    const total = parts.reduce((s, p) => s + p.length + 1, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
        out[o++] = 0x0a;
    }
    void context;
    return out;
};

export const interpretPage = (
    context: PDFContext,
    pageDict: PDFDict,
    pageResources: PDFDict | null,
    registry: FontRegistry,
    overrides: StreamOverrides = new Map(),
): Interpretation => {
    const streams = new Map<string, StreamCtx>();
    const placements: Placement[] = [];
    let seq = 0;
    const paintings = new Map<string, number>();
    // Marked-content nesting across the page and the forms it paints: the BDC carrying /ActualText, or null.
    const marked: ({ streamKey: string; opIndex: number } | null)[] = [];

    const pageBytes = overrides.get("page") ?? pageContentBytes(context, pageDict);
    const pageCtx: StreamCtx = { key: "page", kind: "page", bytes: pageBytes, ops: parseContentStream(pageBytes), resources: pageResources };
    streams.set("page", pageCtx);

    const initial: GState = {
        ctm: IDENTITY,
        font: null,
        fontName: "",
        Tfs: 0,
        Tc: 0,
        Tw: 0,
        Th: 1,
        TL: 0,
        Tr: 0,
        Ts: 0,
        fill: { cs: null, color: "0 g" },
        stroke: { cs: null, color: "0 G" },
        clip: null,
        lineWidth: 1,
    };

    const run = (ctx: StreamCtx, start: GState, depth: number, path: Set<string>) => {
        let gs: GState = { ...start, fill: { ...start.fill }, stroke: { ...start.stroke } };
        const stack: GState[] = [];
        let Tm: Matrix = IDENTITY;
        let Tlm: Matrix = IDENTITY;
        const res = ctx.resources;

        const lookupRes = (cat: string, name: string): PDFObject | undefined => {
            const d = res?.lookup(N(cat));
            if (!(d instanceof PDFDict)) return undefined;
            return d.get(N(name));
        };

        const setFont = (name: string, size: number, fontObj?: PDFObject) => {
            const obj = fontObj ?? lookupRes("Font", name);
            gs.font = registry.get(obj);
            gs.fontName = name;
            gs.Tfs = size;
        };

        const moveLine = (tx: number, ty: number) => {
            Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
            Tm = Tlm;
        };

        const show = (bytes: Uint8Array, opIndex: number, elem: number) => {
            const font = gs.font;
            if (!font) return;
            const glyphs = font.decode(bytes);
            const snap: TextStateSnap = {
                font,
                fontName: gs.fontName,
                Tfs: gs.Tfs,
                Tc: gs.Tc,
                Tw: gs.Tw,
                Th: gs.Th,
                Tr: gs.Tr,
                Ts: gs.Ts,
                fill: colourStr(gs.fill),
                stroke: colourStr(gs.stroke),
                lineWidth: gs.lineWidth,
                ctmScale: Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1,
            };
            let actual: Placement["actualText"];
            for (let k = marked.length - 1; k >= 0 && !actual; k--) actual = marked[k] ?? undefined;
            glyphs.forEach((g, gi) => {
                font.markUsed(g.code);
                const M = mul(Tm, gs.ctm);
                const trm = mul([gs.Tfs * gs.Th, 0, 0, gs.Tfs, 0, gs.Ts], M);
                const xl = Math.hypot(trm[0], trm[1]) || 1;
                const yl = Math.hypot(trm[2], trm[3]) || 1;
                const advPre = g.w0 * gs.Tfs + gs.Tc + (g.isSpace ? gs.Tw : 0);
                const tx = advPre * gs.Th;
                placements.push({
                    streamKey: ctx.key,
                    opIndex,
                    elem,
                    gi,
                    seq: seq++,
                    glyph: g,
                    origin: [trm[4], trm[5]],
                    xAxis: [trm[0] / xl, trm[1] / xl],
                    yAxis: [trm[2] / yl, trm[3] / yl],
                    sizeUser: yl,
                    advPre,
                    advUser: tx * Math.hypot(M[0], M[1]),
                    state: snap,
                    actualText: actual,
                    clip: gs.clip ?? undefined,
                    tm: Tm,
                    tlm: Tlm,
                    ctm: gs.ctm,
                });
                Tm = mul([1, 0, 0, 1, tx, 0], Tm);
            });
        };

        // Current path, tracked only while it is made of rectangles (table cells, text boxes).
        let pathBox: [number, number, number, number] | null = null;
        let pathRectOnly = true;
        let clipNext = false;
        const endPath = () => {
            if (clipNext && pathRectOnly && pathBox) {
                const c = gs.clip;
                gs.clip = c ? [Math.max(c[0], pathBox[0]), Math.max(c[1], pathBox[1]), Math.min(c[2], pathBox[2]), Math.min(c[3], pathBox[3])] : pathBox;
            }
            pathBox = null;
            pathRectOnly = true;
            clipNext = false;
        };
        ctx.ops.forEach((op, i) => {
            const a = op.args;
            switch (op.op) {
                case "re": {
                    const [x, y, w, h] = numArgs(a);
                    const pts = [applyPt(gs.ctm, x, y), applyPt(gs.ctm, x + w, y), applyPt(gs.ctm, x, y + h), applyPt(gs.ctm, x + w, y + h)];
                    const xs = pts.map((p) => p[0]);
                    const ys = pts.map((p) => p[1]);
                    const b: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
                    // Several rectangles in one clip path: their union bounds what can show.
                    pathBox = pathBox ? [Math.min(pathBox[0], b[0]), Math.min(pathBox[1], b[1]), Math.max(pathBox[2], b[2]), Math.max(pathBox[3], b[3])] : b;
                    break;
                }
                case "m":
                case "l":
                case "c":
                case "v":
                case "y":
                case "h":
                    pathRectOnly = false;
                    break;
                case "W":
                case "W*":
                    clipNext = true;
                    break;
                case "n":
                case "S":
                case "s":
                case "f":
                case "F":
                case "f*":
                case "B":
                case "B*":
                case "b":
                case "b*":
                    // A clip we can't describe as a rectangle still restricts drawing: forget the known bounds.
                    if (clipNext && !(pathRectOnly && pathBox)) gs.clip = null;
                    endPath();
                    break;
                case "q":
                    stack.push({ ...gs, fill: { ...gs.fill }, stroke: { ...gs.stroke } });
                    break;
                case "Q":
                    if (stack.length) gs = stack.pop()!;
                    break;
                case "BMC":
                    marked.push(null);
                    break;
                case "BDC": {
                    const props = a[1];
                    const has = props?.t === "dict" && props.entries.some(([k]) => k === "ActualText");
                    marked.push(has ? { streamKey: ctx.key, opIndex: i } : null);
                    break;
                }
                case "EMC":
                    marked.pop();
                    break;
                case "cm": {
                    const m = numArgs(a);
                    if (m.length === 6) gs.ctm = mul(m as Matrix, gs.ctm);
                    break;
                }
                case "gs": {
                    const nm = a[0]?.t === "name" ? a[0].v : null;
                    const eg = nm ? lookupRes("ExtGState", nm) : undefined;
                    const egd = eg instanceof PDFRef ? context.lookup(eg) : eg;
                    if (egd instanceof PDFDict) {
                        const lw = numOf(egd.lookup(N("LW")));
                        if (lw !== undefined) gs.lineWidth = lw;
                        const f = egd.lookup(N("Font"));
                        if (f instanceof PDFArray && f.size() >= 2) setFont(`@gs:${nm}`, numOf(f.lookup(1) as PDFObject) ?? gs.Tfs, f.get(0));
                    }
                    break;
                }
                case "w":
                    if (a[0]?.t === "num") gs.lineWidth = a[0].v;
                    break;
                // Fill colour
                case "g":
                case "rg":
                case "k":
                    gs.fill = { cs: null, color: serializeOp(op.op, a) };
                    break;
                case "cs":
                    gs.fill = { cs: serializeOp(op.op, a), color: "" };
                    break;
                case "sc":
                case "scn":
                    gs.fill = { cs: gs.fill.cs, color: serializeOp(op.op, a) };
                    break;
                // Stroke colour
                case "G":
                case "RG":
                case "K":
                    gs.stroke = { cs: null, color: serializeOp(op.op, a) };
                    break;
                case "CS":
                    gs.stroke = { cs: serializeOp(op.op, a), color: "" };
                    break;
                case "SC":
                case "SCN":
                    gs.stroke = { cs: gs.stroke.cs, color: serializeOp(op.op, a) };
                    break;
                // Text
                case "BT":
                    Tm = IDENTITY;
                    Tlm = IDENTITY;
                    break;
                case "Tf":
                    if (a[0]?.t === "name") setFont(a[0].v, a[1]?.t === "num" ? a[1].v : 0);
                    break;
                case "Tc":
                    gs.Tc = a[0]?.t === "num" ? a[0].v : 0;
                    break;
                case "Tw":
                    gs.Tw = a[0]?.t === "num" ? a[0].v : 0;
                    break;
                case "Tz":
                    gs.Th = (a[0]?.t === "num" ? a[0].v : 100) / 100;
                    break;
                case "TL":
                    gs.TL = a[0]?.t === "num" ? a[0].v : 0;
                    break;
                case "Tr":
                    gs.Tr = a[0]?.t === "num" ? a[0].v : 0;
                    break;
                case "Ts":
                    gs.Ts = a[0]?.t === "num" ? a[0].v : 0;
                    break;
                case "Td": {
                    const [tx, ty] = numArgs(a);
                    moveLine(tx ?? 0, ty ?? 0);
                    break;
                }
                case "TD": {
                    const [tx, ty] = numArgs(a);
                    gs.TL = -(ty ?? 0);
                    moveLine(tx ?? 0, ty ?? 0);
                    break;
                }
                case "Tm": {
                    const m = numArgs(a);
                    if (m.length === 6) {
                        Tlm = m as Matrix;
                        Tm = Tlm;
                    }
                    break;
                }
                case "T*":
                    moveLine(0, -gs.TL);
                    break;
                case "Tj":
                    if (a[0]?.t === "str") show(a[0].bytes, i, 0);
                    break;
                case "'":
                    moveLine(0, -gs.TL);
                    if (a[0]?.t === "str") show(a[0].bytes, i, 0);
                    break;
                case '"':
                    if (a[0]?.t === "num") gs.Tw = a[0].v;
                    if (a[1]?.t === "num") gs.Tc = a[1].v;
                    moveLine(0, -gs.TL);
                    if (a[2]?.t === "str") show(a[2].bytes, i, 0);
                    break;
                case "TJ":
                    if (a[0]?.t === "arr") {
                        a[0].items.forEach((it, k) => {
                            if (it.t === "str") show(it.bytes, i, k);
                            else if (it.t === "num") Tm = mul([1, 0, 0, 1, -(it.v / 1000) * gs.Tfs * gs.Th, 0], Tm);
                        });
                    }
                    break;
                case "Do": {
                    if (depth > 12 || a[0]?.t !== "name") break;
                    const nm = a[0].v;
                    const xo = lookupRes("XObject", nm);
                    const ref = xo instanceof PDFRef ? xo : undefined;
                    const stream = ref ? context.lookup(ref) : xo;
                    if (!(stream instanceof PDFStream)) break;
                    if (nameOf(stream.dict.lookup(N("Subtype"))) !== "Form") break;
                    const formId = ref ? `form:${ref.toString()}` : `form:inline:${ctx.key}:${nm}`;
                    if (path.has(formId)) break;
                    // Each painting is its own stream context, so an edit touches only the copy the user clicked.
                    const nth = paintings.get(formId) ?? 0;
                    paintings.set(formId, nth + 1);
                    const key = `${formId}@${nth}`;
                    let fctx = streams.get(key);
                    if (!fctx) {
                        const bytes = overrides.get(key) ?? streamBytes(stream);
                        if (!bytes) break;
                        const fr = stream.dict.lookup(N("Resources"));
                        fctx = {
                            key,
                            kind: "form",
                            bytes,
                            ops: parseContentStream(bytes),
                            resources: fr instanceof PDFDict ? fr : res,
                            formRef: ref,
                            form: stream,
                            parentKey: ctx.key,
                            nameInParent: nm,
                            doOpIndex: i,
                        };
                        streams.set(key, fctx);
                    }
                    const mArr = stream.dict.lookup(N("Matrix"));
                    let fm: Matrix = IDENTITY;
                    if (mArr instanceof PDFArray && mArr.size() === 6) {
                        fm = [0, 1, 2, 3, 4, 5].map((k) => {
                            const v = mArr.lookup(k);
                            return v instanceof PDFNumber ? v.asNumber() : 0;
                        }) as Matrix;
                    }
                    const inner: GState = { ...gs, ctm: mul(fm, gs.ctm), fill: { ...gs.fill }, stroke: { ...gs.stroke } };
                    // A form is clipped to its BBox.
                    const bb = stream.dict.lookup(N("BBox"));
                    if (bb instanceof PDFArray && bb.size() === 4) {
                        const v = [0, 1, 2, 3].map((k) => {
                            const n = bb.lookup(k);
                            return n instanceof PDFNumber ? n.asNumber() : 0;
                        });
                        const pts = [
                            applyPt(inner.ctm, v[0], v[1]),
                            applyPt(inner.ctm, v[2], v[1]),
                            applyPt(inner.ctm, v[0], v[3]),
                            applyPt(inner.ctm, v[2], v[3]),
                        ];
                        const b: [number, number, number, number] = [
                            Math.min(...pts.map((p) => p[0])),
                            Math.min(...pts.map((p) => p[1])),
                            Math.max(...pts.map((p) => p[0])),
                            Math.max(...pts.map((p) => p[1])),
                        ];
                        const c = inner.clip;
                        inner.clip = c ? [Math.max(c[0], b[0]), Math.max(c[1], b[1]), Math.min(c[2], b[2]), Math.min(c[3], b[3])] : b;
                    }
                    const nextPath = new Set(path);
                    nextPath.add(formId);
                    // Text matrices do not leak across the form boundary.
                    const savedTm = Tm;
                    const savedTlm = Tlm;
                    run(fctx, inner, depth + 1, nextPath);
                    Tm = savedTm;
                    Tlm = savedTlm;
                    break;
                }
            }
        });
    };

    run(pageCtx, initial, 0, new Set(["page"]));
    return { streams, placements };
};
