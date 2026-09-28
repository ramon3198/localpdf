// Image XObjects and inline images → pixels (§8.9): stream filters (Flate / LZW / ASCII85 / ASCIIHex / RunLength with
// PNG and TIFF predictors), every colour space of graphics-color, Decode arrays, 1–16 bit samples, stencil masks and
// the three kinds of transparency (SMask, colour-key /Mask, stencil /Mask). DCT (JPEG) data is kept as the original
// bytes whenever Word can show it as is; CMYK JPEGs, masks and transforms go through the local JPEG decoder.
import {
    PDFArray,
    PDFBool,
    type PDFContext,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    type PDFObject,
    PDFRawStream,
    PDFStream,
    decodePDFRawStream,
} from "pdf-lib";
import { type Operand, parseContentStream } from "../pdf-text-engine/content-lexer";
import { cmykToRgbBytes } from "./graphics-cmyk";
import { type ColorSpace, type ColorSpaces, type RGB, componentsOf, deref, numbersOf, toRgb } from "./graphics-color";
import type { ImageSource } from "./graphics-interpreter";
import { type JpegPixels, decodeJpeg, jpegInfo } from "./graphics-jpeg";

/** RGBA pixels, rows top to bottom. */
export type Raster = { width: number; height: number; rgba: Uint8Array; alpha: boolean };

export type DecodedImage =
    | { kind: "raster"; raster: Raster }
    /** Original JPEG bytes. `passThrough`: Word shows them as the PDF does; `raster()` decodes (with any mask). */
    | { kind: "jpeg"; bytes: Uint8Array; width: number; height: number; passThrough: boolean; raster: () => Raster | null }
    | { kind: "unsupported"; filter: string }
    | { kind: "invalid" };

const N = (s: string) => PDFName.of(s);

/** Pixel budget for one decoded image (RGBA bytes = 4×): larger images are skipped rather than exhausting memory. */
const MAX_PIXELS = 40_000_000;

const STREAM_FILTERS: Record<string, string> = {
    FlateDecode: "FlateDecode",
    Fl: "FlateDecode",
    LZWDecode: "LZWDecode",
    LZW: "LZWDecode",
    ASCII85Decode: "ASCII85Decode",
    A85: "ASCII85Decode",
    ASCIIHexDecode: "ASCIIHexDecode",
    AHx: "ASCIIHexDecode",
    RunLengthDecode: "RunLengthDecode",
    RL: "RunLengthDecode",
};
const IMAGE_FILTERS: Record<string, string> = {
    DCTDecode: "DCTDecode",
    DCT: "DCTDecode",
    JPXDecode: "JPXDecode",
    JBIG2Decode: "JBIG2Decode",
    CCITTFaxDecode: "CCITTFaxDecode",
    CCF: "CCITTFaxDecode",
};
const INLINE_KEYS: Record<string, string> = {
    BPC: "BitsPerComponent",
    CS: "ColorSpace",
    D: "Decode",
    DP: "DecodeParms",
    F: "Filter",
    H: "Height",
    IM: "ImageMask",
    I: "Interpolate",
    W: "Width",
    L: "Length",
};

// ── Stream data ─────────────────────────────────────────────────────────────────────────────────────────────────────

const listOf = (context: PDFContext, o: PDFObject | undefined): (PDFObject | undefined)[] => {
    const v = deref(context, o);
    if (v instanceof PDFArray) {
        const out: (PDFObject | undefined)[] = [];
        for (let i = 0; i < v.size(); i++) out.push(deref(context, v.get(i)));
        return out;
    }
    return v ? [v] : [];
};

const numIn = (context: PDFContext, d: PDFObject | undefined, key: string, dflt: number) => {
    const dict = deref(context, d);
    const v = dict instanceof PDFDict ? deref(context, dict.get(N(key))) : undefined;
    return v instanceof PDFNumber ? v.asNumber() : dflt;
};

