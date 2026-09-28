// Word-ready typography from PDF fonts and colour operators: family names Word knows, bold/italic, ascent/descent,
// and fill colours (gray, RGB, CMYK, ICC, Lab, Separation/DeviceN, Indexed) as 6-digit hex.
import { PDFArray, type PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRef, PDFStream, PDFString } from "pdf-lib";
import { streamBytes } from "../pdf-text-engine/font-model";
import type { Hex } from "./types";

// ── Fonts ──────────────────────────────────────────────────────────────────────────────────────────

export type FontFace = {
    /** Family as Word should use it ("Times New Roman", "Calibri Light", "Open Sans"). */
    family: string;
    bold: boolean;
    italic: boolean;
    /** Weight class 100–900 (after mapping to a Word family: "Segoe UI Semibold" is 400 in its own family). */
    weight: number;
    /** Ascent / descent as a fraction of the font size (positive numbers). */
    ascent: number;
    descent: number;
    /** Symbol / dingbat font: its glyphs are pictograms (bullets), not letters. */
    symbolic: boolean;
    /** Core family of the same kind to fall back on when `family` isn't installed (undefined for Office fonts). */
    fallback?: string;
};

/** What we read from a pdf-text-engine FontModel (duck-typed: the registry may also hold virtual fonts). */
type FontLike = {
    baseFont?: string;
    dict?: PDFDict;
    styleInfo?: () => { name: string; family: string; weight: number; italic: boolean; serif: boolean; mono: boolean };
};

const N = (s: string) => PDFName.of(s);
const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);
const text = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

/** Families that other names stand for: metric clones and PostScript aliases → the font Word users have. */
const ALIASES: [RegExp, string][] = [
    [/^(timesnewroman|timesroman|times|tinos|liberationserif|nimbusrom(an|no9l|anno9l)?|texgyretermes|termes|freeserif|thorndale)$/, "Times New Roman"],
    [/^(arial|helvetica|arimo|liberationsans|nimbussan(s|l)?|texgyreheros|heros|freesans|albany|swiss721|arialunicodems)$/, "Arial"],
    [/^(couriernew|courier|cousine|liberationmono|nimbusmon(o|l)?|freemono|texgyrecursor|cumberland)$/, "Courier New"],
    [/^(calibri|carlito)$/, "Calibri"],
    [/^(cambria|caladea)$/, "Cambria"],
    [/^(cambriamath)$/, "Cambria Math"],
    [/^(symbol|symbolmt|standardsymbolsps|standardsyml)$/, "Symbol"],
    // ZapfDingbats text comes out as real Unicode dingbats (✓ ● ➔): a Unicode font shows them.
    [/^(zapfdingbats|dingbats|itczapfdingbats|d050000l)$/, "Segoe UI Symbol"],
    [/^(wingdings)$/, "Wingdings"],
    [/^(dejavusans)$/, "DejaVu Sans"],
    [/^(dejavuserif)$/, "DejaVu Serif"],
    [/^(dejavusansmono)$/, "DejaVu Sans Mono"],
    [/^(segoeui)$/, "Segoe UI"],
    [/^(trebuchetms|trebuchet)$/, "Trebuchet MS"],
    [/^(comicsansms|comicsans)$/, "Comic Sans MS"],
    [/^(centurygothic)$/, "Century Gothic"],
    [/^(bookantiqua)$/, "Book Antiqua"],
    [/^(palatinolinotype|palatino|texgyrepagella|pagella|urwpalladio|p052)$/, "Palatino Linotype"],
    [/^(bookmanoldstyle|bookman|urwbookman)$/, "Bookman Old Style"],
    [/^(garamond|adobegaramond|adobegaramondpro|garamondpremrpro|egaramond)$/, "Garamond"],
    [/^(lucidaconsole)$/, "Lucida Console"],
    [/^(lucidasansunicode)$/, "Lucida Sans Unicode"],
    [/^(msgothic)$/, "MS Gothic"],
    [/^(msmincho)$/, "MS Mincho"],
    [/^(simsun)$/, "SimSun"],
    [/^(yugothic)$/, "Yu Gothic"],
    [/^(microsoftyahei)$/, "Microsoft YaHei"],
    [/^(microsoftsansserif)$/, "Microsoft Sans Serif"],
    [/^(frutiger|univers|swiss)$/, "Arial"],
    // TeX's Computer Modern / Latin Modern: nobody has them in Word; the closest faces everyone has.
    [/^(cmr\d*|cmbx\d*|cmti\d*|cmsl\d*|cmcsc\d*|cmu(serif)?|lmroman\d*|latinmodernroman|sfrm\d*|sfbx\d*|sfti\d*)$/, "Times New Roman"],
    [/^(cmss\d*|cmssbx\d*|lmsans\d*|cmusansserif|latinmodernsans)$/, "Arial"],
    [/^(cmtt\d*|lmmono\d*|cmutypewriter|latinmodernmono)$/, "Courier New"],
];

