/**
 * FontModel — everything the engine needs to know about one PDF font resource:
 *   decode:  string bytes → glyphs (code, raw bytes, horizontal advance w0, Unicode)
 *   encode:  Unicode text → codes/bytes in THIS font, only for glyphs the embedded program really has
 *
 * Supports simple fonts (Type1/TrueType/MMType1, incl. the non-embedded Standard 14), Type3 and
 * Type0 composite fonts with Identity-H or embedded encoding CMaps. Vertical writing is flagged as
 * unsupported so callers fall back to a safe path.
 */
import { FontNames, Font as StdFont } from "@pdf-lib/standard-fonts";
import {
    PDFArray,
    type PDFContext,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    type PDFObject,
    PDFRawStream,
    PDFRef,
    PDFStream,
    PDFString,
    decodePDFRawStream,
} from "pdf-lib";
import { type ParsedCMap, lookupCid, parseCMap, splitCodes } from "./cmap";
import { parseContentStream } from "./content-lexer";
import { describeFont, slugFamily } from "./font-style";
import { type EncodingTable, STANDARD_ENCODING, SYMBOL_ENCODING, ZAPF_DINGBATS_ENCODING, encodingByName, glyphNameToUnicode } from "./glyph-names";

export type Glyph = {
    code: number;
    bytes: Uint8Array;
    /** Horizontal displacement in text space for a font size of 1 (i.e. width/1000 for most fonts). */
    w0: number;
    unicode: string | null;
    /** Single-byte code 32 — the only code word spacing (Tw) applies to. */
    isSpace: boolean;
};

export type EncodedChar = { ch: string; code: number; bytes: Uint8Array; w0: number; isSpace: boolean };

/** Minimal fontkit surface we use (the real object has much more). */
export type FontkitLike = {
    numGlyphs: number;
    glyphForCodePoint?: (cp: number) => { id: number } | null;
    getGlyph?: (id: number) => { path?: { commands?: unknown[] }; advanceWidth?: number } | null;
    unitsPerEm?: number;
    italicAngle?: number;
    familyName?: string;
    "OS/2"?: { usWeightClass?: number; panose?: number[]; fsSelection?: number | { italic?: boolean } };
};

export type FontStyleInfo = { name: string; family: string; weight: number; italic: boolean; serif: boolean; mono: boolean };
export type FontkitFactory = (bytes: Uint8Array) => FontkitLike | null;

const N = (s: string) => PDFName.of(s);
const NL = String.fromCharCode(10);

export const nameOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? o.decodeText() : undefined);
export const numOf = (o: PDFObject | undefined): number | undefined => (o instanceof PDFNumber ? o.asNumber() : undefined);

export const streamBytes = (s: PDFObject | undefined): Uint8Array | null => {
    if (!s) return null;
    try {
        if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
        const anyS = s as unknown as { getUnencodedContents?: () => Uint8Array; getContents?: () => Uint8Array };
        if (typeof anyS.getUnencodedContents === "function") return anyS.getUnencodedContents();
        if (s instanceof PDFStream && typeof anyS.getContents === "function") return anyS.getContents();
    } catch {
        /* undecodable filter */
    }
    return null;
};

const STD14: Record<string, FontNames> = {
    Courier: FontNames.Courier,
    "Courier-Bold": FontNames.CourierBold,
    "Courier-Oblique": FontNames.CourierOblique,
    "Courier-BoldOblique": FontNames.CourierBoldOblique,
    Helvetica: FontNames.Helvetica,
    "Helvetica-Bold": FontNames.HelveticaBold,
    "Helvetica-Oblique": FontNames.HelveticaOblique,
    "Helvetica-BoldOblique": FontNames.HelveticaBoldOblique,
    "Times-Roman": FontNames.TimesRoman,
    "Times-Bold": FontNames.TimesRomanBold,
    "Times-Italic": FontNames.TimesRomanItalic,
    "Times-BoldItalic": FontNames.TimesRomanBoldItalic,
    Symbol: FontNames.Symbol,
    ZapfDingbats: FontNames.ZapfDingbats,
};

