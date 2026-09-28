// Baseline JPEG encoder (ITU T.81 Annex K tables, YCbCr 4:2:0) — for photographic pictures that had to be decoded
// (rotated, flipped, cropped or CMYK JPEGs, large photos stored losslessly): as PNG they would make the .docx many
// times bigger than the PDF.
import type { Raster } from "./graphics-image";

const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
    22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// Annex K.1 quantisation tables (natural order).
const LUMA_Q = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
    103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Annex K.3 Huffman tables: code counts per length (1..16) and symbols.
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
    0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
    0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
    0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
    0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
    0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
    0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

type Code = { code: Int32Array; size: Int32Array };

/** Canonical codes (§C.2) for a table given as counts per length and symbols. */
const codes = (bits: number[], values: number[]): Code => {
    const code = new Int32Array(256);
    const size = new Int32Array(256);
    let c = 0;
    let k = 0;
    for (let l = 1; l <= 16; l++) {
        for (let i = 0; i < bits[l - 1]; i++) {
            code[values[k]] = c;
            size[values[k]] = l;
            k++;
            c++;
        }
        c <<= 1;
    }
    return { code, size };
};

const scaledTable = (base: number[], quality: number) => {
    const q = Math.max(1, Math.min(100, Math.round(quality)));
    const scale = q < 50 ? 5000 / q : 200 - 2 * q;
    return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
};

class Writer {
    private buf: Uint8Array;
    len = 0;
    private acc = 0;
    private bits = 0;
    constructor(size: number) {
        this.buf = new Uint8Array(Math.max(1024, size));
    }
    private ensure(n: number) {
        if (this.len + n <= this.buf.length) return;
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    byte(b: number) {
        this.ensure(1);
        this.buf[this.len++] = b & 0xff;
    }
    word(w: number) {
        this.byte(w >> 8);
        this.byte(w);
    }
    bytes(a: ArrayLike<number>) {
        for (let i = 0; i < a.length; i++) this.byte(a[i]);
    }
    /** Entropy-coded bits, with 0xFF byte stuffing. */
    put(value: number, size: number) {
        for (let i = size - 1; i >= 0; i--) {
            this.acc = (this.acc << 1) | ((value >> i) & 1);
            if (++this.bits === 8) {
                this.byte(this.acc);
                if (this.acc === 0xff) this.byte(0);
                this.acc = 0;
                this.bits = 0;
            }
        }
    }
    flushBits() {
        if (this.bits > 0) this.put((1 << (8 - this.bits)) - 1, 8 - this.bits);
    }
    result() {
        return this.buf.slice(0, this.len);
    }
}

const COS = (() => {
    const t = new Float64Array(64);
    for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[u * 8 + x] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    return t;
})();

/** Forward DCT of an 8×8 block (level-shifted samples) into `out` (natural order). */
const fdct = (block: Float64Array, out: Float64Array, tmp: Float64Array) => {
    for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
            tmp[y * 8 + u] = s;
        }
    for (let v = 0; v < 8; v++)
        for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
            out[v * 8 + u] = s;
        }
};

const magnitude = (v: number) => {
    let n = 0;
    let a = Math.abs(v);
    while (a) {
        n++;
        a >>= 1;
    }
    return n;
};