/** Families that Office installs as separate families per weight (Word can only toggle bold). */
const weightFamily = (family: string, weight: number, raw: string): { family: string; weight: number } => {
    const r = raw.toLowerCase().replace(/[\s_-]/g, "");
    if (family === "Calibri" && weight <= 350) return { family: "Calibri Light", weight: 400 };
    if (family === "Segoe UI") {
        if (/semilight/.test(r)) return { family: "Segoe UI Semilight", weight: 400 };
        if (weight <= 300) return { family: "Segoe UI Light", weight: 400 };
        if (weight >= 850) return { family: "Segoe UI Black", weight: 400 };
        if (weight >= 550 && weight < 650) return { family: "Segoe UI Semibold", weight: 400 };
    }
    if (family === "Arial") {
        if (/narrow/.test(r)) return { family: "Arial Narrow", weight };
        if (/black/.test(r) || weight >= 850) return { family: "Arial Black", weight: 400 };
    }
    if (family === "Aptos") {
        if (/display/.test(r)) return { family: "Aptos Display", weight };
        if (/narrow/.test(r)) return { family: "Aptos Narrow", weight };
        if (weight <= 350) return { family: "Aptos Light", weight: 400 };
        if (weight >= 550 && weight < 650) return { family: "Aptos SemiBold", weight: 400 };
        if (weight >= 750 && weight < 850) return { family: "Aptos ExtraBold", weight: 400 };
        if (weight >= 850) return { family: "Aptos Black", weight: 400 };
    }
    if (family === "Franklin Gothic") {
        const m = /(medium|book|demi|heavy)/.exec(r);
        if (m) return { family: `Franklin Gothic ${m[1][0].toUpperCase()}${m[1].slice(1)}`, weight: 400 };
    }
    return { family, weight };
};

const STYLE_WORDS =
    /(regular|roman|normal|book|bold|bolditalic|italic|oblique|medium|light|thin|hairline|black|heavy|semibold|demibold|demi|extrabold|ultrabold|extralight|ultralight|semilight|condensed|cond|narrow|expanded|extended|italicmt|boldmt|mt|psmt|ps)$/i;

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" → "Times New Roman"; "OpenSans-SemiBold" → "Open Sans". */
export const familyFromName = (name: string): string => {
    let s = name.replace(/^[A-Z]{6}\+/, "").trim();
    // "Arial,Bold", "Arial-BoldMT", "Arial Bold": the family is before the first separator.
    s = s.split(/[,-]/)[0] ?? s;
    s = s.replace(/[_]+/g, " ").trim();
    // Style words glued to the family ("ArialBold", "TimesNewRomanPSMT", "Calibri Light").
    for (let i = 0; i < 4; i++) {
        const compact = s.replace(/\s+$/, "");
        const m = STYLE_WORDS.exec(compact);
        if (!m || compact.length - m[0].length < 3) break;
        // "Roman" is part of "Times New Roman"; "Book" of "Book Antiqua" is a prefix, never stripped here.
        if (/^roman$/i.test(m[0]) && /times\s*new\s*$/i.test(compact.slice(0, -m[0].length))) break;
        s = compact.slice(0, -m[0].length).replace(/[\s,]+$/, "");
    }
    const slug = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const [re, fam] of ALIASES) if (re.test(slug)) return fam;
    if (/^franklingothic/.test(slug)) return "Franklin Gothic";
    if (/^aptos/.test(slug)) return "Aptos";
    if (/\s/.test(s)) return s.replace(/\s+/g, " ");
    // CamelCase → words: "PlayfairDisplay" → "Playfair Display", "EBGaramond" → "EB Garamond", "IBMPlexSans" → "IBM Plex Sans".
    const spaced = s
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-zA-Z])(\d)/g, "$1 $2")
        .trim();
    return spaced || "Arial";
};

