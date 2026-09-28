"use client";

import { decodePDFRawStream, PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

export type ExtractedFontBinary = {
    /** PostScript name from FontDescriptor (may include "ABCDEF+" subset prefix). */
    psName: string;
    /** Raw font bytes — TrueType, CFF or Type1, depending on subtype. */
    bytes: Uint8Array;
    /** "FontFile" (Type1), "FontFile2" (TrueType), "FontFile3" (CFF/OpenType). */
    subtype: "FontFile" | "FontFile2" | "FontFile3";
};

const FONT_FILE_KEYS = [
    { key: PDFName.of("FontFile2"), subtype: "FontFile2" as const },
    { key: PDFName.of("FontFile3"), subtype: "FontFile3" as const },
    { key: PDFName.of("FontFile"), subtype: "FontFile" as const },
];

const FONT_NAME_KEY = PDFName.of("FontName");
const TYPE_KEY = PDFName.of("Type");
const FONT_DESCRIPTOR_NAME = PDFName.of("FontDescriptor");

/** Convert a PDFName to its plain string value (without leading slash), tolerant of pdf-lib version differences. */
const pdfNameToString = (n: PDFName): string => {
    const v = (n as unknown as { value?: unknown }).value;
    if (typeof v === "string") return v;
    // Fallback: use toString() which returns "/Name", then strip the leading slash.
    return n.toString().replace(/^\//, "");
};

/** Normalize a font name for fuzzy matching: strip subset prefix ("ABCDEF+"), strip a trailing
 *  pdfjs disambiguation suffix ("-7572"), lowercase, and drop non-alphanumerics. */
const normalizeFontName = (s: string): string =>
    s
        .replace(/^[A-Z]{6}\+/, "")
        .replace(/-\d+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

/** Find the best matching extracted font binary for a PostScript name reported by pdfjs.
 *  pdfjs and pdf-lib can name the same font differently (subset prefixes, numeric suffixes),
 *  so we try exact keys first, then a normalized comparison across all extracted fonts. */
/** True for the 14 standard PDF base fonts (and common aliases). These are NEVER embedded, so a
 *  request for one must NOT be satisfied by an unrelated single embedded font. */
const isStandard14Name = (psName: string): boolean =>
    /^(arial|helvetica|times|timesnewroman|courier|couriernew|symbol|zapfdingbats)\b/i.test(
        psName.replace(/^[A-Z]{6}\+/, "").replace(/[-\s]/g, ""),
    );

export const resolveBestFont = (
    map: Map<string, ExtractedFontBinary>,
    psName: string | null,
): ExtractedFontBinary | null => {
    if (!psName) return null;
    const direct = [psName, psName.replace(/^[A-Z]{6}\+/, ""), psName.replace(/^[A-Z]{6}\+/, "").replace(/-\d+$/, "")];
    for (const k of direct) {
        const hit = map.get(k);
        if (hit) return hit;
    }
    const target = normalizeFontName(psName);
    for (const [key, info] of map) {
        if (normalizeFontName(key) === target) return info;
    }
    // Last resort: a single embedded font — but only if the request isn't a Standard-14 base font
    // (those are unembedded and must fall through to a faithful Helvetica/Times/Courier substitution).
    if (map.size === 1 && !isStandard14Name(psName)) return [...map.values()][0];
    return null;
};

/** Walk every indirect object in the PDF and pull out any embedded font binaries.
 *  Returns a Map keyed by the PostScript name (with any subset prefix stripped),
 *  so we can look the font up via the same name pdfjs reports for the text item. */
export const extractFontsFromPdf = async (file: File): Promise<Map<string, ExtractedFontBinary>> => {
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    const map = new Map<string, ExtractedFontBinary>();

    // Read pdf-lib's object map directly (it's private in the typings): enumerateIndirectObjects() re-sorts by object
    // number, which would change which of two same-named fonts wins below.
    const objects = (doc.context as unknown as { indirectObjects: Map<PDFRef, unknown> }).indirectObjects;
    for (const [, obj] of objects) {
        if (!(obj instanceof PDFDict)) continue;

        // FontDescriptor dict may be reached via /Type entry OR by being referenced as a /FontDescriptor on a Font dict.
        // PDFs in the wild sometimes omit /Type so we accept any dict that has /FontName + /FontFile*.
        const type = obj.lookup(TYPE_KEY);
        const isFontDescriptor = type instanceof PDFName && pdfNameToString(type) === "FontDescriptor";
        const hasFontName = obj.lookup(FONT_NAME_KEY) instanceof PDFName;

        // First, also detect Font dicts and follow their FontDescriptor pointer.
        if (!isFontDescriptor) {
            // Try as Font dict
            if (type instanceof PDFName && pdfNameToString(type) === "Font") {
                const fdRef = obj.get(FONT_DESCRIPTOR_NAME);
                const fdObj = fdRef instanceof PDFRef ? doc.context.lookup(fdRef) : fdRef;
                if (fdObj instanceof PDFDict) {
                    const fontName = fdObj.lookup(FONT_NAME_KEY);
                    if (fontName instanceof PDFName) {
                        for (const { key, subtype } of FONT_FILE_KEYS) {
                            const ffRef = fdObj.get(key);
                            const stream = ffRef instanceof PDFRef ? doc.context.lookup(ffRef) : ffRef;
                            if (stream instanceof PDFRawStream) {
                                try {
                                    const bytes = decodePDFRawStream(stream).decode();
                                    const rawName = pdfNameToString(fontName).replace(/^[A-Z]{6}\+/, "");
                                    map.set(rawName, { psName: rawName, bytes, subtype });
                                    if (rawName !== pdfNameToString(fontName)) map.set(pdfNameToString(fontName), { psName: rawName, bytes, subtype });
                                } catch {
                                    /* unreadable */
                                }
                                break;
                            }
                        }
                    }
                }
            }
            // Also check the loose case (no /Type but has FontName + FontFile)
            if (!hasFontName) continue;
        }

        const fontName = obj.lookup(FONT_NAME_KEY);
        if (!(fontName instanceof PDFName)) continue;

        for (const { key, subtype } of FONT_FILE_KEYS) {
            const ffRef = obj.get(key);
            const stream = ffRef instanceof PDFRef ? doc.context.lookup(ffRef) : ffRef;
            if (stream instanceof PDFRawStream) {
                try {
                    const bytes = decodePDFRawStream(stream).decode();
                    const rawName = pdfNameToString(fontName).replace(/^[A-Z]{6}\+/, "");
                    map.set(rawName, { psName: rawName, bytes, subtype });
                    if (rawName !== pdfNameToString(fontName)) map.set(pdfNameToString(fontName), { psName: rawName, bytes, subtype });
                } catch {
                    /* unreadable */
                }
                break;
            }
        }
    }

    return map;
};