/** Map a (possibly aliased) base font name to Standard 14 metrics, for width fallback. */
export const std14For = (baseFont: string): FontNames | null => {
    const n = baseFont.replace(/^[A-Z]{6}\+/, "");
    if (STD14[n]) return STD14[n];
    const s = n.toLowerCase().replace(/[\s_-]/g, "");
    const bold = /bold|black|heavy|semibold|demi/.test(s);
    const italic = /italic|oblique/.test(s);
    const pick = (fam: "Helvetica" | "Times" | "Courier") => {
        if (fam === "Times")
            return bold && italic
                ? FontNames.TimesRomanBoldItalic
                : bold
                  ? FontNames.TimesRomanBold
                  : italic
                    ? FontNames.TimesRomanItalic
                    : FontNames.TimesRoman;
        if (fam === "Courier")
            return bold && italic ? FontNames.CourierBoldOblique : bold ? FontNames.CourierBold : italic ? FontNames.CourierOblique : FontNames.Courier;
        return bold && italic ? FontNames.HelveticaBoldOblique : bold ? FontNames.HelveticaBold : italic ? FontNames.HelveticaOblique : FontNames.Helvetica;
    };
    if (/^(arial|helvetica)/.test(s)) return pick("Helvetica");
    if (/^(timesnewroman|times)/.test(s)) return pick("Times");
    if (/^(couriernew|courier)/.test(s)) return pick("Courier");
    if (s === "symbol") return FontNames.Symbol;
    return null;
};

const stdFontCache = new Map<FontNames, StdFont>();
const loadStd = (n: FontNames) => {
    let f = stdFontCache.get(n);
    if (!f) {
        f = StdFont.load(n);
        stdFontCache.set(n, f);
    }
    return f;
};

export class FontModel implements DecodingFont {
    readonly kind: "simple" | "type0" | "type3";
    readonly subtype: string;
    readonly baseFont: string;
    readonly isSubset: boolean;
    readonly isEmbedded: boolean;
    readonly std14: FontNames | null;
    readonly vertical: boolean;
    /** False when we can't reliably segment codes or compute widths — callers must not edit. */
    readonly supported: boolean;
    /** Codes observed anywhere in the document's content streams for this font. */
    readonly usedCodes = new Set<number>();
    /** Byte length observed per code (composite fonts with variable-width codespaces). */
    private readonly codeLen = new Map<number, number>();

    private widthsSimple: Map<number, number> | null = null;
    private missingWidth = 0;
    private widthScale = 0.001;
    private encoding: EncodingTable | null = null;
    private differencesUsed = false;
    private toUnicode: Map<number, string> | null = null;
    private charProcs: Set<string> | null = null;
    // Type0
    private cidWidths: Map<number, number> | null = null;
    private dw = 1000;
    private cmap: ParsedCMap | null = null;
    private identity = false;
    private cidToGid: Uint8Array | "Identity" | null = null;
    private fontProgram: Uint8Array | null = null;
    private fontProgramKind: "FontFile" | "FontFile2" | "FontFile3" | null = null;
    private fk: FontkitLike | null | undefined = undefined;
    private desc: { fontName?: string; family?: string; weight?: number; italicAngle?: number; flags?: number } = {};
    private reverse: Map<string, number> | null = null;
    private cidFont: PDFDict | null = null;
    /** Glyphs taken from the embedded program that /W or ToUnicode don't describe yet (Word subsets carry the
     *  glyphs of the family's other faces): their real advance and Unicode, written back by `writeAdditions`. */
    private readonly added = new Map<number, { w: number; unicode: string }>();
    private outline: number | null | undefined = undefined;