const WEIGHTS: [RegExp, number][] = [
    [/(thin|hairline)/, 100],
    [/(extralight|ultralight)/, 200],
    [/semilight/, 350],
    [/light/, 300],
    [/(semibold|demibold|demi)/, 600],
    [/(extrabold|ultrabold)/, 800],
    [/(black|heavy)/, 900],
    [/bold/, 700],
    [/medium/, 500],
];
const weightFromName = (s: string) => {
    const n = s.toLowerCase().replace(/[\s_-]/g, "");
    for (const [re, w] of WEIGHTS) if (re.test(n)) return w;
    return 400;
};

const faceCache = new WeakMap<object, FontFace>();

/** Families installed with Windows / Office (no fallback needed). */
const CORE =
    /^(Arial|Arial (Narrow|Black)|Times New Roman|Courier New|Calibri( Light)?|Cambria( Math)?|Candara|Consolas|Constantia|Corbel|Georgia|Verdana|Tahoma|Segoe UI( \w+)?|Trebuchet MS|Garamond|Book Antiqua|Bookman Old Style|Century Gothic|Century|Comic Sans MS|Impact|Lucida (Console|Sans Unicode)|Palatino Linotype|Franklin Gothic( \w+)?|Gill Sans MT|Aptos( \w+)?|Symbol|Wingdings|Webdings|MS Gothic|MS Mincho|SimSun|Yu Gothic|Microsoft YaHei|Microsoft Sans Serif|Sylfaen|Ebrima|Gadugi|Leelawadee( UI)?|Nirmala UI|Javanese Text|Myanmar Text|Mongolian Baiti|MV Boli|Sitka( \w+)?)$/;

const descriptorOf = (dict: PDFDict | undefined): PDFDict | undefined => {
    if (!dict) return undefined;
    const direct = dict.lookup(N("FontDescriptor"));
    if (direct instanceof PDFDict) return direct;
    const desc = dict.lookup(N("DescendantFonts"));
    const cid = desc instanceof PDFArray ? desc.lookup(0) : undefined;
    const fd = cid instanceof PDFDict ? cid.lookup(N("FontDescriptor")) : undefined;
    return fd instanceof PDFDict ? fd : undefined;
};

/** Word family, bold, italic and vertical metrics of a PDF font (cached per font object). */
export const fontFace = (font: unknown): FontFace => {
    const f = font as FontLike | null;
    if (f && typeof f === "object") {
        const hit = faceCache.get(f);
        if (hit) return hit;
    }
    let info: ReturnType<NonNullable<FontLike["styleInfo"]>> | null = null;
    try {
        info = f?.styleInfo ? f.styleInfo() : null;
    } catch {
        info = null;
    }
    const fd = descriptorOf(f?.dict);
    const baseName = (f?.baseFont || info?.name || "").replace(/^[A-Z]{6}\+/, "");
    const descFamily = text(fd?.lookup(N("FontFamily")))?.trim();
    const descName = fd?.lookup(N("FontName"));
    const psName = baseName || (descName instanceof PDFName ? descName.decodeText().replace(/^[A-Z]{6}\+/, "") : "");
    // The descriptor's family is the real name when present ("Playfair Display"); else the PostScript name.
    let family = descFamily && /[a-z]{2}/i.test(descFamily) && !/^[A-Z]{6}\+/.test(descFamily) ? familyFromName(descFamily) : familyFromName(psName || "Arial");
    // Generated names ("F1", "T1_0", "R12") say nothing: pick a face of the same class.
    if (!psName || /^[A-Z]{1,3}\d+(_\d+)?$/i.test(psName) || family.replace(/[^a-z]/gi, "").length < 3)
        family = info?.mono ? "Courier New" : info?.serif ? "Times New Roman" : "Arial";
    let weight = info?.weight ?? 400;
    // Names say more than a generic 400 in the descriptor ("Segoe UI Semibold", "Calibri Light").
    const byName = weightFromName(psName);
    if (weight === 400 && byName !== 400) weight = byName;
    const italic = info?.italic ?? /(italic|oblique)/i.test(psName);
    const mapped = weightFamily(family, weight, psName + " " + (descFamily ?? ""));
    family = mapped.family;
    weight = mapped.weight;
    const flags = num(fd?.lookup(N("Flags"))) ?? 0;
    const symbolic =
        /^(Symbol|Wingdings|Webdings)/.test(family) ||
        /(dingbat|wingding|webding|symbol)/i.test(psName) ||
        ((flags & 4) !== 0 && !(flags & 32) && /(ding|sym|icon|fontawesome|material)/i.test(psName));
    // Vertical metrics: descriptor values are often missing or bogus; keep them inside sane bounds.
    const asc = num(fd?.lookup(N("Ascent")));
    const desc = num(fd?.lookup(N("Descent")));
    const ascent = asc !== undefined && asc / 1000 >= 0.5 && asc / 1000 <= 1.3 ? asc / 1000 : 0.85;
    const descent = desc !== undefined && Math.abs(desc) / 1000 >= 0.08 && Math.abs(desc) / 1000 <= 0.6 ? Math.abs(desc) / 1000 : 0.22;
    const face: FontFace = { family, bold: weight >= 600, italic, weight, ascent, descent, symbolic };
    // Condensed display faces fall back on a narrow face, or the text would run far wider than in the PDF.
    const condensed = /(anton|bebas|oswald|condensed|narrow|compressed|league\s*gothic|fjalla|teko|pathway|saira\s*extra)/i.test(family + " " + psName);
    if (!symbolic && !CORE.test(family)) face.fallback = info?.mono ? "Courier New" : condensed ? "Arial Narrow" : info?.serif ? "Times New Roman" : "Arial";
    if (f && typeof f === "object") faceCache.set(f, face);
    return face;
};

