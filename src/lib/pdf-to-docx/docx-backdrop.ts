// The picture behind a layout page (its graphics without the text), as pixels the writer can look at. Word draws a
// table's cell shading over the whole cell; the PDF may have drawn a band inset by the cell padding, or a rounded
// badge. Where Word's shading would visibly differ from the picture, the writer leaves the fill to the picture.
import * as UPNGModule from "@pdf-lib/upng";
import { hexColor } from "./docx-units";
import { decodeJpeg } from "./graphics-jpeg";
import type { PlacedImage, Rect } from "./types";

type UpngDecode = { decode: (buf: ArrayBuffer) => unknown; toRGBA8: (img: unknown) => ArrayBuffer[] };
const UPNG = ((UPNGModule as unknown as { default?: UpngDecode }).default ?? UPNGModule) as unknown as UpngDecode;

/** Page positions (points) → the picture's colour there. */
export type Backdrop = {
    /** Mean RGB of the pixels around (x, y), or undefined outside the picture. */
    rgb: (x: number, y: number) => [number, number, number] | undefined;
};

/** Channel difference below which two colours look the same on the page (JPEG noise, near-white tints). */
const SAME = 10;

const decodePixels = (image: PlacedImage): { width: number; height: number; channels: number; data: Uint8Array } | undefined => {
    try {
        if (image.mime === "image/png") {
            const bytes = image.data;
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const decoded = UPNG.decode(buf) as { width: number; height: number };
            const rgba = UPNG.toRGBA8(decoded)[0];
            return { width: decoded.width, height: decoded.height, channels: 4, data: new Uint8Array(rgba) };
        }
        const jpeg = decodeJpeg(image.data);
        if (!jpeg || (jpeg.components !== 3 && jpeg.components !== 1)) return undefined;
        return { width: jpeg.width, height: jpeg.height, channels: jpeg.components, data: jpeg.data };
    } catch {
        return undefined;
    }
};

export const backdropOf = (image: PlacedImage | undefined): Backdrop | undefined => {
    if (!image || image.box.width <= 0 || image.box.height <= 0) return undefined;
    const px = decodePixels(image);
    if (!px || px.width < 2 || px.height < 2 || px.data.length < px.width * px.height * px.channels) return undefined;
    const sx = px.width / image.box.width;
    const sy = px.height / image.box.height;
    return {
        rgb: (x, y) => {
            const cx = Math.round((x - image.box.x) * sx);
            const cy = Math.round((y - image.box.y) * sy);
            if (cx < 0 || cy < 0 || cx >= px.width || cy >= px.height) return undefined;
            const sum = [0, 0, 0];
            let n = 0;
            for (let j = Math.max(0, cy - 1); j <= Math.min(px.height - 1, cy + 1); j++)
                for (let i = Math.max(0, cx - 1); i <= Math.min(px.width - 1, cx + 1); i++) {
                    const at = (j * px.width + i) * px.channels;
                    for (let k = 0; k < 3; k++) sum[k] += px.data[at + (px.channels === 1 ? 0 : k)];
                    n++;
                }
            return [sum[0] / n, sum[1] / n, sum[2] / n];
        },
    };
};

const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];

/**
 * Whether Word's shading of `box` in `color` looks like the picture: the fill reaches the box's corners (just inside
 * its borders) and its middle. A band inset by the cell padding, a badge or a picture in the cell fail.
 */
export const shadingMatches = (backdrop: Backdrop, box: Rect, color: string): boolean => {
    const hex = hexColor(color);
    if (!hex) return false;
    const want = rgbOf(hex);
    const d = Math.min(2.5, box.width / 4, box.height / 4);
    const xs = [box.x + d, box.x + box.width / 2, box.x + box.width - d];
    const ys = [box.y + d, box.y + box.height / 2, box.y + box.height - d];
    for (const y of ys)
        for (const x of xs) {
            const got = backdrop.rgb(x, y);
            if (!got || got.some((v, k) => Math.abs(v - want[k]) > SAME)) return false;
        }
    return true;
};
