// Unit conversions between the page model (PDF points) and WordprocessingML measures. Non-finite input (a model
// with broken geometry) becomes 0 instead of reaching docx, which throws on NaN.

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Twentieths of a point (twips): indents, spacing, page size, tab stops, frame geometry. */
export const twip = (pt: number): number => Math.round(finite(pt) * 20);

/** English Metric Units: DrawingML offsets and extents (1 pt = 12 700 EMU). */
export const emu = (pt: number): number => Math.round(finite(pt) * 12700);

/** Half-points: font sizes (w:sz). Word accepts 1–1638 pt. */
export const halfPoints = (pt: number): number => clamp(Math.round(finite(pt, 11) * 2), 2, 3276);

/** Eighths of a point: border widths (w:sz of borders), limited to Word's 1/4–12 pt range. */
export const eighths = (pt: number): number => clamp(Math.round(finite(pt) * 8), 2, 96);

/** docx sizes images in "pixels" at 96 dpi (1 px = 9525 EMU): points → those pixels, fractional on purpose. */
export const drawingPixels = (pt: number): number => (finite(pt) * 96) / 72;

/** `value` limited to [min, max] (min wins if they cross; NaN gives min). */
export const clamp = (value: number, min: number, max: number): number => (Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min);

/** "1f2937", "#1F2937", "abc" → "1F2937"; anything else → undefined. */
export const hexColor = (color: string | undefined): string | undefined => {
    if (!color) return undefined;
    let c = color.trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(c)) c = c.replace(/./g, (ch) => ch + ch);
    return /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : undefined;
};