// ── Colour ─────────────────────────────────────────────────────────────────────────────────────────

type Space =
    | { kind: "gray" | "rgb" | "cmyk" | "pattern" | "none" }
    | { kind: "lab"; white: number[] }
    | { kind: "sep"; n: number; alt: Space; fn: ((x: number[]) => number[]) | null; all?: boolean }
    | { kind: "indexed"; base: Space; hival: number; table: Uint8Array<ArrayBufferLike> };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const hex2 = (v: number) =>
    Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
export const rgbHex = (r: number, g: number, b: number): Hex => hex2(r) + hex2(g) + hex2(b);

/** CMYK → sRGB as viewers show it (the polynomial fit pdf.js uses for DeviceCMYK, Apache-2.0), 0–1 in and out. */
export const cmykToRgb = (c: number, m: number, y: number, k: number): [number, number, number] => {
    c = clamp01(c);
    m = clamp01(m);
    y = clamp01(y);
    k = clamp01(k);
    const r =
        255 +
        c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 285.2331026137004) +
        m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 5.497006427196366) +
        y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
        k * (-21.86122147463605 * k - 189.48180835922747);
    const g =
        255 +
        c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 79.2970844816548) +
        m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
        y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
        k * (-20.737325471181034 * k - 187.80453709719578);
    const b =
        255 +
        c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k - 14.183576799673286) +
        m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
        y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
        k * (-22.33816807309886 * k - 180.12613974708367);
    return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255)];
};

const labToRgb = (L: number, a: number, b: number, white: number[]): [number, number, number] => {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const inv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
    const X = white[0] * inv(fx);
    const Y = white[1] * inv(fy);
    const Z = white[2] * inv(fz);
    // XYZ (D50-ish white) → linear sRGB (D65 matrix; the white-point difference is negligible for text colours).
    const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
    const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
    return [clamp01(gamma(lin[0])), clamp01(gamma(lin[1])), clamp01(gamma(lin[2]))];
};

const numbersOf = (arr: PDFObject | undefined): number[] => {
    if (!(arr instanceof PDFArray)) return [];
    const out: number[] = [];
    for (let i = 0; i < arr.size(); i++) out.push(num(arr.lookup(i)) ?? 0);
    return out;
};