/** Undoes PNG (10–15) and TIFF (2) predictors. */
const unpredict = (context: PDFContext, data: Uint8Array, parms: PDFObject | undefined): Uint8Array => {
    const predictor = numIn(context, parms, "Predictor", 1);
    if (predictor < 2) return data;
    const colors = numIn(context, parms, "Colors", 1);
    const bpc = numIn(context, parms, "BitsPerComponent", 8);
    const columns = numIn(context, parms, "Columns", 1);
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowBytes = Math.ceil((colors * bpc * columns) / 8);
    if (predictor === 2) {
        const out = data.slice();
        if (bpc !== 8) return out;
        for (let r = 0; r * rowBytes < out.length; r++) {
            const o = r * rowBytes;
            for (let i = bpp; i < rowBytes && o + i < out.length; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff;
        }
        return out;
    }
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
        const type = data[r * (rowBytes + 1)];
        const src = r * (rowBytes + 1) + 1;
        const dst = r * rowBytes;
        const up = dst - rowBytes;
        for (let i = 0; i < rowBytes; i++) {
            const raw = data[src + i];
            const left = i >= bpp ? out[dst + i - bpp] : 0;
            const above = r > 0 ? out[up + i] : 0;
            const ul = r > 0 && i >= bpp ? out[up + i - bpp] : 0;
            let v: number;
            switch (type) {
                case 1:
                    v = raw + left;
                    break;
                case 2:
                    v = raw + above;
                    break;
                case 3:
                    v = raw + ((left + above) >> 1);
                    break;
                case 4: {
                    const p = left + above - ul;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - above);
                    const pc = Math.abs(p - ul);
                    v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? above : ul);
                    break;
                }
                default:
                    v = raw;
            }
            out[dst + i] = v & 0xff;
        }
    }
    return out;
};

/** Applies the stream filters; stops at the first image filter (DCT, JPX, JBIG2, CCITT), which must come last. */
export const decodeFilters = (
    context: PDFContext,
    dict: PDFDict,
    raw: Uint8Array,
): { data: Uint8Array; imageFilter: string | null; imageParms: PDFObject | undefined } | null => {
    const filters = listOf(context, dict.get(N("Filter")));
    const parms = listOf(context, dict.get(N("DecodeParms")) ?? dict.get(N("DP")));
    let data = raw;
    for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const name = f instanceof PDFName ? f.decodeText() : "";
        const p = parms[i];
        const stream = STREAM_FILTERS[name];
        if (stream) {
            try {
                const d = PDFDict.withContext(context);
                d.set(N("Filter"), N(stream));
                if (p instanceof PDFDict) d.set(N("DecodeParms"), p);
                data = decodePDFRawStream(PDFRawStream.of(d, data)).decode();
            } catch {
                return null;
            }
            data = unpredict(context, data, p);
            continue;
        }
        const image = IMAGE_FILTERS[name];
        if (image) return { data, imageFilter: image, imageParms: p };
        return null;
    }
    return { data, imageFilter: null, imageParms: undefined };
};

// ── Inline images ──────────────────────────────────────────────────────────────────────────────────────────────────

const operandToPdf = (context: PDFContext, o: Operand): PDFObject => {
    switch (o.t) {
        case "num":
            return PDFNumber.of(o.v);
        case "name":
            return N(INLINE_FILTER_NAMES[o.v] ?? o.v);
        case "bool":
            return o.v ? PDFBool.True : PDFBool.False;
        case "str": {
            let hex = "";
            for (let i = 0; i < o.bytes.length; i++) hex += o.bytes[i].toString(16).padStart(2, "0");
            return PDFHexString.of(hex);
        }
        case "arr": {
            const arr = PDFArray.withContext(context);
            for (const it of o.items) arr.push(operandToPdf(context, it));
            return arr;
        }
        case "dict": {
            const d = PDFDict.withContext(context);
            for (const [k, v] of o.entries) d.set(N(INLINE_KEYS[k] ?? k), operandToPdf(context, v));
            return d;
        }
        case "null":
            return PDFNumber.of(0);
    }
};

const INLINE_FILTER_NAMES: Record<string, string> = {
    AHx: "ASCIIHexDecode",
    A85: "ASCII85Decode",
    LZW: "LZWDecode",
    Fl: "FlateDecode",
    RL: "RunLengthDecode",
    CCF: "CCITTFaxDecode",
    DCT: "DCTDecode",
};

