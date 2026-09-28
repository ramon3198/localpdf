// Content-stream interpreter for everything that is not text (ISO 32000-1 §8): walks the page and the Form XObjects
// it paints (recursively, with /Matrix and /BBox), keeps the graphics state that matters for reproduction — CTM,
// fill / stroke colour, alpha, line width, dash, clip — and turns painting operators into display-space primitives:
// filled boxes, straight rules, image placements and the bounds of vector art that cannot be expressed as either.
import { PDFArray, type PDFContext, PDFDict, PDFName, PDFNumber, type PDFObject, PDFRef, PDFStream } from "pdf-lib";
import { type ContentOp, type Operand, parseContentStream } from "../pdf-text-engine/content-lexer";
import { streamBytes } from "../pdf-text-engine/font-model";
import { type Matrix, applyPt, mul, pageContentBytes } from "../pdf-text-engine/text-interpreter";
import { type ColorSpace, ColorSpaces, GRAY, type RGB, deref, initialColor, numbersOf, toRgb } from "./graphics-color";
import {
    type Box,
    type ClipRegion,
    type SubPath,
    boundsOf,
    boxArea,
    boxH,
    boxW,
    clipOf,
    flatten,
    hasCurves,
    intersectBox,
    intersectClip,
    intersectRegions,
    isRoundedBox,
    polyArea,
    polyBounds,
    rectilinearRegion,
    rectilinearVertices,
    straighten,
} from "./graphics-region";

/** Thickest filled shape that still reads as a line (table borders, underlines, separators). */
export const RULE_MAX = 4.5;

export type RawFill = { box: Box; rgb: RGB; alpha: number; order: number; gradient?: boolean };
export type RawRule = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    rgb: RGB;
    alpha: number;
    order: number;
    style?: "dotted" | "dashed";
    /** The filled box the rule was painted as (thin fills), when it was not a stroke. */
    box?: Box;
};
export type ImageSource =
    | { kind: "xobject"; stream: PDFStream; ref?: PDFRef; resources: PDFDict | null }
    | { kind: "inline"; bytes: Uint8Array; resources: PDFDict | null };
export type ImageDraw = { src: ImageSource; ctm: Matrix; clip: ClipRegion; order: number; fill: RGB | null; alpha: number };
export type ComplexMark = { box: Box; order: number };

export type GraphicsScan = {
    fills: RawFill[];
    rules: RawRule[];
    images: ImageDraw[];
    complex: ComplexMark[];
    /** Work limits were hit: the page is treated as complex vector art. */
    truncated: boolean;
};

type Paint = { cs: ColorSpace; comps: number[]; pattern: PDFObject | null };
type GState = {
    ctm: Matrix;
    /** The CTM at the start of the current content stream (page or form): what pattern matrices are relative to. */
    base: Matrix;
    fill: Paint;
    stroke: Paint;
    ca: number;
    CA: number;
    softMask: boolean;
    lineWidth: number;
    dash: number[];
    clip: ClipRegion;
};

const LIMITS = { ops: 400_000, segments: 20_000, fills: 30_000, rules: 30_000, images: 1_000, complex: 20_000, depth: 12 };

const N = (s: string) => PDFName.of(s);
const nums = (args: Operand[]) => args.map((a) => (a.t === "num" ? a.v : 0));
const nameArg = (a: Operand | undefined) => (a?.t === "name" ? a.v : null);

/** Visibility of optional content (§8.11) under the document's default configuration. */
export class OptionalContent {
    private off = new Set<string>();
    private on = new Set<string>();
    private baseOn = true;
    readonly active: boolean;

    constructor(private readonly context: PDFContext) {
        const catalog = context.lookup(context.trailerInfo.Root);
        const props = catalog instanceof PDFDict ? deref(context, catalog.get(N("OCProperties"))) : undefined;
        const d = props instanceof PDFDict ? deref(context, props.get(N("D"))) : undefined;
        this.active = d instanceof PDFDict;
        if (!(d instanceof PDFDict)) return;
        const base = deref(context, d.get(N("BaseState")));
        this.baseOn = !(base instanceof PDFName && base.decodeText() === "OFF");
        const collect = (key: string, into: Set<string>) => {
            const arr = deref(context, d.get(N(key)));
            if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) into.add(String(arr.get(i)));
        };
        collect("OFF", this.off);
        collect("ON", this.on);
    }

    private ocgVisible(ref: PDFObject | undefined): boolean {
        const key = String(ref);
        return this.baseOn ? !this.off.has(key) : this.on.has(key);
    }

    /** Whether content tagged with this OCG / OCMD (a reference or dictionary) is shown. */
    visible(o: PDFObject | undefined): boolean {
        if (!this.active || !o) return true;
        const d = deref(this.context, o);
        if (!(d instanceof PDFDict)) return true;
        const type = deref(this.context, d.get(N("Type")));
        if (type instanceof PDFName && type.decodeText() === "OCMD") {
            const ocgs = d.get(N("OCGs"));
            const list: PDFObject[] = [];
            const arr = deref(this.context, ocgs);
            if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) list.push(arr.get(i));
            else if (ocgs) list.push(ocgs);
            if (!list.length) return true;
            const states = list.map((x) => this.ocgVisible(x));
            const p = deref(this.context, d.get(N("P")));
            const policy = p instanceof PDFName ? p.decodeText() : "AnyOn";
            if (policy === "AllOn") return states.every(Boolean);
            if (policy === "AnyOff") return states.some((s) => !s);
            if (policy === "AllOff") return states.every((s) => !s);
            return states.some(Boolean);
        }
        return this.ocgVisible(o instanceof PDFRef ? o : undefined);
    }
}