/** PDF function (types 0, 2, 3, 4) as a JS function, or null when it can't be evaluated. */
const pdfFunction = (obj: PDFObject | undefined, context: PDFContext, depth = 0): ((x: number[]) => number[]) | null => {
    const o = obj instanceof PDFRef ? context.lookup(obj) : obj;
    if (depth > 4) return null;
    if (o instanceof PDFArray) {
        const fns: (((x: number[]) => number[]) | null)[] = [];
        for (let i = 0; i < o.size(); i++) fns.push(pdfFunction(o.get(i), context, depth + 1));
        if (fns.some((f) => !f)) return null;
        return (x) => fns.flatMap((f) => f!(x).slice(0, 1));
    }
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!dict) return null;
    const type = num(dict.lookup(N("FunctionType")));
    const domain = numbersOf(dict.lookup(N("Domain")));
    const range = numbersOf(dict.lookup(N("Range")));
    const clipRange = (y: number[]) =>
        range.length ? y.map((v, i) => (i * 2 + 1 < range.length ? Math.min(range[i * 2 + 1], Math.max(range[i * 2], v)) : v)) : y;
    const clipDomain = (x: number[]) => x.map((v, i) => (i * 2 + 1 < domain.length ? Math.min(domain[i * 2 + 1], Math.max(domain[i * 2], v)) : v));
    if (type === 2) {
        const c0 = numbersOf(dict.lookup(N("C0")));
        const c1 = numbersOf(dict.lookup(N("C1")));
        const n = num(dict.lookup(N("N"))) ?? 1;
        const C0 = c0.length ? c0 : [0];
        const C1 = c1.length ? c1 : [1];
        return (x) => {
            const t = Math.pow(clipDomain(x)[0] ?? 0, n);
            return clipRange(C0.map((v, i) => v + t * ((C1[i] ?? 0) - v)));
        };
    }
    if (type === 0 && o instanceof PDFStream) {
        const size = numbersOf(dict.lookup(N("Size")));
        const bps = num(dict.lookup(N("BitsPerSample"))) ?? 8;
        if (size.length !== 1 || ![1, 2, 4, 8, 16].includes(bps)) return null;
        const bytes = streamBytes(o);
        if (!bytes) return null;
        const outs = range.length / 2;
        const encode = numbersOf(dict.lookup(N("Encode")));
        const decode = numbersOf(dict.lookup(N("Decode")));
        const enc = encode.length >= 2 ? encode : [0, size[0] - 1];
        const dec = decode.length ? decode : range;
        const max = Math.pow(2, bps) - 1;
        const sample = (i: number, j: number) => {
            const bit = (i * outs + j) * bps;
            if (bps >= 8) {
                const at = bit >> 3;
                return bps === 8 ? (bytes[at] ?? 0) : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
            }
            const byte = bytes[bit >> 3] ?? 0;
            return (byte >> (8 - bps - (bit & 7))) & max;
        };
        return (x) => {
            const d0 = domain[0] ?? 0;
            const d1 = domain[1] ?? 1;
            const xv = clipDomain(x)[0] ?? 0;
            const e = enc[0] + ((xv - d0) * (enc[1] - enc[0])) / (d1 - d0 || 1);
            const p = Math.min(size[0] - 1, Math.max(0, e));
            const i0 = Math.floor(p);
            const i1 = Math.min(size[0] - 1, i0 + 1);
            const t = p - i0;
            const out: number[] = [];
            for (let j = 0; j < outs; j++) {
                const s = sample(i0, j) * (1 - t) + sample(i1, j) * t;
                out.push(dec[j * 2] + (s * (dec[j * 2 + 1] - dec[j * 2])) / max);
            }
            return clipRange(out);
        };
    }
    if (type === 3) {
        const fns = dict.lookup(N("Functions"));
        const bounds = numbersOf(dict.lookup(N("Bounds")));
        const encode = numbersOf(dict.lookup(N("Encode")));
        if (!(fns instanceof PDFArray)) return null;
        const parts: (((x: number[]) => number[]) | null)[] = [];
        for (let i = 0; i < fns.size(); i++) parts.push(pdfFunction(fns.get(i), context, depth + 1));
        if (parts.some((f) => !f)) return null;
        return (x) => {
            const xv = clipDomain(x)[0] ?? 0;
            let k = 0;
            while (k < bounds.length && xv >= bounds[k]) k++;
            const lo = k === 0 ? (domain[0] ?? 0) : bounds[k - 1];
            const hi = k === bounds.length ? (domain[1] ?? 1) : bounds[k];
            const e0 = encode[k * 2] ?? 0;
            const e1 = encode[k * 2 + 1] ?? 1;
            return clipRange(parts[k]!([e0 + ((xv - lo) * (e1 - e0)) / (hi - lo || 1)]));
        };
    }
    if (type === 4 && o instanceof PDFStream) {
        const bytes = streamBytes(o);
        if (!bytes) return null;
        const prog = parsePostScript(bytes);
        if (!prog) return null;
        return (x) => {
            const stack = clipDomain(x).slice();
            try {
                runPostScript(prog, stack);
            } catch {
                return range.length ? range.filter((_, i) => i % 2 === 0) : [0];
            }
            const outs = range.length / 2 || stack.length;
            return clipRange(stack.slice(-outs));
        };
    }
    return null;
};

