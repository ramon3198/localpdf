"use client";

// "Equilibrado" compression: the images inside the PDF are re-encoded as lighter JPEGs, with no more resolution than
// the size they are shown at needs, and everything else (text, fonts, vector art, links, forms) stays untouched.
// Only images that are safe to rewrite are touched: 8-bit gray or RGB samples without colour-key masks or Decode
// arrays. CMYK, indexed, 1-bit (fax / JBIG2) and JPEG 2000 images are left as they are.
import { PDFArray, PDFBool, type PDFContext, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { parseContentStream } from "./pdf-text-engine/content-lexer";
import { streamBytes } from "./pdf-text-engine/font-model";
import { IDENTITY, type Matrix, mul, pageContentBytes } from "./pdf-text-engine/text-interpreter";
import { decodeFilters } from "./pdf-to-docx/graphics-image";
import { jpegInfo } from "./pdf-to-docx/graphics-jpeg";

export type RecompressOptions = {
    /** JPEG quality, 1–100. */
    quality: number;
    /** Images shown with more pixels per inch than this are scaled down to it. */
    maxDpi: number;
    onProgress?: (done: number, total: number) => void;
    /** Checked between images: true stops the work (the document is then half done and must be discarded). */
    isCancelled?: () => boolean;
};

export type RecompressStats = { candidates: number; recompressed: number };

const N = (s: string) => PDFName.of(s);

/** Smaller images are icons and rules: nothing to gain, and they show JPEG artefacts first. */
const MIN_PIXELS = 64 * 64;
const MIN_BYTES = 8 * 1024;
/** Pixel budget for one decoded image (RGBA bytes = 4×): larger ones are skipped rather than exhausting memory. */
const MAX_PIXELS = 40_000_000;
/** The new image replaces the old one only when it is at least this much lighter. */
const WORTH_IT = 0.9;
/** Above this, scaling down saves too little to be worth the blur. */
const KEEP_SIZE_ABOVE = 0.85;
const MAX_FORM_DEPTH = 8;

const deref = (context: PDFContext, o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? context.lookup(o) : o);
const numberOf = (context: PDFContext, o: PDFObject | undefined): number | null => {
    const v = deref(context, o);
    return v instanceof PDFNumber ? v.asNumber() : null;
};
const nameOf = (context: PDFContext, o: PDFObject | undefined): string | null => {
    const v = deref(context, o);
    return v instanceof PDFName ? v.decodeText() : null;
};

/** Largest size (in points) each image is painted at, over every page and the forms the pages paint. */
const collectPlacements = (doc: PDFDocument): Map<PDFRef, { w: number; h: number }> => {
    const context = doc.context;
    const placed = new Map<PDFRef, { w: number; h: number }>();

    const walk = (bytes: Uint8Array, resources: PDFDict | null, start: Matrix, depth: number) => {
        let ctm = start;
        const stack: Matrix[] = [];
        const xobjects = resources ? deref(context, resources.get(N("XObject"))) : undefined;
        for (const { op, args } of parseContentStream(bytes)) {
            if (op === "q") stack.push(ctm);
            else if (op === "Q") ctm = stack.pop() ?? ctm;
            else if (op === "cm") {
                const m = args.map((a) => (a.t === "num" ? a.v : NaN));
                if (m.length === 6 && m.every(Number.isFinite)) ctm = mul(m as Matrix, ctm);
            } else if (op === "Do") {
                const name = args[0]?.t === "name" ? args[0].v : null;
                const entry = name && xobjects instanceof PDFDict ? xobjects.get(N(name)) : undefined;
                const stream = deref(context, entry);
                if (!(stream instanceof PDFStream)) continue;
                const subtype = nameOf(context, stream.dict.get(N("Subtype")));
                if (subtype === "Image" && entry instanceof PDFRef) {
                    const w = Math.hypot(ctm[0], ctm[1]);
                    const h = Math.hypot(ctm[2], ctm[3]);
                    const seen = placed.get(entry);
                    placed.set(entry, { w: Math.max(w, seen?.w ?? 0), h: Math.max(h, seen?.h ?? 0) });
                } else if (subtype === "Form" && depth < MAX_FORM_DEPTH) {
                    const formBytes = streamBytes(stream);
                    if (!formBytes) continue;
                    const matrixObj = deref(context, stream.dict.get(N("Matrix")));
                    const m = matrixObj instanceof PDFArray ? matrixObj.asArray().map((v) => numberOf(context, v) ?? NaN) : [];
                    const matrix = m.length === 6 && m.every(Number.isFinite) ? (m as Matrix) : IDENTITY;
                    const own = deref(context, stream.dict.get(N("Resources")));
                    walk(formBytes, own instanceof PDFDict ? own : resources, mul(matrix, ctm), depth + 1);
                }
            }
        }
    };

    for (const page of doc.getPages()) {
        try {
            walk(pageContentBytes(context, page.node), page.node.Resources() ?? null, IDENTITY, 0);
        } catch {
            // A page whose content can't be read keeps its images as they are.
        }
    }
    return placed;
};

/** Samples per pixel when the image's colour space is plain gray or RGB (device, calibrated or ICC); null otherwise. */
const grayOrRgb = (context: PDFContext, o: PDFObject | undefined): 1 | 3 | null => {
    const v = deref(context, o);
    const family = v instanceof PDFName ? v.decodeText() : v instanceof PDFArray && v.size() ? nameOf(context, v.get(0)) : null;
    if (family === "DeviceGray" || family === "CalGray") return 1;
    if (family === "DeviceRGB" || family === "CalRGB") return 3;
    if (family === "ICCBased" && v instanceof PDFArray) {
        const profile = deref(context, v.get(1));
        const n = profile instanceof PDFStream ? numberOf(context, profile.dict.get(N("N"))) : null;
        return n === 1 || n === 3 ? n : null;
    }
    return null;
};

/**
 * A copy of the JPEG without EXIF or ICC data: the browser would rotate the pixels by the EXIF orientation and convert
 * them with the embedded profile, and a PDF does neither. JFIF (APP0) and Adobe (APP14) stay: they say how to decode.
 */
const stripJpegMetadata = (b: Uint8Array): Uint8Array => {
    if (b[0] !== 0xff || b[1] !== 0xd8) return b;
    const parts: Uint8Array[] = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length) {
        if (b[i] !== 0xff) return b;
        const marker = b[i + 1];
        if (marker === 0xff) {
            i++;
            continue;
        }
        if (marker === 0xda) break; // Start of scan: the rest is image data.
        const length = (b[i + 2] << 8) | b[i + 3];
        if (length < 2 || i + 2 + length > b.length) return b;
        const isApp = marker >= 0xe0 && marker <= 0xef;
        if (!isApp || marker === 0xe0 || marker === 0xee) parts.push(b.subarray(i, i + 2 + length));
        i += 2 + length;
    }
    parts.push(b.subarray(i));
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

type Pixels = { source: ImageBitmap | ImageData; width: number; height: number; close: () => void };

/** The image's samples as the browser can draw them, or null when this image must be left alone. */
const readPixels = async (context: PDFContext, stream: PDFRawStream, comps: 1 | 3, width: number, height: number): Promise<Pixels | null> => {
    const filtered = decodeFilters(context, stream.dict, stream.contents);
    if (!filtered) return null;
    if (filtered.imageFilter === "DCTDecode") {
        const info = jpegInfo(filtered.data);
        // A ColorTransform parameter overrides the JPEG's own markers, which the browser would follow.
        const parms = deref(context, filtered.imageParms);
        if (!info || info.components !== comps || (parms instanceof PDFDict && parms.has(N("ColorTransform")))) return null;
        const blob = new Blob([stripJpegMetadata(filtered.data) as BlobPart], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        if (bitmap.width !== info.width || bitmap.height !== info.height) {
            bitmap.close();
            return null;
        }
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    if (filtered.imageFilter) return null; // JPEG 2000, JBIG2, fax.
    const data = filtered.data;
    const count = width * height;
    if (data.length < count * comps) return null;
    const rgba = new Uint8ClampedArray(count * 4);
    for (let i = 0, o = 0; i < count; i++, o += 4) {
        if (comps === 1) {
            rgba[o] = rgba[o + 1] = rgba[o + 2] = data[i];
        } else {
            rgba[o] = data[i * 3];
            rgba[o + 1] = data[i * 3 + 1];
            rgba[o + 2] = data[i * 3 + 2];
        }
        rgba[o + 3] = 255;
    }
    return { source: new ImageData(rgba, width, height), width, height, close: () => undefined };
};

const encodeJpeg = async (pixels: Pixels, width: number, height: number, quality: number): Promise<Uint8Array | null> => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    try {
        if (pixels.source instanceof ImageData && width === pixels.width && height === pixels.height) {
            ctx.putImageData(pixels.source, 0, 0);
        } else {
            const drawable = pixels.source instanceof ImageData ? await createImageBitmap(pixels.source) : pixels.source;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(drawable, 0, 0, width, height);
            if (drawable !== pixels.source) drawable.close();
        }
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality / 100));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
};

/** Re-encodes the document's images in place. The caller saves the document afterwards. */
export const recompressImages = async (doc: PDFDocument, { quality, maxDpi, onProgress, isCancelled }: RecompressOptions): Promise<RecompressStats> => {
    const context = doc.context;
    const placed = collectPlacements(doc);

    // Images that mask other images must keep their exact samples and colour space.
    const masks = new Set<PDFRef>();
    for (const [, object] of context.enumerateIndirectObjects()) {
        if (!(object instanceof PDFStream)) continue;
        for (const key of ["SMask", "Mask"]) {
            const mask = object.dict.get(N(key));
            if (mask instanceof PDFRef) masks.add(mask);
        }
    }

    const candidates: [PDFRef, PDFRawStream][] = [];
    for (const [ref, object] of context.enumerateIndirectObjects()) {
        if (object instanceof PDFRawStream && placed.has(ref) && !masks.has(ref) && nameOf(context, object.dict.get(N("Subtype"))) === "Image") {
            candidates.push([ref, object]);
        }
    }

    let recompressed = 0;
    for (let index = 0; index < candidates.length; index++) {
        if (isCancelled?.()) break;
        onProgress?.(index, candidates.length);
        const [ref, stream] = candidates[index];
        const dict = stream.dict;
        const width = numberOf(context, dict.get(N("Width"))) ?? 0;
        const height = numberOf(context, dict.get(N("Height"))) ?? 0;
        const stencil = deref(context, dict.get(N("ImageMask")));
        const softMask = deref(context, dict.get(N("SMask")));
        const comps = grayOrRgb(context, dict.get(N("ColorSpace")));
        if (
            !comps ||
            width * height < MIN_PIXELS ||
            width * height > MAX_PIXELS ||
            stream.contents.length < MIN_BYTES ||
            numberOf(context, dict.get(N("BitsPerComponent"))) !== 8 ||
            (stencil instanceof PDFBool && stencil.asBoolean()) ||
            dict.has(N("Mask")) ||
            dict.has(N("Decode")) ||
            // A soft mask with /Matte holds colours already blended with it: they can't be resampled apart.
            (softMask instanceof PDFStream && softMask.dict.has(N("Matte")))
        ) {
            continue;
        }

        try {
            const pixels = await readPixels(context, stream, comps, width, height);
            if (!pixels) continue;
            try {
                const size = placed.get(ref)!;
                const needed = Math.max(((size.w / 72) * maxDpi) / pixels.width, ((size.h / 72) * maxDpi) / pixels.height);
                const scale = needed > 0 && needed < KEEP_SIZE_ABOVE ? needed : 1;
                const outWidth = Math.max(1, Math.round(pixels.width * scale));
                const outHeight = Math.max(1, Math.round(pixels.height * scale));
                const jpeg = await encodeJpeg(pixels, outWidth, outHeight, quality);
                if (!jpeg || jpeg.length >= stream.contents.length * WORTH_IT) continue;

                const next = dict.clone(context);
                for (const key of ["Filter", "DecodeParms", "DP", "Length"]) next.delete(N(key));
                next.set(N("Filter"), N("DCTDecode"));
                next.set(N("Width"), PDFNumber.of(outWidth));
                next.set(N("Height"), PDFNumber.of(outHeight));
                next.set(N("BitsPerComponent"), PDFNumber.of(8));
                // The browser's JPEGs always have three components, also for gray images.
                if (comps === 1) next.set(N("ColorSpace"), N("DeviceRGB"));
                context.assign(ref, PDFRawStream.of(next, jpeg));
                recompressed++;
            } finally {
                pixels.close();
            }
        } catch {
            // An image the browser can't decode keeps its original data.
        }
    }
    onProgress?.(candidates.length, candidates.length);
    return { candidates: candidates.length, recompressed };
};
