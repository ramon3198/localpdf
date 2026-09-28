/**
 * Tokenizer/parser for PDF content streams (ISO 32000-1 §7.2, §8.9.7).
 *
 * Produces a flat list of operators with their operands AND the byte range they occupied in the
 * source, so a rewriter can re-emit untouched operators verbatim and only re-serialize the ones it
 * changes. Handles literal/hex strings, names with #xx escapes, arrays, dictionaries (marked-content
 * properties), comments and inline images (BI … ID <binary> EI).
 */

export type Operand =
    | { t: "num"; v: number }
    | { t: "name"; v: string }
    | { t: "str"; bytes: Uint8Array; hex: boolean }
    | { t: "arr"; items: Operand[] }
    | { t: "dict"; entries: [string, Operand][] }
    | { t: "bool"; v: boolean }
    | { t: "null" };

export type ContentOp = {
    op: string;
    args: Operand[];
    /** Byte offset of the first operand (or the operator when it has none). */
    start: number;
    /** Byte offset just past the operator keyword (or the EI of an inline image). */
    end: number;
};

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);
const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

type Tok =
    | { k: "operand"; v: Operand; start: number }
    | { k: "op"; v: string; start: number; end: number }
    | { k: "arrOpen"; start: number }
    | { k: "arrClose" }
    | { k: "dictOpen"; start: number }
    | { k: "dictClose" }
    | { k: "eof" };

class Lexer {
    pos = 0;
    constructor(readonly b: Uint8Array) {}

    skipWhiteAndComments() {
        const b = this.b;
        while (this.pos < b.length) {
            const c = b[this.pos];
            if (isWhite(c)) {
                this.pos++;
            } else if (c === 0x25) {
                while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
            } else break;
        }
    }

    next(): Tok {
        this.skipWhiteAndComments();
        const b = this.b;
        if (this.pos >= b.length) return { k: "eof" };
        const start = this.pos;
        const c = b[this.pos];
        if (c === 0x28) return { k: "operand", v: this.readLiteralString(), start };
        if (c === 0x3c) {
            if (b[this.pos + 1] === 0x3c) {
                this.pos += 2;
                return { k: "dictOpen", start };
            }
            return { k: "operand", v: this.readHexString(), start };
        }
        if (c === 0x3e) {
            // ">>" closes a dict; a stray ">" is skipped.
            this.pos += b[this.pos + 1] === 0x3e ? 2 : 1;
            return { k: "dictClose" };
        }
        if (c === 0x5b) {
            this.pos++;
            return { k: "arrOpen", start };
        }
        if (c === 0x5d) {
            this.pos++;
            return { k: "arrClose" };
        }
        if (c === 0x7b || c === 0x7d || c === 0x29) {
            // PostScript procedure braces / stray ")" — not meaningful in content streams; skip.
            this.pos++;
            return this.next();
        }
        if (c === 0x2f) return { k: "operand", v: this.readName(), start };
        // Regular token: number or keyword.
        let end = this.pos;
        while (end < b.length && isRegular(b[end])) end++;
        const text = latin1(b, this.pos, end);
        this.pos = end;
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return { k: "operand", v: { t: "num", v: parseFloat(text) }, start };
        if (/^[+-]{2,}\d/.test(text) || /^[+-]?\d+\.\d*[+-]?\d*$/.test(text)) {
            // Malformed numbers seen in the wild ("--5", "1.2-3"): keep the leading numeric part.
            const m = text.replace(/^[+-]+/, (s) => (s.split("").filter((x) => x === "-").length % 2 ? "-" : "")).match(/^[+-]?(\d+\.?\d*|\.\d+)/);
            if (m) return { k: "operand", v: { t: "num", v: parseFloat(m[0]) }, start };
        }
        if (text === "true") return { k: "operand", v: { t: "bool", v: true }, start };
        if (text === "false") return { k: "operand", v: { t: "bool", v: false }, start };
        if (text === "null") return { k: "operand", v: { t: "null" }, start };
        return { k: "op", v: text, start, end };
    }