    constructor(
        readonly context: PDFContext,
        readonly dict: PDFDict,
        readonly ref: PDFRef | null,
        private readonly fontkitFactory: FontkitFactory | null = null,
        /** True once every page's codes are in `usedCodes` — required before we claim an unused code. */
        private readonly documentScanned: () => boolean = () => false,
    ) {
        this.subtype = nameOf(dict.lookup(N("Subtype"))) ?? "Type1";
        this.baseFont = nameOf(dict.lookup(N("BaseFont"))) ?? "";
        this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
        let supported = true;
        let vertical = false;

        if (this.subtype === "Type0") {
            this.kind = "type0";
            const desc = dict.lookup(N("DescendantFonts"));
            const cidFont = desc instanceof PDFArray ? (desc.lookup(0) as PDFObject) : undefined;
            const cf = cidFont instanceof PDFDict ? cidFont : null;
            const enc = dict.lookup(N("Encoding"));
            const encName = nameOf(enc);
            if (encName === "Identity-H" || encName === "Identity-V") {
                this.identity = true;
                vertical = encName === "Identity-V";
            } else if (enc instanceof PDFStream) {
                const b = streamBytes(enc);
                if (b) {
                    this.cmap = parseCMap(b);
                    vertical = this.cmap.wmode === 1;
                    if (this.cmap.usecmap === "Identity-H" || this.cmap.usecmap === "Identity-V") this.identity = true;
                    else if (this.cmap.usecmap) supported = false;
                } else supported = false;
            } else supported = false; // predefined non-identity CMaps (CJK) — not handled
            if (cf) {
                this.cidFont = cf;
                this.dw = numOf(cf.lookup(N("DW"))) ?? 1000;
                this.cidWidths = parseW(cf.lookup(N("W")));
                const c2g = cf.lookup(N("CIDToGIDMap"));
                if (nameOf(c2g) === "Identity" || c2g === undefined) this.cidToGid = "Identity";
                else if (c2g instanceof PDFStream) this.cidToGid = streamBytes(c2g);
                this.readDescriptor(cf.lookup(N("FontDescriptor")));
            } else supported = false;
        } else if (this.subtype === "Type3") {
            this.kind = "type3";
            const fm = dict.lookup(N("FontMatrix"));
            const a = fm instanceof PDFArray ? numOf(fm.lookup(0)) : undefined;
            this.widthScale = a ?? 0.001;
            const cp = dict.lookup(N("CharProcs"));
            if (cp instanceof PDFDict) this.charProcs = new Set(cp.keys().map((k) => k.decodeText()));
            this.readDescriptor(dict.lookup(N("FontDescriptor"))); // optional, but Chrome writes FontName/FontFamily
            this.readSimpleWidthsAndEncoding();
        } else {
            this.kind = "simple";
            this.readDescriptor(dict.lookup(N("FontDescriptor")));
            this.readSimpleWidthsAndEncoding();
        }

        const tu = dict.lookup(N("ToUnicode"));
        if (tu instanceof PDFStream) {
            const b = streamBytes(tu);
            if (b) {
                const cm = parseCMap(b);
                if (cm.toUnicode.size) this.toUnicode = cm.toUnicode;
            }
        }

        this.isEmbedded = this.fontProgram !== null || this.kind === "type3";
        this.std14 = !this.isEmbedded ? std14For(this.baseFont) : null;
        if (this.kind === "simple" && !this.widthsSimple && !this.std14) {
            // No widths and no metrics source: approximate with Helvetica so decoding still works, but
            // mark unsupported so we never rewrite positions based on guessed advances.
            supported = false;
        }
        this.vertical = vertical;
        this.supported = supported && !vertical;
    }

    private readDescriptor(fd: PDFObject | undefined) {
        if (!(fd instanceof PDFDict)) return;
        this.missingWidth = numOf(fd.lookup(N("MissingWidth"))) ?? 0;
        const fam = fd.lookup(N("FontFamily"));
        this.desc = {
            fontName: nameOf(fd.lookup(N("FontName"))),
            family: fam instanceof PDFString || fam instanceof PDFHexString ? fam.decodeText() : undefined,
            weight: numOf(fd.lookup(N("FontWeight"))),
            italicAngle: numOf(fd.lookup(N("ItalicAngle"))),
            flags: numOf(fd.lookup(N("Flags"))),
        };
        for (const k of ["FontFile2", "FontFile3", "FontFile"] as const) {
            const s = fd.lookup(N(k));
            if (s instanceof PDFStream) {
                this.fontProgram = streamBytes(s);
                this.fontProgramKind = k;
                break;
            }
        }
    }

