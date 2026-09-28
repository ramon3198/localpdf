// Shared data model of the PDF → Word converter. Every stage (text extraction, graphics, layout, tables, writer)
// reads and writes these types, so they are the contract between the modules of src/lib/pdf-to-docx.
//
// Geometry is in PDF points (1/72 in) in the page's DISPLAY space: origin at the top-left corner of the visible page
// (CropBox, after /Rotate), x to the right, y downwards — the way the page looks on screen at 100 %.

export type Rect = { x: number; y: number; width: number; height: number };

/** 6-digit hex colour without '#', e.g. "1F2937". */
export type Hex = string;

export type TextStyle = {
    /** Family as Word should use it: "Times New Roman", "Arial", "Calibri", "Courier New", "Inter"… */
    fontFamily: string;
    /** Size in points. */
    fontSize: number;
    bold: boolean;
    italic: boolean;
    underline?: boolean;
    strike?: boolean;
    color: Hex;
    /** Raised or lowered, smaller text (footnote marks, exponents). `fontSize` is then the size the glyphs are drawn at. */
    verticalAlign?: "superscript" | "subscript";
    /** Extra space between letters in points (letter-spaced titles). */
    characterSpacing?: number;
    /** Target of the link annotation covering this text. */
    link?: string;
    /** Hollow letters: only their outline is drawn, in `color` (Word's Outline text effect). */
    outline?: boolean;
    /**
     * A family every Word installation has, of the same kind (sans / serif / mono), to name as the substitute when
     * `fontFamily` isn't installed ("Inter" → "Arial"). Absent for fonts Office ships.
     */
    fallbackFamily?: string;
    /** Horizontal scaling of the glyphs in percent (PDF Tz), when it isn't 100. */
    horizontalScale?: number;
};

/** Glyphs with one style on one line. `text` includes the spaces that separate it from the next run. */
export type TextRun = {
    text: string;
    style: TextStyle;
    /** Ink box of the run (x = pen start, width = advance, y/height = ascent/descent box). */
    box: Rect;
    baseline: number;
};

/** One visual line: runs left to right, same baseline (superscripts belong to their line). */
export type TextLine = {
    runs: TextRun[];
    box: Rect;
    baseline: number;
    /** Most common font size of the line. */
    fontSize: number;
    /** Text drawn invisibly (render mode 3), e.g. an OCR layer over a scan. */
    invisible?: boolean;
    /**
     * Rotated text: clockwise angle of the baseline in degrees (display space; 90 = reading downwards). `box`, `baseline`
     * and the runs' boxes are then given in the text's own unrotated frame, placed so that the frame's centre is the
     * centre of the text on the page: draw the box unrotated, then rotate it by `rotation` about its centre.
     */
    rotation?: number;
};

export type PlacedImage = {
    /** Where it is drawn on the page (after clipping to the page). */
    box: Rect;
    mime: "image/png" | "image/jpeg";
    data: Uint8Array;
    pixelWidth: number;
    pixelHeight: number;
};

/** A filled rectangle (backgrounds, table cell shading, highlight bands). */
export type FilledRect = Rect & { color: Hex; opacity: number };

/** A straight stroked (or thin filled) line: table borders, underlines, separators. */
export type RuleSegment = { x1: number; y1: number; x2: number; y2: number; width: number; color: Hex; style?: "dotted" | "dashed" };

export type PageGraphics = {
    images: PlacedImage[];
    fills: FilledRect[];
    rules: RuleSegment[];
    /** True when the page has vector drawing that is neither a table rule nor a simple fill (logos, charts, curves). */
    hasComplexVector: boolean;
    /** Bounds of that vector art (logos, charts, icons), clustered. */
    complexAreas?: Rect[];
    /** Images whose compression can't be decoded here (JPEG 2000, JBIG2, CCITT): only visible in a rendered page. */
    skippedImages?: { box: Rect; filter: string }[];
};

/** Everything extracted from one page, before layout analysis. */
export type PageContent = {
    index: number;
    width: number;
    height: number;
    lines: TextLine[];
    graphics: PageGraphics;
};

export type ParagraphAlignment = "left" | "center" | "right" | "justify";

