// Glyphs of a page in display space, ready for line building: position, direction, size, advance, Word face, visible
// colour, visibility (render mode, ExtGState alpha, clipping, page bounds), ActualText spans and link targets.
// Overprinted copies (text shadows, fill + stroke layers, double-struck fake bold, invisible duplicates) are merged.
import { PDFArray, type PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, type PDFObject, type PDFPage, PDFRef, PDFString } from "pdf-lib";
import type { FontRegistry } from "../pdf-text-engine/font-model";
import { type Interpretation, type Placement, interpretPage } from "../pdf-text-engine/text-interpreter";
import type { PageGeometry } from "./page-geometry";
import { type StructTag, pageStructure } from "./text-structure";
import { type FontFace, colourOf, fontFace, rgbHex } from "./text-style";
import type { Hex } from "./types";

export type Glyph = {
    /** Content order. */
    seq: number;
    /** Unicode text ("" when the font has no mapping, or inside an ActualText span after its first glyph). */
    text: string;
    /** Space, tab or other whitespace glyph. */
    ws: boolean;
    /** Origin (pen position on the baseline) in display space. */
    x: number;
    y: number;
    /** Unit vector of the baseline direction in display space. */
    dx: number;
    dy: number;
    /** Position along the baseline direction and across it (grows downwards for horizontal text). */
    u: number;
    v: number;
    /** Text rise (Ts) in points: v + rise is the baseline the glyph was raised from. */
    rise: number;
    size: number;
    /** Advance including character / word spacing, and the glyph's own advance. */
    adv: number;
    ink: number;
    face: FontFace;
    color: Hex;
    bold: boolean;
    /** Slanted by the text matrix (a synthetic oblique of an upright font). */
    oblique: boolean;
    /** Width of the glyphs relative to their height in percent (PDF Tz, or a text matrix squeezed horizontally). */
    hscale: number;
    /** Hollow letters (stroked, not filled). */
    outline: boolean;
    invisible: boolean;
    /** Identity of the ActualText span the glyph belongs to. */
    span: string | null;
    link: string | null;
    /** Tagged PDFs: the logical element the glyph belongs to, or "artifact" for page furniture. */
    struct: StructTag | "artifact" | null;
    /** Font object (runs never mix fonts with different faces). */
    font: unknown;
};

const N = (s: string) => PDFName.of(s);

const decodeTextString = (o: { bytes: Uint8Array }) => {
    const b = o.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        let s = "";
        for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
        return s;
    }
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return s;
};

type Alpha = { fill: Float32Array; stroke: Float32Array };

/** Fill / stroke alpha (ExtGState ca / CA) in force at every operator of every stream the interpreter walked. */
const alphaTables = (interp: Interpretation, context: PDFContext): Map<string, Alpha> => {
    const out = new Map<string, Alpha>();
    const extCache = new Map<PDFDict, Map<string, { ca?: number; CA?: number }>>();
    const extOf = (res: PDFDict | null, name: string) => {
        if (!res) return undefined;
        let m = extCache.get(res);
        if (!m) extCache.set(res, (m = new Map()));
        if (m.has(name)) return m.get(name);
        const eg = res.lookup(N("ExtGState"));
        let d = eg instanceof PDFDict ? eg.get(N(name)) : undefined;
        if (d instanceof PDFRef) d = context.lookup(d);
        const v = d instanceof PDFDict ? { ca: numOf(d.lookup(N("ca"))), CA: numOf(d.lookup(N("CA"))) } : {};
        m.set(name, v);
        return v;
    };
    for (const [key, ctx] of interp.streams) {
        let fill = 1;
        let stroke = 1;
        if (ctx.kind === "form" && ctx.parentKey) {
            const parent = out.get(ctx.parentKey);
            const at = ctx.doOpIndex ?? 0;
            if (parent && at < parent.fill.length) {
                fill = parent.fill[at];
                stroke = parent.stroke[at];
            }
        }
        const n = ctx.ops.length;
        const tf = new Float32Array(n);
        const ts = new Float32Array(n);
        const stack: [number, number][] = [];
        for (let i = 0; i < n; i++) {
            const op = ctx.ops[i];
            if (op.op === "q") stack.push([fill, stroke]);
            else if (op.op === "Q") [fill, stroke] = stack.pop() ?? [fill, stroke];
            else if (op.op === "gs" && op.args[0]?.t === "name") {
                const e = extOf(ctx.resources, op.args[0].v);
                if (e?.ca !== undefined) fill = e.ca;
                if (e?.CA !== undefined) stroke = e.CA;
            }
            tf[i] = fill;
            ts[i] = stroke;
        }
        out.set(key, { fill: tf, stroke: ts });
    }
    return out;
};

