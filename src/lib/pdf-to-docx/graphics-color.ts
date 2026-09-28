// Colour spaces and PDF functions (ISO 32000-1 §8.6, §7.10): enough to turn any fill / stroke colour or image sample
// into sRGB — Device*, Cal*, ICCBased (by N / Alternate), Lab, Indexed, Separation and DeviceN (tint transforms of
// type 0, 2, 3 and 4) — plus the Pattern space, which callers treat separately.
import { PDFArray, type PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRef, PDFStream, PDFString } from "pdf-lib";
import { streamBytes } from "../pdf-text-engine/font-model";
import { cmykToRgb } from "./graphics-cmyk";

export type PdfFunction = (input: number[]) => number[];

export type ColorSpace =
    | { kind: "gray" }
    | { kind: "rgb" }
    | { kind: "cmyk" }
    | { kind: "lab"; white: [number, number, number]; range: [number, number, number, number] }
    | { kind: "indexed"; base: ColorSpace; hival: number; lookup: Uint8Array }
    | { kind: "separation"; alt: ColorSpace; fn: PdfFunction | null; none: boolean; all: boolean }
    | { kind: "devicen"; n: number; alt: ColorSpace; fn: PdfFunction | null; none: boolean }
    | { kind: "pattern"; base: ColorSpace | null };

export type RGB = [number, number, number];

const N = (s: string) => PDFName.of(s);

export const GRAY: ColorSpace = { kind: "gray" };
export const RGB_CS: ColorSpace = { kind: "rgb" };
export const CMYK: ColorSpace = { kind: "cmyk" };

export const deref = (context: PDFContext, o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? context.lookup(o) : o);

export const numbersOf = (context: PDFContext, o: PDFObject | undefined): number[] | null => {
    const a = deref(context, o);
    if (!(a instanceof PDFArray)) return null;
    const out: number[] = [];
    for (let i = 0; i < a.size(); i++) {
        const v = deref(context, a.get(i));
        out.push(v instanceof PDFNumber ? v.asNumber() : 0);
    }
    return out;
};

const nameStr = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? o.decodeText() : undefined);

const bytesOf = (context: PDFContext, o: PDFObject | undefined): Uint8Array | null => {
    const v = deref(context, o);
    if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes();
    if (v instanceof PDFStream) return streamBytes(v);
    return null;
};

export const componentsOf = (cs: ColorSpace): number => {
    switch (cs.kind) {
        case "gray":
        case "indexed":
        case "separation":
            return 1;
        case "rgb":
        case "lab":
            return 3;
        case "cmyk":
            return 4;
        case "devicen":
            return cs.n;
        case "pattern":
            return cs.base ? componentsOf(cs.base) : 0;
    }
};

/** The colour a colour space starts with after cs / CS (§8.6.8). */
export const initialColor = (cs: ColorSpace): number[] => {
    switch (cs.kind) {
        case "gray":
        case "indexed":
            return [0];
        case "rgb":
            return [0, 0, 0];
        case "cmyk":
            return [0, 0, 0, 1];
        case "lab":
            return [0, Math.max(0, cs.range[0]), Math.max(0, cs.range[2])];
        case "separation":
            return [1];
        case "devicen":
            return new Array(cs.n).fill(1);
        case "pattern":
            return [];
    }
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

const labToRgb = (cs: Extract<ColorSpace, { kind: "lab" }>, L: number, a: number, b: number): RGB => {
    const [Xw, Yw, Zw] = cs.white;
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const g = (t: number) => (t >= 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));
    // XYZ relative to the space's white point, adapted to D65 by scaling (von Kries on XYZ; good enough for fills).
    const X = g(fx) * Xw * (0.9505 / (Xw || 0.9505));
    const Y = g(fy) * Yw * (1 / (Yw || 1));
    const Z = g(fz) * Zw * (1.089 / (Zw || 1.089));
    const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
    const gamma = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return [gamma(lin[0]), gamma(lin[1]), gamma(lin[2])];
};