export type Paragraph = {
    kind: "paragraph";
    /** Source lines, in order (layout mode positions them; flow mode uses `runs`). */
    lines: TextLine[];
    /** The paragraph's text as runs: consecutive lines joined (space, or nothing after a hyphen that splits a word). */
    runs: TextRun[];
    box: Rect;
    alignment: ParagraphAlignment;
    /** Points from the section's left / right margin. */
    indentLeft: number;
    indentRight: number;
    /** Points; negative = hanging indent (list items). */
    firstLineIndent: number;
    /** Gap above the paragraph beyond normal line spacing, in points. */
    spaceBefore: number;
    /** Distance between baselines in points (exact line spacing); 0 = Word's single spacing. */
    lineSpacing: number;
    heading?: 1 | 2 | 3;
    list?: { kind: "bullet" | "number"; marker: string; level: number };
    /** Keep each source line as its own line inside the paragraph (addresses, poems, short lists without markers). */
    keepLineBreaks?: boolean;
    shading?: Hex;
    borderBottom?: { color: Hex; width: number };
    /**
     * Pieces of one line set apart by a wide gap (a tab in the source: "Fecha:⇥15/09/2026", a right-aligned page number)
     * are joined with "\t" in the runs; each tab moves to the next stop. Positions in points from the section's left
     * margin (like indentLeft); "right" stops align the text before the next tab (or the line end) to the stop.
     */
    tabStops?: { position: number; alignment: "left" | "right" | "center"; leader?: "dot" | "hyphen" | "underscore" }[];
    /** Rotated paragraph (see TextLine.rotation): `box`, lines and runs are in the unrotated frame centred on the text. */
    rotation?: number;
    /**
     * Justified text cut by the end of the page or column (it continues on the next one): its last line is stretched to
     * the margin too, which Word only does for a line that ends with a line break.
     */
    justifyLastLine?: boolean;
};

export type TableCell = {
    box: Rect;
    paragraphs: Paragraph[];
    shading?: Hex;
    rowSpan: number;
    colSpan: number;
    /** Which edges have a visible border (from the page's rules). */
    borders: { top?: RuleSegment; right?: RuleSegment; bottom?: RuleSegment; left?: RuleSegment };
    verticalAlign?: "top" | "center" | "bottom";
};

export type TableRow = { height: number; cells: TableCell[] };

export type Table = { kind: "table"; box: Rect; columnWidths: number[]; rows: TableRow[] };

export type FloatingImage = { kind: "image"; image: PlacedImage; behindText: boolean };

export type Block = Paragraph | Table | FloatingImage;

/** A page after layout analysis: what the writer turns into Word content. */
export type PageModel = {
    index: number;
    width: number;
    height: number;
    margins: { top: number; right: number; bottom: number; left: number };
    /** Blocks in reading order. */
    blocks: Block[];
    /**
     * Body text set in several columns (flow mode writes a multi-column section). Blocks are in column order;
     * `breaks` are the indices of the blocks that start column 2, 3… (a column break goes before each), and `widths`
     * the columns' widths when they differ. Blocks before the first column's first block (a full-width title) and after
     * the columns belong to single-column sections around it.
     */
    columns?: { count: number; gap: number; breaks?: number[]; widths?: number[]; first?: number; last?: number };
    /** How the writer should reproduce this page. */
    mode: "flow" | "layout";
    /** Layout mode: the page's graphics (text removed), drawn behind the positioned text. */
    background?: PlacedImage;
    /** The page had no real text and was read with OCR. */
    ocr?: boolean;
};

export type RenderedImage = { data: Uint8Array; mime: "image/png" | "image/jpeg"; pixelWidth: number; pixelHeight: number };

export type OcrWord = {
    text: string;
    /** In the rendered image's pixels. */
    box: Rect;
    confidence: number;
    /** Words of one OCR line share it. */
    line: number;
    /** Words of one OCR paragraph share it. */
    paragraph: number;
};

/** What the host provides (browser: pdf.js + canvas + tesseract.js; Node tests: pdf.js legacy + @napi-rs/canvas). */
export type ConvertEnvironment = {
    /** Render page `pageIndex` (0-based) of the given PDF bytes at `dpi`. Used for layout-mode backgrounds and OCR. */
    renderPage?: (pdf: Uint8Array, pageIndex: number, dpi: number) => Promise<RenderedImage>;
    /** Recognise the words of a rendered page. */
    ocr?: (image: RenderedImage, languages: string[], signal?: AbortSignal) => Promise<OcrWord[]>;
    /** fontkit's `create`, so font programs can be read (styles, glyph names). */
    fontkit?: (bytes: Uint8Array) => unknown;
    /**
     * A TrueType/OpenType file for a family that Word may not have (the app's font pack: Inter, Poppins, Anton…), so the
     * .docx can embed it. null when there is none. Office's own fonts are never requested.
     */
    loadFont?: (family: string, bold: boolean, italic: boolean) => Promise<Uint8Array | null>;
};

export type ConvertOptions = {
    /** auto: layout mode only for pages whose design can't be expressed as flowing text. Default "auto". */
    mode?: "auto" | "flow" | "layout";
    /** Read scanned pages with OCR (needs env.ocr). Default true when env.ocr exists. */
    ocr?: boolean;
    /** tesseract language codes, e.g. ["spa", "eng"]. */
    ocrLanguages?: string[];
    /** 0-based pages to convert (default: all). */
    pages?: number[];
    onProgress?: (progress: { page: number; pages: number; stage: "reading" | "analysing" | "ocr" | "writing" }) => void;
    signal?: AbortSignal;
};

export type ConvertStats = {
    pages: number;
    paragraphs: number;
    tables: number;
    images: number;
    ocrPages: number;
    layoutPages: number;
    /** Plain-Spanish notes for the user (e.g. "La página 3 es una imagen sin texto: se incluye como imagen."). */
    warnings: string[];
};

export type ConvertResult = { docx: Uint8Array; stats: ConvertStats };