type PsToken = number | string | PsToken[];

const parsePostScript = (bytes: Uint8Array): PsToken[] | null => {
    let src = "";
    for (let i = 0; i < bytes.length; i++) src += String.fromCharCode(bytes[i]);
    const tokens = src.match(/[{}]|[^\s{}]+/g) ?? [];
    let i = 0;
    const block = (): PsToken[] => {
        const out: PsToken[] = [];
        while (i < tokens.length) {
            const t = tokens[i++];
            if (t === "{") out.push(block());
            else if (t === "}") return out;
            else {
                const v = Number(t);
                out.push(Number.isFinite(v) && /^[-+.\d]/.test(t) ? v : t);
            }
        }
        return out;
    };
    const top = block();
    return Array.isArray(top[0]) ? (top[0] as PsToken[]) : top;
};

const runPostScript = (prog: PsToken[], st: number[], depth = 0) => {
    if (depth > 20) throw new Error("depth");
    const pop = () => {
        const v = st.pop();
        if (v === undefined) throw new Error("underflow");
        return v;
    };
    for (let k = 0; k < prog.length; k++) {
        const t = prog[k];
        if (typeof t === "number") {
            st.push(t);
            continue;
        }
        if (Array.isArray(t)) {
            // Procedures are only operands of if / ifelse.
            const next = prog[k + 1];
            if (next === "if") {
                if (pop()) runPostScript(t, st, depth + 1);
                k++;
            } else if (Array.isArray(next) && prog[k + 2] === "ifelse") {
                runPostScript(pop() ? t : next, st, depth + 1);
                k += 2;
            }
            continue;
        }
        let a: number;
        let b: number;
        switch (t) {
            case "add":
                b = pop();
                st.push(pop() + b);
                break;
            case "sub":
                b = pop();
                st.push(pop() - b);
                break;
            case "mul":
                b = pop();
                st.push(pop() * b);
                break;
            case "div":
                b = pop();
                a = pop();
                st.push(b ? a / b : 0);
                break;
            case "idiv":
                b = pop();
                a = pop();
                st.push(b ? Math.trunc(a / b) : 0);
                break;
            case "mod":
                b = pop();
                a = pop();
                st.push(b ? a % b : 0);
                break;
            case "neg":
                st.push(-pop());
                break;
            case "abs":
                st.push(Math.abs(pop()));
                break;
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
            case "sqrt":
                st.push(Math.sqrt(Math.max(0, pop())));
                break;
            case "exp":
                b = pop();
                st.push(Math.pow(pop(), b));
                break;
            case "ln":
                st.push(Math.log(Math.max(1e-12, pop())));
                break;
            case "log":
                st.push(Math.log10(Math.max(1e-12, pop())));
                break;
            case "sin":
                st.push(Math.sin((pop() * Math.PI) / 180));
                break;
            case "cos":
                st.push(Math.cos((pop() * Math.PI) / 180));
                break;
            case "atan":
                b = pop();
                a = pop();
                st.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360);
                break;
            case "dup":
                a = pop();
                st.push(a, a);
                break;
            case "exch":
                b = pop();
                a = pop();
                st.push(b, a);
                break;
            case "pop":
                pop();
                break;
            case "copy": {
                const n = pop();
                st.push(...st.slice(st.length - n));
                break;
            }
            case "index": {
                const n = pop();
                st.push(st[st.length - 1 - n] ?? 0);
                break;
            }
            case "roll": {
                const j = pop();
                const n = pop();
                if (n > 0 && n <= st.length) {
                    const part = st.splice(st.length - n, n);
                    const s = ((j % n) + n) % n;
                    st.push(...part.slice(n - s), ...part.slice(0, n - s));
                }
                break;
            }
            case "eq":
                st.push(pop() === pop() ? 1 : 0);
                break;
            case "ne":
                st.push(pop() !== pop() ? 1 : 0);
                break;
            case "gt":
                b = pop();
                st.push(pop() > b ? 1 : 0);
                break;
            case "ge":
                b = pop();
                st.push(pop() >= b ? 1 : 0);
                break;
            case "lt":
                b = pop();
                st.push(pop() < b ? 1 : 0);
                break;
            case "le":
                b = pop();
                st.push(pop() <= b ? 1 : 0);
                break;
            case "and":
                b = pop();
                st.push(pop() & b);
                break;
            case "or":
                b = pop();
                st.push(pop() | b);
                break;
            case "xor":
                b = pop();
                st.push(pop() ^ b);
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
            default:
                throw new Error("unsupported " + t);
        }
    }
};

