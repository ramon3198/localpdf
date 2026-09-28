// Images placed on the page: floating pictures positioned relative to the page, in front of or behind the text.
import { HorizontalPositionRelativeFrom, ImageRun, TextWrappingType, VerticalPositionRelativeFrom } from "docx";
import { drawingPixels, emu } from "./docx-units";
import type { PlacedImage } from "./types";

/** Minimum size (points) worth writing; smaller boxes are clipping leftovers. */
const MIN_SIZE = 0.5;

export const isWritableImage = (image: PlacedImage): boolean =>
    image.box.width >= MIN_SIZE && image.box.height >= MIN_SIZE && image.data.length > 0 && (image.mime === "image/png" || image.mime === "image/jpeg");

/**
 * A floating picture at `image.box` (page coordinates), no text wrapping. `z` orders overlapping objects (higher is
 * in front); `behind` puts it behind the text layer.
 */
export const floatingImage = (image: PlacedImage, options: { behind: boolean; z: number; name: string }): ImageRun =>
    new ImageRun({
        type: image.mime === "image/png" ? "png" : "jpg",
        data: image.data,
        transformation: { width: drawingPixels(image.box.width), height: drawingPixels(image.box.height) },
        floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(image.box.x) },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(image.box.y) },
            wrap: { type: TextWrappingType.NONE },
            behindDocument: options.behind,
            allowOverlap: true,
            layoutInCell: false,
            lockAnchor: true,
            zIndex: options.z,
        },
        altText: { name: options.name, description: options.name, title: options.name },
    });