const numOf = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

type Box4 = [number, number, number, number];

/**
 * Opaque rectangles painted in each stream (filled rectangle paths, opaque images), in user space with the index of
 * the operator that paints them: text drawn earlier in the same stream and lying under one of them is hidden.
 */
const opaquePaints = (interp: Interpretation, context: PDFContext, alpha: Map<string, Alpha>): Map<string, { op: number; box: Box4 }[]> => {
    const out = new Map<string, { op: number; box: Box4 }[]>();
    const normalBlend = new Map<string, boolean>();
    for (const [key, ctx] of interp.streams) {
        const list: { op: number; box: Box4 }[] = [];
        const fillAlpha = alpha.get(key)?.fill;
        let ctm = [1, 0, 0, 1, 0, 0];
        let blendOk = true;
        const stack: { ctm: number[]; blendOk: boolean }[] = [];
        let rects: Box4[] = [];
        let rectOnly = true;
        const res = ctx.resources;
        const axisAligned = () => Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
        const map = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
        const boxOf = (x0: number, y0: number, x1: number, y1: number): Box4 => {
            const a = map(x0, y0);
            const b = map(x1, y1);
            return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        };
        ctx.ops.forEach((op, i) => {
            const a = op.args;
            switch (op.op) {
                case "q":
                    stack.push({ ctm: ctm.slice(), blendOk });
                    break;
                case "Q": {
                    const s = stack.pop();
                    if (s) [ctm, blendOk] = [s.ctm, s.blendOk];
                    break;
                }
                case "cm":
                    if (a.length === 6 && a.every((x) => x.t === "num")) {
                        const m = a.map((x) => (x.t === "num" ? x.v : 0));
                        ctm = [
                            m[0] * ctm[0] + m[1] * ctm[2],
                            m[0] * ctm[1] + m[1] * ctm[3],
                            m[2] * ctm[0] + m[3] * ctm[2],
                            m[2] * ctm[1] + m[3] * ctm[3],
                            m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
                            m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
                        ];
                    }
                    break;
                case "gs":
                    if (a[0]?.t === "name" && res) {
                        const name = a[0].v;
                        const cacheKey = `${key}/${name}`;
                        let ok = normalBlend.get(cacheKey);
                        if (ok === undefined) {
                            const eg = res.lookup(N("ExtGState"));
                            let d = eg instanceof PDFDict ? eg.get(N(name)) : undefined;
                            if (d instanceof PDFRef) d = context.lookup(d);
                            const bm = d instanceof PDFDict ? d.lookup(N("BM")) : undefined;
                            const smask = d instanceof PDFDict ? d.lookup(N("SMask")) : undefined;
                            const bmName = bm instanceof PDFName ? bm.decodeText() : bm instanceof PDFArray ? "" : "Normal";
                            ok = (bmName === "Normal" || bmName === "Compatible") && (!smask || (smask instanceof PDFName && smask.decodeText() === "None"));
                            normalBlend.set(cacheKey, ok);
                        }
                        blendOk = ok;
                    }
                    break;
                case "re":
                    if (a.length === 4 && a.every((x) => x.t === "num")) {
                        const [x, y, w, h] = a.map((v) => (v.t === "num" ? v.v : 0));
                        if (axisAligned()) rects.push(boxOf(x, y, x + w, y + h));
                        else rectOnly = false;
                    }
                    break;
                case "m":
                case "l":
                case "c":
                case "v":
                case "y":
                case "h":
                    rectOnly = false;
                    break;
                case "f":
                case "F":
                case "f*":
                case "B":
                case "B*":
                case "b":
                case "b*":
                    if (rectOnly && blendOk && (fillAlpha?.[i] ?? 1) >= 0.95)
                        for (const r of rects) if ((r[2] - r[0]) * (r[3] - r[1]) >= 4) list.push({ op: i, box: r });
                    rects = [];
                    rectOnly = true;
                    break;
                case "n":
                case "S":
                case "s":
                    rects = [];
                    rectOnly = true;
                    break;
                case "Do": {
                    // An opaque image (no soft mask, no colour-key or stencil mask) covers its unit square.
                    if (a[0]?.t !== "name" || !res || !axisAligned() || !blendOk || (fillAlpha?.[i] ?? 1) < 0.95) break;
                    const xo = res.lookup(N("XObject"));
                    let s = xo instanceof PDFDict ? xo.get(N(a[0].v)) : undefined;
                    if (s instanceof PDFRef) s = context.lookup(s);
                    const dict = s && "dict" in (s as object) ? (s as unknown as { dict: PDFDict }).dict : null;
                    if (!dict) break;
                    const sub = dict.lookup(N("Subtype"));
                    if (!(sub instanceof PDFName) || sub.decodeText() !== "Image") break;
                    if (dict.lookup(N("SMask")) || dict.lookup(N("Mask")) || dict.lookup(N("ImageMask"))) break;
                    list.push({ op: i, box: boxOf(0, 0, 1, 1) });
                    break;
                }
            }
        });
        if (list.length)
            out.set(
                key,
                list.length > 600
                    ? list.sort((p, q) => (q.box[2] - q.box[0]) * (q.box[3] - q.box[1]) - (p.box[2] - p.box[0]) * (p.box[3] - p.box[1])).slice(0, 600)
                    : list,
            );
    }
    return out;
};