/** Splits "BI … ID data EI" into a dictionary with full key names and the data bytes. */
const parseInline = (context: PDFContext, bytes: Uint8Array): { dict: PDFDict; data: Uint8Array } | null => {
    // Find the ID keyword: whitespace-delimited "ID" followed by one whitespace byte.
    const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
    let id = -1;
    for (let i = 2; i + 2 < bytes.length; i++) {
        if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && isWs(bytes[i - 1]) && isWs(bytes[i + 2])) {
            id = i;
            break;
        }
    }
    if (id < 0) return null;
    const head = new Uint8Array(id - 2 + 3);
    head.set(bytes.subarray(2, id));
    head.set([0x20, 0x49, 0x44], id - 2);
    const op = parseContentStream(head).find((o) => o.op === "ID");
    if (!op) return null;
    const dict = PDFDict.withContext(context);
    for (let i = 0; i + 1 < op.args.length; i += 2) {
        const k = op.args[i];
        if (k.t !== "name") continue;
        dict.set(N(INLINE_KEYS[k.v] ?? k.v), operandToPdf(context, op.args[i + 1]));
    }
    let end = bytes.length;
    // Drop "EI" and the whitespace before it.
    if (end >= 2 && bytes[end - 2] === 0x45 && bytes[end - 1] === 0x49) end -= 2;
    let start = id + 3;
    const filtered = dict.get(N("Filter"));
    if (!filtered) {
        // Unfiltered data has a known length: trust it over the EI scan.
        const w = numIn(context, dict, "Width", 0);
        const h = numIn(context, dict, "Height", 0);
        const bpc = numIn(context, dict, "BitsPerComponent", 1);
        const im = deref(context, dict.get(N("ImageMask")));
        const isMask = im instanceof PDFBool && im.asBoolean();
        const n = isMask ? 1 : 3;
        const len = Math.ceil((w * n * bpc) / 8) * h;
        if (len > 0 && start + len <= bytes.length) return { dict, data: bytes.subarray(start, start + len) };
    }
    while (end > start && isWs(bytes[end - 1])) end--;
    if (start > end) start = end;
    return { dict, data: bytes.subarray(start, end) };
};

// ── Samples → pixels ───────────────────────────────────────────────────────────────────────────────────────────────

type ImageParams = { width: number; height: number; bpc: number; cs: ColorSpace | null; decode: number[] | null; isMask: boolean };

const defaultDecode = (cs: ColorSpace, bpc: number): number[] => {
    if (cs.kind === "indexed") return [0, Math.pow(2, bpc) - 1];
    if (cs.kind === "lab") return [0, 100, cs.range[0], cs.range[1], cs.range[2], cs.range[3]];
    return new Array(componentsOf(cs)).fill(0).flatMap(() => [0, 1]);
};

const sampleReader = (data: Uint8Array, bpc: number) => {
    if (bpc === 8) return (bit: number) => data[bit >> 3] ?? 0;
    if (bpc === 16) return (bit: number) => data[bit >> 3] ?? 0; // high byte, rescaled by the caller
    return (bit: number) => {
        let v = 0;
        for (let b = 0; b < bpc; b++) {
            const p = bit + b;
            v = (v << 1) | (((data[p >> 3] ?? 0) >> (7 - (p & 7))) & 1);
        }
        return v;
    };
};

/** Raw sample value (0 .. 2^bpc − 1; 16-bit samples reduced to 8) of component k of pixel (x, y). */
const samplesOf = (data: Uint8Array, p: ImageParams, ncomp: number) => {
    const rowBits = Math.ceil((p.width * ncomp * p.bpc) / 8) * 8;
    const read = sampleReader(data, p.bpc);
    return (x: number, y: number, k: number) => read(y * rowBits + (x * ncomp + k) * p.bpc);
};