const spaceCache = new WeakMap<object, Space>();

const resolveSpace = (obj: PDFObject | undefined, context: PDFContext, depth = 0): Space => {
    const o = obj instanceof PDFRef ? context.lookup(obj) : obj;
    if (depth > 5 || !o) return { kind: "gray" };
    if (o instanceof PDFName) {
        const n = o.decodeText();
        if (n === "DeviceGray" || n === "G" || n === "CalGray") return { kind: "gray" };
        if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return { kind: "rgb" };
        if (n === "DeviceCMYK" || n === "CMYK") return { kind: "cmyk" };
        if (n === "Pattern") return { kind: "pattern" };
        return { kind: "gray" };
    }
    if (!(o instanceof PDFArray) || o.size() === 0) return { kind: "gray" };
    const hit = spaceCache.get(o);
    if (hit) return hit;
    const family = o.lookup(0);
    const fam = family instanceof PDFName ? family.decodeText() : "";
    let space: Space = { kind: "gray" };
    if (fam === "ICCBased") {
        const s = o.lookup(1);
        const n = s instanceof PDFStream ? num(s.dict.lookup(N("N"))) : undefined;
        const alt = s instanceof PDFStream ? s.dict.lookup(N("Alternate")) : undefined;
        space =
            n === 1 ? { kind: "gray" } : n === 4 ? { kind: "cmyk" } : n === 3 ? { kind: "rgb" } : alt ? resolveSpace(alt, context, depth + 1) : { kind: "rgb" };
    } else if (fam === "CalRGB") space = { kind: "rgb" };
    else if (fam === "CalGray") space = { kind: "gray" };
    else if (fam === "Lab") {
        const d = o.lookup(1);
        const wp = d instanceof PDFDict ? numbersOf(d.lookup(N("WhitePoint"))) : [];
        space = { kind: "lab", white: wp.length === 3 ? wp : [0.9505, 1, 1.089] };
    } else if (fam === "Separation" || fam === "DeviceN") {
        const names = o.lookup(1);
        const n = fam === "Separation" ? 1 : names instanceof PDFArray ? names.size() : 1;
        const sepName = names instanceof PDFName ? names.decodeText() : "";
        if (sepName === "None") space = { kind: "none" };
        else
            space = {
                kind: "sep",
                n,
                alt: resolveSpace(o.get(2), context, depth + 1),
                fn: pdfFunction(o.get(3), context),
                all: sepName === "All",
            };
    } else if (fam === "Indexed" || fam === "I") {
        const base = resolveSpace(o.get(1), context, depth + 1);
        const hival = num(o.lookup(2)) ?? 255;
        const look = o.lookup(3);
        let table: Uint8Array = new Uint8Array(0);
        if (look instanceof PDFStream) table = streamBytes(look) ?? table;
        else if (look instanceof PDFString || look instanceof PDFHexString) table = look.asBytes();
        space = { kind: "indexed", base, hival, table };
    } else if (fam === "Pattern") space = { kind: "pattern" };
    else space = resolveSpace(family, context, depth + 1);
    spaceCache.set(o, space);
    return space;
};