/** Glyph under an opaque paint that comes later in its stream: covered, so not shown. */
const hiddenUnder = (p: Placement, paints: { op: number; box: Box4 }[] | undefined) => {
    if (!paints) return false;
    const w = p.advUser;
    const h = p.sizeUser;
    const pts = [
        [p.origin[0] - p.yAxis[0] * 0.15 * h, p.origin[1] - p.yAxis[1] * 0.15 * h],
        [p.origin[0] + p.xAxis[0] * w + p.yAxis[0] * 0.6 * h, p.origin[1] + p.xAxis[1] * w + p.yAxis[1] * 0.6 * h],
        [p.origin[0] + p.xAxis[0] * w - p.yAxis[0] * 0.15 * h, p.origin[1] + p.xAxis[1] * w - p.yAxis[1] * 0.15 * h],
        [p.origin[0] + p.yAxis[0] * 0.6 * h, p.origin[1] + p.yAxis[1] * 0.6 * h],
    ];
    const x0 = Math.min(...pts.map((q) => q[0]));
    const y0 = Math.min(...pts.map((q) => q[1]));
    const x1 = Math.max(...pts.map((q) => q[0]));
    const y1 = Math.max(...pts.map((q) => q[1]));
    return paints.some((f) => f.op > p.opIndex && x0 >= f.box[0] - 0.5 && y0 >= f.box[1] - 0.5 && x1 <= f.box[2] + 0.5 && y1 <= f.box[3] + 0.5);
};

export type LinkArea = { x0: number; y0: number; x1: number; y1: number; uri: string };