export class GraphicsInterpreter {
    readonly out: GraphicsScan = { fills: [], rules: [], images: [], complex: [], truncated: false };
    private order = 0;
    private opCount = 0;
    private tileDepth = 0;
    private readonly spaces: ColorSpaces;
    private readonly oc: OptionalContent;
    private readonly page: Box;

    constructor(
        private readonly context: PDFContext,
        pageSize: { width: number; height: number },
        private readonly baseMatrix: Matrix,
    ) {
        this.spaces = new ColorSpaces(context);
        this.oc = new OptionalContent(context);
        this.page = { x0: 0, y0: 0, x1: pageSize.width, y1: pageSize.height };
    }

    runPage(pageDict: PDFDict, resources: PDFDict | null) {
        const bytes = pageContentBytes(this.context, pageDict);
        const gs: GState = {
            ctm: this.baseMatrix,
            base: this.baseMatrix,
            fill: { cs: GRAY, comps: [0], pattern: null },
            stroke: { cs: GRAY, comps: [0], pattern: null },
            ca: 1,
            CA: 1,
            softMask: false,
            lineWidth: 1,
            dash: [],
            clip: clipOf([this.page], true),
        };
        this.run(bytes, parseContentStream(bytes), resources, gs, 0, new Set());
    }

    /** Records vector art over `box`, widened by `pad` (half the pen of a stroke) and cut to the clip and the page. */
    private complexAt(box: Box | null, clip: ClipRegion, pad = 0) {
        if (!box || this.out.complex.length >= LIMITS.complex) return;
        const wide = pad > 0 ? { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad } : box;
        const b = intersectBox(wide, clip.bbox);
        const c = b && intersectBox(b, this.page);
        if (c) this.out.complex.push({ box: c, order: this.order++ });
    }