    private readSimpleWidthsAndEncoding() {
        const d = this.dict;
        const first = numOf(d.lookup(N("FirstChar")));
        const widths = d.lookup(N("Widths"));
        if (first !== undefined && widths instanceof PDFArray) {
            const m = new Map<number, number>();
            widths.asArray().forEach((_, i) => {
                const w = numOf(widths.lookup(i) as PDFObject);
                if (w !== undefined) m.set(first + i, w);
            });
            this.widthsSimple = m;
        }
        // Encoding
        const enc = d.lookup(N("Encoding"));
        const base = this.subtype === "Type3" ? null : this.defaultEncoding();
        let table: EncodingTable | null = null;
        if (enc instanceof PDFName) table = encodingByName(enc.decodeText()) ?? base;
        else if (enc instanceof PDFDict) {
            table = (encodingByName(nameOf(enc.lookup(N("BaseEncoding")))) ?? base ?? new Array(256)).slice();
            const diffs = enc.lookup(N("Differences"));
            if (diffs instanceof PDFArray) {
                let code = 0;
                for (const o of diffs.asArray()) {
                    const v = o instanceof PDFRef ? this.context.lookup(o) : o;
                    if (v instanceof PDFNumber) code = v.asNumber();
                    else if (v instanceof PDFName) {
                        table[code++] = v.decodeText();
                        this.differencesUsed = true;
                    }
                }
            }
        } else table = base;
        this.encoding = table;
    }

    private defaultEncoding(): EncodingTable {
        const n = this.baseFont.replace(/^[A-Z]{6}\+/, "");
        if (/^Symbol/.test(n)) return SYMBOL_ENCODING;
        if (/^ZapfDingbats/.test(n)) return ZAPF_DINGBATS_ENCODING;
        return STANDARD_ENCODING;
    }

    /** Horizontal advance (text space, font size 1) for a code. */
    widthOf(code: number): number {
        if (this.kind === "type0") {
            const cid = this.cidFor(code);
            const w = cid === null ? undefined : (this.cidWidths?.get(cid) ?? this.added.get(cid)?.w);
            return (w ?? this.dw) / 1000;
        }
        const w = this.widthsSimple?.get(code);
        if (w !== undefined) return w * this.widthScale;
        if (this.std14) {
            const g = this.encoding?.[code];
            if (g) {
                try {
                    const aw = loadStd(this.std14).getWidthOfGlyph(g);
                    if (aw !== undefined) return aw / 1000;
                } catch {
                    /* unknown glyph */
                }
            }
        }
        return this.missingWidth * this.widthScale;
    }

    private cidFor(code: number): number | null {
        if (this.identity && !this.cmap) return code;
        if (this.cmap) {
            const c = lookupCid(this.cmap, code);
            if (c !== null) return c;
            return this.identity ? code : null;
        }
        return code;
    }

    unicodeOf(code: number): string | null {
        const u = this.toUnicode?.get(code) ?? this.added.get(code)?.unicode;
        if (u !== undefined) return u;
        if (this.kind !== "type0") return glyphNameToUnicode(this.encoding?.[code]);
        return null;
    }

    decode(bytes: Uint8Array): Glyph[] {
        const out: Glyph[] = [];
        if (this.kind === "type0") {
            const parts = this.identity && !this.cmap ? splitFixed(bytes, 2) : splitCodes(bytes, this.cmap?.codespace ?? [], 2);
            for (const p of parts) {
                this.codeLen.set(p.code, p.len);
                out.push({
                    code: p.code,
                    bytes: bytes.slice(p.start, p.start + p.len),
                    w0: this.widthOf(p.code),
                    unicode: this.unicodeOf(p.code),
                    isSpace: p.len === 1 && p.code === 32,
                });
            }
            return out;
        }
        for (let i = 0; i < bytes.length; i++) {
            const c = bytes[i];
            out.push({ code: c, bytes: bytes.slice(i, i + 1), w0: this.widthOf(c), unicode: this.unicodeOf(c), isSpace: c === 32 });
        }
        return out;
    }