/** Colour components (in the space's own ranges) → sRGB 0..1, or null when nothing is painted (/None separations). */
export const toRgb = (cs: ColorSpace, comps: number[], depth = 0): RGB | null => {
    const c = (i: number, dflt = 0) => (Number.isFinite(comps[i]) ? comps[i] : dflt);
    switch (cs.kind) {
        case "gray": {
            const v = clamp01(c(0));
            return [v, v, v];
        }
        case "rgb":
            return [clamp01(c(0)), clamp01(c(1)), clamp01(c(2))];
        case "cmyk":
            return cmykToRgb(clamp01(c(0)), clamp01(c(1)), clamp01(c(2)), clamp01(c(3, 1)));
        case "lab":
            return labToRgb(cs, c(0), c(1), c(2));
        case "indexed": {
            const nb = componentsOf(cs.base);
            const idx = Math.max(0, Math.min(cs.hival, Math.round(c(0))));
            const base: number[] = [];
            for (let k = 0; k < nb; k++) {
                const v = (cs.lookup[idx * nb + k] ?? 0) / 255;
                if (cs.base.kind === "lab") {
                    const lo = k === 0 ? 0 : cs.base.range[(k - 1) * 2];
                    const hi = k === 0 ? 100 : cs.base.range[(k - 1) * 2 + 1];
                    base.push(lo + v * (hi - lo));
                } else base.push(v);
            }
            return depth > 4 ? null : toRgb(cs.base, base, depth + 1);
        }
        case "separation": {
            if (cs.none) return null;
            const t = clamp01(c(0, 1));
            if (cs.all || !cs.fn) return [1 - t, 1 - t, 1 - t];
            const alt = safeEval(cs.fn, [t]);
            return alt && depth <= 4 ? toRgb(cs.alt, alt, depth + 1) : [1 - t, 1 - t, 1 - t];
        }
        case "devicen": {
            if (cs.none) return null;
            const ins = Array.from({ length: cs.n }, (_, i) => clamp01(c(i, 1)));
            const alt = cs.fn ? safeEval(cs.fn, ins) : null;
            if (alt && depth <= 4) return toRgb(cs.alt, alt, depth + 1);
            const t = Math.max(...ins, 0);
            return [1 - t, 1 - t, 1 - t];
        }
        case "pattern":
            return cs.base && depth <= 4 ? toRgb(cs.base, comps, depth + 1) : null;
    }
};

const safeEval = (fn: PdfFunction, input: number[]): number[] | null => {
    try {
        const out = fn(input);
        return out.every((v) => Number.isFinite(v)) ? out : null;
    } catch {
        return null;
    }
};

