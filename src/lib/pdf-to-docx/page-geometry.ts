import type { PDFPage } from "pdf-lib";
import { type Matrix, applyPt, mul } from "../pdf-text-engine/text-interpreter";

/** How a page's user space maps to its display space (see types.ts): CropBox origin, /Rotate, y downwards. */
export type PageGeometry = {
    /** Display size in points (swapped for 90°/270° rotation). */
    width: number;
    height: number;
    rotate: 0 | 90 | 180 | 270;
    /** User space → display space, in the engine's [a b c d e f] convention (applyPt). */
    matrix: Matrix;
    toDisplay: (x: number, y: number) => [number, number];
    /** Composes a transformation that ends in user space (e.g. a CTM) with the display mapping. */
    compose: (m: Matrix) => Matrix;
};

export const pageGeometry = (page: PDFPage): PageGeometry => {
    const box = page.getCropBox();
    const bx = box.x;
    const by = box.y;
    const bw = box.width;
    const bh = box.height;
    const angle = (((page.getRotation().angle % 360) + 360) % 360) as number;
    const rotate = ([0, 90, 180, 270].includes(angle) ? angle : 0) as PageGeometry["rotate"];
    // X/Y of the display point for user point (x, y); /Rotate turns the page clockwise.
    const matrix: Matrix =
        rotate === 0
            ? [1, 0, 0, -1, -bx, by + bh]
            : rotate === 90
              ? [0, 1, 1, 0, -by, -bx]
              : rotate === 180
                ? [-1, 0, 0, 1, bx + bw, -by]
                : [0, -1, -1, 0, by + bh, bx + bw];
    const swapped = rotate === 90 || rotate === 270;
    return {
        width: swapped ? bh : bw,
        height: swapped ? bw : bh,
        rotate,
        matrix,
        toDisplay: (x, y) => applyPt(matrix, x, y),
        compose: (m) => mul(m, matrix),
    };
};