/** URI link annotations of the page, as display-space rectangles (QuadPoints when given, else /Rect). */
export const pageLinks = (page: PDFPage, geometry: PageGeometry): LinkArea[] => {
    const out: LinkArea[] = [];
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) return out;
    for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (!(a instanceof PDFDict)) continue;
        const sub = a.lookup(N("Subtype"));
        if (!(sub instanceof PDFName) || sub.decodeText() !== "Link") continue;
        const action = a.lookup(N("A"));
        let uri: string | undefined;
        if (action instanceof PDFDict) {
            const u = action.lookup(N("URI"));
            if (u instanceof PDFString || u instanceof PDFHexString) uri = u.decodeText();
            else {
                const s = action.lookup(N("S"));
                const f = action.lookup(N("F"));
                if (s instanceof PDFName && s.decodeText() === "Launch" && (f instanceof PDFString || f instanceof PDFHexString)) uri = f.decodeText();
            }
        }
        if (!uri || !/^(https?:|mailto:|tel:|ftp:|www\.)/i.test(uri.trim())) continue;
        uri = uri.trim();
        if (/^www\./i.test(uri)) uri = "http://" + uri;
        const boxes: number[][] = [];
        const qp = a.lookup(N("QuadPoints"));
        if (qp instanceof PDFArray && qp.size() >= 8 && qp.size() % 8 === 0) {
            for (let k = 0; k < qp.size(); k += 8) {
                const v = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => numOf(qp.lookup(k + j)) ?? 0);
                boxes.push([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]);
            }
        } else {
            const r = a.lookup(N("Rect"));
            if (!(r instanceof PDFArray) || r.size() !== 4) continue;
            const v = [0, 1, 2, 3].map((j) => numOf(r.lookup(j)) ?? 0);
            boxes.push([v[0], v[1], v[2], v[1], v[2], v[3], v[0], v[3]]);
        }
        for (const q of boxes) {
            const pts = [0, 2, 4, 6].map((j) => geometry.toDisplay(q[j], q[j + 1]));
            out.push({
                x0: Math.min(...pts.map((p) => p[0])),
                y0: Math.min(...pts.map((p) => p[1])),
                x1: Math.max(...pts.map((p) => p[0])),
                y1: Math.max(...pts.map((p) => p[1])),
                uri,
            });
        }
    }
    return out;
};

// Alphabetic presentation forms (ligatures U+FB00–FB06) → their letters; everything else keeps its code points.
const LIGATURES = ["ff", "fi", "fl", "ffi", "ffl", "st", "st"];
const cleanText = (s: string | null): string => {
    if (!s) return "";
    let out = "";
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c >= 0xfb00 && c <= 0xfb06) out += LIGATURES[c - 0xfb00];
        else if (c === 0xa0 || c === 0x2007 || c === 0x202f || c === 0x2002 || c === 0x2003 || c === 0x2009 || c === 0x200a) out += " ";
        else if (c === 0x09 || c === 0x0a || c === 0x0d) out += " ";
        else if (c < 0x20 || c === 0x7f || c === 0xfffd || c === 0xfeff || c === 0x200b || (c >= 0x80 && c < 0xa0)) continue;
        else out += ch;
    }
    return out;
};

/** Blend a colour painted with opacity `a` over white paper (semi-transparent watermarks read as light grey). */
const overWhite = (hex: Hex, a: number): Hex => {
    if (a >= 0.98) return hex;
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return rgbHex(1 - a * (1 - c[0]), 1 - a * (1 - c[1]), 1 - a * (1 - c[2]));
};

/** Relative luminance of a hex colour (0 black – 1 white). */
const luminanceOf = (hex: Hex) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

/** Glyph advance without Tc/Tw: where its ink ends (the editor's inkAdvance). */
const inkAdvance = (p: Placement) => (p.advPre ? (p.advUser * p.glyph.w0 * p.state.Tfs) / p.advPre : p.advUser);