/** Encodes opaque pixels (alpha ignored) as a baseline JFIF JPEG. */
export const encodeJpeg = (r: Raster, quality = 90): Uint8Array => {
    const { width: W, height: H, rgba } = r;
    const lq = scaledTable(LUMA_Q, quality);
    const cq = scaledTable(CHROMA_Q, quality);
    const dcL = codes(DC_LUMA_BITS, DC_VALUES);
    const dcC = codes(DC_CHROMA_BITS, DC_VALUES);
    const acL = codes(AC_LUMA_BITS, AC_LUMA_VALUES);
    const acC = codes(AC_CHROMA_BITS, AC_CHROMA_VALUES);
    const w = new Writer(W * H);
    w.word(0xffd8);
    // APP0 JFIF.
    w.word(0xffe0);
    w.word(16);
    w.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    // DQT.
    for (const [id, t] of [
        [0, lq],
        [1, cq],
    ] as [number, number[]][]) {
        w.word(0xffdb);
        w.word(67);
        w.byte(id);
        for (let k = 0; k < 64; k++) w.byte(t[ZIGZAG[k]]);
    }
    // SOF0: 3 components, Y 2×2, Cb and Cr 1×1.
    w.word(0xffc0);
    w.word(17);
    w.byte(8);
    w.word(H);
    w.word(W);
    w.byte(3);
    w.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    // DHT.
    for (const [cls, bits, values] of [
        [0x00, DC_LUMA_BITS, DC_VALUES],
        [0x10, AC_LUMA_BITS, AC_LUMA_VALUES],
        [0x01, DC_CHROMA_BITS, DC_VALUES],
        [0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES],
    ] as [number, number[], number[]][]) {
        w.word(0xffc4);
        w.word(3 + 16 + values.length);
        w.byte(cls);
        w.bytes(bits);
        w.bytes(values);
    }
    // SOS.
    w.word(0xffda);
    w.word(12);
    w.byte(3);
    w.bytes([1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    const block = new Float64Array(64);
    const coef = new Float64Array(64);
    const tmp = new Float64Array(64);
    const preds = [0, 0, 0];
    const encodeBlock = (comp: number, qt: number[], dc: Code, ac: Code) => {
        fdct(block, coef, tmp);
        const q = new Int32Array(64);
        for (let k = 0; k < 64; k++) {
            const i = ZIGZAG[k];
            q[k] = Math.round(coef[i] / qt[i]);
        }
        const diff = q[0] - preds[comp];
        preds[comp] = q[0];
        const ds = magnitude(diff);
        w.put(dc.code[ds], dc.size[ds]);
        if (ds) w.put(diff < 0 ? diff + (1 << ds) - 1 : diff, ds);
        let run = 0;
        for (let k = 1; k < 64; k++) {
            const v = q[k];
            if (v === 0) {
                run++;
                continue;
            }
            while (run > 15) {
                w.put(ac.code[0xf0], ac.size[0xf0]);
                run -= 16;
            }
            const s = magnitude(v);
            const sym = (run << 4) | s;
            w.put(ac.code[sym], ac.size[sym]);
            w.put(v < 0 ? v + (1 << s) - 1 : v, s);
            run = 0;
        }
        if (run > 0) w.put(ac.code[0], ac.size[0]);
    };
    const px = (x: number, y: number) => ((y < H ? y : H - 1) * W + (x < W ? x : W - 1)) * 4;
    const Y = (o: number) => 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    for (let my = 0; my < H; my += 16)
        for (let mx = 0; mx < W; mx += 16) {
            for (let by = 0; by < 2; by++)
                for (let bx = 0; bx < 2; bx++) {
                    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = Y(px(mx + bx * 8 + x, my + by * 8 + y)) - 128;
                    encodeBlock(0, lq, dcL, acL);
                }
            for (const [comp, fr, fg, fb] of [
                [1, -0.168736, -0.331264, 0.5],
                [2, 0.5, -0.418688, -0.081312],
            ]) {
                for (let y = 0; y < 8; y++)
                    for (let x = 0; x < 8; x++) {
                        // Average of the 2×2 pixels this chroma sample covers.
                        let s = 0;
                        for (let dy = 0; dy < 2; dy++)
                            for (let dx = 0; dx < 2; dx++) {
                                const o = px(mx + 2 * x + dx, my + 2 * y + dy);
                                s += fr * rgba[o] + fg * rgba[o + 1] + fb * rgba[o + 2];
                            }
                        block[y * 8 + x] = s / 4;
                    }
                encodeBlock(comp, cq, dcC, acC);
            }
        }
    w.flushBits();
    w.word(0xffd9);
    return w.result();
};
