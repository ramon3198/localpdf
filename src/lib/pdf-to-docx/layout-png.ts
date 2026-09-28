// A 2×2 PNG of one colour (optionally translucent), stretched by Word to draw a filled rectangle behind flowing text.
// Stored (uncompressed) deflate: no compression library needed, and the image is a few dozen bytes.
import type { Hex, PlacedImage, Rect } from "./types";

let crcTable: Uint32Array | null = null;
const crc32 = (bytes: Uint8Array) => {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes: Uint8Array) => {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
};

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const chunk = (type: string, data: number[]) => {
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    return [...u32(data.length), ...body, ...u32(crc32(body))];
};

const cache = new Map<string, Uint8Array>();

/** PNG bytes of a solid colour, `opacity` 0–1. */
export const solidPng = (color: Hex, opacity = 1): Uint8Array => {
    const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    const key = `${color}:${a}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const r = parseInt(color.slice(0, 2), 16) || 0;
    const g = parseInt(color.slice(2, 4), 16) || 0;
    const b = parseInt(color.slice(4, 6), 16) || 0;
    const size = 2;
    const raw: number[] = [];
    for (let y = 0; y < size; y++) {
        raw.push(0); // filter: none
        for (let x = 0; x < size; x++) raw.push(r, g, b, a);
    }
    const data = Uint8Array.from(raw);
    // zlib header, one final stored block, Adler-32.
    const zlib = [0x78, 0x01, 0x01, data.length & 0xff, data.length >> 8, ~data.length & 0xff, (~data.length >> 8) & 0xff, ...data, ...u32(adler32(data))];
    const ihdr = [...u32(size), ...u32(size), 8, 6, 0, 0, 0];
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", ihdr), ...chunk("IDAT", zlib), ...chunk("IEND", [])]);
    cache.set(key, png);
    return png;
};

/** A filled rectangle as an image placed over `box`. */
export const solidImage = (color: Hex, opacity: number, box: Rect): PlacedImage => ({
    box: { ...box },
    mime: "image/png",
    data: solidPng(color, opacity),
    pixelWidth: 2,
    pixelHeight: 2,
});
