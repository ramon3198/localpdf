/**
 * Built-in PDF encodings (ISO 32000-1 Annex D) and a glyph-name → Unicode table for the Latin
 * repertoire. Used to decode/encode simple (single-byte) fonts that lack a usable ToUnicode CMap
 * and to look up Standard-14 AFM widths by glyph name.
 */
import { Encodings } from "@pdf-lib/standard-fonts";

export type EncodingTable = (string | undefined)[];

const asciiCore = (q39: string, q96: string): EncodingTable => {
    const t: EncodingTable = new Array(256);
    const names =
        "space exclam quotedbl numbersign dollar percent ampersand Q39 parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore Q96 a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde".split(
            " ",
        );
    names.forEach((n, i) => (t[32 + i] = n === "Q39" ? q39 : n === "Q96" ? q96 : n));
    return t;
};

export const STANDARD_ENCODING: EncodingTable = (() => {
    const t = asciiCore("quoteright", "quoteleft");
    const hi: Record<number, string> = {
        161: "exclamdown",
        162: "cent",
        163: "sterling",
        164: "fraction",
        165: "yen",
        166: "florin",
        167: "section",
        168: "currency",
        169: "quotesingle",
        170: "quotedblleft",
        171: "guillemotleft",
        172: "guilsinglleft",
        173: "guilsinglright",
        174: "fi",
        175: "fl",
        177: "endash",
        178: "dagger",
        179: "daggerdbl",
        180: "periodcentered",
        182: "paragraph",
        183: "bullet",
        184: "quotesinglbase",
        185: "quotedblbase",
        186: "quotedblright",
        187: "guillemotright",
        188: "ellipsis",
        189: "perthousand",
        191: "questiondown",
        193: "grave",
        194: "acute",
        195: "circumflex",
        196: "tilde",
        197: "macron",
        198: "breve",
        199: "dotaccent",
        200: "dieresis",
        202: "ring",
        203: "cedilla",
        205: "hungarumlaut",
        206: "ogonek",
        207: "caron",
        208: "emdash",
        225: "AE",
        227: "ordfeminine",
        232: "Lslash",
        233: "Oslash",
        234: "OE",
        235: "ordmasculine",
        241: "ae",
        245: "dotlessi",
        248: "lslash",
        249: "oslash",
        250: "oe",
        251: "germandbls",
    };
    for (const [k, v] of Object.entries(hi)) t[Number(k)] = v;
    return t;
})();

export const MAC_ROMAN_ENCODING: EncodingTable = (() => {
    const t = asciiCore("quotesingle", "grave");
    const hi =
        "Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron".split(
            " ",
        );
    hi.forEach((n, i) => (t[128 + i] = n));
    return t;
})();

type StdEncoding = { unicodeMappings: Record<string, [number, string]> };
const tableFrom = (enc: StdEncoding): EncodingTable => {
    const t: EncodingTable = new Array(256);
    for (const [, [code, glyph]] of Object.entries(enc.unicodeMappings)) if (t[code] === undefined) t[code] = glyph;
    return t;
};

export const WIN_ANSI_ENCODING: EncodingTable = tableFrom(Encodings.WinAnsi as unknown as StdEncoding);
export const SYMBOL_ENCODING: EncodingTable = tableFrom(Encodings.Symbol as unknown as StdEncoding);
export const ZAPF_DINGBATS_ENCODING: EncodingTable = tableFrom(Encodings.ZapfDingbats as unknown as StdEncoding);

export const encodingByName = (n: string | undefined): EncodingTable | null => {
    switch (n) {
        case "WinAnsiEncoding":
            return WIN_ANSI_ENCODING;
        case "MacRomanEncoding":
            return MAC_ROMAN_ENCODING;
        case "StandardEncoding":
            return STANDARD_ENCODING;
        case "MacExpertEncoding":
            return null;
        default:
            return null;
    }
};

// ── Glyph name → Unicode ─────────────────────────────────────────────────────────────────────────