export const rasterFromSamples = (data: Uint8Array, p: ImageParams, fill: RGB | null): Raster | null => {
    const { width: W, height: H } = p;
    if (W <= 0 || H <= 0 || W * H > MAX_PIXELS) return null;
    const rgba = new Uint8Array(W * H * 4);
    if (p.isMask || !p.cs) {
        // Stencil mask: 0 paints the current fill colour (Decode [1 0] swaps).
        const read = samplesOf(data, { ...p, bpc: 1 }, 1);
        const invert = !!p.decode && p.decode[0] > p.decode[1];
        const c = fill ?? [0, 0, 0];
        const r = Math.round(c[0] * 255);
        const g = Math.round(c[1] * 255);
        const b = Math.round(c[2] * 255);
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const s = read(x, y, 0);
                const o = (y * W + x) * 4;
                rgba[o] = r;
                rgba[o + 1] = g;
                rgba[o + 2] = b;
                rgba[o + 3] = (s === 0) !== invert ? 255 : 0;
            }
        return { width: W, height: H, rgba, alpha: true };
    }
    const cs = p.cs;
    const n = componentsOf(cs);
    const bpc = p.bpc === 16 ? 8 : p.bpc;
    const maxV = Math.pow(2, bpc) - 1;
    const decode = p.decode && p.decode.length >= 2 * n ? p.decode : defaultDecode(cs, p.bpc);
    const isDefault = decode.every((v, i) => v === defaultDecode(cs, p.bpc)[i]);
    const read = samplesOf(data, p, n);
    // Per-component value tables: sample → component value in the colour space's range.
    const tables: Float64Array[] = [];
    for (let k = 0; k < n; k++) {
        const t = new Float64Array(maxV + 1);
        const d0 = decode[2 * k];
        const d1 = decode[2 * k + 1];
        for (let s = 0; s <= maxV; s++) t[s] = cs.kind === "indexed" && p.bpc !== 16 ? d0 + (s * (d1 - d0)) / (maxV || 1) : d0 + (s * (d1 - d0)) / (maxV || 1);
        tables.push(t);
    }
    if (cs.kind === "indexed" && isDefault) {
        // Palette lookup.
        const palette = new Uint8Array((cs.hival + 1) * 3);
        for (let i = 0; i <= cs.hival; i++) {
            const c = toRgb(cs, [i]) ?? [0, 0, 0];
            palette[i * 3] = Math.round(c[0] * 255);
            palette[i * 3 + 1] = Math.round(c[1] * 255);
            palette[i * 3 + 2] = Math.round(c[2] * 255);
        }
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const i = Math.min(read(x, y, 0), cs.hival);
                const o = (y * W + x) * 4;
                rgba[o] = palette[i * 3];
                rgba[o + 1] = palette[i * 3 + 1];
                rgba[o + 2] = palette[i * 3 + 2];
                rgba[o + 3] = 255;
            }
        return { width: W, height: H, rgba, alpha: false };
    }
    if ((cs.kind === "gray" || cs.kind === "rgb" || cs.kind === "cmyk") && bpc === 8) {
        const tb = tables.map((t) => Uint8Array.from(t, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const o = (y * W + x) * 4;
                if (cs.kind === "gray") {
                    const v = tb[0][read(x, y, 0)];
                    rgba[o] = v;
                    rgba[o + 1] = v;
                    rgba[o + 2] = v;
                } else if (cs.kind === "rgb") {
                    rgba[o] = tb[0][read(x, y, 0)];
                    rgba[o + 1] = tb[1][read(x, y, 1)];
                    rgba[o + 2] = tb[2][read(x, y, 2)];
                } else {
                    cmykToRgbBytes(tb[0][read(x, y, 0)] / 255, tb[1][read(x, y, 1)] / 255, tb[2][read(x, y, 2)] / 255, tb[3][read(x, y, 3)] / 255, rgba, o);
                }
                rgba[o + 3] = 255;
            }
        return { width: W, height: H, rgba, alpha: false };
    }
    // General path: convert each distinct sample combination once.
    const cache = new Map<number, number>();
    const comps = new Array<number>(n).fill(0);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            let key = 0;
            for (let k = 0; k < n; k++) {
                const s = read(x, y, k);
                comps[k] = tables[k][s];
                key = key * (maxV + 1) + s;
            }
            let packed = n <= 4 ? cache.get(key) : undefined;
            if (packed === undefined) {
                const c = toRgb(cs, comps);
                packed = c ? (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255) : -1;
                if (n <= 4 && cache.size < 65536) cache.set(key, packed);
            }
            const o = (y * W + x) * 4;
            if (packed < 0) {
                rgba[o + 3] = 0;
                continue;
            }
            rgba[o] = (packed >> 16) & 0xff;
            rgba[o + 1] = (packed >> 8) & 0xff;
            rgba[o + 2] = packed & 0xff;
            rgba[o + 3] = 255;
        }
    return { width: W, height: H, rgba, alpha: false };
};