export const rgbToHex = (rgb: RGB): string =>
    rgb
        .map((v) =>
            Math.round(clamp01(v) * 255)
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")
        .toUpperCase();

// ── Colour space resolution ─────────────────────────────────────────────────────────────────────────────────────────

const deviceByName = (n: string): ColorSpace | null => {
    switch (n) {
        case "DeviceGray":
        case "G":
        case "CalGray":
            return GRAY;
        case "DeviceRGB":
        case "RGB":
        case "CalRGB":
            return RGB_CS;
        case "DeviceCMYK":
        case "CMYK":
            return CMYK;
        case "Pattern":
            return { kind: "pattern", base: null };
    }
    return null;
};

export class ColorSpaces {
    private cache = new Map<PDFObject, ColorSpace>();
    private fnCache = new Map<PDFObject, PdfFunction | null>();

    constructor(private readonly context: PDFContext) {}

    /** Resolves a colour space operand (a name, possibly a resource name) or object. */
    resolve(o: PDFObject | undefined, resources: PDFDict | null, depth = 0): ColorSpace {
        if (depth > 6 || !o) return GRAY;
        const context = this.context;
        if (o instanceof PDFName) {
            const dev = deviceByName(o.decodeText());
            if (dev) return dev;
            const csDict = resources ? deref(context, resources.get(N("ColorSpace"))) : undefined;
            const entry = csDict instanceof PDFDict ? csDict.get(o) : undefined;
            if (entry) return this.resolve(entry, resources, depth + 1);
            return GRAY;
        }
        const cached = this.cache.get(o);
        if (cached) return cached;
        let cs: ColorSpace = GRAY;
        try {
            cs = this.parse(o, resources, depth);
        } catch {
            cs = GRAY;
        }
        this.cache.set(o, cs);
        return cs;
    }

    private parse(o: PDFObject, resources: PDFDict | null, depth: number): ColorSpace {
        const context = this.context;
        const v = deref(context, o);
        if (v instanceof PDFName) return this.resolve(v, resources, depth + 1);
        if (!(v instanceof PDFArray) || v.size() === 0) return GRAY;
        const family = nameStr(deref(context, v.get(0))) ?? "";
        const dev = family === "Pattern" ? null : deviceByName(family);
        if (dev) return dev;
        switch (family) {
            case "ICCBased": {
                const s = deref(context, v.get(1));
                if (!(s instanceof PDFStream)) return RGB_CS;
                const alt = s.dict.get(N("Alternate"));
                const n = deref(context, s.dict.get(N("N")));
                const count = n instanceof PDFNumber ? n.asNumber() : 3;
                if (alt) {
                    const altCs = this.resolve(alt, resources, depth + 1);
                    if (componentsOf(altCs) === count) return altCs;
                }
                return count === 1 ? GRAY : count === 4 ? CMYK : RGB_CS;
            }
            case "Lab": {
                const d = deref(context, v.get(1));
                const wp = d instanceof PDFDict ? numbersOf(context, d.get(N("WhitePoint"))) : null;
                const range = d instanceof PDFDict ? numbersOf(context, d.get(N("Range"))) : null;
                return {
                    kind: "lab",
                    white: wp && wp.length === 3 ? [wp[0], wp[1], wp[2]] : [0.9505, 1, 1.089],
                    range: range && range.length === 4 ? [range[0], range[1], range[2], range[3]] : [-100, 100, -100, 100],
                };
            }
            case "Indexed":
            case "I": {
                const base = this.resolve(v.get(1), resources, depth + 1);
                const hv = deref(context, v.get(2));
                const hival = hv instanceof PDFNumber ? Math.max(0, Math.min(255, Math.round(hv.asNumber()))) : 0;
                const lookup = bytesOf(context, v.get(3)) ?? new Uint8Array(0);
                return { kind: "indexed", base, hival, lookup };
            }
            case "Separation": {
                const colorant = nameStr(deref(context, v.get(1))) ?? "";
                const alt = this.resolve(v.get(2), resources, depth + 1);
                const fn = this.fn(v.get(3));
                return { kind: "separation", alt, fn, none: colorant === "None", all: colorant === "All" };
            }
            case "DeviceN": {
                const names = deref(context, v.get(1));
                const count = names instanceof PDFArray ? names.size() : 1;
                let none = names instanceof PDFArray && count > 0;
                if (names instanceof PDFArray) for (let i = 0; i < count; i++) if (nameStr(deref(context, names.get(i))) !== "None") none = false;
                const alt = this.resolve(v.get(2), resources, depth + 1);
                const fn = this.fn(v.get(3));
                return { kind: "devicen", n: count, alt, fn, none };
            }
            case "Pattern":
                return { kind: "pattern", base: v.size() > 1 ? this.resolve(v.get(1), resources, depth + 1) : null };
        }
        return GRAY;
    }

    /** A PDF function (dictionary or stream, or an array of 1-output functions). */
    fn(o: PDFObject | undefined): PdfFunction | null {
        if (!o) return null;
        const key = o;
        if (this.fnCache.has(key)) return this.fnCache.get(key) ?? null;
        let f: PdfFunction | null = null;
        try {
            f = parseFunction(this.context, o, 0);
        } catch {
            f = null;
        }
        this.fnCache.set(key, f);
        return f;
    }
}

// ── PDF functions ───────────────────────────────────────────────────────────────────────────────────────────────────

const interp = (x: number, x0: number, x1: number, y0: number, y1: number) => (x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0));
const clampTo = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const parseFunction = (context: PDFContext, o: PDFObject | undefined, depth: number): PdfFunction | null => {
    if (depth > 8) return null;
    const v = deref(context, o);
    if (v instanceof PDFArray) {
        const parts: PdfFunction[] = [];
        for (let i = 0; i < v.size(); i++) {
            const f = parseFunction(context, v.get(i), depth + 1);
            if (!f) return null;
            parts.push(f);
        }
        return (input) => parts.flatMap((f) => f(input));
    }
    const dict = v instanceof PDFStream ? v.dict : v instanceof PDFDict ? v : null;
    if (!dict) return null;
    const typeObj = deref(context, dict.get(N("FunctionType")));
    const type = typeObj instanceof PDFNumber ? typeObj.asNumber() : -1;
    const domain = numbersOf(context, dict.get(N("Domain"))) ?? [0, 1];
    const range = numbersOf(context, dict.get(N("Range")));
    const clipIn = (input: number[]) => input.map((x, i) => (domain.length > 2 * i + 1 ? clampTo(x, domain[2 * i], domain[2 * i + 1]) : x));
    const clipOut = (out: number[]) => (range ? out.map((y, j) => (range.length > 2 * j + 1 ? clampTo(y, range[2 * j], range[2 * j + 1]) : y)) : out);

    if (type === 2) {
        const c0 = numbersOf(context, dict.get(N("C0"))) ?? [0];
        const c1 = numbersOf(context, dict.get(N("C1"))) ?? [1];
        const nObj = deref(context, dict.get(N("N")));
        const n = nObj instanceof PDFNumber ? nObj.asNumber() : 1;
        return (input) => {
            const x = clipIn(input)[0] ?? 0;
            const p = n === 1 ? x : Math.pow(Math.max(x, 0), n);
            return clipOut(c0.map((a, j) => a + p * ((c1[j] ?? a) - a)));
        };
    }
    if (type === 3) {
        const fnsObj = deref(context, dict.get(N("Functions")));
        if (!(fnsObj instanceof PDFArray)) return null;
        const fns: PdfFunction[] = [];
        for (let i = 0; i < fnsObj.size(); i++) {
            const f = parseFunction(context, fnsObj.get(i), depth + 1);
            if (!f) return null;
            fns.push(f);
        }
        const bounds = numbersOf(context, dict.get(N("Bounds"))) ?? [];
        const encode = numbersOf(context, dict.get(N("Encode"))) ?? fns.flatMap(() => [0, 1]);
        return (input) => {
            const x = clipIn(input)[0] ?? 0;
            let i = 0;
            while (i < bounds.length && x >= bounds[i]) i++;
            const lo = i === 0 ? domain[0] : bounds[i - 1];
            const hi = i === bounds.length ? domain[1] : bounds[i];
            const e = interp(x, lo, hi, encode[2 * i] ?? 0, encode[2 * i + 1] ?? 1);
            return clipOut(fns[Math.min(i, fns.length - 1)]([e]));
        };
    }
    if (type === 0 && v instanceof PDFStream) {
        const size = numbersOf(context, dict.get(N("Size"))) ?? [];
        const bpsObj = deref(context, dict.get(N("BitsPerSample")));
        const bps = bpsObj instanceof PDFNumber ? bpsObj.asNumber() : 8;
        if (!range || !size.length) return null;
        const m = size.length;
        const nOut = range.length / 2;
        const encode = numbersOf(context, dict.get(N("Encode"))) ?? size.flatMap((s) => [0, s - 1]);
        const decode = numbersOf(context, dict.get(N("Decode"))) ?? range;
        const data = streamBytes(v);
        if (!data) return null;
        const maxV = Math.pow(2, bps) - 1;
        const sample = (index: number, j: number) => {
            const bitPos = (index * nOut + j) * bps;
            let val = 0;
            if (bps === 8) val = data[bitPos >> 3] ?? 0;
            else if (bps === 16) val = ((data[bitPos >> 3] ?? 0) << 8) | (data[(bitPos >> 3) + 1] ?? 0);
            else {
                for (let b = 0; b < bps; b++) {
                    const p = bitPos + b;
                    val = (val << 1) | (((data[p >> 3] ?? 0) >> (7 - (p & 7))) & 1);
                }
            }
            return val;
        };
        return (input) => {
            const x = clipIn(input);
            const e: number[] = [];
            for (let i = 0; i < m; i++) e.push(clampTo(interp(x[i] ?? 0, domain[2 * i], domain[2 * i + 1], encode[2 * i], encode[2 * i + 1]), 0, size[i] - 1));
            const out = new Array(nOut).fill(0);
            // Multilinear interpolation over the 2^m neighbouring samples (m is 1–4 in practice).
            const corners = 1 << Math.min(m, 8);
            for (let cidx = 0; cidx < corners; cidx++) {
                let w = 1;
                let index = 0;
                let stride = 1;
                for (let i = 0; i < m; i++) {
                    const lo = Math.floor(e[i]);
                    const f = e[i] - lo;
                    const bit = (cidx >> i) & 1;
                    const pos = Math.min(lo + bit, size[i] - 1);
                    w *= bit ? f : 1 - f;
                    index += pos * stride;
                    stride *= size[i];
                }
                if (w === 0) continue;
                for (let j = 0; j < nOut; j++) out[j] += w * sample(index, j);
            }
            return clipOut(out.map((s, j) => interp(s, 0, maxV, decode[2 * j], decode[2 * j + 1])));
        };
    }
    if (type === 4 && v instanceof PDFStream) {
        const code = streamBytes(v);
        if (!code || !range) return null;
        const program = parsePostScript(code);
        if (!program) return null;
        const nOut = range.length / 2;
        return (input) => {
            const stack = clipIn(input).slice();
            runPostScript(program, stack, 0);
            const out = stack.slice(Math.max(0, stack.length - nOut));
            while (out.length < nOut) out.unshift(0);
            return clipOut(out);
        };
    }
    return null;
};