    readName(): Operand {
        const b = this.b;
        this.pos++; // "/"
        const out: number[] = [];
        while (this.pos < b.length && isRegular(b[this.pos])) {
            const c = b[this.pos];
            if (c === 0x23 && hexVal(b[this.pos + 1]) >= 0 && hexVal(b[this.pos + 2]) >= 0) {
                out.push(hexVal(b[this.pos + 1]) * 16 + hexVal(b[this.pos + 2]));
                this.pos += 3;
            } else {
                out.push(c);
                this.pos++;
            }
        }
        return { t: "name", v: String.fromCharCode(...out) };
    }

    readHexString(): Operand {
        const b = this.b;
        this.pos++; // "<"
        const out: number[] = [];
        let hi = -1;
        while (this.pos < b.length && b[this.pos] !== 0x3e) {
            const v = hexVal(b[this.pos++]);
            if (v < 0) continue;
            if (hi < 0) hi = v;
            else {
                out.push(hi * 16 + v);
                hi = -1;
            }
        }
        if (hi >= 0) out.push(hi * 16);
        this.pos++; // ">"
        return { t: "str", bytes: Uint8Array.from(out), hex: true };
    }

    readLiteralString(): Operand {
        const b = this.b;
        this.pos++; // "("
        const out: number[] = [];
        let depth = 1;
        while (this.pos < b.length) {
            let c = b[this.pos++];
            if (c === 0x5c) {
                c = b[this.pos++];
                switch (c) {
                    case 0x6e:
                        out.push(0x0a);
                        break; // \n
                    case 0x72:
                        out.push(0x0d);
                        break; // \r
                    case 0x74:
                        out.push(0x09);
                        break; // \t
                    case 0x62:
                        out.push(0x08);
                        break; // \b
                    case 0x66:
                        out.push(0x0c);
                        break; // \f
                    case 0x28:
                        out.push(0x28);
                        break;
                    case 0x29:
                        out.push(0x29);
                        break;
                    case 0x5c:
                        out.push(0x5c);
                        break;
                    case 0x0d:
                        if (b[this.pos] === 0x0a) this.pos++;
                        break; // line continuation
                    case 0x0a:
                        break;
                    default:
                        if (c >= 0x30 && c <= 0x37) {
                            let v = c - 0x30;
                            for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + (b[this.pos++] - 0x30);
                            out.push(v & 0xff);
                        } else if (c !== undefined) out.push(c);
                }
                continue;
            }
            if (c === 0x28) depth++;
            else if (c === 0x29) {
                depth--;
                if (depth === 0) break;
            } else if (c === 0x0d) {
                // EOL inside a string is normalised to LF.
                if (b[this.pos] === 0x0a) this.pos++;
                out.push(0x0a);
                continue;
            }
            out.push(c);
        }
        return { t: "str", bytes: Uint8Array.from(out), hex: false };
    }

    /** After an "ID" keyword: skip exactly one whitespace byte and scan binary data up to "EI". */
    skipInlineImageData(): number {
        const b = this.b;
        if (isWhite(b[this.pos])) this.pos++;
        let i = this.pos;
        while (i < b.length - 1) {
            if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === 0 || isWhite(b[i - 1])) && (i + 2 >= b.length || isWhite(b[i + 2]) || isDelim(b[i + 2]))) {
                // Guard against "EI" occurring inside binary data: the following bytes must look like ASCII.
                let ascii = true;
                for (let j = i + 2; j < Math.min(b.length, i + 12); j++) {
                    const c = b[j];
                    if (c > 0x7e || (c < 0x20 && !isWhite(c))) {
                        ascii = false;
                        break;
                    }
                }
                if (ascii) {
                    this.pos = i + 2;
                    return this.pos;
                }
            }
            i++;
        }
        this.pos = b.length;
        return this.pos;
    }
}

const latin1 = (b: Uint8Array, s: number, e: number) => {
    let out = "";
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
};