    /** Best knowledge of the typeface: FontDescriptor first, then the embedded program, then the name. */
    styleInfo(): FontStyleInfo {
        const name = this.baseFont || this.desc.fontName || this.desc.family || "";
        const byName = describeFont(name);
        let fk: FontkitLike | null = null;
        try {
            fk = this.fontkit();
        } catch {
            fk = null;
        }
        // Separate reads: fontkit parses tables lazily and a subset may lack `post` but still have OS/2.
        let os2: FontkitLike["OS/2"] | undefined;
        let fkItalic: number | undefined;
        try {
            os2 = fk?.["OS/2"];
        } catch {
            os2 = undefined;
        }
        try {
            fkItalic = fk?.italicAngle;
        } catch {
            fkItalic = undefined;
        }
        const family = this.desc.family ? slugFamily(this.desc.family) : byName.family;
        // The embedded program is the ground truth for the glyph shapes; then the descriptor; then the name.
        const progWeight = os2?.usWeightClass && os2.usWeightClass >= 100 && os2.usWeightClass <= 1000 ? os2.usWeightClass : undefined;
        const weight = progWeight ?? this.desc.weight ?? byName.weight;
        const flags = this.desc.flags ?? 0;
        const fsSel = os2?.fsSelection;
        // Real program data (a slanted post angle or the OS/2 italic bit) decides; a zero angle alone is only trusted
        // together with an OS/2 table that says upright (Chrome's synthetic "-Oblique" fonts).
        const selItalic = fsSel === undefined ? undefined : typeof fsSel === "number" ? (fsSel & 1) !== 0 : !!fsSel.italic;
        const progItalic = fkItalic !== undefined && Math.abs(fkItalic) > 0.5 ? true : selItalic;
        // Without program data: a slanted descriptor angle, the name, or the Italic flag. MuPDF writes ItalicAngle 0
        // for every font, so a zero angle must not override "Lora Italic".
        const descAngle = this.desc.italicAngle;
        const italic = progItalic ?? ((descAngle !== undefined && Math.abs(descAngle) > 0.5) || byName.italic || (flags & 64) !== 0);
        const panoseSerif = os2?.panose?.[0] === 2 ? (os2.panose[1] >= 2 && os2.panose[1] <= 10 ? true : os2.panose[1] >= 11 ? false : undefined) : undefined;
        const mono = (flags & 1) !== 0 || byName.mono;
        const serif = !mono && ((flags & 2) !== 0 || (panoseSerif ?? byName.serif));
        return { name, family, weight, italic, serif, mono };
    }

    markUsed(code: number) {
        if (this.usedCodes.has(code)) return;
        this.usedCodes.add(code);
        this.reverse = null; // preference for used codes may change
    }

    // ── Encoding new text ────────────────────────────────────────────────────────────────────────

    private fontkit(): FontkitLike | null {
        if (this.fk !== undefined) return this.fk;
        this.fk = null;
        if (this.fontProgram && this.fontkitFactory && this.fontProgramKind !== "FontFile") {
            try {
                this.fk = this.fontkitFactory(this.fontProgram);
            } catch {
                this.fk = null;
            }
        }
        return this.fk;
    }

    private gidHasOutline(gid: number, ch: string): boolean {
        const fk = this.fontkit();
        if (!fk || gid <= 0) return false;
        try {
            // fontkit parses tables lazily — any access can throw on unusual subset programs.
            if (gid >= fk.numGlyphs) return false;
            const g = fk.getGlyph?.(gid);
            if (!g) return false;
            const cmds = g.path?.commands?.length ?? 0;
            return cmds > 0 || (/\s/.test(ch) && (g.advanceWidth ?? 0) > 0);
        } catch {
            return false;
        }
    }

    private gidForCid(cid: number): number | null {
        if (this.cidToGid === "Identity") return cid;
        if (this.cidToGid instanceof Uint8Array) {
            const i = cid * 2;
            if (i + 1 >= this.cidToGid.length) return null;
            return (this.cidToGid[i] << 8) | this.cidToGid[i + 1];
        }
        return null;
    }

    private buildReverse(): Map<string, number> {
        if (this.reverse) return this.reverse;
        const m = new Map<string, number>();
        const consider = (u: string | null | undefined, code: number) => {
            if (!u) return;
            const prev = m.get(u);
            // Prefer codes actually used in the document (guaranteed to render).
            if (prev === undefined || (!this.usedCodes.has(prev) && this.usedCodes.has(code))) m.set(u, code);
        };
        if (this.toUnicode) for (const [code, u] of this.toUnicode) consider(u, code);
        if (this.kind !== "type0" && this.encoding) {
            for (let code = 0; code < 256; code++) consider(glyphNameToUnicode(this.encoding[code]), code);
        }
        this.reverse = m;
        return m;
    }