// ── Type 4 (PostScript calculator) ─────────────────────────────────────────────────────────────────────────────────

type PsItem = number | string | PsItem[];

const parsePostScript = (bytes: Uint8Array): PsItem[] | null => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const tokens = s.match(/[{}]|[^\s{}]+/g) ?? [];
    let pos = 0;
    const block = (): PsItem[] => {
        const out: PsItem[] = [];
        while (pos < tokens.length) {
            const t = tokens[pos++];
            if (t === "{") out.push(block());
            else if (t === "}") return out;
            else {
                const n = Number(t);
                out.push(Number.isFinite(n) && /^[+-]?(\d|\.\d)/.test(t) ? n : t);
            }
        }
        return out;
    };
    // The program is one outer { … }.
    while (pos < tokens.length && tokens[pos] !== "{") pos++;
    if (pos >= tokens.length) return null;
    pos++;
    return block();
};

const runPostScript = (prog: PsItem[], st: number[], depth: number) => {
    if (depth > 20) return;
    const pop = () => st.pop() ?? 0;
    for (let i = 0; i < prog.length; i++) {
        const it = prog[i];
        if (typeof it === "number") {
            st.push(it);
            continue;
        }
        if (Array.isArray(it)) {
            // Procedures are only operands of if / ifelse.
            const next = prog[i + 1];
            if (next === "if") {
                if (pop()) runPostScript(it, st, depth + 1);
                i++;
            } else if (Array.isArray(next) && prog[i + 2] === "ifelse") {
                if (pop()) runPostScript(it, st, depth + 1);
                else runPostScript(next, st, depth + 1);
                i += 2;
            }
            continue;
        }
        let a: number;
        let b: number;
        switch (it) {
            case "abs":
                st.push(Math.abs(pop()));
                break;
            case "add":
                b = pop();
                a = pop();
                st.push(a + b);
                break;
            case "sub":
                b = pop();
                a = pop();
                st.push(a - b);
                break;
            case "mul":
                b = pop();
                a = pop();
                st.push(a * b);
                break;
            case "div":
                b = pop();
                a = pop();
                st.push(b === 0 ? 0 : a / b);
                break;
            case "idiv":
                b = pop();
                a = pop();
                st.push(b === 0 ? 0 : Math.trunc(a / b));
                break;
            case "mod":
                b = pop();
                a = pop();
                st.push(b === 0 ? 0 : a % b);
                break;
            case "neg":
                st.push(-pop());
                break;
            case "atan": {
                b = pop();
                a = pop();
                let deg = (Math.atan2(a, b) * 180) / Math.PI;
                if (deg < 0) deg += 360;
                st.push(deg);
                break;
            }
            case "ceiling":
                st.push(Math.ceil(pop()));
                break;
            case "floor":
                st.push(Math.floor(pop()));
                break;
            case "round":
                st.push(Math.round(pop()));
                break;
            case "truncate":
            case "cvi":
                st.push(Math.trunc(pop()));
                break;
            case "cvr":
                break;
            case "cos":
                st.push(Math.cos((pop() * Math.PI) / 180));
                break;
            case "sin":
                st.push(Math.sin((pop() * Math.PI) / 180));
                break;
            case "exp":
                b = pop();
                a = pop();
                st.push(Math.pow(a, b));
                break;
            case "ln":
                st.push(Math.log(pop()));
                break;
            case "log":
                st.push(Math.log10(pop()));
                break;
            case "sqrt":
                st.push(Math.sqrt(Math.max(0, pop())));
                break;
            case "eq":
                b = pop();
                a = pop();
                st.push(a === b ? 1 : 0);
                break;
            case "ne":
                b = pop();
                a = pop();
                st.push(a !== b ? 1 : 0);
                break;
            case "gt":
                b = pop();
                a = pop();
                st.push(a > b ? 1 : 0);
                break;
            case "ge":
                b = pop();
                a = pop();
                st.push(a >= b ? 1 : 0);
                break;
            case "lt":
                b = pop();
                a = pop();
                st.push(a < b ? 1 : 0);
                break;
            case "le":
                b = pop();
                a = pop();
                st.push(a <= b ? 1 : 0);
                break;
            case "and":
                b = pop();
                a = pop();
                st.push(a & b);
                break;
            case "or":
                b = pop();
                a = pop();
                st.push(a | b);
                break;
            case "xor":
                b = pop();
                a = pop();
                st.push(a ^ b);
                break;
            case "not":
                a = pop();
                st.push(a === 0 ? 1 : a === 1 ? 0 : ~a);
                break;
            case "bitshift":
                b = pop();
                a = pop();
                st.push(b >= 0 ? a << b : a >> -b);
                break;
            case "true":
                st.push(1);
                break;
            case "false":
                st.push(0);
                break;
            case "dup":
                st.push(st.length ? st[st.length - 1] : 0);
                break;
            case "pop":
                pop();
                break;
            case "exch":
                b = pop();
                a = pop();
                st.push(b, a);
                break;
            case "copy": {
                const n = Math.max(0, Math.trunc(pop()));
                st.push(...st.slice(st.length - n));
                break;
            }
            case "index": {
                const n = Math.max(0, Math.trunc(pop()));
                st.push(st[st.length - 1 - n] ?? 0);
                break;
            }
            case "roll": {
                const j = Math.trunc(pop());
                const n = Math.max(0, Math.trunc(pop()));
                if (n > 0 && n <= st.length) {
                    const part = st.splice(st.length - n, n);
                    const k = ((j % n) + n) % n;
                    st.push(...part.slice(n - k), ...part.slice(0, n - k));
                }
                break;
            }
        }
    }
};