/** Parse a content stream into operators. Never throws on malformed input — best effort, like viewers. */
export const parseContentStream = (bytes: Uint8Array): ContentOp[] => {
    const lx = new Lexer(bytes);
    const ops: ContentOp[] = [];
    let stack: Operand[] = [];
    let stackStart = -1;
    // Nested containers being built (arrays / dicts).
    type Frame = { kind: "arr"; items: Operand[]; start: number } | { kind: "dict"; items: Operand[]; start: number };
    const frames: Frame[] = [];

    const pushOperand = (o: Operand, start: number) => {
        if (frames.length) frames[frames.length - 1].items.push(o);
        else {
            if (stack.length === 0) stackStart = start;
            stack.push(o);
        }
    };

    for (;;) {
        const t = lx.next();
        if (t.k === "eof") break;
        if (t.k === "operand") pushOperand(t.v, t.start);
        else if (t.k === "arrOpen") frames.push({ kind: "arr", items: [], start: t.start });
        else if (t.k === "dictOpen") frames.push({ kind: "dict", items: [], start: t.start });
        else if (t.k === "arrClose" || t.k === "dictClose") {
            const want = t.k === "arrClose" ? "arr" : "dict";
            const f = frames.pop();
            if (!f) continue;
            if (f.kind !== want) {
                // Mismatched close — best effort: treat as closing whatever was open.
            }
            let v: Operand;
            if (f.kind === "arr") v = { t: "arr", items: f.items };
            else {
                const entries: [string, Operand][] = [];
                for (let i = 0; i + 1 < f.items.length; i += 2) {
                    const k = f.items[i];
                    if (k.t === "name") entries.push([k.v, f.items[i + 1]]);
                }
                v = { t: "dict", entries };
            }
            pushOperand(v, f.start);
        } else if (t.k === "op") {
            if (frames.length) {
                // An operator inside an array/dict is malformed; flush the containers onto the stack.
                while (frames.length) {
                    const f = frames.pop()!;
                    pushOperand(f.kind === "arr" ? { t: "arr", items: f.items } : { t: "dict", entries: [] }, f.start);
                }
            }
            const start = stack.length ? stackStart : t.start;
            if (t.v === "BI") {
                // Inline image: gather everything up to and including EI as one opaque operator.
                for (;;) {
                    const u = lx.next();
                    if (u.k === "eof") break;
                    if (u.k === "op" && u.v === "ID") break;
                }
                const end = lx.skipInlineImageData();
                ops.push({ op: "BI", args: [], start, end });
            } else {
                ops.push({ op: t.v, args: stack, start, end: t.end });
            }
            stack = [];
            stackStart = -1;
        }
    }
    return ops;
};

// ── Serialization ────────────────────────────────────────────────────────────────────────────────

export const formatNumber = (v: number): string => {
    if (!Number.isFinite(v)) return "0";
    if (Number.isInteger(v)) return String(v);
    // 8 decimals: enough to round-trip values like 13.333333 exactly (no collateral change on restore).
    let s = v.toFixed(8);
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
};

const nameEscape = (s: string) => {
    let out = "/";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x21 || c > 0x7e || c === 0x23 || isDelim(c)) out += "#" + c.toString(16).padStart(2, "0");
        else out += s[i];
    }
    return out;
};

export const hexOf = (bytes: ArrayLike<number>) => {
    let s = "<";
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] & 0xff).toString(16).padStart(2, "0");
    return s + ">";
};

export const serializeOperand = (o: Operand): string => {
    switch (o.t) {
        case "num":
            return formatNumber(o.v);
        case "name":
            return nameEscape(o.v);
        case "str":
            return hexOf(o.bytes);
        case "arr":
            return "[" + o.items.map(serializeOperand).join(" ") + "]";
        case "dict":
            return "<<" + o.entries.map(([k, v]) => nameEscape(k) + " " + serializeOperand(v)).join(" ") + ">>";
        case "bool":
            return o.v ? "true" : "false";
        case "null":
            return "null";
    }
};

export const serializeOp = (op: string, args: Operand[]) => (args.length ? args.map(serializeOperand).join(" ") + " " : "") + op;

export const num = (v: number): Operand => ({ t: "num", v });
export const name = (v: string): Operand => ({ t: "name", v });
export const str = (bytes: ArrayLike<number>): Operand => ({ t: "str", bytes: Uint8Array.from(bytes as ArrayLike<number>), hex: true });

export const bytesFromLatin1 = (s: string) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};
