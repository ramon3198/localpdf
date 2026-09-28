// Baseline and progressive JPEG decoder (ITU T.81, Huffman coding, 8-bit precision) — used only when a JPEG from the
// PDF cannot go to Word as is: CMYK / YCCK images, images with masks, or pictures that must be cropped, flipped or
// rotated. Output samples are interleaved and colour-transformed (YCbCr → RGB, YCCK → CMYK) as the DCTDecode filter
// defines; PDF Decode arrays and colour spaces are applied by the caller.

export type JpegPixels = { width: number; height: number; components: number; data: Uint8Array; adobe: boolean };

const ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
    22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Size and component count from the frame header, without decoding. */
export const jpegInfo = (b: Uint8Array): { width: number; height: number; components: number; progressive: boolean } | null => {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let pos = 2;
    while (pos + 4 <= b.length) {
        if (b[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = b[pos + 1];
        if (marker === 0xff) {
            pos++;
            continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            pos += 2;
            continue;
        }
        const len = (b[pos + 2] << 8) | b[pos + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (pos + 9 >= b.length) return null;
            const height = (b[pos + 5] << 8) | b[pos + 6];
            const width = (b[pos + 7] << 8) | b[pos + 8];
            const components = b[pos + 9];
            return { width, height, components, progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce };
        }
        if (marker === 0xd9 || marker === 0xda) return null;
        pos += 2 + len;
    }
    return null;
};

type Huffman = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };

const buildHuffman = (counts: Uint8Array, values: Uint8Array): Huffman => {
    const maxcode = new Int32Array(18).fill(-1);
    const valptr = new Int32Array(17);
    const mincode = new Int32Array(17);
    let code = 0;
    let k = 0;
    for (let l = 1; l <= 16; l++) {
        const n = counts[l - 1];
        if (n) {
            valptr[l] = k;
            mincode[l] = code;
            code += n;
            k += n;
            maxcode[l] = code - 1;
        }
        code <<= 1;
    }
    maxcode[17] = 0x7fffffff;
    return { maxcode, valptr, mincode, values };
};

type Component = {
    id: number;
    h: number;
    v: number;
    tq: number;
    blocksPerLine: number;
    blocksPerColumn: number;
    stride: number;
    coefs: Int16Array;
    dc: Huffman | null;
    ac: Huffman | null;
    pred: number;
};

export const decodeJpeg = (data: Uint8Array, colorTransform?: number): JpegPixels | null => {
    try {
        return decode(data, colorTransform);
    } catch {
        return null;
    }
};

const decode = (b: Uint8Array, colorTransformParam?: number): JpegPixels | null => {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    const qts: Int32Array[] = [];
    const dcTables: Huffman[] = [];
    const acTables: Huffman[] = [];
    let width = 0;
    let height = 0;
    let progressive = false;
    let comps: Component[] = [];
    let mcusPerLine = 0;
    let mcusPerColumn = 0;
    let hmax = 1;
    let vmax = 1;
    let resetInterval = 0;
    let adobe: { transform: number } | null = null;
    let jfif = false;
    let pos = 2;

    const u16 = (p: number) => (b[p] << 8) | b[p + 1];

    // Entropy-coded data reader.
    let bitBuf = 0;
    let bitCnt = 0;
    let dataPos = 0;
    const readBit = (): number => {
        if (bitCnt === 0) {
            if (dataPos >= b.length) return 0;
            const byte = b[dataPos];
            if (byte === 0xff) {
                const next = b[dataPos + 1];
                if (next === 0) {
                    dataPos += 2;
                } else if (next === 0xff) {
                    // Fill bytes before a marker.
                    dataPos++;
                    return readBit();
                } else {
                    // A marker: no more data in this interval.
                    return 0;
                }
            } else dataPos++;
            bitBuf = byte;
            bitCnt = 8;
        }
        bitCnt--;
        return (bitBuf >> bitCnt) & 1;
    };
    const receive = (n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) | readBit();
        return v;
    };
    const receiveExtend = (n: number) => {
        if (n === 0) return 0;
        if (n === 1) return readBit() ? 1 : -1;
        const v = receive(n);
        return v >= 1 << (n - 1) ? v : v - (1 << n) + 1;
    };
    const decodeHuff = (t: Huffman | null): number => {
        if (!t) return 0;
        let code = 0;
        for (let l = 1; l <= 16; l++) {
            code = (code << 1) | readBit();
            if (code <= t.maxcode[l]) return t.values[t.valptr[l] + code - t.mincode[l]];
        }
        return 0;
    };

    let eobrun = 0;
    let acState = 0;
    let acNext = 0;

    const decodeScan = (scomps: Component[], ss: number, se: number, ah: number, al: number) => {
        const baseline = (c: Component, off: number) => {
            const t = decodeHuff(c.dc);
            c.pred += t === 0 ? 0 : receiveExtend(t);
            c.coefs[off] = c.pred;
            let k = 1;
            while (k < 64) {
                const rs = decodeHuff(c.ac);
                const s = rs & 15;
                const r = rs >> 4;
                if (s === 0) {
                    if (r < 15) break;
                    k += 16;
                    continue;
                }
                k += r;
                if (k > 63) break;
                c.coefs[off + ZIGZAG[k]] = receiveExtend(s);
                k++;
            }
        };
        const dcFirst = (c: Component, off: number) => {
            const t = decodeHuff(c.dc);
            c.pred += t === 0 ? 0 : receiveExtend(t) * (1 << al);
            c.coefs[off] = c.pred;
        };
        const dcSuccessive = (c: Component, off: number) => {
            if (readBit()) c.coefs[off] |= 1 << al;
        };
        const acFirst = (c: Component, off: number) => {
            if (eobrun > 0) {
                eobrun--;
                return;
            }
            let k = ss;
            while (k <= se) {
                const rs = decodeHuff(c.ac);
                const s = rs & 15;
                const r = rs >> 4;
                if (s === 0) {
                    if (r < 15) {
                        eobrun = receive(r) + (1 << r) - 1;
                        break;
                    }
                    k += 16;
                    continue;
                }
                k += r;
                if (k > 63) break;
                c.coefs[off + ZIGZAG[k]] = receiveExtend(s) * (1 << al);
                k++;
            }
        };
        const acSuccessive = (c: Component, off: number) => {
            let k = ss;
            let r = 0;
            while (k <= se) {
                const z = off + ZIGZAG[k];
                const cur = c.coefs[z];
                const sign = cur < 0 ? -1 : 1;
                switch (acState) {
                    case 0: {
                        const rs = decodeHuff(c.ac);
                        const s = rs & 15;
                        r = rs >> 4;
                        if (s === 0) {
                            if (r < 15) {
                                eobrun = receive(r) + (1 << r);
                                acState = 4;
                            } else {
                                r = 16;
                                acState = 1;
                            }
                        } else {
                            acNext = receiveExtend(s);
                            acState = r ? 2 : 3;
                        }
                        continue;
                    }
                    case 1:
                    case 2:
                        if (cur) c.coefs[z] += sign * (readBit() << al);
                        else {
                            r--;
                            if (r === 0) acState = acState === 2 ? 3 : 0;
                        }
                        break;
                    case 3:
                        if (cur) c.coefs[z] += sign * (readBit() << al);
                        else {
                            c.coefs[z] = acNext << al;
                            acState = 0;
                        }
                        break;
                    case 4:
                        if (cur) c.coefs[z] += sign * (readBit() << al);
                        break;
                }
                k++;
            }
            if (acState === 4) {
                eobrun--;
                if (eobrun === 0) acState = 0;
            }
        };
        const fn = !progressive ? baseline : ss === 0 ? (ah === 0 ? dcFirst : dcSuccessive) : ah === 0 ? acFirst : acSuccessive;
        const single = scomps.length === 1;
        const total = single ? scomps[0].blocksPerLine * scomps[0].blocksPerColumn : mcusPerLine * mcusPerColumn;
        let mcu = 0;
        while (mcu < total) {
            for (const c of scomps) c.pred = 0;
            eobrun = 0;
            acState = 0;
            bitCnt = 0;
            const n = resetInterval ? Math.min(resetInterval, total - mcu) : total - mcu;
            for (let i = 0; i < n; i++, mcu++) {
                if (single) {
                    const c = scomps[0];
                    const row = Math.floor(mcu / c.blocksPerLine);
                    const col = mcu % c.blocksPerLine;
                    fn(c, 64 * (row * c.stride + col));
                } else {
                    const mrow = Math.floor(mcu / mcusPerLine);
                    const mcol = mcu % mcusPerLine;
                    for (const c of scomps)
                        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) fn(c, 64 * ((mrow * c.v + v) * c.stride + mcol * c.h + h));
                }
            }
            // Expect a restart marker (or the end of the scan).
            bitCnt = 0;
            while (dataPos + 1 < b.length && !(b[dataPos] === 0xff && b[dataPos + 1] !== 0 && b[dataPos + 1] !== 0xff)) dataPos++;
            if (dataPos + 1 < b.length && b[dataPos + 1] >= 0xd0 && b[dataPos + 1] <= 0xd7) dataPos += 2;
            else break;
        }
    };

    while (pos + 1 < b.length) {
        if (b[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = b[pos + 1];
        pos += 2;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
            if (marker === 0xff) pos--;
            continue;
        }
        if (marker === 0xd9) break;
        const len = u16(pos);
        const seg = pos + 2;
        const end = pos + len;
        switch (marker) {
            case 0xe0:
                if (b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46) jfif = true;
                break;
            case 0xee:
                if (b[seg] === 0x41 && b[seg + 1] === 0x64 && b[seg + 2] === 0x6f && b[seg + 3] === 0x62 && b[seg + 4] === 0x65)
                    adobe = { transform: b[seg + 11] ?? 0 };
                break;
            case 0xdb: {
                let p = seg;
                while (p < end) {
                    const pq = b[p] >> 4;
                    const tq = b[p] & 15;
                    p++;
                    const t = new Int32Array(64);
                    for (let j = 0; j < 64; j++) {
                        t[ZIGZAG[j]] = pq ? u16(p + 2 * j) : b[p + j];
                    }
                    p += pq ? 128 : 64;
                    qts[tq] = t;
                }
                break;
            }
            case 0xc4: {
                let p = seg;
                while (p < end) {
                    const tc = b[p] >> 4;
                    const th = b[p] & 15;
                    const counts = b.subarray(p + 1, p + 17);
                    let total = 0;
                    for (let i = 0; i < 16; i++) total += counts[i];
                    const values = b.slice(p + 17, p + 17 + total);
                    const table = buildHuffman(counts, values);
                    if (tc === 0) dcTables[th] = table;
                    else acTables[th] = table;
                    p += 17 + total;
                }
                break;
            }
            case 0xdd:
                resetInterval = u16(seg);
                break;
            case 0xc0:
            case 0xc1:
            case 0xc2: {
                if (b[seg] !== 8) return null;
                progressive = marker === 0xc2;
                height = u16(seg + 1);
                width = u16(seg + 3);
                const n = b[seg + 5];
                comps = [];
                for (let i = 0; i < n; i++) {
                    const p = seg + 6 + i * 3;
                    comps.push({
                        id: b[p],
                        h: Math.max(1, b[p + 1] >> 4),
                        v: Math.max(1, b[p + 1] & 15),
                        tq: b[p + 2],
                        blocksPerLine: 0,
                        blocksPerColumn: 0,
                        stride: 0,
                        coefs: new Int16Array(0),
                        dc: null,
                        ac: null,
                        pred: 0,
                    });
                }
                if (!width || !height || width * height > 40_000_000) return null;
                hmax = Math.max(...comps.map((c) => c.h));
                vmax = Math.max(...comps.map((c) => c.v));
                mcusPerLine = Math.ceil(width / (8 * hmax));
                mcusPerColumn = Math.ceil(height / (8 * vmax));
                for (const c of comps) {
                    c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
                    c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
                    c.stride = mcusPerLine * c.h;
                    c.coefs = new Int16Array(64 * c.stride * mcusPerColumn * c.v);
                }
                break;
            }
            case 0xc3:
            case 0xc5:
            case 0xc6:
            case 0xc7:
            case 0xc9:
            case 0xca:
            case 0xcb:
            case 0xcd:
            case 0xce:
            case 0xcf:
                // Lossless, hierarchical and arithmetic-coded JPEGs are not supported.
                return null;
            case 0xda: {
                const ns = b[seg];
                const scomps: Component[] = [];
                for (let i = 0; i < ns; i++) {
                    const id = b[seg + 1 + i * 2];
                    const t = b[seg + 2 + i * 2];
                    const c = comps.find((x) => x.id === id);
                    if (!c) return null;
                    c.dc = dcTables[t >> 4] ?? c.dc;
                    c.ac = acTables[t & 15] ?? c.ac;
                    scomps.push(c);
                }
                const p = seg + 1 + ns * 2;
                const ss = b[p];
                const se = b[p + 1];
                const ah = b[p + 2] >> 4;
                const al = b[p + 2] & 15;
                dataPos = end;
                bitCnt = 0;
                decodeScan(scomps, ss, se, ah, al);
                pos = dataPos;
                continue;
            }
        }
        pos = end;
    }
    if (!comps.length || !width || !height) return null;

    // Dequantise and inverse-DCT every block into per-component planes.
    const idct = new Float64Array(64);
    for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) idct[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    const planes: { w: number; h: number; data: Uint8Array; c: Component }[] = [];
    const tmp = new Float64Array(64);
    const blk = new Float64Array(64);
    for (const c of comps) {
        const qt = qts[c.tq] ?? new Int32Array(64).fill(1);
        const pw = c.blocksPerLine * 8;
        const ph = c.blocksPerColumn * 8;
        const plane = new Uint8Array(pw * ph);
        for (let br = 0; br < c.blocksPerColumn; br++)
            for (let bc = 0; bc < c.blocksPerLine; bc++) {
                const off = 64 * (br * c.stride + bc);
                for (let i = 0; i < 64; i++) blk[i] = c.coefs[off + i] * qt[i];
                // Rows: tmp[v][x] = Σu idct[x][u] · F[v][u].
                for (let v = 0; v < 8; v++)
                    for (let x = 0; x < 8; x++) {
                        let s = 0;
                        for (let u = 0; u < 8; u++) s += idct[x * 8 + u] * blk[v * 8 + u];
                        tmp[v * 8 + x] = s;
                    }
                // Columns: f[y][x] = Σv idct[y][v] · tmp[v][x].
                for (let y = 0; y < 8; y++)
                    for (let x = 0; x < 8; x++) {
                        let s = 0;
                        for (let v = 0; v < 8; v++) s += idct[y * 8 + v] * tmp[v * 8 + x];
                        const val = Math.round(s + 128);
                        plane[(br * 8 + y) * pw + bc * 8 + x] = val < 0 ? 0 : val > 255 ? 255 : val;
                    }
            }
        planes.push({ w: pw, h: ph, data: plane, c });
    }

    const n = comps.length;
    let transform: boolean;
    if (colorTransformParam === 0 || colorTransformParam === 1) transform = colorTransformParam === 1;
    else if (adobe) transform = adobe.transform !== 0;
    else if (n === 3) transform = jfif || !(comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42);
    else transform = false;

    const out = new Uint8Array(width * height * n);
    const xmap = planes.map((p) => {
        const m = new Int32Array(width);
        for (let x = 0; x < width; x++) m[x] = Math.min(p.w - 1, Math.floor((x * p.c.h) / hmax));
        return m;
    });
    for (let y = 0; y < height; y++) {
        const rows = planes.map((p) => Math.min(p.h - 1, Math.floor((y * p.c.v) / vmax)) * p.w);
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * n;
            for (let k = 0; k < n; k++) out[o + k] = planes[k].data[rows[k] + xmap[k][x]];
            if (transform && n >= 3) {
                const Y = out[o];
                const cb = out[o + 1] - 128;
                const cr = out[o + 2] - 128;
                const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
                const R = clamp(Y + 1.402 * cr);
                const G = clamp(Y - 0.344136 * cb - 0.714136 * cr);
                const B = clamp(Y + 1.772 * cb);
                if (n === 3) {
                    out[o] = R;
                    out[o + 1] = G;
                    out[o + 2] = B;
                } else {
                    // YCCK → CMYK: the YCC part carries inverted C, M, Y.
                    out[o] = 255 - R;
                    out[o + 1] = 255 - G;
                    out[o + 2] = 255 - B;
                }
            }
        }
    }
    return { width, height, components: n, data: out, adobe: !!adobe };
};