    /** Can this code be drawn with THIS font's program and look right? */
    private canRender(code: number, ch: string): boolean {
        if (this.kind === "type3") {
            const g = this.encoding?.[code];
            return !!g && !!this.charProcs?.has(g);
        }
        // With /Widths, a code outside it is drawn with MissingWidth by viewers (usually 0): glyphs would overlap.
        if (this.kind === "simple" && this.widthsSimple && !((this.widthsSimple.get(code) ?? 0) > 0)) return false;
        if (!this.isEmbedded) {
            // Non-embedded: the viewer supplies a complete font. Standard 14 only covers its encoding.
            return this.std14 ? this.widthOf(code) > 0 : true;
        }
        if (this.usedCodes.has(code)) return true;
        if (this.kind === "type0") {
            const cid = this.cidFor(code);
            const gid = cid === null ? null : this.gidForCid(cid);
            if (gid !== null && this.fontProgramKind === "FontFile2") return this.gidHasOutline(gid, ch);
            return !this.isSubset && (this.cidWidths?.has(cid ?? -1) ?? false);
        }
        // Simple embedded font. A full (non-subset) program has every glyph of its encoding.
        if (!this.isSubset) return this.widthOf(code) > 0;
        return false;
    }

    /** Type3 fonts whose glyphs are rings of constant thickness (Chrome's -webkit-text-stroke): that thickness in
     *  text space at font size 1, or null for ordinary filled glyphs. Glyphs from other fonts must then be stroked. */
    outlineWidth(): number | null {
        if (this.outline !== undefined) return this.outline;
        this.outline = null;
        if (this.kind !== "type3") return null;
        const procs = this.dict.lookup(N("CharProcs"));
        const fm = this.dict.lookup(N("FontMatrix"));
        if (!(procs instanceof PDFDict) || !(fm instanceof PDFArray)) return null;
        const m = [0, 1, 2, 3].map((i) => numOf(fm.lookup(i) as PDFObject) ?? 0);
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const widths: number[] = [];
        let seen = 0;
        let ringed = 0;
        for (const key of procs.keys().slice(0, 24)) {
            const bytes = streamBytes(procs.lookup(key) as PDFObject);
            if (!bytes) continue;
            // Contours as polylines (curves flattened).
            const contours: number[][] = [];
            let cur: number[] | null = null;
            let px = 0;
            let py = 0;
            const to = (x: number, y: number) => {
                if (!cur) contours.push((cur = [px, py]));
                cur.push(x, y);
                px = x;
                py = y;
            };
            let painted = false;
            for (const op of parseContentStream(bytes)) {
                const v = op.args.map((a) => (a.t === "num" ? a.v : 0));
                if (op.op === "m") {
                    cur = null;
                    px = v[0];
                    py = v[1];
                } else if (op.op === "l") to(v[0], v[1]);
                else if (op.op === "c" || op.op === "v" || op.op === "y") {
                    const [x1, y1, x2, y2, x3, y3] =
                        op.op === "c" ? v : op.op === "v" ? [px, py, v[0], v[1], v[2], v[3]] : [v[0], v[1], v[2], v[3], v[2], v[3]];
                    const [x0, y0] = [px, py];
                    for (let k = 1; k <= 8; k++) {
                        const t = k / 8;
                        const u = 1 - t;
                        to(
                            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
                            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
                        );
                    }
                } else if (op.op === "re") {
                    cur = null;
                    px = v[0];
                    py = v[1];
                    to(v[0] + v[2], v[1]);
                    to(v[0] + v[2], v[1] + v[3]);
                    to(v[0], v[1] + v[3]);
                    to(v[0], v[1]);
                } else if (["f", "F", "f*", "B", "B*", "b", "b*"].includes(op.op)) painted = true;
            }
            if (!painted || !contours.length) continue;
            seen++;
            // Outlines come as pairs of contours (the two edges of the stroke).
            if (contours.length % 2 !== 0) continue;
            ringed++;
            let area = 0;
            let perim = 0;
            for (const c of contours) {
                for (let k = 0; k + 3 < c.length; k += 2) {
                    area += c[k] * c[k + 3] - c[k + 2] * c[k + 1];
                    perim += Math.hypot(c[k + 2] - c[k], c[k + 3] - c[k + 1]);
                }
                const n = c.length;
                area += c[n - 2] * c[1] - c[0] * c[n - 1]; // close
                perim += Math.hypot(c[0] - c[n - 2], c[1] - c[n - 1]);
            }
            // A band of thickness t along a centre line of length L: area t·L, both edges together ≈ 2L.
            if (perim > 0) widths.push((2 * Math.abs(area / 2)) / perim);
        }
        if (seen < 3 || ringed < 0.8 * seen || widths.length < 3) return null;
        widths.sort((x, y) => x - y);
        const med = widths[Math.floor(widths.length / 2)];
        // Every glyph the same thin band: an outline. Filled letters vary and are much thicker.
        const alike = widths.filter((x) => x >= 0.75 * med && x <= 1.33 * med).length;
        if (!(med > 0) || alike < 0.8 * widths.length || med * scale > 0.06) return null;
        this.outline = med * scale;
        return this.outline;
    }

