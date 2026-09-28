export type Pt = { x: number; y: number };

type BaseItem = { id: string; page: number };

/** Replacement of an existing text run of the PDF. CSS values are in editor canvas px (zoom = 1). */
export type TextEditItem = BaseItem & {
    type: "textEdit";
    /** id of the original ExtractedText being replaced. */
    sourceId: string;
    /** The original text of the run. */
    str: string;
    newText: string;
    /** pdfjs TextItem.transform / width in PDF user space — used by the content-stream engine. */
    pdfTransform: number[];
    pdfWidth: number;
    /** Bbox in CSS px of the canvas (overlay coords). */
    cssX: number;
    cssY: number;
    cssWidth: number;
    cssHeight: number;
    cssBaselineY: number;
    cssFontSize: number;
    /** Current colour of the new text (sampled from the original, or chosen by the user). */
    textColor: string;
    bgColor: string;
    /** Left/right background colours for the overlay fallback cover. */
    bgLeft: string;
    bgRight: string;
    /** Actual vertical ink extent of the original glyphs (CSS px abs). */
    inkTop: number | null;
    inkBottom: number | null;
    /** Generic mapping (Helvetica/Times/Courier) — used by the overlay fallback. */
    family: "helvetica" | "times" | "courier";
    /** CSS font-family used to preview the typed text in the input. */
    cssFontFamily: string;
    pdfjsFontName: string;
    /** PostScript name (matches the FontDescriptor in the PDF). */
    psFontName: string | null;
    bold: boolean;
    italic: boolean;
    /** Original style of the run — the engine only overrides what the user actually changed. */
    origTextColor: string;
    origCssFontSize: number;
    origBold: boolean;
    origItalic: boolean;
};

/** Text added by the user ("Añadir texto") or a sticky note ("Nota"). One or more lines, no automatic wrapping. */
export type TextItem = BaseItem & {
    type: "text";
    /** Left edge of the text. */
    x: number;
    /** Top of the first line box (lines are `fontSize * ADDED_TEXT_LINE_HEIGHT` tall). */
    y: number;
    text: string;
    /** CSS px of the editor canvas (zoom = 1). */
    fontSize: number;
    color: string;
    /** Sticky note: the text sits on a padded, filled box of colour `background`. */
    note?: boolean;
    background?: string;
};

export type DrawingItem = BaseItem & {
    type: "drawing";
    points: Pt[];
    color: string;
    width: number;
    /** Straight line produced by the "Subrayar"/"Tachar" tools (drawn and exported like any stroke). */
    kind?: "underline" | "strike";
};
export type RectangleItem = BaseItem & {
    type: "rectangle";
    x: number;
    y: number;
    width: number;
    height: number;
    stroke: string;
    fill: string | null;
    strokeWidth: number;
};
export type HighlightItem = BaseItem & { type: "highlight"; x: number; y: number; width: number; height: number; color: string };
export type ImageItem = BaseItem & { type: "image"; x: number; y: number; width: number; height: number; dataUrl: string; isPng: boolean };

export type EditorItem = TextItem | DrawingItem | RectangleItem | HighlightItem | ImageItem | TextEditItem;

/** Width of the editor canvas render (CSS px at zoom 1). All item coordinates are relative to it. */
export const EDITOR_CSS_WIDTH = 820;

/** Line height of added text and notes, relative to the font size (same value in the editor and in the PDF). */
export const ADDED_TEXT_LINE_HEIGHT = 1.2;
/** Inner padding of a sticky note, in editor px. */
export const NOTE_PADDING = { x: 8, y: 6 };
/** Notes always use dark text: the colour the user picks is the paper colour. */
export const NOTE_TEXT_COLOR = "#1f2937";
/** Highlighter opacity (multiplied over the page, so the text underneath stays black). */
export const HIGHLIGHT_OPACITY = 0.35;

/** Mix a #rrggbb colour towards black (amount < 0) or white (amount > 0). */
export const shadeHex = (hex: string, amount: number) => {
    const m = hex.replace("#", "").match(/.{2}/g) ?? ["00", "00", "00"];
    const target = amount < 0 ? 0 : 255;
    const k = Math.min(1, Math.abs(amount));
    return `#${m
        .slice(0, 3)
        .map((h) => Math.round(parseInt(h, 16) + (target - parseInt(h, 16)) * k))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
};
/** Text colour that stays readable on a note's paper (dark paper chosen with the free colour picker gets white text). */
export const noteTextColorFor = (background: string) => {
    const m = background.replace("#", "").match(/.{2}/g) ?? ["ff", "ff", "ff"];
    const [r, g, b] = m.slice(0, 3).map((h) => parseInt(h, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "#ffffff" : NOTE_TEXT_COLOR;
};
/** Border of a sticky note: a darker shade of its paper colour. */
export const noteBorderColor = (background: string) => shadeHex(background, -0.35);

/** A text edit changes something only if the text or any style differs from the original run. */
export const textEditIsNoop = (it: TextEditItem) =>
    it.newText === it.str &&
    it.textColor.toLowerCase() === it.origTextColor.toLowerCase() &&
    Math.abs(it.cssFontSize - it.origCssFontSize) < 0.01 &&
    it.bold === it.origBold &&
    it.italic === it.origItalic;