/**
 * Reads the glyphs of a page. `interp` may be passed when the caller already interpreted the page.
 */
export const readGlyphs = (
    doc: { context: PDFContext },
    page: PDFPage,
    registry: FontRegistry,
    geometry: PageGeometry,
    interp: Interpretation = interpretPage(doc.context, page.node, page.node.Resources() ?? null, registry),
): Glyph[] => {
    const context = doc.context;
    const alpha = alphaTables(interp, context);
    const paints = opaquePaints(interp, context, alpha);
    const links = pageLinks(page, geometry);
    let structure: ReturnType<typeof pageStructure> = null;
    try {
        structure = pageStructure(context, page, interp);
    } catch {
        // A broken structure tree only loses the tags; the text is read all the same.
        structure = null;
    }
    const M = geometry.matrix;
    const W = geometry.width;
    const H = geometry.height;
    const spans = new Map<string, string>();
    const glyphs: Glyph[] = [];

    for (const p of interp.placements) {
        const tr = p.state.Tr;
        const fills = tr === 0 || tr === 2 || tr === 4 || tr === 6;
        const strokes = tr === 1 || tr === 2 || tr === 5 || tr === 6;
        const al = alpha.get(p.streamKey);
        const fa = al && p.opIndex < al.fill.length ? al.fill[p.opIndex] : 1;
        const sa = al && p.opIndex < al.stroke.length ? al.stroke[p.opIndex] : 1;
        const strokeWidth = p.state.lineWidth * p.state.ctmScale;
        const fillShows = fills && fa > 0.02;
        const strokeShows = strokes && sa > 0.02 && strokeWidth >= 0;
        let invisible = !(fillShows || strokeShows);
        // Covered by an opaque shape or picture painted after it (a box in front of text, a white-out): not shown.
        if (!invisible && hiddenUnder(p, paints.get(p.streamKey))) continue;

        // Clipped away by a rectangular clip, or outside the visible page.
        const size = p.sizeUser;
        if (!(size > 0.2) || !Number.isFinite(size)) continue;
        const cx = p.origin[0] + p.xAxis[0] * (p.advUser / 2) + p.yAxis[0] * size * 0.3;
        const cy = p.origin[1] + p.xAxis[1] * (p.advUser / 2) + p.yAxis[1] * size * 0.3;
        const clip = p.clip;
        if (clip && (cx < clip[0] - 0.5 || cx > clip[2] + 0.5 || cy < clip[1] - 0.5 || cy > clip[3] + 0.5)) {
            if (!invisible) continue;
        }
        const [X, Y] = geometry.toDisplay(p.origin[0], p.origin[1]);
        const [CX, CY] = geometry.toDisplay(cx, cy);
        if (CX < -1 || CY < -1 || CX > W + 1 || CY > H + 1) continue;

        let dx = p.xAxis[0] * M[0] + p.xAxis[1] * M[2];
        let dy = p.xAxis[0] * M[1] + p.xAxis[1] * M[3];
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        // Snap near-axis directions (rounding in generated matrices).
        if (Math.abs(dy) < 1e-3) {
            dy = 0;
            dx = Math.sign(dx) || 1;
        } else if (Math.abs(dx) < 1e-3) {
            dx = 0;
            dy = Math.sign(dy) || 1;
        }

        const font = p.state.font;
        const face = fontFace(font);
        const resources = interp.streams.get(p.streamKey)?.resources ?? null;
        const fillHex = colourOf(p.state.fill, resources, context);
        const strokeHex = colourOf(p.state.stroke, resources, context);
        let color: Hex;
        if (fillShows) color = overWhite(fillHex ?? "000000", fa);
        else if (strokeShows) color = overWhite(strokeHex ?? "000000", sa);
        else color = fillHex ?? "000000";
        // Fill + stroke with a visible pen: text made bold by stroking (Word does this for fonts without a bold face), or
        // letters with a contour in another colour, which look as heavy. A white pen only trims the letters on paper.
        const penShows = !!strokeHex && (strokeHex === fillHex || luminanceOf(strokeHex) < 0.85);
        const bold = face.bold || ((tr === 2 || tr === 6) && fillShows && strokeShows && penShows && strokeWidth > 0.012 * size);
        // Glyph shape as drawn: a text matrix that squeezes the glyphs (Tz, or unequal axes) and one that slants them.
        const tm = p.tm;
        const ctm = p.ctm;
        const m0 = tm[0] * ctm[0] + tm[1] * ctm[2];
        const m1 = tm[0] * ctm[1] + tm[1] * ctm[3];
        const m2 = tm[2] * ctm[0] + tm[3] * ctm[2];
        const m3 = tm[2] * ctm[1] + tm[3] * ctm[3];
        const yLen = Math.hypot(m2, m3);
        const hscale = yLen > 0 ? (100 * (p.state.Th || 1) * Math.hypot(m0, m1)) / yLen : 100;
        const oblique = Math.abs(p.xAxis[0] * p.yAxis[0] + p.xAxis[1] * p.yAxis[1]) > 0.12;
        // Hollow text: stroked without fill, or a Type3 font whose glyphs are thin rings (browsers' text-stroke).
        let outline = strokeShows && !fillShows;
        if (!outline && fillShows) {
            const ring = (font as { outlineWidth?: () => number | null } | null)?.outlineWidth;
            try {
                outline = typeof ring === "function" && ring.call(font) !== null;
            } catch {
                outline = false;
            }
        }

        let text = cleanText(p.glyph.unicode);
        const ws = p.glyph.isSpace || (text !== "" && text.trim() === "");
        if (ws) text = " ";
        let span: string | null = null;
        if (p.actualText) {
            span = `${p.actualText.streamKey}#${p.actualText.opIndex}`;
            if (!spans.has(span)) {
                const op = interp.streams.get(p.actualText.streamKey)?.ops[p.actualText.opIndex];
                const props = op?.args[1];
                const entry = props?.t === "dict" ? props.entries.find(([k]) => k === "ActualText") : undefined;
                spans.set(span, entry && entry[1].t === "str" ? cleanText(decodeTextString(entry[1])) : "");
            }
        }
        const rise = p.state.Tfs ? (p.state.Ts * size) / p.state.Tfs : 0;
        const ink = inkAdvance(p);
        let link: string | null = null;
        if (links.length) {
            // The glyph's centre inside the link area (areas are drawn a little wider than their text).
            for (const l of links) {
                if (CX >= l.x0 + 1.5 && CX <= l.x1 - 1.5 && CY >= l.y0 - 1 && CY <= l.y1 + 1) {
                    link = l.uri;
                    break;
                }
            }
        }
        glyphs.push({
            seq: p.seq,
            text,
            ws,
            x: X,
            y: Y,
            dx,
            dy,
            u: dx * X + dy * Y,
            v: -dy * X + dx * Y,
            rise,
            size,
            adv: Number.isFinite(p.advUser) ? p.advUser : 0,
            ink: Number.isFinite(ink) ? ink : 0,
            face,
            color,
            bold,
            oblique,
            hscale: Number.isFinite(hscale) && hscale > 1 ? hscale : 100,
            outline,
            invisible,
            span,
            link,
            struct: structure ? structure(p.streamKey, p.opIndex) : null,
            font,
        });
    }
    // ActualText: the span's text replaces its glyphs — carried by the first glyph, the rest contribute nothing.
    if (spans.size) {
        const seen = new Set<string>();
        for (const g of glyphs) {
            if (!g.span) continue;
            if (seen.has(g.span)) g.text = "";
            else {
                seen.add(g.span);
                g.text = spans.get(g.span) ?? g.text;
                g.ws = g.text !== "" && g.text.trim() === "";
            }
        }
    }
    return dedupeOverprints(glyphs);
};