/** Nearest-neighbour resize of a single-channel buffer. */
const resizeChannel = (src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array => {
    if (sw === dw && sh === dh) return src;
    const out = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
        for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))];
    }
    return out;
};

/**
 * Decoded JPEG samples → RGBA. Inside a PDF the samples mean what the colour space and the Decode array say: Adobe
 * CMYK JPEGs store inverted inks and come with Decode [1 0 1 0 1 0 1 0] — no "Adobe marker" guessing (as pdf.js).
 */
const jpegToRaster = (jp: JpegPixels, decode: number[] | null): Raster => {
    const W = jp.width;
    const H = jp.height;
    const rgba = new Uint8Array(W * H * 4);
    const src = jp.data;
    const n = jp.components;
    const inv = (k: number) => !!decode && decode.length > 2 * k + 1 && decode[2 * k] > decode[2 * k + 1];
    const invert = [0, 1, 2, 3].map(inv);
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
        const s = i * n;
        if (n === 1) {
            const v = invert[0] ? 255 - src[s] : src[s];
            rgba[o] = v;
            rgba[o + 1] = v;
            rgba[o + 2] = v;
        } else if (n === 3) {
            rgba[o] = invert[0] ? 255 - src[s] : src[s];
            rgba[o + 1] = invert[1] ? 255 - src[s + 1] : src[s + 1];
            rgba[o + 2] = invert[2] ? 255 - src[s + 2] : src[s + 2];
        } else {
            const f = (k: number) => (invert[k] ? 1 - src[s + k] / 255 : src[s + k] / 255);
            cmykToRgbBytes(f(0), f(1), f(2), f(3), rgba, o);
        }
        rgba[o + 3] = 255;
    }
    return { width: W, height: H, rgba, alpha: false };
};

// ── Entry point ────────────────────────────────────────────────────────────────────────────────────────────────────

type MaskInfo = { kind: "smask"; stream: PDFStream } | { kind: "stencil"; stream: PDFStream } | { kind: "key"; ranges: number[] } | null;

/** Alpha channel (0..255, W×H) from a soft mask or stencil mask image, resized to the base image. */
const maskAlpha = (context: PDFContext, spaces: ColorSpaces, mask: MaskInfo, W: number, H: number): Uint8Array | null => {
    if (!mask || mask.kind === "key") return null;
    const decoded = decodeImage(context, spaces, { kind: "xobject", stream: mask.stream, resources: null }, [0, 0, 0], mask.kind === "smask");
    let raster: Raster | null = null;
    if (decoded.kind === "raster") raster = decoded.raster;
    else if (decoded.kind === "jpeg") raster = decoded.raster();
    if (!raster) return null;
    const ch = new Uint8Array(raster.width * raster.height);
    for (let i = 0; i < ch.length; i++) ch[i] = mask.kind === "smask" ? raster.rgba[i * 4] : raster.rgba[i * 4 + 3];
    return resizeChannel(ch, raster.width, raster.height, W, H);
};

const applyAlpha = (r: Raster, alpha: Uint8Array | null): Raster => {
    if (!alpha) return r;
    let any = false;
    for (let i = 0; i < alpha.length; i++) {
        const a = Math.min(r.rgba[i * 4 + 3], alpha[i]);
        if (a !== 255) any = true;
        r.rgba[i * 4 + 3] = a;
    }
    return { ...r, alpha: r.alpha || any };
};

/**
 * Decodes an image. `fill` is the current fill colour (for stencil masks); `asMask` reads the image as a soft mask
 * (its gray levels are the alpha values, colour space forced to gray).
 */