const components = (s: Space): number =>
    s.kind === "gray" ? 1 : s.kind === "rgb" ? 3 : s.kind === "cmyk" ? 4 : s.kind === "lab" ? 3 : s.kind === "sep" ? s.n : s.kind === "indexed" ? 1 : 0;

const toRgb = (s: Space, v: number[], depth = 0): [number, number, number] | null => {
    if (depth > 5) return null;
    switch (s.kind) {
        case "gray":
            return [clamp01(v[0] ?? 0), clamp01(v[0] ?? 0), clamp01(v[0] ?? 0)];
        case "rgb":
            return [clamp01(v[0] ?? 0), clamp01(v[1] ?? 0), clamp01(v[2] ?? 0)];
        case "cmyk":
            return cmykToRgb(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
        case "lab":
            return labToRgb(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, s.white);
        case "sep": {
            if (s.all) return [1 - clamp01(v[0] ?? 1), 1 - clamp01(v[0] ?? 1), 1 - clamp01(v[0] ?? 1)];
            if (s.fn) {
                try {
                    return toRgb(s.alt, s.fn(v.length ? v : [1]), depth + 1);
                } catch {
                    /* fall through */
                }
            }
            const t = clamp01(v[0] ?? 1);
            return [1 - t, 1 - t, 1 - t];
        }
        case "indexed": {
            const n = components(s.base);
            const i = Math.max(0, Math.min(s.hival, Math.round(v[0] ?? 0)));
            const vals: number[] = [];
            for (let k = 0; k < n; k++) vals.push((s.table[i * n + k] ?? 0) / 255);
            if (s.base.kind === "lab") return null;
            return toRgb(s.base, vals, depth + 1);
        }
        default:
            return null;
    }
};

const unescapeName = (s: string) => s.replace(/^\//, "").replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

const colourCache = new WeakMap<object, Map<string, Hex | null>>();
const noResources = {};

/**
 * The colour a set of colour operators paints with, as hex ("0 g", "1 0 0 rg", "0 0 0 1 k", "/CS0 cs\n0.3 sc"…), or
 * null when it can't be told (patterns: gradients, tiling). `resources` resolves named colour spaces.
 */
export const colourOf = (ops: string, resources: PDFDict | null, context: PDFContext): Hex | null => {
    const key = resources ?? noResources;
    let cache = colourCache.get(key);
    if (!cache) colourCache.set(key, (cache = new Map()));
    const hit = cache.get(ops);
    if (hit !== undefined) return hit;
    let space: Space = { kind: "gray" };
    let values: number[] | null = null;
    for (const line of ops.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const op = parts.pop() ?? "";
        const nums = parts.filter((p) => /^[-+.\d]/.test(p)).map(Number);
        if (op === "g" || op === "G") {
            space = { kind: "gray" };
            values = nums;
        } else if (op === "rg" || op === "RG") {
            space = { kind: "rgb" };
            values = nums;
        } else if (op === "k" || op === "K") {
            space = { kind: "cmyk" };
            values = nums;
        } else if (op === "cs" || op === "CS") {
            const name = unescapeName(parts[0] ?? "");
            const direct = ["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern", "CalRGB", "CalGray"].includes(name);
            if (direct) space = resolveSpace(PDFName.of(name), context);
            else {
                const csDict = resources?.lookup(N("ColorSpace"));
                const entry = csDict instanceof PDFDict ? csDict.get(N(name)) : undefined;
                space = resolveSpace(entry ?? PDFName.of(name), context);
            }
            // The initial colour of a space: black, or full tint for separations.
            values = null;
        } else if (op === "sc" || op === "scn" || op === "SC" || op === "SCN") {
            values = nums;
            if (parts.some((p) => p.startsWith("/")) && !nums.length) space = { kind: "pattern" };
        }
    }
    let rgb: [number, number, number] | null;
    if (space.kind === "pattern" || space.kind === "none") rgb = null;
    else if (values === null)
        rgb = space.kind === "sep" ? toRgb(space, space.n > 1 ? new Array(space.n).fill(1) : [1]) : space.kind === "cmyk" ? [0, 0, 0] : [0, 0, 0];
    else rgb = toRgb(space, values);
    const hex = rgb ? rgbHex(rgb[0], rgb[1], rgb[2]) : null;
    cache.set(ops, hex);
    return hex;
};
