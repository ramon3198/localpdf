/**
 * Minimal CMap parser (Adobe TN #5014 / ISO 32000-1 §9.7.5, §9.10.3) covering what real PDFs use:
 *  - codespace ranges (to split a string into character codes of 1–4 bytes)
 *  - bfchar / bfrange   → Unicode (ToUnicode CMaps)
 *  - cidchar / cidrange → CID       (embedded encoding CMaps of Type0 fonts)
 */
import { type Operand, parseContentStream } from "./content-lexer";

export type CodespaceRange = { bytes: number; lo: number; hi: number };

export type ParsedCMap = {
    codespace: CodespaceRange[];
    /** code → Unicode string (ToUnicode). */
    toUnicode: Map<number, string>;
    /** code → CID (encoding CMaps). */
    toCid: Map<number, number>;
    cidRanges: { lo: number; hi: number; cid: number; bytes: number }[];
    wmode: number;
    usecmap: string | null;
};

const bytesToNum = (b: Uint8Array) => {
    let v = 0;
    for (let i = 0; i < b.length; i++) v = v * 256 + b[i];
    return v;
};

const utf16be = (b: Uint8Array): string => {
    // ToUnicode destinations are UTF-16BE; a single byte is tolerated as Latin-1.
    if (b.length === 1) return String.fromCharCode(b[0]);
    const units: number[] = [];
    for (let i = 0; i + 1 < b.length; i += 2) units.push((b[i] << 8) | b[i + 1]);
    return String.fromCharCode(...units);
};

export const parseCMap = (bytes: Uint8Array): ParsedCMap => {
    const out: ParsedCMap = { codespace: [], toUnicode: new Map(), toCid: new Map(), cidRanges: [], wmode: 0, usecmap: null };
    const ops = parseContentStream(bytes);
    for (const op of ops) {
        const a = op.args;
        switch (op.op) {
            case "endcodespacerange":
                for (let i = 0; i + 1 < a.length; i += 2) {
                    const lo = a[i];
                    const hi = a[i + 1];
                    if (lo.t === "str" && hi.t === "str") out.codespace.push({ bytes: lo.bytes.length, lo: bytesToNum(lo.bytes), hi: bytesToNum(hi.bytes) });
                }
                break;
            case "endbfchar":
                for (let i = 0; i + 1 < a.length; i += 2) {
                    const src = a[i];
                    const dst = a[i + 1];
                    if (src.t !== "str") continue;
                    if (dst.t === "str") out.toUnicode.set(bytesToNum(src.bytes), utf16be(dst.bytes));
                    else if (dst.t === "name") out.toUnicode.set(bytesToNum(src.bytes), dst.v);
                }
                break;
            case "endbfrange":
                for (let i = 0; i + 2 < a.length; i += 3) {
                    const lo = a[i];
                    const hi = a[i + 1];
                    const dst = a[i + 2];
                    if (lo.t !== "str" || hi.t !== "str") continue;
                    const l = bytesToNum(lo.bytes);
                    const h = bytesToNum(hi.bytes);
                    if (h < l || h - l > 0xffff) continue;
                    if (dst.t === "str") {
                        const base = utf16be(dst.bytes);
                        const units = Array.from(base, (ch) => ch.charCodeAt(0));
                        // Increment the LAST code unit for each successive code.
                        for (let c = l; c <= h; c++) {
                            const u = units.slice();
                            u[u.length - 1] = (u[u.length - 1] + (c - l)) & 0xffff;
                            out.toUnicode.set(c, String.fromCharCode(...u));
                        }
                    } else if (dst.t === "arr") {
                        dst.items.forEach((it: Operand, k) => {
                            if (it.t === "str" && l + k <= h) out.toUnicode.set(l + k, utf16be(it.bytes));
                        });
                    }
                }
                break;
            case "endcidchar":
                for (let i = 0; i + 1 < a.length; i += 2) {
                    const src = a[i];
                    const cid = a[i + 1];
                    if (src.t === "str" && cid.t === "num") out.toCid.set(bytesToNum(src.bytes), cid.v);
                }
                break;
            case "endcidrange":
                for (let i = 0; i + 2 < a.length; i += 3) {
                    const lo = a[i];
                    const hi = a[i + 1];
                    const cid = a[i + 2];
                    if (lo.t === "str" && hi.t === "str" && cid.t === "num")
                        out.cidRanges.push({ lo: bytesToNum(lo.bytes), hi: bytesToNum(hi.bytes), cid: cid.v, bytes: lo.bytes.length });
                }
                break;
            case "usecmap":
                if (a[0]?.t === "name") out.usecmap = a[0].v;
                break;
            case "def":
                if (a.length >= 2 && a[0].t === "name" && a[0].v === "WMode" && a[1].t === "num") out.wmode = a[1].v;
                break;
        }
    }
    return out;
};

/** Split a byte string into character codes using codespace ranges (falls back to `defaultBytes`). */
export const splitCodes = (bytes: Uint8Array, codespace: CodespaceRange[], defaultBytes: number): { code: number; start: number; len: number }[] => {
    const res: { code: number; start: number; len: number }[] = [];
    let i = 0;
    while (i < bytes.length) {
        let matched = 0;
        if (codespace.length) {
            for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
                let v = 0;
                for (let k = 0; k < n; k++) v = v * 256 + bytes[i + k];
                if (codespace.some((r) => r.bytes === n && v >= r.lo && v <= r.hi)) {
                    matched = n;
                    break;
                }
            }
        }
        const n = matched || Math.min(defaultBytes, bytes.length - i);
        let v = 0;
        for (let k = 0; k < n; k++) v = v * 256 + bytes[i + k];
        res.push({ code: v, start: i, len: n });
        i += n;
    }
    return res;
};

export const lookupCid = (cmap: ParsedCMap, code: number): number | null => {
    const direct = cmap.toCid.get(code);
    if (direct !== undefined) return direct;
    for (const r of cmap.cidRanges) if (code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
    return null;
};