    /** Advance of a glyph in the embedded program, in 1/1000 em. */
    private programAdvance(gid: number): number | null {
        const fk = this.fontkit();
        try {
            const upm = fk?.unitsPerEm;
            const aw = fk?.getGlyph?.(gid)?.advanceWidth;
            if (!upm || aw === undefined || !(aw >= 0)) return null;
            return Math.round((aw * 1000 * 1000) / upm) / 1000;
        } catch {
            return null;
        }
    }

    /** Write /W and ToUnicode entries for the program glyphs we started using (see `added`). */
    writeAdditions() {
        if (!this.added.size || this.kind !== "type0" || !this.cidFont) return;
        const ctx = this.context;
        const newW = [...this.added].filter(([cid]) => !this.cidWidths?.has(cid));
        if (newW.length) {
            let w = this.cidFont.lookup(N("W"));
            if (!(w instanceof PDFArray)) {
                w = ctx.obj([]);
                this.cidFont.set(N("W"), w);
            }
            for (const [cid, a] of newW) {
                (w as PDFArray).push(PDFNumber.of(cid));
                (w as PDFArray).push(ctx.obj([PDFNumber.of(a.w)]));
                this.cidWidths ??= new Map();
                this.cidWidths.set(cid, a.w);
            }
        }
        const tu = this.dict.lookup(N("ToUnicode"));
        const newU = [...this.added].filter(([cid]) => !this.toUnicode?.has(cid));
        if (newU.length && tu instanceof PDFStream) {
            const b = streamBytes(tu);
            if (b) {
                let text = "";
                for (let i = 0; i < b.length; i++) text += String.fromCharCode(b[i]);
                const at = text.lastIndexOf("endcmap");
                if (at >= 0) {
                    const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
                    const utf16 = (u: string) => {
                        let h = "";
                        for (let i = 0; i < u.length; i++) h += hex4(u.charCodeAt(i));
                        return h;
                    };
                    const lines: string[] = [];
                    for (let i = 0; i < newU.length; i += 100) {
                        const chunk = newU.slice(i, i + 100);
                        lines.push(`${chunk.length} beginbfchar`, ...chunk.map(([cid, a]) => `<${hex4(cid)}> <${utf16(a.unicode)}>`), "endbfchar");
                    }
                    const out = text.slice(0, at) + lines.join(NL) + NL + text.slice(at);
                    const bytes = new Uint8Array(out.length);
                    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
                    this.dict.set(N("ToUnicode"), ctx.register(ctx.flateStream(bytes)));
                    this.toUnicode ??= new Map();
                    for (const [cid, a] of newU) this.toUnicode.set(cid, a.unicode);
                }
            }
        }
        this.added.clear();
    }

    /** Encode one character with this font, or null when it can't be rendered faithfully. */
    encodeChar(ch: string): EncodedChar | null {
        if (!this.supported) return null;
        const rev = this.buildReverse();
        let code = rev.get(ch);
        if (code === undefined && this.kind === "type0" && this.identity && !this.cmap) {
            // Glyphs present in the program but absent from ToUnicode: map via the font's own cmap.
            const fk = this.fontkit();
            const cp = ch.codePointAt(0);
            let gid = 0;
            try {
                gid = fk && cp !== undefined ? (fk.glyphForCodePoint?.(cp)?.id ?? 0) : 0;
            } catch {
                gid = 0; // program without a usable cmap
            }
            if (gid > 0 && this.cidToGid === "Identity") {
                if (!this.canRender(gid, ch)) return null;
                const known = this.cidWidths?.has(gid) || this.usedCodes.has(gid);
                if (!known) {
                    // A new CID for this font: its advance must go into /W. Only when no page draws it already.
                    if (!this.documentScanned()) return null;
                    const w = this.programAdvance(gid);
                    if (w === null) return null;
                    this.added.set(gid, { w, unicode: ch });
                } else this.added.set(gid, { w: this.widthOf(gid) * 1000, unicode: ch });
                this.reverse?.set(ch, gid);
                code = gid;
            }
        }
        if (code === undefined) return null;
        if (!this.canRender(code, ch)) return null;
        let bytes: Uint8Array;
        if (this.kind === "type0") {
            const len = this.codeLen.get(code) ?? (this.identity && !this.cmap ? 2 : guessLen(this.cmap, code));
            bytes = new Uint8Array(len);
            for (let i = len - 1, v = code; i >= 0; i--, v = Math.floor(v / 256)) bytes[i] = v & 0xff;
        } else bytes = Uint8Array.of(code & 0xff);
        return { ch, code, bytes, w0: this.widthOf(code), isSpace: bytes.length === 1 && code === 32 };
    }
}

