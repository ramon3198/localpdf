// How Microsoft Word lays out lines, measured on Word's own PDF export (calibration docs built with docx, printed
// by Word, measured with PyMuPDF). The writer uses these numbers to predict where Word will put each baseline, so
// flowing text lands where the PDF had it.

/**
 * With "exact" line spacing L, Word places the baseline 0.8·L below the top of the line box (for every font and
 * size): ascent part 0.8·L, descent part 0.2·L. Frames and flowing paragraphs behave the same.
 */
export const EXACT_BASELINE = 0.8;

type SingleMetrics = {
    /** First baseline below the top of the line, as a fraction of the font size. */
    ascent: number;
    /** Line pitch of "single" spacing, as a fraction of the font size. */
    height: number;
};

// Single (auto) line spacing of the fonts Windows and Office install, measured in Word at 16 pt (first baseline
// below a frame's top, and the pitch of two lines). Families Word maps to one of them (Helvetica → Arial…) share it.
const SINGLE: Record<string, SingleMetrics> = {
    "times new roman": { ascent: 0.93, height: 1.147 },
    times: { ascent: 0.93, height: 1.147 },
    arial: { ascent: 0.938, height: 1.147 },
    helvetica: { ascent: 0.938, height: 1.147 },
    "arial narrow": { ascent: 0.938, height: 1.147 },
    "arial black": { ascent: 1.099, height: 1.41 },
    calibri: { ascent: 0.949, height: 1.222 },
    "calibri light": { ascent: 0.949, height: 1.222 },
    cambria: { ascent: 0.951, height: 1.17 },
    "cambria math": { ascent: 0.957, height: 1.17 },
    "courier new": { ascent: 0.831, height: 1.132 },
    courier: { ascent: 0.831, height: 1.132 },
    georgia: { ascent: 0.914, height: 1.132 },
    verdana: { ascent: 1.006, height: 1.215 },
    tahoma: { ascent: 0.999, height: 1.2 },
    "segoe ui": { ascent: 1.081, height: 1.327 },
    "segoe ui light": { ascent: 1.076, height: 1.335 },
    "segoe ui semibold": { ascent: 1.076, height: 1.335 },
    "trebuchet ms": { ascent: 0.934, height: 1.162 },
    garamond: { ascent: 0.863, height: 1.125 },
    "book antiqua": { ascent: 0.961, height: 1.238 },
    "palatino linotype": { ascent: 1.051, height: 1.35 },
    "century gothic": { ascent: 1.008, height: 1.222 },
    century: { ascent: 0.986, height: 1.2 },
    "bookman old style": { ascent: 0.941, height: 1.178 },
    aptos: { ascent: 0.936, height: 1.222 },
    consolas: { ascent: 0.921, height: 1.17 },
    candara: { ascent: 0.951, height: 1.222 },
    constantia: { ascent: 0.953, height: 1.215 },
    corbel: { ascent: 0.953, height: 1.215 },
    "franklin gothic medium": { ascent: 0.916, height: 1.132 },
    "gill sans mt": { ascent: 0.927, height: 1.163 },
    "lucida sans unicode": { ascent: 1.092, height: 1.538 },
    "lucida console": { ascent: 0.792, height: 0.997 },
    "microsoft sans serif": { ascent: 0.922, height: 1.132 },
    rockwell: { ascent: 0.952, height: 1.17 },
    "tw cen mt": { ascent: 0.854, height: 1.087 },
    "comic sans ms": { ascent: 1.104, height: 1.395 },
    impact: { ascent: 1.014, height: 1.215 },
    sylfaen: { ascent: 1.014, height: 1.312 },
    ebrima: { ascent: 1.111, height: 1.357 },
    gadugi: { ascent: 1.081, height: 1.335 },
    "leelawadee ui": { ascent: 1.081, height: 1.335 },
    "nirmala ui": { ascent: 1.084, height: 1.328 },
    "yu gothic": { ascent: 1.181, height: 1.673 },
    "ms gothic": { ascent: 1.009, height: 1.298 },
    "malgun gothic": { ascent: 1.288, height: 1.733 },
    simsun: { ascent: 1.004, height: 1.297 },
};

const DEFAULT_SINGLE: SingleMetrics = { ascent: 0.93, height: 1.17 };

export const singleMetrics = (fontFamily: string): SingleMetrics => SINGLE[fontFamily.trim().toLowerCase()] ?? DEFAULT_SINGLE;

/** Whether Word's single spacing of this family is known (not the generic estimate). */
export const hasSingleMetrics = (fontFamily: string): boolean => fontFamily.trim().toLowerCase() in SINGLE;

/**
 * Families any Windows + Office machine has (the measured ones): Word sets them with the PDF's own glyph widths.
 * Other families (web fonts, brand fonts) may be substituted with wider or narrower ones where the .docx is opened.
 */
export const isCommonFont = (fontFamily: string): boolean => hasSingleMetrics(fontFamily) || /^(symbol|wingdings|webdings)/i.test(fontFamily.trim());

/** Word's vertAlign superscript/subscript prints the run at this fraction of its w:sz. */
export const SCRIPT_SCALE = 2 / 3;

/** Line box of one paragraph line in Word: its height and where the baseline sits below its top. */
export type LineBox = { height: number; baseline: number };

/** Word raises superscripts by about 0.37 of their w:sz and lowers subscripts by about 0.08 (measured). */
const SUPER_RAISE = 0.37;
const SUB_LOWER = 0.08;

/**
 * The line box Word gives a line with this spacing (exact) or, for spacing 0, single spacing of its runs (raised
 * superscripts and lowered subscripts make the line taller). `fontSize` is the printed size.
 */
export const lineBox = (lineSpacing: number, runs: { fontFamily: string; fontSize: number; verticalAlign?: "superscript" | "subscript" }[]): LineBox => {
    if (lineSpacing > 0) return { height: lineSpacing, baseline: lineSpacing * EXACT_BASELINE };
    let ascent = 0;
    let descent = 0;
    for (const r of runs) {
        const m = singleMetrics(r.fontFamily);
        const shift =
            r.verticalAlign === "superscript"
                ? SUPER_RAISE * (r.fontSize / SCRIPT_SCALE)
                : r.verticalAlign === "subscript"
                  ? -SUB_LOWER * (r.fontSize / SCRIPT_SCALE)
                  : 0;
        ascent = Math.max(ascent, m.ascent * r.fontSize + shift);
        descent = Math.max(descent, (m.height - m.ascent) * r.fontSize - shift);
    }
    if (ascent === 0) return { height: 13.8, baseline: 11.2 };
    return { height: ascent + descent, baseline: ascent };
};