export const decodeImage = (context: PDFContext, spaces: ColorSpaces, src: ImageSource, fill: RGB | null, asMask = false): DecodedImage => {
    let dict: PDFDict;
    let raw: Uint8Array;
    if (src.kind === "xobject") {
        dict = src.stream.dict;
        raw = src.stream instanceof PDFRawStream ? src.stream.contents : src.stream.getContents();
    } else {
        const parsed = parseInline(context, src.bytes);
        if (!parsed) return { kind: "invalid" };
        dict = parsed.dict;
        raw = parsed.data;
    }
    const width = Math.round(numIn(context, dict, "Width", 0));
    const height = Math.round(numIn(context, dict, "Height", 0));
    if (width <= 0 || height <= 0) return { kind: "invalid" };
    const imObj = deref(context, dict.get(N("ImageMask")));
    const isMask = !asMask && imObj instanceof PDFBool && imObj.asBoolean();
    const bpc = isMask ? 1 : Math.round(numIn(context, dict, "BitsPerComponent", 8));
    const csObj = dict.get(N("ColorSpace"));
    let cs: ColorSpace | null = isMask ? null : asMask ? { kind: "gray" } : csObj ? spaces.resolve(csObj, src.resources) : null;
    const decode = numbersOf(context, dict.get(N("Decode")));

    let mask: MaskInfo = null;
    if (!isMask && !asMask) {
        const sm = deref(context, dict.get(N("SMask")));
        const mk = deref(context, dict.get(N("Mask")));
        if (sm instanceof PDFStream) mask = { kind: "smask", stream: sm };
        else if (mk instanceof PDFStream) mask = { kind: "stencil", stream: mk };
        else if (mk instanceof PDFArray) mask = { kind: "key", ranges: numbersOf(context, mk) ?? [] };
    }

    const filtered = decodeFilters(context, dict, raw);
    if (!filtered) return { kind: "invalid" };
    if (filtered.imageFilter === "DCTDecode") {
        const bytes = filtered.data;
        const info = jpegInfo(bytes);
        if (!info) return { kind: "invalid" };
        const comps = info.components;
        if (!cs) cs = comps === 1 ? { kind: "gray" } : comps === 4 ? { kind: "cmyk" } : { kind: "rgb" };
        const csOk = (cs.kind === "gray" && comps === 1) || (cs.kind === "rgb" && comps === 3);
        const decodeOk = !decode || decode.every((v, i) => v === (i % 2 === 0 ? 0 : 1));
        // A DCTDecode /ColorTransform parameter overrides the JPEG's own markers.
        const ct = numIn(context, filtered.imageParms, "ColorTransform", -1);
        const passThrough = csOk && decodeOk && !mask && !asMask && ct === -1;
        const finalCs = cs;
        return {
            kind: "jpeg",
            bytes,
            width: info.width,
            height: info.height,
            passThrough,
            raster: () => {
                const jp = decodeJpeg(bytes, ct === 0 || ct === 1 ? ct : undefined);
                if (!jp) return null;
                let r: Raster;
                if (finalCs.kind === "gray" || finalCs.kind === "rgb" || finalCs.kind === "cmyk" || jp.components !== componentsOf(finalCs)) {
                    r = jpegToRaster(jp, decode);
                } else {
                    // Other colour spaces (Lab, ICC with odd alternates, Separation…): go through the sample path.
                    r =
                        rasterFromSamples(jp.data, { width: jp.width, height: jp.height, bpc: 8, cs: finalCs, decode, isMask: false }, fill) ??
                        jpegToRaster(jp, decode);
                }
                return applyAlpha(r, maskAlpha(context, spaces, mask, r.width, r.height));
            },
        };
    }
    if (filtered.imageFilter) return { kind: "unsupported", filter: filtered.imageFilter };
    const p: ImageParams = { width, height, bpc: [1, 2, 4, 8, 16].includes(bpc) ? bpc : 8, cs, decode, isMask: isMask || !cs };
    const raster = rasterFromSamples(filtered.data, p, fill);
    if (!raster) return { kind: "invalid" };
    if (mask?.kind === "key" && cs && mask.ranges.length >= 2 * componentsOf(cs)) {
        // Colour-key masking compares raw samples.
        const n = componentsOf(cs);
        const read = samplesOf(filtered.data, p, n);
        const scale = p.bpc === 16 ? 256 : 1;
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                let inside = true;
                for (let k = 0; k < n && inside; k++) {
                    const s = read(x, y, k) * scale;
                    if (s < mask.ranges[2 * k] || s > mask.ranges[2 * k + 1] + (scale - 1)) inside = false;
                }
                if (inside) {
                    raster.rgba[(y * width + x) * 4 + 3] = 0;
                    raster.alpha = true;
                }
            }
        return { kind: "raster", raster };
    }
    return { kind: "raster", raster: applyAlpha(raster, maskAlpha(context, spaces, mask, width, height)) };
};