    private run(bytes: Uint8Array, ops: ContentOp[], resources: PDFDict | null, start: GState, depth: number, forms: Set<string>) {
        const context = this.context;
        let gs: GState = { ...start };
        const stack: GState[] = [];
        let subpaths: SubPath[] = [];
        let cur: SubPath | null = null;
        let lastStart: [number, number] | null = null;
        let clipPending: "nz" | "eo" | null = null;
        // Marked-content nesting: true where optional content hides what is painted.
        const marked: boolean[] = [];
        let hiddenDepth = 0;

        const res = (cat: string, name: string): PDFObject | undefined => {
            const d = resources ? deref(context, resources.get(N(cat))) : undefined;
            return d instanceof PDFDict ? d.get(N(name)) : undefined;
        };
        const pt = (x: number, y: number) => applyPt(gs.ctm, x, y);
        const current = (): [number, number] | null => {
            if (cur) {
                const last = cur.segs[cur.segs.length - 1];
                return last ? [last.x, last.y] : [cur.x, cur.y];
            }
            return lastStart;
        };
        const ensure = () => {
            if (!cur) {
                const p = lastStart ?? [0, 0];
                cur = { x: p[0], y: p[1], segs: [], closed: false };
                subpaths.push(cur);
            }
            return cur;
        };
        const endPath = () => {
            if (clipPending) {
                const region = this.clipRegion(subpaths, clipPending === "eo");
                if (region) gs = { ...gs, clip: intersectClip(gs.clip, region) };
            }
            subpaths = [];
            cur = null;
            lastStart = null;
            clipPending = null;
        };
        const setColor = (which: "fill" | "stroke", args: Operand[], space?: ColorSpace) => {
            const paint = gs[which];
            const cs = space ?? paint.cs;
            const pattern = cs.kind === "pattern" ? nameArg(args[args.length - 1]) : null;
            const comps = nums(args.filter((a) => a.t === "num"));
            gs = { ...gs, [which]: { cs, comps, pattern: pattern ? (res("Pattern", pattern) ?? null) : null } };
        };

        for (const op of ops) {
            if (++this.opCount > LIMITS.ops) {
                this.out.truncated = true;
                return;
            }
            const a = op.args;
            const hidden = hiddenDepth > 0;
            switch (op.op) {
                // ── Graphics state ──
                case "q":
                    stack.push(gs);
                    break;
                case "Q":
                    if (stack.length) gs = stack.pop()!;
                    break;
                case "cm": {
                    const m = nums(a);
                    if (m.length === 6 && m.every(Number.isFinite)) gs = { ...gs, ctm: mul(m as Matrix, gs.ctm) };
                    break;
                }
                case "w":
                    if (a[0]?.t === "num") gs = { ...gs, lineWidth: a[0].v };
                    break;
                case "d": {
                    const arr = a[0]?.t === "arr" ? nums(a[0].items) : [];
                    gs = { ...gs, dash: arr.some((v) => v > 0) ? arr : [] };
                    break;
                }
                case "gs": {
                    const nm = nameArg(a[0]);
                    const eg = nm ? deref(context, res("ExtGState", nm)) : undefined;
                    if (eg instanceof PDFDict) gs = this.applyExtGState(gs, eg);
                    break;
                }
                // ── Colour ──
                case "g":
                    gs = { ...gs, fill: { cs: GRAY, comps: nums(a), pattern: null } };
                    break;
                case "G":
                    gs = { ...gs, stroke: { cs: GRAY, comps: nums(a), pattern: null } };
                    break;
                case "rg":
                    gs = { ...gs, fill: { cs: { kind: "rgb" }, comps: nums(a), pattern: null } };
                    break;
                case "RG":
                    gs = { ...gs, stroke: { cs: { kind: "rgb" }, comps: nums(a), pattern: null } };
                    break;
                case "k":
                    gs = { ...gs, fill: { cs: { kind: "cmyk" }, comps: nums(a), pattern: null } };
                    break;
                case "K":
                    gs = { ...gs, stroke: { cs: { kind: "cmyk" }, comps: nums(a), pattern: null } };
                    break;
                case "cs":
                case "CS": {
                    const nm = a[0]?.t === "name" ? PDFName.of(a[0].v) : undefined;
                    const cs = this.spaces.resolve(nm, resources);
                    const paint: Paint = { cs, comps: initialColor(cs), pattern: null };
                    gs = op.op === "cs" ? { ...gs, fill: paint } : { ...gs, stroke: paint };
                    break;
                }
                case "sc":
                case "scn":
                    setColor("fill", a);
                    break;
                case "SC":
                case "SCN":
                    setColor("stroke", a);
                    break;
                // ── Path construction ──
                case "m": {
                    const [x, y] = nums(a);
                    const p = pt(x ?? 0, y ?? 0);
                    if (subpaths.length >= LIMITS.segments) break;
                    cur = { x: p[0], y: p[1], segs: [], closed: false };
                    subpaths.push(cur);
                    lastStart = p;
                    break;
                }
                case "l": {
                    const [x, y] = nums(a);
                    const p = pt(x ?? 0, y ?? 0);
                    const sp = ensure();
                    if (sp.segs.length < LIMITS.segments) sp.segs.push({ kind: "L", x: p[0], y: p[1] });
                    break;
                }
                case "c":
                case "v":
                case "y": {
                    const v = nums(a);
                    const from = current() ?? [0, 0];
                    let c1: [number, number];
                    let c2: [number, number];
                    let end: [number, number];
                    if (op.op === "c") {
                        c1 = pt(v[0] ?? 0, v[1] ?? 0);
                        c2 = pt(v[2] ?? 0, v[3] ?? 0);
                        end = pt(v[4] ?? 0, v[5] ?? 0);
                    } else if (op.op === "v") {
                        c1 = from;
                        c2 = pt(v[0] ?? 0, v[1] ?? 0);
                        end = pt(v[2] ?? 0, v[3] ?? 0);
                    } else {
                        c1 = pt(v[0] ?? 0, v[1] ?? 0);
                        end = pt(v[2] ?? 0, v[3] ?? 0);
                        c2 = end;
                    }
                    const sp = ensure();
                    if (sp.segs.length < LIMITS.segments) sp.segs.push({ kind: "C", x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1], x: end[0], y: end[1] });
                    break;
                }
                case "h":
                    if (cur) {
                        cur.closed = true;
                        lastStart = [cur.x, cur.y];
                        cur = null;
                    }
                    break;
                case "re": {
                    const [x, y, w, h] = nums(a);
                    if (subpaths.length >= LIMITS.segments) break;
                    const p0 = pt(x ?? 0, y ?? 0);
                    const p1 = pt((x ?? 0) + (w ?? 0), y ?? 0);
                    const p2 = pt((x ?? 0) + (w ?? 0), (y ?? 0) + (h ?? 0));
                    const p3 = pt(x ?? 0, (y ?? 0) + (h ?? 0));
                    subpaths.push({
                        x: p0[0],
                        y: p0[1],
                        segs: [
                            { kind: "L", x: p1[0], y: p1[1] },
                            { kind: "L", x: p2[0], y: p2[1] },
                            { kind: "L", x: p3[0], y: p3[1] },
                        ],
                        closed: true,
                        rect: true,
                    });
                    cur = null;
                    lastStart = p0;
                    break;
                }
                // ── Clipping and painting ──
                case "W":
                    clipPending = "nz";
                    break;
                case "W*":
                    clipPending = "eo";
                    break;
                case "n":
                    endPath();
                    break;
                case "f":
                case "F":
                case "f*":
                    if (!hidden) this.fillPath(subpaths, op.op === "f*", gs, resources);
                    endPath();
                    break;
                case "S":
                case "s":
                    if (!hidden) this.strokePath(subpaths, op.op === "s", gs);
                    endPath();
                    break;
                case "B":
                case "B*":
                case "b":
                case "b*":
                    if (!hidden) {
                        this.fillPath(subpaths, op.op.endsWith("*"), gs, resources);
                        this.strokePath(subpaths, op.op.startsWith("b"), gs);
                    }
                    endPath();
                    break;
                case "sh": {
                    const nm = nameArg(a[0]);
                    const sh = nm ? deref(context, res("Shading", nm)) : undefined;
                    if (!hidden && sh) this.paintShading(sh, gs, resources, gs.clip.boxes);
                    break;
                }
                // ── XObjects and inline images ──
                case "Do": {
                    if (hidden) break;
                    const nm = nameArg(a[0]);
                    const xo = nm ? res("XObject", nm) : undefined;
                    const stream = deref(context, xo);
                    if (!(stream instanceof PDFStream)) break;
                    const oc = stream.dict.get(N("OC"));
                    if (oc && !this.oc.visible(oc)) break;
                    const subtype = deref(context, stream.dict.get(N("Subtype")));
                    const st = subtype instanceof PDFName ? subtype.decodeText() : "";
                    if (st === "Image") {
                        this.drawImage({ kind: "xobject", stream, ref: xo instanceof PDFRef ? xo : undefined, resources }, gs);
                    } else if (st === "Form" && depth < LIMITS.depth) {
                        const id = xo instanceof PDFRef ? xo.toString() : `inline:${nm}:${depth}`;
                        if (forms.has(id)) break;
                        this.runForm(stream, id, resources, gs, depth, forms);
                    }
                    break;
                }
                case "BI":
                    if (!hidden) this.drawImage({ kind: "inline", bytes: bytes.subarray(op.start, op.end), resources }, gs);
                    break;
                // ── Optional content ──
                case "BMC":
                    marked.push(false);
                    break;
                case "BDC": {
                    let hide = false;
                    if (nameArg(a[0]) === "OC") {
                        const prop = a[1];
                        if (prop?.t === "name") {
                            const pobj = res("Properties", prop.v);
                            hide = !this.oc.visible(pobj);
                        }
                    }
                    marked.push(hide);
                    if (hide) hiddenDepth++;
                    break;
                }
                case "EMC":
                    if (marked.pop()) hiddenDepth = Math.max(0, hiddenDepth - 1);
                    break;
            }
        }
    }

    private applyExtGState(gs: GState, eg: PDFDict): GState {
        const context = this.context;
        const num = (k: string) => {
            const v = deref(context, eg.get(N(k)));
            return v instanceof PDFNumber ? v.asNumber() : undefined;
        };
        const next = { ...gs };
        const lw = num("LW");
        if (lw !== undefined) next.lineWidth = lw;
        const ca = num("ca");
        if (ca !== undefined) next.ca = Math.max(0, Math.min(1, ca));
        const CA = num("CA");
        if (CA !== undefined) next.CA = Math.max(0, Math.min(1, CA));
        const sm = deref(context, eg.get(N("SMask")));
        if (sm) next.softMask = !(sm instanceof PDFName && sm.decodeText() === "None");
        const d = deref(context, eg.get(N("D")));
        if (d instanceof PDFArray && d.size() >= 1) {
            const arr = numbersOf(context, d.get(0)) ?? [];
            next.dash = arr.some((v) => v > 0) ? arr : [];
        }
        return next;
    }

    private runForm(stream: PDFStream, id: string, parentRes: PDFDict | null, gs: GState, depth: number, forms: Set<string>) {
        const context = this.context;
        const bytes = streamBytes(stream);
        if (!bytes) return;
        const m = numbersOf(context, stream.dict.get(N("Matrix")));
        const fm: Matrix = m && m.length === 6 ? (m as Matrix) : [1, 0, 0, 1, 0, 0];
        const ctm = mul(fm, gs.ctm);
        let clip = gs.clip;
        const bb = numbersOf(context, stream.dict.get(N("BBox")));
        if (bb && bb.length === 4) {
            const corners = [applyPt(ctm, bb[0], bb[1]), applyPt(ctm, bb[2], bb[1]), applyPt(ctm, bb[2], bb[3]), applyPt(ctm, bb[0], bb[3])];
            const flat = corners.flat();
            const box = polyBounds(flat);
            const axis = Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
            const swapped = Math.abs(ctm[0]) < 1e-6 && Math.abs(ctm[3]) < 1e-6;
            const exact = axis || swapped;
            const region = clipOf([box], exact, exact ? 1 : polyArea(flat) / Math.max(boxArea(box), 1e-9));
            if (!exact) region.shapes = [{ polys: [flat], evenOdd: false }];
            clip = intersectClip(clip, region);
        }
        const fr = deref(context, stream.dict.get(N("Resources")));
        const resources = fr instanceof PDFDict ? fr : parentRes;
        const inner: GState = { ...gs, ctm, base: ctm, clip };
        const next = new Set(forms);
        next.add(id);
        this.run(bytes, parseContentStream(bytes), resources, inner, depth + 1, next);
    }

    private drawImage(src: ImageSource, gs: GState) {
        if (this.out.images.length >= LIMITS.images) {
            this.out.truncated = true;
            return;
        }
        const fill = gs.fill.cs.kind === "pattern" ? null : toRgb(gs.fill.cs, gs.fill.comps);
        this.out.images.push({ src, ctm: gs.ctm, clip: gs.clip, order: this.order++, fill, alpha: gs.ca });
    }

    // ── Fills ──────────────────────────────────────────────────────────────────────────────────────────────────────

    /** The area a path covers as boxes: exact for rectilinear paths, the bounds of box-like shapes otherwise. */
    private shapeOf(subpaths: SubPath[], evenOdd: boolean): { boxes: Box[]; exact: boolean; complex: boolean; bbox: Box | null; ratio: number } {
        const sps = subpaths.map(straighten).filter((sp) => sp.segs.length > 0);
        if (!sps.length) return { boxes: [], exact: true, complex: false, bbox: null, ratio: 1 };
        const polys: number[][] = [];
        let exact = true;
        let complex = false;
        let area = 0;
        const all: number[] = [];
        for (const sp of sps) {
            const flat = flatten(sp);
            all.push(...flat);
            const rv = rectilinearVertices(sp);
            if (rv) {
                polys.push(rv);
                area += polyArea(rv);
                continue;
            }
            exact = false;
            const b = polyBounds(flat);
            const a = polyArea(flat);
            area += a;
            // Thin, elongated shapes read as lines whatever their ends look like (mitred border pieces).
            const t = Math.min(boxW(b), boxH(b));
            const thin = t <= RULE_MAX && Math.max(boxW(b), boxH(b)) >= 3 * t;
            const boxy = isRoundedBox(sp) || a >= 0.95 * boxArea(b);
            if (!thin && !boxy) complex = true;
            // Keep the subpath's orientation so the nonzero rule still sees holes.
            let signed = 0;
            for (let i = 0; i < flat.length; i += 2) {
                const j = (i + 2) % flat.length;
                signed += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
            }
            const r = [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1].map((v) => Math.round(v * 100) / 100);
            polys.push(signed >= 0 ? r : [r[0], r[1], r[6], r[7], r[4], r[5], r[2], r[3]]);
        }
        const bbox = polyBounds(all);
        const ratio = Math.min(1, area / Math.max(boxArea(bbox), 1e-9));
        if (complex) return { boxes: [bbox], exact: false, complex: true, bbox, ratio };
        const boxes = rectilinearRegion(polys, evenOdd);
        if (!boxes) return { boxes: [bbox], exact: false, complex: false, bbox, ratio };
        return { boxes, exact, complex: false, bbox, ratio };
    }

    private clipRegion(subpaths: SubPath[], evenOdd: boolean): ClipRegion | null {
        if (!subpaths.some((sp) => sp.segs.length > 0)) return null;
        const shape = this.shapeOf(subpaths, evenOdd);
        if (!shape.bbox) return null;
        if (shape.complex || !shape.exact) {
            // Rounded or slanted clips: approximate by the bounds, remembering how much of them the shape covers and
            // its outline (pictures inside are masked by it).
            const boxes = shape.complex ? [shape.bbox] : shape.boxes;
            const region = clipOf(boxes, false, shape.ratio);
            const polys = subpaths.filter((sp) => sp.segs.length > 0).map(flatten);
            if (polys.reduce((n, p) => n + p.length / 2, 0) <= 2000) region.shapes = [{ polys, evenOdd }];
            return region;
        }
        return clipOf(shape.boxes, true);
    }

    private fillPath(subpaths: SubPath[], evenOdd: boolean, gs: GState, resources: PDFDict | null) {
        if (!subpaths.length) return;
        const shape = this.shapeOf(subpaths, evenOdd);
        if (!shape.bbox) return;
        if (shape.complex || gs.softMask) {
            this.complexAt(shape.bbox, gs.clip);
            return;
        }
        if (gs.fill.cs.kind === "pattern") {
            const pat = deref(this.context, gs.fill.pattern ?? undefined);
            this.paintPattern(pat, gs, resources, shape.boxes);
            return;
        }
        const rgb = toRgb(gs.fill.cs, gs.fill.comps);
        if (!rgb || gs.ca < 0.03) return;
        this.emitArea(shape.boxes, gs, rgb, gs.ca);
    }

    /** Paints boxes (already in display space) under the clip: thin ones become rules, the rest fills. */
    private emitArea(boxes: Box[], gs: GState, rgb: RGB, alpha: number, gradient?: boolean) {
        const clip = gs.clip;
        let visible = intersectRegions(boxes, clip.boxes);
        visible = intersectRegions(visible, [this.page]);
        if (!visible.length) return;
        if (!clip.exact && clip.fillRatio < 0.985) {
            // A slanted or curved clip cuts the shape: what shows is not a box.
            const bounds = boundsOf(visible)!;
            if (boxArea(bounds) > 0.3 * boxArea(clip.bbox) || boxArea(bounds) > 400) this.complexAt(bounds, clip);
        }
        const order = this.order++;
        for (const b of visible) {
            const w = boxW(b);
            const h = boxH(b);
            const t = Math.min(w, h);
            const len = Math.max(w, h);
            if (t <= RULE_MAX && len >= 3 * t && len >= 1 && !gradient) {
                if (this.out.rules.length >= LIMITS.rules) {
                    this.out.truncated = true;
                    continue;
                }
                const horizontal = w >= h;
                const cy = (b.y0 + b.y1) / 2;
                const cx = (b.x0 + b.x1) / 2;
                this.out.rules.push(
                    horizontal
                        ? { x1: b.x0, y1: cy, x2: b.x1, y2: cy, width: h, rgb, alpha, order, box: b }
                        : { x1: cx, y1: b.y0, x2: cx, y2: b.y1, width: w, rgb, alpha, order, box: b },
                );
            } else {
                if (this.out.fills.length >= LIMITS.fills) {
                    this.out.truncated = true;
                    continue;
                }
                this.out.fills.push({ box: b, rgb, alpha, order, gradient });
            }
        }
    }

    // ── Strokes ────────────────────────────────────────────────────────────────────────────────────────────────────

    private strokePath(subpaths: SubPath[], closeAll: boolean, gs: GState) {
        if (!subpaths.length) return;
        const [a, b, c, d] = gs.ctm;
        // Width across a horizontal / vertical display segment: the pen (a disk of lineWidth) mapped by the CTM.
        const lw = gs.lineWidth > 0 ? gs.lineWidth : 0;
        const widthH = lw > 0 ? lw * Math.hypot(b, d) : 0.5;
        const widthV = lw > 0 ? lw * Math.hypot(a, c) : 0.5;
        // Stroked art reaches half a pen beyond its path.
        const pen = Math.max(widthH, widthV) / 2;
        if (gs.softMask || gs.stroke.cs.kind === "pattern") {
            const all = subpaths.flatMap(flatten);
            if (all.length) this.complexAt(polyBounds(all), gs.clip, pen);
            return;
        }
        const rgb = toRgb(gs.stroke.cs, gs.stroke.comps);
        if (!rgb || gs.CA < 0.03) return;
        let style: RawRule["style"];
        if (gs.dash.length) {
            const on = gs.dash.filter((_, i) => i % 2 === 0);
            const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
            style = Math.max(...on) * scale <= Math.max(widthH, widthV) * 1.5 ? "dotted" : "dashed";
        }
        const order = this.order++;
        for (const raw of subpaths) {
            const sp = straighten(raw);
            if (!sp.segs.length) continue;
            const rounded = isRoundedBox(sp);
            let px = sp.x;
            let py = sp.y;
            const segment = (x0: number, y0: number, x1: number, y1: number) => {
                const dx = x1 - x0;
                const dy = y1 - y0;
                if (Math.hypot(dx, dy) < 0.05) return;
                if (Math.abs(dy) <= 0.05) this.emitRule(Math.min(x0, x1), y0, Math.max(x0, x1), y0, widthH, true, rgb, gs, order, style);
                else if (Math.abs(dx) <= 0.05) this.emitRule(x0, Math.min(y0, y1), x0, Math.max(y0, y1), widthV, false, rgb, gs, order, style);
                else this.complexAt(polyBounds([x0, y0, x1, y1]), gs.clip, pen);
            };
            for (const s of sp.segs) {
                if (s.kind === "L") segment(px, py, s.x, s.y);
                else if (!rounded) this.complexAt(polyBounds(flatten({ x: px, y: py, segs: [s], closed: false })), gs.clip, pen);
                px = s.x;
                py = s.y;
            }
            if (sp.closed || closeAll || sp.rect) segment(px, py, sp.x, sp.y);
        }
    }

    private emitRule(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        width: number,
        horizontal: boolean,
        rgb: RGB,
        gs: GState,
        order: number,
        style?: RawRule["style"],
    ) {
        const half = width / 2;
        const box: Box = horizontal ? { x0: x1, y0: y1 - half, x1: x2, y1: y1 + half } : { x0: x1 - half, y0: y1, x1: x1 + half, y1: y2 };
        // Zero-length pieces still need a body to intersect with the clip.
        if (box.x1 - box.x0 < 1e-3) box.x1 = box.x0 + 1e-3;
        if (box.y1 - box.y0 < 1e-3) box.y1 = box.y0 + 1e-3;
        const pieces = intersectRegions(intersectRegions([box], gs.clip.boxes), [this.page]);
        for (const p of pieces) {
            if (this.out.rules.length >= LIMITS.rules) {
                this.out.truncated = true;
                return;
            }
            const w = horizontal ? Math.min(width, p.y1 - p.y0) : Math.min(width, p.x1 - p.x0);
            this.out.rules.push(
                horizontal
                    ? { x1: p.x0, y1: (p.y0 + p.y1) / 2, x2: p.x1, y2: (p.y0 + p.y1) / 2, width: w, rgb, alpha: gs.CA, order, style }
                    : { x1: (p.x0 + p.x1) / 2, y1: p.y0, x2: (p.x0 + p.x1) / 2, y2: p.y1, width: w, rgb, alpha: gs.CA, order, style },
            );
        }
    }

    // ── Shadings and patterns ──────────────────────────────────────────────────────────────────────────────────────

    /** Average colour of an axial / radial / function shading and how much it varies (0..1). */
    private shadingColor(sh: PDFObject, resources: PDFDict | null): { rgb: RGB; spread: number } | null {
        const context = this.context;
        const dict = sh instanceof PDFStream ? sh.dict : sh instanceof PDFDict ? sh : null;
        if (!dict) return null;
        const cs = this.spaces.resolve(dict.get(N("ColorSpace")), resources);
        const typeObj = deref(context, dict.get(N("ShadingType")));
        const type = typeObj instanceof PDFNumber ? typeObj.asNumber() : 0;
        const fn = this.spaces.fn(dict.get(N("Function")));
        const samples: RGB[] = [];
        if ((type === 2 || type === 3) && fn) {
            const dom = numbersOf(context, dict.get(N("Domain"))) ?? [0, 1];
            for (let i = 0; i <= 8; i++) {
                const t = dom[0] + ((dom[1] - dom[0]) * i) / 8;
                const rgb = toRgb(cs, fn([t]));
                if (rgb) samples.push(rgb);
            }
        } else if (type === 1 && fn) {
            const dom = numbersOf(context, dict.get(N("Domain"))) ?? [0, 1, 0, 1];
            for (let i = 0; i <= 4; i++)
                for (let j = 0; j <= 4; j++) {
                    const rgb = toRgb(cs, fn([dom[0] + ((dom[1] - dom[0]) * i) / 4, dom[2] + ((dom[3] - dom[2]) * j) / 4]));
                    if (rgb) samples.push(rgb);
                }
        }
        if (!samples.length) return null;
        const avg: RGB = [0, 1, 2].map((k) => samples.reduce((s, c) => s + c[k], 0) / samples.length) as RGB;
        let spread = 0;
        for (let k = 0; k < 3; k++) {
            const vals = samples.map((c) => c[k]);
            spread = Math.max(spread, Math.max(...vals) - Math.min(...vals));
        }
        return { rgb: avg, spread };
    }

    private paintShading(sh: PDFObject, gs: GState, resources: PDFDict | null, area: Box[]) {
        const shade = this.shadingColor(sh, resources);
        const bounds = boundsOf(intersectRegions(area, [this.page]));
        if (!shade || gs.softMask) {
            this.complexAt(bounds, gs.clip);
            return;
        }
        // Gentle gradients read as a flat colour; strong ones are design elements.
        if (shade.spread > 0.1) this.complexAt(bounds, gs.clip);
        if (gs.ca >= 0.03) this.emitArea(area, gs, shade.rgb, gs.ca, true);
    }

    private paintPattern(pat: PDFObject | undefined, gs: GState, resources: PDFDict | null, boxes: Box[]) {
        const context = this.context;
        const dict = pat instanceof PDFStream ? pat.dict : pat instanceof PDFDict ? pat : null;
        const typeObj = dict ? deref(context, dict.get(N("PatternType"))) : undefined;
        const type = typeObj instanceof PDFNumber ? typeObj.asNumber() : 0;
        if (dict && type === 2) {
            const sh = deref(context, dict.get(N("Shading")));
            if (sh) {
                this.paintShading(sh, gs, resources, boxes);
                return;
            }
        }
        if (pat instanceof PDFStream && type === 1 && this.paintTiles(pat, gs, resources, boxes)) return;
        // Textures, hatching and unreadable patterns.
        this.complexAt(boundsOf(boxes), gs.clip);
    }

    /**
     * Tiling patterns whose area is covered by a few tiles (how browsers print CSS background images: one tile the
     * size of the element) are drawn by running the tile's content in place, clipped to the filled area.
     */
    private paintTiles(pat: PDFStream, gs: GState, resources: PDFDict | null, boxes: Box[]): boolean {
        const context = this.context;
        if (this.tileDepth >= 3) return false;
        const bytes = streamBytes(pat);
        const bbox = numbersOf(context, pat.dict.get(N("BBox")));
        if (!bytes || !bbox || bbox.length !== 4) return false;
        const m = numbersOf(context, pat.dict.get(N("Matrix")));
        const pm: Matrix = m && m.length === 6 ? (m as Matrix) : [1, 0, 0, 1, 0, 0];
        const M = mul(pm, gs.base);
        const xs = deref(context, pat.dict.get(N("XStep")));
        const ys = deref(context, pat.dict.get(N("YStep")));
        const xstep = Math.abs(xs instanceof PDFNumber ? xs.asNumber() : bbox[2] - bbox[0]) || 1;
        const ystep = Math.abs(ys instanceof PDFNumber ? ys.asNumber() : bbox[3] - bbox[1]) || 1;
        const area = intersectRegions(intersectRegions(boxes, gs.clip.boxes), [this.page]);
        const bounds = boundsOf(area);
        if (!bounds) return true;
        const [a, b, c, d, e, f] = M;
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-9) return false;
        const inv: Matrix = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
        const pb = polyBounds(
            [
                applyPt(inv, bounds.x0, bounds.y0),
                applyPt(inv, bounds.x1, bounds.y0),
                applyPt(inv, bounds.x0, bounds.y1),
                applyPt(inv, bounds.x1, bounds.y1),
            ].flat(),
        );
        const i0 = Math.ceil((pb.x0 - bbox[2]) / xstep - 1e-6);
        const i1 = Math.floor((pb.x1 - bbox[0]) / xstep + 1e-6);
        const j0 = Math.ceil((pb.y0 - bbox[3]) / ystep - 1e-6);
        const j1 = Math.floor((pb.y1 - bbox[1]) / ystep + 1e-6);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4 || i1 < i0 || j1 < j0) return false;
        const pr = deref(context, pat.dict.get(N("Resources")));
        const tileRes = pr instanceof PDFDict ? pr : resources;
        const ops = parseContentStream(bytes);
        const axis = (Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6) || (Math.abs(a) < 1e-6 && Math.abs(d) < 1e-6);
        for (let i = i0; i <= i1; i++)
            for (let j = j0; j <= j1; j++) {
                const ctm = mul([1, 0, 0, 1, i * xstep, j * ystep], M);
                const tileBox = polyBounds(
                    [applyPt(ctm, bbox[0], bbox[1]), applyPt(ctm, bbox[2], bbox[1]), applyPt(ctm, bbox[0], bbox[3]), applyPt(ctm, bbox[2], bbox[3])].flat(),
                );
                const clip = intersectClip(clipOf(area, gs.clip.exact), clipOf([tileBox], axis));
                const tileGs: GState = {
                    ctm,
                    base: ctm,
                    fill: { cs: GRAY, comps: [0], pattern: null },
                    stroke: { cs: GRAY, comps: [0], pattern: null },
                    ca: gs.ca,
                    CA: gs.CA,
                    softMask: gs.softMask,
                    lineWidth: 1,
                    dash: [],
                    clip,
                };
                this.tileDepth++;
                try {
                    this.run(bytes, ops, tileRes, tileGs, 1, new Set());
                } finally {
                    this.tileDepth--;
                }
            }
        return true;
    }
}

export { boxArea, boxH, boxW };