/**
 * Overprinted copies of the same text: shadows drawn first, then the text; fill then stroke layers; text struck twice
 * with a tiny offset (fake bold); invisible copies under visible text. The copy on top is kept.
 */
const dedupeOverprints = (glyphs: Glyph[]): Glyph[] => {
    if (glyphs.length < 2) return glyphs;
    const removed = new Uint8Array(glyphs.length);
    const grid = new Map<string, number[]>();
    const cellOf = (g: Glyph) => Math.max(1, g.size * 0.3);
    const keyOf = (g: Glyph, cx: number, cy: number) => `${g.text}|${cx}|${cy}`;
    const same = (a: Glyph, b: Glyph, ox: number, oy: number, tol: number) =>
        a.text === b.text && Math.abs(a.size - b.size) < 0.15 * a.size && Math.abs(b.x - a.x - ox) <= tol && Math.abs(b.y - a.y - oy) <= tol;
    for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        if (!g.text || g.ws) continue;
        const cell = cellOf(g);
        const gx = Math.floor(g.x / cell);
        const gy = Math.floor(g.y / cell);
        let match = -1;
        for (let ax = -1; ax <= 1 && match < 0; ax++) {
            for (let ay = -1; ay <= 1 && match < 0; ay++) {
                const list = grid.get(keyOf(g, gx + ax, gy + ay));
                if (!list) continue;
                for (let k = list.length - 1; k >= 0; k--) {
                    const j = list[k];
                    if (removed[j]) continue;
                    const o = glyphs[j];
                    if (Math.abs(o.size - g.size) > 0.15 * g.size || Math.abs(o.dx - g.dx) > 1e-3 || Math.abs(o.dy - g.dy) > 1e-3) continue;
                    const ox = g.x - o.x;
                    const oy = g.y - o.y;
                    const dist = Math.hypot(ox, oy);
                    if (dist > 0.3 * g.size) continue;
                    // Tiny offsets are overprints; larger ones only when the neighbours are shifted the same way
                    // (a whole string shadowed), so "ii" in a narrow font is never taken for a copy.
                    let confirmed = dist < 0.06 * g.size;
                    if (!confirmed) {
                        const tol = 0.02 * g.size + 0.05;
                        const nextG = glyphs[i + 1];
                        const nextO = glyphs[j + 1];
                        const prevG = glyphs[i - 1];
                        const prevO = glyphs[j - 1];
                        confirmed =
                            (!!nextG && !!nextO && j + 1 !== i && nextG.text !== "" && !nextG.ws && same(nextO, nextG, ox, oy, tol)) ||
                            (!!prevG && !!prevO && i - 1 !== j && prevG.text !== "" && !prevG.ws && same(prevO, prevG, ox, oy, tol));
                    }
                    if (!confirmed) continue;
                    match = j;
                    break;
                }
            }
        }
        if (match >= 0) {
            const o = glyphs[match];
            if (g.invisible && !o.invisible) {
                removed[i] = 1;
                continue;
            }
            removed[match] = 1;
            const dist = Math.hypot(g.x - o.x, g.y - o.y);
            // Struck twice a hair apart in the same colour: bold.
            if (!o.invisible && !g.invisible && o.color === g.color && dist > 0.004 * g.size && dist < 0.06 * g.size) g.bold = true;
        }
        const key = keyOf(g, gx, gy);
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
    }
    // Whitespace glyphs of removed copies go too (a shadow's spaces would double the real ones).
    for (let i = 0; i < glyphs.length; i++) {
        if (!glyphs[i].ws || removed[i]) continue;
        const prev = glyphs[i - 1];
        const next = glyphs[i + 1];
        if ((prev && removed[i - 1] && (!next || removed[i + 1] || next.ws)) || (next && removed[i + 1] && (!prev || removed[i - 1]))) removed[i] = 1;
    }
    return glyphs.filter((_, i) => !removed[i]);
};