const GLYPH_TO_UNICODE: Map<string, string> = (() => {
    const m = new Map<string, string>();
    for (const enc of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats] as unknown as StdEncoding[]) {
        for (const [cp, [, glyph]] of Object.entries(enc.unicodeMappings)) if (!m.has(glyph)) m.set(glyph, String.fromCodePoint(Number(cp)));
    }
    const extra: Record<string, number> = {
        fi: 0xfb01,
        fl: 0xfb02,
        ff: 0xfb00,
        ffi: 0xfb03,
        ffl: 0xfb04,
        dotlessi: 0x131,
        dotlessj: 0x237,
        Lslash: 0x141,
        lslash: 0x142,
        fraction: 0x2044,
        hungarumlaut: 0x2dd,
        ogonek: 0x2db,
        caron: 0x2c7,
        breve: 0x2d8,
        dotaccent: 0x2d9,
        ring: 0x2da,
        minus: 0x2212,
        nbspace: 0xa0,
        nonbreakingspace: 0xa0,
        sfthyphen: 0xad,
        softhyphen: 0xad,
        notequal: 0x2260,
        infinity: 0x221e,
        lessequal: 0x2264,
        greaterequal: 0x2265,
        partialdiff: 0x2202,
        summation: 0x2211,
        product: 0x220f,
        pi: 0x3c0,
        integral: 0x222b,
        Omega: 0x2126,
        radical: 0x221a,
        approxequal: 0x2248,
        Delta: 0x2206,
        lozenge: 0x25ca,
        Euro: 0x20ac,
        euro: 0x20ac,
        apple: 0xf8ff,
        Abreve: 0x102,
        abreve: 0x103,
        Aogonek: 0x104,
        aogonek: 0x105,
        Cacute: 0x106,
        cacute: 0x107,
        Ccaron: 0x10c,
        ccaron: 0x10d,
        Dcaron: 0x10e,
        dcaron: 0x10f,
        Dcroat: 0x110,
        dcroat: 0x111,
        Ecaron: 0x11a,
        ecaron: 0x11b,
        Eogonek: 0x118,
        eogonek: 0x119,
        Edotaccent: 0x116,
        edotaccent: 0x117,
        Gbreve: 0x11e,
        gbreve: 0x11f,
        Idotaccent: 0x130,
        Lacute: 0x139,
        lacute: 0x13a,
        Lcaron: 0x13d,
        lcaron: 0x13e,
        Nacute: 0x143,
        nacute: 0x144,
        Ncaron: 0x147,
        ncaron: 0x148,
        Ohungarumlaut: 0x150,
        ohungarumlaut: 0x151,
        Racute: 0x154,
        racute: 0x155,
        Rcaron: 0x158,
        rcaron: 0x159,
        Sacute: 0x15a,
        sacute: 0x15b,
        Scedilla: 0x15e,
        scedilla: 0x15f,
        Scommaaccent: 0x218,
        scommaaccent: 0x219,
        Tcaron: 0x164,
        tcaron: 0x165,
        Tcommaaccent: 0x21a,
        tcommaaccent: 0x21b,
        Uhungarumlaut: 0x170,
        uhungarumlaut: 0x171,
        Uring: 0x16e,
        uring: 0x16f,
        Zacute: 0x179,
        zacute: 0x17a,
        Zdotaccent: 0x17b,
        zdotaccent: 0x17c,
        Amacron: 0x100,
        amacron: 0x101,
        Emacron: 0x112,
        emacron: 0x113,
        Imacron: 0x12a,
        imacron: 0x12b,
        Omacron: 0x14c,
        omacron: 0x14d,
        Umacron: 0x16a,
        umacron: 0x16b,
        Iogonek: 0x12e,
        iogonek: 0x12f,
        Uogonek: 0x172,
        uogonek: 0x173,
        Gcommaaccent: 0x122,
        gcommaaccent: 0x123,
        Kcommaaccent: 0x136,
        kcommaaccent: 0x137,
        Lcommaaccent: 0x13b,
        lcommaaccent: 0x13c,
        Ncommaaccent: 0x145,
        ncommaaccent: 0x146,
        Rcommaaccent: 0x156,
        rcommaaccent: 0x157,
        commaaccent: 0xf6c3,
        overscore: 0xaf,
        middot: 0xb7,
        mu1: 0xb5,
        Ohm: 0x2126,
        periodcentered: 0xb7,
        bullet: 0x2022,
        figuredash: 0x2012,
        quotereversed: 0x201b,
    };
    for (const [k, v] of Object.entries(extra)) if (!m.has(k)) m.set(k, String.fromCodePoint(v));
    return m;
})();

/** Resolve a glyph name to Unicode following the Adobe Glyph List conventions. */
export const glyphNameToUnicode = (glyph: string | undefined): string | null => {
    if (!glyph) return null;
    const direct = GLYPH_TO_UNICODE.get(glyph);
    if (direct) return direct;
    // uniXXXX[XXXX...] — sequence of 4-hex-digit code units.
    let m = glyph.match(/^uni((?:[0-9A-Fa-f]{4})+)$/);
    if (m) {
        const cps: number[] = [];
        for (let i = 0; i < m[1].length; i += 4) cps.push(parseInt(m[1].slice(i, i + 4), 16));
        return String.fromCharCode(...cps);
    }
    m = glyph.match(/^u([0-9A-Fa-f]{4,6})$/);
    if (m) {
        const cp = parseInt(m[1], 16);
        if (cp <= 0x10ffff) return String.fromCodePoint(cp);
    }
    // Suffixed variants ("a.sc", "one.oldstyle") and ligatures ("f_f_i").
    const dot = glyph.indexOf(".");
    if (dot > 0) return glyphNameToUnicode(glyph.slice(0, dot));
    if (glyph.includes("_")) {
        const parts = glyph.split("_").map(glyphNameToUnicode);
        if (parts.every(Boolean)) return parts.join("");
    }
    // Single ASCII letter/digit names are handled above; "gXX"/"cidXX" have no Unicode meaning.
    return null;
};

/** Reverse map for one encoding table: Unicode char → code. */
export const reverseEncoding = (table: EncodingTable): Map<string, number> => {
    const m = new Map<string, number>();
    for (let code = 0; code < 256; code++) {
        const u = glyphNameToUnicode(table[code]);
        if (u && !m.has(u)) m.set(u, code);
    }
    return m;
};