const splitFixed = (bytes: Uint8Array, n: number) => {
    const res: { code: number; start: number; len: number }[] = [];
    for (let i = 0; i < bytes.length; i += n) {
        let v = 0;
        const len = Math.min(n, bytes.length - i);
        for (let k = 0; k < len; k++) v = v * 256 + bytes[i + k];
        res.push({ code: v, start: i, len });
    }
    return res;
};

const guessLen = (cmap: ParsedCMap | null, code: number) => {
    if (cmap) for (const r of cmap.codespace) if (code >= r.lo && code <= r.hi) return r.bytes;
    return code > 0xff ? 2 : 1;
};

/** Parse a CIDFont /W array: [c [w1 w2 …]  cFirst cLast w  …]. */
const parseW = (w: PDFObject | undefined): Map<number, number> | null => {
    if (!(w instanceof PDFArray)) return null;
    const m = new Map<number, number>();
    const arr = w;
    const len = w.size();
    let i = 0;
    while (i < len) {
        const a = numOf(arr.lookup(i) as PDFObject);
        const b = arr.lookup(i + 1) as PDFObject;
        if (a === undefined) {
            i++;
            continue;
        }
        if (b instanceof PDFArray) {
            b.asArray().forEach((_, k) => {
                const v = numOf(b.lookup(k) as PDFObject);
                if (v !== undefined) m.set(a + k, v);
            });
            i += 2;
        } else {
            const last = numOf(b);
            const v = numOf(arr.lookup(i + 2) as PDFObject);
            if (last !== undefined && v !== undefined && last - a < 65536) for (let c = a; c <= last; c++) m.set(c, v);
            i += 3;
        }
    }
    return m;
};

/** What the interpreter needs from a font: turn string bytes into glyphs. */
export interface DecodingFont {
    decode(bytes: Uint8Array): Glyph[];
    markUsed(code: number): void;
}

/** Per-document registry so every page shares one FontModel per font object. */
export class FontRegistry {
    private readonly byRef = new Map<string, FontModel>();
    private readonly byDict = new WeakMap<PDFDict, FontModel>();
    private readonly virtual = new Map<string, DecodingFont>();
    private readonly models: FontModel[] = [];
    /** Set once every page was interpreted, so `usedCodes` is complete. */
    documentScanned = false;
    constructor(
        readonly context: PDFContext,
        readonly fontkitFactory: FontkitFactory | null,
    ) {}

    /** Persist font changes (new /W and ToUnicode entries) — call once, after all pages are committed. */
    writeAdditions() {
        for (const m of this.models) m.writeAdditions();
    }

    /** Fonts embedded by us are only written at save time — decode them from what we encoded. */
    setVirtual(ref: PDFRef, font: DecodingFont) {
        this.virtual.set(ref.toString(), font);
    }

    get(obj: PDFObject | undefined): DecodingFont | null {
        let ref: PDFRef | null = null;
        let dict: PDFObject | undefined = obj;
        if (obj instanceof PDFRef) {
            ref = obj;
            const v = this.virtual.get(obj.toString());
            if (v) return v;
            const hit = this.byRef.get(obj.toString());
            if (hit) return hit;
            dict = this.context.lookup(obj);
        }
        if (!(dict instanceof PDFDict)) return null;
        const hit = this.byDict.get(dict);
        if (hit) return hit;
        const fm = new FontModel(this.context, dict, ref, this.fontkitFactory, () => this.documentScanned);
        this.models.push(fm);
        if (ref) this.byRef.set(ref.toString(), fm);
        this.byDict.set(dict, fm);
        return fm;
    }
}
