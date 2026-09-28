"use client";

import {
    type CSSProperties,
    type FC,
    type KeyboardEvent as RKeyboardEvent,
    type MouseEvent as RMouseEvent,
    type PointerEvent as RPointerEvent,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import {
    AlertTriangle,
    Brush01,
    Check,
    ChevronLeft,
    ChevronRight,
    Cursor04,
    Edit05,
    Expand06,
    File04,
    FlipBackward,
    FlipForward,
    Image01,
    InfoCircle,
    LayoutLeft,
    MessageTextSquare01,
    Minus,
    PaintPour,
    PenTool02,
    Plus,
    RefreshCcw01,
    Save01,
    Square,
    Strikethrough01,
    Trash01,
    Type01,
    Underline01,
    XClose,
} from "@untitledui/icons";
import { useRouter } from "next/navigation";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
    Button as AriaButton,
    Dialog as AriaDialog,
    Heading as AriaHeading,
    Modal as AriaModal,
    ModalOverlay as AriaModalOverlay,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
    ToggleButton as AriaToggleButton,
    ToggleButtonGroup as AriaToggleButtonGroup,
} from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Slider } from "@/components/base/slider/slider";
import { Tooltip } from "@/components/base/tooltip/tooltip";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { type ExtractedFontBinary, extractFontsFromPdf } from "@/lib/font-extractor";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { type ExtractedText, extractTextItems } from "@/lib/text-extractor";
import { cx } from "@/utils/cx";
import { type EditMode, type PreviewRun, buildEditedPdf, renderPreviewPage } from "./build-edited-pdf";
import {
    ADDED_TEXT_LINE_HEIGHT,
    EDITOR_CSS_WIDTH,
    type EditorItem,
    HIGHLIGHT_OPACITY,
    NOTE_PADDING,
    type Pt,
    type TextEditItem,
    type TextItem,
    noteBorderColor,
    noteTextColorFor,
    textEditIsNoop,
} from "./editor-types";
import { ADDED_TEXT_FONT_STACK, addedTextFont, canvasToUrl, ensureAddedTextFonts, measureTextWidth, renderPixelRatio } from "./render-utils";

type Mode = "edit" | "annotate";
type Tool = "select" | "editText" | "text" | "note" | "draw" | "rectangle" | "highlight" | "underline" | "strike" | "image";
/** Tools and item kinds that have their own colour (and remember it). */
type ColorKey = "text" | "note" | "draw" | "rectangle" | "highlight" | "underline" | "strike";
type Item = EditorItem;
type Align = "left" | "right" | "center";
type Box = { x: number; y: number; w: number; h: number };
type ZoomMode = "auto" | "fit" | "manual";

type SourceFile = { file: File; pageCount: number };

type PageRender = {
    page: number;
    /** Object URL of the rasterized page. */
    dataUrl: string;
    /** CSS px of the rendered canvas (also our "editor coords" basis). */
    cssWidth: number;
    cssHeight: number;
    /** Original page size in PDF units. */
    pdfWidth: number;
    pdfHeight: number;
};

type Preview = { page: number; key: string; dataUrl: string; modes: Record<string, EditMode>; runs: PreviewRun[] };

/** What the user is typing into an existing run before it is committed (one undo step per commit). */
type TextDraft = { text: string; textColor: string; cssFontSize: number; bold: boolean; italic: boolean };

type DocState = { items: Item[]; past: Item[][]; future: Item[][] };
const EMPTY_DOC: DocState = { items: [], past: [], future: [] };
const HISTORY_LIMIT = 100;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
/** Default zoom fits the page width, but never blows a page up beyond 125 % on wide screens. */
const AUTO_MAX_ZOOM = 1.25;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
/** Below this on-screen font size, existing text is edited in a field inside the popover instead of in place. */
const MIN_INPLACE_FONT_PX = 12;

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtNumber = (n: number) => n.toLocaleString("es", { maximumFractionDigits: 1 });
const parseNumber = (s: string) => {
    const v = parseFloat(s.replace(",", ".").replace(/[^\d.]/g, ""));
    return Number.isFinite(v) ? v : null;
};

type ToolDef = { id: Tool; label: string; icon: FC<{ className?: string }> };

const TOOLS_EDIT: ToolDef[] = [
    { id: "select", label: "Seleccionar", icon: Cursor04 },
    { id: "editText", label: "Editar texto", icon: Edit05 },
    { id: "text", label: "Añadir texto", icon: Type01 },
    { id: "draw", label: "Dibujar", icon: PenTool02 },
    { id: "rectangle", label: "Rectángulo", icon: Square },
];
const TOOLS_ANNOTATE: ToolDef[] = [
    { id: "select", label: "Seleccionar", icon: Cursor04 },
    { id: "highlight", label: "Resaltar", icon: Brush01 },
    { id: "underline", label: "Subrayar", icon: Underline01 },
    { id: "strike", label: "Tachar", icon: Strikethrough01 },
    { id: "draw", label: "Dibujar", icon: PenTool02 },
    { id: "note", label: "Nota", icon: MessageTextSquare01 },
];

const TITLES: Record<
    Mode,
    { title: string; description: string; verb: string; shortVerb: string; busy: string; drop: string; one: string; many: string; none: string }
> = {
    edit: {
        title: "Editar PDF",
        description: "Cambia el texto con su misma fuente y añade texto, formas o imágenes.",
        verb: "Aplicar cambios",
        shortVerb: "Aplicar cambios",
        busy: "Aplicando cambios…",
        drop: "Suelta el PDF que quieres editar.",
        one: "cambio",
        many: "cambios",
        none: "Sin cambios",
    },
    annotate: {
        title: "Anotar PDF",
        description: "Resalta, subraya, tacha y añade notas a tu documento.",
        verb: "Guardar anotaciones",
        shortVerb: "Guardar",
        busy: "Guardando…",
        drop: "Suelta el PDF que quieres anotar.",
        one: "anotación",
        many: "anotaciones",
        none: "Sin anotaciones",
    },
};

type Swatch = { value: string; label: string };
const INK_COLORS: Swatch[] = [
    { value: "#111827", label: "Negro" },
    { value: "#dc2626", label: "Rojo" },
    { value: "#2563eb", label: "Azul" },
    { value: "#16a34a", label: "Verde" },
    { value: "#ea580c", label: "Naranja" },
];
const SHAPE_COLORS: Swatch[] = [...INK_COLORS.slice(0, 4), { value: "#ffffff", label: "Blanco" }];
const HIGHLIGHT_COLORS: Swatch[] = [
    { value: "#facc15", label: "Amarillo" },
    { value: "#4ade80", label: "Verde" },
    { value: "#60a5fa", label: "Azul" },
    { value: "#f472b6", label: "Rosa" },
    { value: "#fb923c", label: "Naranja" },
];
const NOTE_COLORS: Swatch[] = [
    { value: "#fef08a", label: "Amarillo" },
    { value: "#bbf7d0", label: "Verde" },
    { value: "#bfdbfe", label: "Azul" },
    { value: "#fbcfe8", label: "Rosa" },
    { value: "#fed7aa", label: "Naranja" },
];
const PRESETS: Record<ColorKey, Swatch[]> = {
    text: INK_COLORS,
    note: NOTE_COLORS,
    draw: INK_COLORS,
    rectangle: SHAPE_COLORS,
    highlight: HIGHLIGHT_COLORS,
    underline: INK_COLORS,
    strike: INK_COLORS,
};
const DEFAULT_COLORS: Record<ColorKey, string> = {
    text: "#111827",
    note: "#fef08a",
    draw: "#dc2626",
    rectangle: "#dc2626",
    highlight: "#facc15",
    underline: "#2563eb",
    strike: "#dc2626",
};

const DRAW_TOOLS: Tool[] = ["draw", "rectangle", "highlight", "underline", "strike"];

const colorKeyForTool = (tool: Tool): ColorKey | null =>
    tool === "text" || tool === "note" || tool === "draw" || tool === "rectangle" || tool === "highlight" || tool === "underline" || tool === "strike"
        ? tool
        : null;

const colorKeyForItem = (it: Item): ColorKey | null => {
    if (it.type === "text") return it.note ? "note" : "text";
    if (it.type === "drawing") return it.kind ?? "draw";
    if (it.type === "rectangle") return "rectangle";
    if (it.type === "highlight") return "highlight";
    return null;
};

const itemColor = (it: Item): string | null => {
    if (it.type === "text") return it.note ? (it.background ?? DEFAULT_COLORS.note) : it.color;
    if (it.type === "drawing" || it.type === "highlight") return it.color;
    if (it.type === "rectangle") return it.stroke;
    return null;
};

const withColor = (it: Item, color: string): Item => {
    if (it.type === "text") return it.note ? { ...it, background: color, color: noteTextColorFor(color) } : { ...it, color };
    if (it.type === "drawing" || it.type === "highlight") return { ...it, color };
    if (it.type === "rectangle") return { ...it, stroke: color, fill: it.fill ? color : null };
    return it;
};

const itemLabel = (it: Item) =>
    it.type === "text"
        ? `${it.note ? "Nota" : "Texto añadido"}: ${it.text.slice(0, 40)}`
        : it.type === "drawing"
          ? it.kind === "underline"
              ? "Subrayado"
              : it.kind === "strike"
                ? "Tachado"
                : "Dibujo"
          : it.type === "rectangle"
            ? "Rectángulo"
            : it.type === "highlight"
              ? "Resaltado"
              : it.type === "image"
                ? "Imagen"
                : "Texto editado";

const moveItem = (it: Item, dx: number, dy: number): Item => {
    if (it.type === "drawing") return { ...it, points: it.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    if (it.type === "textEdit") return it;
    return { ...it, x: it.x + dx, y: it.y + dy };
};

const textEditFromSource = (src: ExtractedText): TextEditItem => ({
    id: newId(),
    type: "textEdit",
    page: src.page,
    sourceId: src.id,
    str: src.str,
    newText: src.str,
    cssX: src.cssX,
    cssY: src.cssY,
    cssWidth: src.cssWidth,
    cssHeight: src.cssHeight,
    cssBaselineY: src.cssBaselineY,
    cssFontSize: src.cssFontSize,
    textColor: src.textColor,
    bgColor: src.bgColor,
    bgLeft: src.bgLeft,
    bgRight: src.bgRight,
    inkTop: src.inkTop,
    inkBottom: src.inkBottom,
    family: src.family,
    cssFontFamily: src.cssFontFamily,
    pdfjsFontName: src.pdfjsFontName,
    psFontName: src.psFontName,
    bold: src.bold,
    italic: src.italic,
    pdfTransform: src.pdfTransform,
    pdfWidth: src.pdfWidth,
    origTextColor: src.textColor,
    origCssFontSize: src.cssFontSize,
    origBold: src.bold,
    origItalic: src.italic,
});

const runFont = (italic: boolean, bold: boolean, size: number, family: string) =>
    `${italic ? "italic " : ""}${bold ? "700" : "400"} ${size}px ${family || "sans-serif"}`;

/** Vertical box of a run drawn at another size: the engine keeps the baseline, so the box scales around it. */
const runBoxAtSize = (src: ExtractedText, size: number) => {
    const k = size / (src.cssFontSize || size || 1);
    return { top: src.cssBaselineY - (src.cssBaselineY - src.cssY) * k, height: src.cssHeight * k };
};

/** How much room a run has on its line, and how the engine is likely to align longer text (right-aligned letterheads
 *  and dates grow to the left, centred titles grow both ways). */
const lineRoom = (src: ExtractedText, runs: ExtractedText[], pageWidth: number): { available: number; align: Align } => {
    const tol = Math.max(2, src.cssFontSize * 0.3);
    const srcRight = src.cssX + src.cssWidth;
    const gap = src.cssFontSize * 0.25;
    let next = Infinity;
    let prev = -Infinity;
    let marginL = src.cssX;
    let marginR = srcRight;
    for (const r of runs) {
        marginL = Math.min(marginL, r.cssX);
        marginR = Math.max(marginR, r.cssX + r.cssWidth);
        if (r.id === src.id || Math.abs(r.cssBaselineY - src.cssBaselineY) >= tol) continue;
        if (r.cssX >= srcRight - 1) next = Math.min(next, r.cssX);
        if (r.cssX + r.cssWidth <= src.cssX + 1) prev = Math.max(prev, r.cssX + r.cssWidth);
    }
    const rightLimit = Number.isFinite(next) ? next - gap : marginR;
    const leftLimit = Number.isFinite(prev) ? prev + gap : marginL;
    const center = src.cssX + src.cssWidth / 2;
    const blockW = Math.max(1, marginR - marginL);
    let align: Align = "left";
    if (!Number.isFinite(next) && Math.abs(srcRight - marginR) < 2 && src.cssX - marginL > blockW * 0.25) align = "right";
    else if (
        !Number.isFinite(next) &&
        !Number.isFinite(prev) &&
        Math.abs(center - pageWidth / 2) < Math.max(3, src.cssFontSize * 0.3) &&
        src.cssX - marginL > 4
    )
        align = "center";
    const available =
        align === "right" ? srcRight - leftLimit : align === "center" ? 2 * Math.min(center - leftLimit, rightLimit - center) : rightLimit - src.cssX;
    return { available: Math.max(src.cssWidth, available), align };
};

/** Where the engine actually drew an edited run, found in the text of the rebuilt preview page. */
const resolveEditedBox = (src: ExtractedText, newText: string, runs: PreviewRun[]): { x: number; w: number } | null => {
    const needle = [...newText.replace(/\s+/g, "")];
    if (!needle.length) return null;
    const tol = Math.max(2, src.cssFontSize * 0.3);
    const line = runs.filter((r) => Math.abs(r.baseline - src.cssBaselineY) < tol).sort((a, b) => a.x - b.x);
    const chars: { ch: string; x0: number; x1: number }[] = [];
    for (const r of line) {
        const cps = [...r.str];
        cps.forEach((ch, i) => {
            if (/\s/.test(ch)) return;
            chars.push({ ch, x0: r.x + (r.w * i) / cps.length, x1: r.x + (r.w * (i + 1)) / cps.length });
        });
    }
    let best: { x0: number; x1: number; d: number } | null = null;
    for (let i = 0; i + needle.length <= chars.length; i++) {
        let ok = true;
        for (let k = 0; k < needle.length && ok; k++) ok = chars[i + k].ch === needle[k];
        if (!ok) continue;
        const x0 = chars[i].x0;
        const x1 = chars[i + needle.length - 1].x1;
        const d = Math.min(Math.abs(x0 - src.cssX), Math.abs(x1 - (src.cssX + src.cssWidth)));
        if (!best || d < best.d) best = { x0, x1, d };
    }
    return best ? { x: best.x0, w: Math.max(1, best.x1 - best.x0) } : null;
};

const alignOfBox = (src: ExtractedText, box: { x: number; w: number }): Align | null => {
    if (Math.abs(box.x - src.cssX) <= 2) return "left";
    if (Math.abs(box.x + box.w - (src.cssX + src.cssWidth)) <= 2) return "right";
    if (Math.abs(box.x + box.w / 2 - (src.cssX + src.cssWidth / 2)) <= 2) return "center";
    return null;
};

/** Caret index closest to a click, measured in the run's own font. */
const caretAt = (text: string, font: string, shownWidth: number, offsetX: number) => {
    const full = measureTextWidth(text, font) || 1;
    const k = shownWidth / full;
    const cps = [...text];
    let prefix = "";
    let best = text.length;
    let bestD = Infinity;
    for (let i = 0; i <= cps.length; i++) {
        const d = Math.abs(measureTextWidth(prefix, font) * k - offsetX);
        if (d < bestD) {
            bestD = d;
            best = prefix.length;
        }
        if (i < cps.length) prefix += cps[i];
    }
    return best;
};

/** Lines of text a drag covers, in reading order (for highlight, underline and strike-through). Partial lines are
 *  extended to whole words, like a text selection. */
type TextLine = { left: number; right: number; top: number; bottom: number; baseline: number; size: number; runs: ExtractedText[] };

/** x of every character boundary of a run, measured in the run's own font and fitted to its real width. */
const charEdges = (r: ExtractedText) => {
    const font = runFont(r.italic, r.bold, r.cssFontSize, r.cssFontFamily);
    const cps = [...r.str];
    const k = r.cssWidth / (measureTextWidth(r.str, font) || 1);
    const edges = [r.cssX];
    let prefix = "";
    for (const ch of cps) {
        prefix += ch;
        edges.push(r.cssX + measureTextWidth(prefix, font) * k);
    }
    return { cps, edges };
};

/** Snap x to the start (or end) of the word under it on a line. */
const snapToWord = (line: TextLine, x: number, side: "start" | "end") => {
    const runs = [...line.runs].sort((a, b) => a.cssX - b.cssX);
    const r = runs.find((r) => x >= r.cssX && x <= r.cssX + r.cssWidth);
    if (!r) {
        // In a gap between runs: the next run starts the selection, the previous one ends it.
        if (side === "start") return runs.find((q) => q.cssX >= x)?.cssX ?? x;
        const prev = [...runs].reverse().find((q) => q.cssX + q.cssWidth <= x);
        return prev ? prev.cssX + prev.cssWidth : x;
    }
    const { cps, edges } = charEdges(r);
    let i = 0;
    while (i < cps.length - 1 && edges[i + 1] <= x) i++;
    const space = (k: number) => /\s/.test(cps[k] ?? " ");
    if (side === "start") {
        if (space(i)) {
            while (i < cps.length && space(i)) i++;
            return edges[Math.min(i, cps.length)];
        }
        while (i > 0 && !space(i - 1)) i--;
        return edges[i];
    }
    if (space(i)) {
        while (i > 0 && space(i)) i--;
        return space(i) ? edges[i] : edges[i + 1];
    }
    while (i < cps.length - 1 && !space(i + 1)) i++;
    return edges[i + 1];
};

const textLinesForDrag = (runs: ExtractedText[], start: Pt, end: Pt): { x0: number; x1: number; line: TextLine }[] => {
    const segs: TextLine[] = [];
    const sorted = [...runs].sort((a, b) => a.cssBaselineY - b.cssBaselineY || a.cssX - b.cssX);
    for (const r of sorted) {
        const tol = Math.max(2, r.cssFontSize * 0.3);
        const seg = segs.find(
            (s) => Math.abs(s.baseline - r.cssBaselineY) < tol && r.cssX < s.right + r.cssFontSize * 2.5 && r.cssX + r.cssWidth > s.left - r.cssFontSize * 2.5,
        );
        if (seg) {
            seg.left = Math.min(seg.left, r.cssX);
            seg.right = Math.max(seg.right, r.cssX + r.cssWidth);
            seg.top = Math.min(seg.top, r.cssY);
            seg.bottom = Math.max(seg.bottom, r.cssY + r.cssHeight);
            seg.size = Math.max(seg.size, r.cssFontSize);
            seg.runs.push(r);
        } else {
            segs.push({
                left: r.cssX,
                right: r.cssX + r.cssWidth,
                top: r.cssY,
                bottom: r.cssY + r.cssHeight,
                baseline: r.cssBaselineY,
                size: r.cssFontSize,
                runs: [r],
            });
        }
    }
    const top = start.y <= end.y ? start : end;
    const bottom = start.y <= end.y ? end : start;
    const x0 = Math.min(start.x, end.x);
    const x1 = Math.max(start.x, end.x);
    const tiny = x1 - x0 < 3 && bottom.y - top.y < 3;
    const hit = segs
        .filter((s) =>
            tiny
                ? start.x >= s.left - 2 && start.x <= s.right + 2 && start.y >= s.top - 2 && start.y <= s.bottom + 2
                : s.bottom > top.y && s.top < bottom.y && s.right > x0 && s.left < x1,
        )
        .sort((a, b) => a.baseline - b.baseline || a.left - b.left);
    if (tiny) return hit.slice(0, 1).map((line) => ({ x0: line.left, x1: line.right, line }));
    const spans =
        hit.length === 1
            ? [{ x0: snapToWord(hit[0], Math.max(hit[0].left, x0), "start"), x1: snapToWord(hit[0], Math.min(hit[0].right, x1), "end"), line: hit[0] }]
            : hit.map((line, i) => ({
                  x0: i === 0 ? snapToWord(line, Math.max(line.left, top.x), "start") : line.left,
                  x1: i === hit.length - 1 ? snapToWord(line, Math.min(line.right, bottom.x), "end") : line.right,
                  line,
              }));
    return spans.filter((s) => s.x1 - s.x0 > 1);
};

const useMediaQuery = (query: string) => {
    const [matches, setMatches] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const update = () => setMatches(mq.matches);
        update();
        mq.addEventListener("change", update);
        return () => mq.removeEventListener("change", update);
    }, [query]);
    return matches;
};

const useElementHeight = (el: HTMLElement | null) => {
    const [h, setH] = useState(0);
    useEffect(() => {
        if (!el) return;
        const ro = new ResizeObserver(() => setH(el.getBoundingClientRect().height));
        ro.observe(el);
        setH(el.getBoundingClientRect().height);
        return () => ro.disconnect();
    }, [el]);
    return h;
};

const hintFor = (tool: Tool, mode: Mode, touch: boolean): string => {
    switch (tool) {
        case "select":
            if (mode === "annotate")
                return touch ? "Toca una anotación para moverla o borrarla." : "Haz clic en una anotación para moverla, cambiar su tamaño o borrarla.";
            return touch
                ? "Toca un texto del documento para cambiarlo, o un elemento añadido para moverlo o borrarlo."
                : "Haz clic en un texto del documento para cambiarlo, o en un elemento añadido para moverlo, cambiar su tamaño o borrarlo.";
        case "editText":
            return touch
                ? "Toca cualquier texto del documento para cambiarlo."
                : "Haz clic en cualquier texto del documento para cambiarlo. Enter aplica y Esc cancela.";
        case "text":
            return touch ? "Toca donde quieras añadir texto." : "Haz clic donde quieras añadir texto.";
        case "note":
            return touch ? "Toca donde quieras añadir una nota." : "Haz clic donde quieras añadir una nota.";
        case "draw":
            return "Arrastra sobre la página para dibujar a mano alzada.";
        case "rectangle":
            return "Arrastra sobre la página para dibujar un rectángulo.";
        case "highlight":
            return "Arrastra sobre el texto que quieras resaltar.";
        case "underline":
            return "Arrastra sobre el texto que quieras subrayar.";
        case "strike":
            return "Arrastra sobre el texto que quieras tachar.";
        case "image":
            return touch ? "Toca la página donde quieras colocar la imagen." : "Haz clic en la página donde quieras colocar la imagen.";
    }
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const EditScreen = ({ mode }: { mode: Mode }) => {
    const router = useRouter();
    const copy = TITLES[mode];
    const TOOLS = mode === "annotate" ? TOOLS_ANNOTATE : TOOLS_EDIT;
    const defaultTool: Tool = mode === "edit" ? "editText" : "highlight";

    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [opening, setOpening] = useState<string | null>(null);
    const [docState, setDocState] = useState<DocState>(EMPTY_DOC);
    const items = docState.items;
    const [activePage, setActivePage] = useState(1);
    const [pageRender, setPageRender] = useState<PageRender | null>(null);
    const [tool, setTool] = useState<Tool>(defaultTool);
    const [colors, setColors] = useState<Record<ColorKey, string>>(() => ({ ...DEFAULT_COLORS, text: mode === "edit" ? "#111827" : "#dc2626" }));
    /** Font sizes of new added text and notes, in points. */
    const [fontSizes, setFontSizes] = useState({ text: 14, note: 11 });
    const [strokeWidths, setStrokeWidths] = useState({ draw: 3, rectangle: 2 });
    const [rectFill, setRectFill] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draftDraw, setDraftDraw] = useState<Pt[] | null>(null);
    const [draftRect, setDraftRect] = useState<{ start: Pt; end: Pt } | null>(null);
    const [pendingImage, setPendingImage] = useState<{ dataUrl: string; isPng: boolean; w: number; h: number } | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    /** Cache of extracted source text per page (so we don't re-extract on every render). */
    const [sourceTexts, setSourceTexts] = useState<Record<number, ExtractedText[]>>({});
    /** Cache of embedded fonts extracted from the source PDF, keyed by PostScript name. */
    const fontBinariesRef = useRef<Map<string, ExtractedFontBinary>>(new Map());
    /** Currently active inline text edit (the run the user clicked) and where to put the caret. */
    const [activeTextEdit, setActiveTextEdit] = useState<{ id: string; caret: number | null } | null>(null);
    /** Live preview of the active page rendered from the edited PDF (same pipeline as "Aplicar cambios"). */
    const [preview, setPreview] = useState<Preview | null>(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [zoomMode, setZoomMode] = useState<ZoomMode>("auto");
    const [manualZoom, setManualZoom] = useState(1);
    const [fitZoom, setFitZoom] = useState(1);
    /** Show the document thumbnails rail on desktop. */
    const [showThumbs, setShowThumbs] = useState(true);
    /** Cached thumbnails per page (data URLs). */
    const [thumbDataUrls, setThumbDataUrls] = useState<Record<number, string>>({});
    const [confirm, setConfirm] = useState<{ kind: "reset" } | { kind: "navigate"; href: string } | null>(null);

    const canvasRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<HTMLDivElement | null>(null);
    const [viewerEl, setViewerEl] = useState<HTMLDivElement | null>(null);
    const pageFrameRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const [chromeEl, setChromeEl] = useState<HTMLDivElement | null>(null);
    const chromeRef = useRef<HTMLDivElement | null>(null);
    const [bottomBarEl, setBottomBarEl] = useState<HTMLDivElement | null>(null);
    const drawPointerRef = useRef<number | null>(null);
    const coalesceRef = useRef<{ key: string; t: number } | null>(null);
    const newTextRef = useRef<{ id: string; snapshot: Item[] } | null>(null);
    /** An added text was being edited when the current click started (that click only closes it). */
    const editingAtPointerDownRef = useRef(false);
    /** The current click started on an added element. */
    const itemPressRef = useRef(false);
    const zoomAnchorRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | null>(null);
    const jsDocRef = useRef<{ file: File; promise: Promise<PDFDocumentProxy> } | null>(null);

    const isLg = useMediaQuery("(min-width: 1024px)");
    const isMd = useMediaQuery("(min-width: 768px)");
    const isTouch = useMediaQuery("(pointer: coarse)");
    const chromeH = useElementHeight(chromeEl);
    const bottomBarH = useElementHeight(bottomBarEl);
    const viewerActualH = useElementHeight(viewerEl);

    const zoom = zoomMode === "manual" ? manualZoom : zoomMode === "fit" ? fitZoom : Math.min(AUTO_MAX_ZOOM, fitZoom);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;

    const pageItems = useMemo(() => items.filter((it) => it.page === activePage), [items, activePage]);
    const pageTexts = sourceTexts[activePage];
    const pxPerPt = pageRender ? pageRender.cssWidth / pageRender.pdfWidth : EDITOR_CSS_WIDTH / 612;
    const selectedItem = selectedId ? (items.find((it) => it.id === selectedId) ?? null) : null;

    // ── History ─────────────────────────────────────────────────────────────────────────────────────
    /** Apply a change as one undo step. Changes with the same `coalesceKey` within a second merge into one step. */
    const commitItems = useCallback((fn: (prev: Item[]) => Item[], coalesceKey?: string) => {
        const now = Date.now();
        const last = coalesceRef.current;
        const merge = !!coalesceKey && !!last && last.key === coalesceKey && now - last.t < 1000;
        coalesceRef.current = coalesceKey ? { key: coalesceKey, t: now } : null;
        setDocState((d) => {
            const next = fn(d.items);
            if (next === d.items) return d;
            return { items: next, past: merge ? d.past : [...d.past, d.items].slice(-HISTORY_LIMIT), future: [] };
        });
    }, []);
    /** Change items without an undo step (live drag/resize after `snapshot()`). */
    const setItemsLive = useCallback((fn: (prev: Item[]) => Item[]) => setDocState((d) => ({ ...d, items: fn(d.items) })), []);
    const snapshot = useCallback(() => {
        coalesceRef.current = null;
        setDocState((d) => ({ ...d, past: [...d.past, d.items].slice(-HISTORY_LIMIT), future: [] }));
    }, []);
    const undo = useCallback(() => {
        coalesceRef.current = null;
        setDocState((d) => (d.past.length ? { items: d.past[d.past.length - 1], past: d.past.slice(0, -1), future: [d.items, ...d.future] } : d));
    }, []);
    const redo = useCallback(() => {
        coalesceRef.current = null;
        setDocState((d) => (d.future.length ? { items: d.future[0], past: [...d.past, d.items], future: d.future.slice(1) } : d));
    }, []);

    // ── Document ────────────────────────────────────────────────────────────────────────────────────
    const getJsDoc = useCallback((file: File) => {
        if (jsDocRef.current?.file !== file) {
            const old = jsDocRef.current;
            old?.promise.then((d) => d.destroy()).catch(() => undefined);
            jsDocRef.current = {
                file,
                promise: (async () => {
                    const pdfjs = await getPdfjs();
                    return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
                })(),
            };
        }
        return jsDocRef.current.promise;
    }, []);

    const resetAll = () => {
        baseReset();
        setDocState(EMPTY_DOC);
        setActivePage(1);
        setPageRender((prev) => {
            if (prev) URL.revokeObjectURL(prev.dataUrl);
            return null;
        });
        setPreview((prev) => {
            if (prev) URL.revokeObjectURL(prev.dataUrl);
            return null;
        });
        setSelectedId(null);
        setTool(defaultTool);
        setPendingImage(null);
        setEditingTextId(null);
        setActiveTextEdit(null);
        setSourceTexts({});
        setThumbDataUrls({});
        setZoomMode("auto");
        jsDocRef.current?.promise.then((d) => d.destroy()).catch(() => undefined);
        jsDocRef.current = null;
    };
    const requestReset = () => (items.length ? setConfirm({ kind: "reset" }) : resetAll());

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        setError(null);
        setOpening(file.name);
        try {
            // Damaged and password-protected files are refused here with a clear message (editing an encrypted PDF
            // would produce a corrupt, unopenable file).
            const doc = await loadPdfForEditing(file);
            setDocState(EMPTY_DOC);
            setSourceTexts({});
            setThumbDataUrls({});
            setPreview(null);
            setActivePage(1);
            setZoomMode("auto");
            fontBinariesRef.current = new Map();
            try {
                fontBinariesRef.current = await extractFontsFromPdf(file);
                // Register each extracted font as a @font-face under its PostScript name so canvas rendering of
                // edited text uses the exact same glyphs/metrics as pdfjs, under a UNIQUE namespaced family
                // ("LocalPDF-<psName>") to avoid clashing with system fonts (e.g. Next.js already loads "Inter").
                if (typeof document !== "undefined" && document.fonts) {
                    for (const [psName, info] of fontBinariesRef.current) {
                        try {
                            const familyName = `LocalPDF-${psName.replace(/^[A-Z]{6}\+/, "")}`;
                            if (Array.from(document.fonts).some((f) => f.family === familyName)) continue;
                            const ff = new FontFace(familyName, info.bytes as unknown as BufferSource);
                            await ff.load();
                            document.fonts.add(ff);
                        } catch {
                            /* font may not be a format the browser supports — ignore */
                        }
                    }
                }
            } catch {
                /* extraction is best-effort; fallback path still works */
            }
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            console.warn("[editor] could not open file", err);
            setError(friendlyError(err, "No se pudo abrir el archivo: no parece un PDF válido o está dañado."));
        } finally {
            setOpening(null);
        }
    };

    useEffect(() => {
        if (input) void ensureAddedTextFonts();
    }, [input]);

    useEffect(
        () => () => {
            jsDocRef.current?.promise.then((d) => d.destroy()).catch(() => undefined);
        },
        [],
    );

    // Render the active page whenever it or the input changes.
    useEffect(() => {
        if (!input) return;
        let aborted = false;
        (async () => {
            try {
                const doc = await getJsDoc(input.file);
                const page = await doc.getPage(activePage);
                const baseVp = page.getViewport({ scale: 1 });
                const targetCssWidth = EDITOR_CSS_WIDTH;
                const scale = targetCssWidth / baseVp.width;
                // Render at ≥2× the layout size so text stays crisp when zooming and on HiDPI screens.
                const pr = renderPixelRatio();
                const vp = page.getViewport({ scale: scale * pr });
                const canvas = document.createElement("canvas");
                canvas.width = Math.ceil(vp.width);
                canvas.height = Math.ceil(vp.height);
                const ctx = canvas.getContext("2d", { alpha: false });
                if (!ctx) throw new Error("Canvas no disponible");
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
                if (aborted) return;
                const url = await canvasToUrl(canvas);
                if (aborted) {
                    URL.revokeObjectURL(url);
                    return;
                }
                setPageRender((prev) => {
                    if (prev) URL.revokeObjectURL(prev.dataUrl);
                    return {
                        page: activePage,
                        dataUrl: url,
                        cssWidth: targetCssWidth,
                        cssHeight: Math.round(baseVp.height * scale * 100) / 100,
                        pdfWidth: baseVp.width,
                        pdfHeight: baseVp.height,
                    };
                });

                // Extract source text items only once per page (cache).
                if (!sourceTexts[activePage]) {
                    const extracted = await extractTextItems(page, activePage, targetCssWidth, canvas);
                    if (!aborted) setSourceTexts((prev) => ({ ...prev, [activePage]: extracted }));
                }
            } catch (err) {
                console.warn("[editor] page render failed", err);
                if (!aborted) setError(friendlyError(err, "No se pudo mostrar esta página del documento."));
            }
        })();
        return () => {
            aborted = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input, activePage, setError, getJsDoc]);

    // Text edits of the active page, as a stable key: the preview is rebuilt only when these change.
    const pageTextEdits = useMemo(
        () => items.filter((it): it is TextEditItem => it.type === "textEdit" && it.page === activePage && !textEditIsNoop(it)),
        [items, activePage],
    );
    const pageEditsKey = useMemo(
        () => JSON.stringify(pageTextEdits.map((it) => [it.id, it.newText, it.textColor, it.cssFontSize, it.bold, it.italic])),
        [pageTextEdits],
    );
    const previewFresh = !!preview && preview.page === activePage && preview.key === pageEditsKey;

    // True WYSIWYG: after each committed text edit, rebuild the page from the edited PDF and show that.
    useEffect(() => {
        if (!input || !pageRender) return;
        if (activeTextEdit) return; // wait until the user commits the edit being typed
        if (!pageTextEdits.length) {
            setPreview((prev) => {
                if (prev) URL.revokeObjectURL(prev.dataUrl);
                return null;
            });
            return;
        }
        if (preview && preview.page === activePage && preview.key === pageEditsKey) return;
        let aborted = false;
        const t = window.setTimeout(async () => {
            setPreviewBusy(true);
            try {
                const { bytes, stats } = await buildEditedPdf(await input.file.arrayBuffer(), pageTextEdits, fontBinariesRef.current);
                if (aborted) return;
                const { url, runs } = await renderPreviewPage(bytes, activePage, renderPixelRatio());
                // Decode before swapping it in: the chips turn transparent as soon as the preview is marked fresh,
                // and must never reveal a page image that is still loading.
                try {
                    const im = new Image();
                    im.src = url;
                    await im.decode();
                } catch {
                    /* shown anyway */
                }
                if (!aborted)
                    setPreview((prev) => {
                        if (prev) URL.revokeObjectURL(prev.dataUrl);
                        return { page: activePage, key: pageEditsKey, dataUrl: url, modes: stats.modes, runs };
                    });
                else URL.revokeObjectURL(url);
            } catch (err) {
                if (!aborted) console.warn("[editor] preview failed", err);
            } finally {
                if (!aborted) setPreviewBusy(false);
            }
        }, 200);
        return () => {
            aborted = true;
            window.clearTimeout(t);
            setPreviewBusy(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input, pageRender, activePage, pageEditsKey, activeTextEdit]);

    // ── Zoom ────────────────────────────────────────────────────────────────────────────────────────
    const viewerCallbackRef = useCallback((el: HTMLDivElement | null) => {
        viewerRef.current = el;
        setViewerEl(el);
    }, []);
    const chromeCallbackRef = useCallback((el: HTMLDivElement | null) => {
        chromeRef.current = el;
        setChromeEl(el);
    }, []);

    // Real fit-to-width, recomputed whenever the viewer changes size (window, thumbnails rail, sidebar).
    useEffect(() => {
        if (!viewerEl) return;
        const measure = () => {
            const inner = viewerEl.firstElementChild as HTMLElement | null;
            const cs = inner ? getComputedStyle(inner) : null;
            const pad = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 32;
            const avail = viewerEl.clientWidth - pad;
            if (avail > 0) setFitZoom(clamp(Math.floor((avail / EDITOR_CSS_WIDTH) * 1000) / 1000, MIN_ZOOM, MAX_ZOOM));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(viewerEl);
        measure();
        return () => ro.disconnect();
    }, [viewerEl]);

    /** Change the zoom keeping the point under `anchor` (or the centre of the viewer) where it is. */
    const zoomTo = useCallback((mode: ZoomMode, value?: number, anchor?: { clientX: number; clientY: number }) => {
        const v = viewerRef.current;
        const p = pageFrameRef.current;
        if (v && p) {
            const vr = v.getBoundingClientRect();
            const pr = p.getBoundingClientRect();
            const vx = anchor ? anchor.clientX - vr.left : v.clientWidth / 2;
            const vy = anchor ? anchor.clientY - vr.top : v.clientHeight / 2;
            zoomAnchorRef.current = { cx: (vx - (pr.left - vr.left)) / zoomRef.current, cy: (vy - (pr.top - vr.top)) / zoomRef.current, vx, vy };
        }
        if (mode === "manual" && value !== undefined) setManualZoom(clamp(Math.round(value * 100) / 100, MIN_ZOOM, MAX_ZOOM));
        setZoomMode(mode);
    }, []);

    useLayoutEffect(() => {
        const a = zoomAnchorRef.current;
        zoomAnchorRef.current = null;
        const v = viewerRef.current;
        const p = pageFrameRef.current;
        if (!a || !v || !p) return;
        const vr = v.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        v.scrollLeft = pr.left - vr.left + v.scrollLeft + a.cx * zoom - a.vx;
        v.scrollTop = pr.top - vr.top + v.scrollTop + a.cy * zoom - a.vy;
    }, [zoom]);

    const zoomStep = (dir: 1 | -1) => {
        const cur = zoomRef.current;
        const next = dir > 0 ? (ZOOM_STEPS.find((z) => z > cur + 0.005) ?? MAX_ZOOM) : ([...ZOOM_STEPS].reverse().find((z) => z < cur - 0.005) ?? MIN_ZOOM);
        zoomTo("manual", next);
    };

    // Ctrl/⌘ + wheel (and trackpad pinch) zooms the page instead of the whole browser tab.
    useEffect(() => {
        if (!viewerEl) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            zoomTo("manual", zoomRef.current * Math.exp(-e.deltaY * 0.0025), { clientX: e.clientX, clientY: e.clientY });
        };
        viewerEl.addEventListener("wheel", onWheel, { passive: false });
        return () => viewerEl.removeEventListener("wheel", onWheel);
    }, [viewerEl, zoomTo]);

    // Phones: tools with options show them where the hint goes, so their hint appears briefly over the page instead.
    const [tip, setTip] = useState<{ key: number; text: string } | null>(null);
    const hasInput = !!input;
    useEffect(() => {
        if (!hasInput || isMd || !colorKeyForTool(tool)) {
            setTip(null);
            return;
        }
        setTip({ key: Date.now(), text: hintFor(tool, mode, isTouch) });
        const t = window.setTimeout(() => setTip(null), 3500);
        return () => window.clearTimeout(t);
    }, [tool, isMd, isTouch, hasInput, mode]);

    // ── Leaving with unsaved work ───────────────────────────────────────────────────────────────────
    const unsavedRef = useRef(false);
    unsavedRef.current = !!input && !result && (items.length > 0 || !!activeTextEdit || !!editingTextId);
    const committedRef = useRef(0);
    committedRef.current = result ? 0 : items.length;
    const guardActive = !!input && !result;
    useEffect(() => {
        if (!guardActive) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (!unsavedRef.current) return;
            e.preventDefault();
            e.returnValue = "";
        };
        // In-app links (sidebar, breadcrumb, logo) navigate without unloading the page: ask first. By the time the
        // click arrives, its pointerdown has already committed any text being typed.
        const onClickCapture = (e: MouseEvent) => {
            if (!committedRef.current || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
            const url = new URL(a.href, window.location.href);
            if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
            e.preventDefault();
            e.stopPropagation();
            setConfirm({ kind: "navigate", href: url.pathname + url.search + url.hash });
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        document.addEventListener("click", onClickCapture, true);
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            document.removeEventListener("click", onClickCapture, true);
        };
    }, [guardActive]);

    // ── Tools ───────────────────────────────────────────────────────────────────────────────────────
    const changeTool = (t: Tool) => {
        setTool(t);
        setSelectedId(null);
        setEditingTextId(null);
        if (t !== "image") setPendingImage(null);
    };

    const goToPage = (n: number) => {
        if (!input) return;
        const page = clamp(n, 1, input.pageCount);
        if (page === activePage) return;
        setActivePage(page);
        setSelectedId(null);
        setEditingTextId(null);
        setActiveTextEdit(null);
        viewerRef.current?.scrollTo({ top: 0, left: 0 });
    };

    const deleteSelected = () => {
        if (!selectedId) return;
        const id = selectedId;
        commitItems((prev) => prev.filter((it) => it.id !== id));
        setSelectedId(null);
        setEditingTextId(null);
    };

    // Keyboard: undo/redo anywhere outside text fields; delete, nudge and Esc for the selected element.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            // Text fields keep their own keys; radios, colour pickers and sliders don't block the shortcuts.
            const typing =
                !!t &&
                (t.isContentEditable ||
                    /^(textarea|select)$/i.test(t.tagName) ||
                    (t.tagName === "INPUT" && !/^(radio|checkbox|range|color|button|submit|file)$/i.test((t as HTMLInputElement).type)));
            if (typing) return;
            if (!input || result) return;
            const cmd = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (cmd && key === "z" && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            if (cmd && (key === "y" || (key === "z" && e.shiftKey))) {
                e.preventDefault();
                redo();
                return;
            }
            if (e.key === "Escape") {
                if (pendingImage) {
                    setPendingImage(null);
                    setTool(defaultTool);
                } else setSelectedId(null);
                return;
            }
            if (!selectedId) return;
            // Don't steal keys from the toolbar (arrow keys move between tools there).
            const onPage = !t || t === document.body || !!canvasRef.current?.contains(t);
            if (!onPage) return;
            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                deleteSelected();
            } else if (e.key.startsWith("Arrow")) {
                e.preventDefault();
                const d = e.shiftKey ? 10 : 1;
                const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
                const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
                const id = selectedId;
                commitItems((prev) => prev.map((it) => (it.id === id ? moveItem(it, dx, dy) : it)), `nudge:${id}`);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    // ── Style options (bound to the selection when there is one) ────────────────────────────────────
    const optionKey: ColorKey | null = selectedItem && tool === "select" ? colorKeyForItem(selectedItem) : colorKeyForTool(tool);
    const optionColor = (selectedItem && tool === "select" ? itemColor(selectedItem) : null) ?? (optionKey ? colors[optionKey] : "#000000");
    const selectedText = selectedItem?.type === "text" && tool === "select" ? selectedItem : null;
    const sizeKey: "text" | "note" | null = selectedText ? (selectedText.note ? "note" : "text") : tool === "text" || tool === "note" ? tool : null;
    const sizePt = selectedText ? Math.round((selectedText.fontSize / pxPerPt) * 2) / 2 : sizeKey ? fontSizes[sizeKey] : 12;
    const strokeKey: "draw" | "rectangle" | null =
        selectedItem && tool === "select"
            ? selectedItem.type === "rectangle"
                ? "rectangle"
                : selectedItem.type === "drawing" && !selectedItem.kind
                  ? "draw"
                  : null
            : tool === "draw" || tool === "rectangle"
              ? tool
              : null;
    const strokeValue =
        selectedItem && tool === "select" && (selectedItem.type === "rectangle" || selectedItem.type === "drawing")
            ? Math.round(selectedItem.type === "rectangle" ? selectedItem.strokeWidth : selectedItem.width)
            : strokeKey
              ? strokeWidths[strokeKey]
              : 3;
    const fillOn = selectedItem?.type === "rectangle" && tool === "select" ? !!selectedItem.fill : rectFill;

    const changeColor = (value: string) => {
        if (optionKey) setColors((c) => ({ ...c, [optionKey]: value }));
        if (selectedItem && tool === "select") {
            const id = selectedItem.id;
            commitItems((prev) => prev.map((it) => (it.id === id ? withColor(it, value) : it)), `color:${id}`);
        }
    };
    const changeSize = (pt: number) => {
        if (sizeKey) setFontSizes((s) => ({ ...s, [sizeKey]: pt }));
        if (selectedText) {
            const id = selectedText.id;
            commitItems((prev) => prev.map((it) => (it.id === id && it.type === "text" ? { ...it, fontSize: pt * pxPerPt } : it)), `size:${id}`);
        }
    };
    const changeStroke = (w: number) => {
        if (strokeKey) setStrokeWidths((s) => ({ ...s, [strokeKey]: w }));
        if (selectedItem && tool === "select") {
            const id = selectedItem.id;
            commitItems(
                (prev) =>
                    prev.map((it) =>
                        it.id !== id ? it : it.type === "rectangle" ? { ...it, strokeWidth: w } : it.type === "drawing" ? { ...it, width: w } : it,
                    ),
                `stroke:${id}`,
            );
        }
    };
    const toggleFill = (on: boolean) => {
        setRectFill(on);
        if (selectedItem?.type === "rectangle" && tool === "select") {
            const id = selectedItem.id;
            commitItems((prev) => prev.map((it) => (it.id === id && it.type === "rectangle" ? { ...it, fill: on ? it.stroke : null } : it)));
        }
    };

    // ── Pointer input on the page ───────────────────────────────────────────────────────────────────
    const ptOnCanvas = (e: { clientX: number; clientY: number }): Pt | null => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return null;
        // The bbox is scaled by the zoom; item coordinates are canonical (zoom = 1).
        return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
    };

    const handleImageFile = (file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            const src = reader.result as string;
            const img = new window.Image();
            img.onload = () => {
                const isPng = /png/i.test(file.type);
                const isJpg = /jpe?g/i.test(file.type);
                let dataUrl = src;
                if (!isPng && !isJpg) {
                    // pdf-lib embeds PNG and JPEG only: convert anything else the browser can decode (WebP, GIF, SVG…).
                    const c = document.createElement("canvas");
                    c.width = img.naturalWidth || 800;
                    c.height = img.naturalHeight || 600;
                    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
                    dataUrl = c.toDataURL("image/png");
                }
                setPendingImage({ dataUrl, isPng: !isJpg, w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
                setSelectedId(null);
                setTool("image");
            };
            img.onerror = () => setError("No se pudo leer la imagen. Prueba con un archivo PNG o JPG.");
            img.src = src;
        };
        reader.readAsDataURL(file);
    };

    const placeImage = (p: Pt) => {
        if (!pendingImage || !pageRender) return;
        const id = newId();
        const ratio = Math.min(1, (pageRender.cssWidth * 0.45) / pendingImage.w, (pageRender.cssHeight * 0.4) / pendingImage.h);
        const w = pendingImage.w * ratio;
        const h = pendingImage.h * ratio;
        const x = clamp(p.x - w / 2, 0, Math.max(0, pageRender.cssWidth - w));
        const y = clamp(p.y - h / 2, 0, Math.max(0, pageRender.cssHeight - h));
        commitItems((prev) => [
            ...prev,
            { id, type: "image", page: activePage, x, y, width: w, height: h, dataUrl: pendingImage.dataUrl, isPng: pendingImage.isPng },
        ]);
        setPendingImage(null);
        setTool("select");
        setSelectedId(id);
    };

    const createTextAt = (p: Pt, note: boolean) => {
        const key = note ? "note" : "text";
        const fontSize = fontSizes[key] * pxPerPt;
        const id = newId();
        const item: TextItem = note
            ? {
                  id,
                  type: "text",
                  page: activePage,
                  x: p.x,
                  y: p.y - fontSize * 0.6,
                  text: "",
                  fontSize,
                  color: noteTextColorFor(colors.note),
                  note: true,
                  background: colors.note,
              }
            : { id, type: "text", page: activePage, x: p.x, y: p.y - (fontSize * ADDED_TEXT_LINE_HEIGHT) / 2, text: "", fontSize, color: colors.text };
        // Not an undo step until it has text: an empty box that is abandoned simply disappears.
        newTextRef.current = { id, snapshot: items };
        setItemsLive((prev) => [...prev, item]);
        setSelectedId(id);
        setEditingTextId(id);
    };

    const onTextCommit = (id: string, raw: string) => {
        const text = raw.replace(/\t/g, "    ").replace(/\s+$/, "");
        const fresh = newTextRef.current?.id === id ? newTextRef.current : null;
        newTextRef.current = null;
        setEditingTextId(null);
        if (fresh) {
            if (!text.trim()) {
                setItemsLive((prev) => prev.filter((it) => it.id !== id));
                setSelectedId(null);
                return;
            }
            coalesceRef.current = null;
            setDocState((d) => ({
                items: d.items.map((it) => (it.id === id && it.type === "text" ? { ...it, text } : it)),
                past: [...d.past, fresh.snapshot].slice(-HISTORY_LIMIT),
                future: [],
            }));
            return;
        }
        const current = items.find((it) => it.id === id);
        if (!current || current.type !== "text" || current.text === text) return;
        if (!text.trim()) {
            commitItems((prev) => prev.filter((it) => it.id !== id));
            setSelectedId(null);
        } else commitItems((prev) => prev.map((it) => (it.id === id && it.type === "text" ? { ...it, text } : it)));
    };

    const onTextCancel = (id: string) => {
        setEditingTextId(null);
        if (newTextRef.current?.id === id) {
            newTextRef.current = null;
            setItemsLive((prev) => prev.filter((it) => it.id !== id));
            setSelectedId(null);
        }
    };

    const isDrawTool = DRAW_TOOLS.includes(tool);

    const onCanvasPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
        if (!isDrawTool || !pageRender) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        if (drawPointerRef.current !== null) {
            // A second finger: that's a pinch, not a stroke.
            drawPointerRef.current = null;
            setDraftDraw(null);
            setDraftRect(null);
            return;
        }
        const p = ptOnCanvas(e);
        if (!p) return;
        e.preventDefault();
        drawPointerRef.current = e.pointerId;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        if (tool === "draw") setDraftDraw([p]);
        else setDraftRect({ start: p, end: p });
    };

    const onCanvasPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
        if (e.pointerId !== drawPointerRef.current) return;
        if (draftDraw) {
            const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
            const pts = (events.length ? events : [e]).map((ev) => ptOnCanvas(ev)).filter((p): p is Pt => !!p);
            if (pts.length) setDraftDraw((prev) => (prev ? [...prev, ...pts] : prev));
        } else if (draftRect) {
            const p = ptOnCanvas(e);
            if (p) setDraftRect((prev) => (prev ? { ...prev, end: p } : prev));
        }
    };

    const finishMarkup = (start: Pt, end: Pt) => {
        const color = colors[tool as ColorKey];
        const runs = pageTexts ?? [];
        const lines = textLinesForDrag(runs, start, end);
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        const created: Item[] = [];
        if (tool === "highlight") {
            if (lines.length) {
                for (const s of lines) {
                    const pad = s.line.size * 0.08;
                    created.push({
                        id: newId(),
                        type: "highlight",
                        page: activePage,
                        x: s.x0,
                        y: s.line.top - pad,
                        width: s.x1 - s.x0,
                        height: s.line.bottom - s.line.top + pad * 2,
                        color,
                    });
                }
            } else if (w > 3 && h > 3) created.push({ id: newId(), type: "highlight", page: activePage, x, y, width: w, height: h, color });
        } else {
            const kind = tool === "underline" ? "underline" : "strike";
            if (lines.length) {
                for (const s of lines) {
                    const ly = kind === "underline" ? s.line.baseline + s.line.size * 0.12 : s.line.baseline - s.line.size * 0.28;
                    const width = Math.max(1, Math.round(s.line.size * 0.07 * 10) / 10);
                    created.push({
                        id: newId(),
                        type: "drawing",
                        kind,
                        page: activePage,
                        points: [
                            { x: s.x0, y: ly },
                            { x: s.x1, y: ly },
                        ],
                        color,
                        width,
                    });
                }
            } else if (w > 3) {
                const ly = kind === "underline" ? y + h : y + h / 2;
                created.push({
                    id: newId(),
                    type: "drawing",
                    kind,
                    page: activePage,
                    points: [
                        { x, y: ly },
                        { x: x + w, y: ly },
                    ],
                    color,
                    width: 2,
                });
            }
        }
        if (created.length) commitItems((prev) => [...prev, ...created]);
    };

    const onCanvasPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
        if (e.pointerId !== drawPointerRef.current) return;
        drawPointerRef.current = null;
        if (draftDraw) {
            if (draftDraw.length > 2) {
                const pts = draftDraw;
                commitItems((prev) => [...prev, { id: newId(), type: "drawing", page: activePage, points: pts, color: colors.draw, width: strokeWidths.draw }]);
            }
            setDraftDraw(null);
        }
        if (draftRect) {
            const { start, end } = draftRect;
            if (tool === "rectangle") {
                const x = Math.min(start.x, end.x);
                const y = Math.min(start.y, end.y);
                const w = Math.abs(end.x - start.x);
                const h = Math.abs(end.y - start.y);
                if (w > 3 && h > 3) {
                    const stroke = colors.rectangle;
                    commitItems((prev) => [
                        ...prev,
                        {
                            id: newId(),
                            type: "rectangle",
                            page: activePage,
                            x,
                            y,
                            width: w,
                            height: h,
                            stroke,
                            fill: rectFill ? stroke : null,
                            strokeWidth: strokeWidths.rectangle,
                        },
                    ]);
                }
            } else finishMarkup(start, end);
            setDraftRect(null);
        }
    };

    const onCanvasPointerCancel = (e: RPointerEvent<HTMLDivElement>) => {
        if (e.pointerId !== drawPointerRef.current) return;
        drawPointerRef.current = null;
        setDraftDraw(null);
        setDraftRect(null);
    };

    const onCanvasClick = (e: RMouseEvent<HTMLDivElement>) => {
        if (!pageRender) return;
        // Touch taps on an element can be delivered to the page underneath: that tap was the element's.
        if (itemPressRef.current) return;
        const p = ptOnCanvas(e);
        if (!p) return;
        if (tool === "text" || tool === "note") {
            // The click that closes a text box shouldn't open another one.
            if (editingAtPointerDownRef.current) return;
            createTextAt(p, tool === "note");
            return;
        }
        if (tool === "image" && pendingImage) {
            placeImage(p);
            return;
        }
        if (tool === "select" || tool === "editText") setSelectedId(null);
    };

    // ── Existing text (edit mode) ───────────────────────────────────────────────────────────────────
    const textLayer = mode === "edit" && (tool === "select" || tool === "editText") && !!pageRender && pageRender.page === activePage;
    const editsBySource = useMemo(() => {
        const m = new Map<string, TextEditItem>();
        for (const it of items) if (it.type === "textEdit") m.set(it.sourceId, it);
        return m;
    }, [items]);

    const commitTextEdit = (src: ExtractedText, draft: TextDraft) => {
        const existing = editsBySource.get(src.id);
        // Trailing/leading whitespace alone is not an edit.
        const newText = draft.text.trim() === src.str.trim() ? src.str : draft.text;
        const base = existing ?? textEditFromSource(src);
        const next: TextEditItem = { ...base, newText, textColor: draft.textColor, cssFontSize: draft.cssFontSize, bold: draft.bold, italic: draft.italic };
        setActiveTextEdit(null);
        if (textEditIsNoop(next)) {
            if (existing) commitItems((prev) => prev.filter((it) => it.id !== existing.id));
            return;
        }
        if (existing) {
            const same =
                existing.newText === next.newText &&
                existing.textColor === next.textColor &&
                Math.abs(existing.cssFontSize - next.cssFontSize) < 0.01 &&
                existing.bold === next.bold &&
                existing.italic === next.italic;
            if (!same) commitItems((prev) => prev.map((it) => (it.id === existing.id ? next : it)));
            return;
        }
        commitItems((prev) => [...prev, next]);
    };

    // ── Apply ───────────────────────────────────────────────────────────────────────────────────────
    const apply = async () => {
        if (!input || !items.length) return;
        setError(null);
        setBusy(true);
        try {
            const { bytes, stats } = await buildEditedPdf(await input.file.arrayBuffer(), items, fontBinariesRef.current);
            if (stats.failed.length && stats.failed.length >= items.length) {
                setError("No se pudo aplicar ningún cambio al documento. Inténtalo de nuevo.");
                return;
            }
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            const pages = new Set(items.map((it) => it.page)).size;
            const notes: string[] = [];
            if (stats.native) notes.push(`${plural(stats.native, "texto editado", "textos editados")} en el propio documento`);
            if (stats.overlay) notes.push(`${plural(stats.overlay, "texto sustituido", "textos sustituidos")} por superposición`);
            const clipped = Object.values(stats.modes).filter((m) => m === "clipped").length;
            if (clipped) notes.push(`${clipped} no ${clipped === 1 ? "cabe" : "caben"} en su celda y se recorta`);
            if (stats.rasterizedText)
                notes.push(
                    stats.rasterizedText === 1
                        ? "1 texto con emojis u otros caracteres especiales se ha guardado como imagen"
                        : `${stats.rasterizedText} textos con emojis u otros caracteres especiales se han guardado como imagen`,
                );
            if (stats.failed.length) notes.push(plural(stats.failed.length, "cambio no se pudo aplicar", "cambios no se pudieron aplicar"));
            setResult({
                blob,
                filename: datedFilename(`${base}-${mode === "annotate" ? "anotado" : "editado"}`, "pdf"),
                summary: [`${plural(items.length, copy.one, copy.many)} en ${pagesLabel(pages)}`, readableBytes(blob.size), ...notes].join(" · "),
            });
        } catch (err) {
            console.warn("[editor] apply failed", err);
            setError(friendlyError(err, "No se pudo guardar el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    // ── Render ──────────────────────────────────────────────────────────────────────────────────────
    const errorNode =
        error === PROTECTED_PDF_MESSAGE ? (
            <Notice tone="error" title="Este PDF está protegido con contraseña">
                <span>Quítale la protección y vuelve a abrirlo aquí. </span>
                <Button href="/tools/unlock" color="link-color" size="sm">
                    Ir a Desproteger PDF
                </Button>
            </Notice>
        ) : (
            <ErrorBanner message={error} />
        );

    const confirmDialog = (
        <DiscardDialog
            state={confirm}
            count={items.length}
            noun={[copy.one, copy.many]}
            onClose={() => setConfirm(null)}
            onConfirm={() => {
                const c = confirm;
                setConfirm(null);
                if (c?.kind === "navigate") {
                    // Drop the guard before navigating.
                    setDocState(EMPTY_DOC);
                    router.push(c.href);
                } else resetAll();
            }}
        />
    );

    if (result) {
        return (
            <ToolPageLayout title={copy.title} description={copy.description} width="wide">
                <SuccessPanel
                    result={result}
                    onReset={resetAll}
                    onBack={() => setResult(null)}
                    backLabel={mode === "annotate" ? "Volver a las anotaciones" : "Volver al editor"}
                />
            </ToolPageLayout>
        );
    }

    const changesLabel = items.length ? plural(items.length, copy.one, copy.many) : copy.none;
    const stickyTop = isLg ? 0 : 56;
    const viewerHeight = `max(22rem, calc(100dvh - ${Math.round(stickyTop + chromeH + (isLg ? 0 : bottomBarH) + 20)}px))`;
    const pageReady = !!pageRender && pageRender.page === activePage;
    const noEditableText = mode === "edit" && (tool === "editText" || tool === "select") && pageReady && Array.isArray(pageTexts) && pageTexts.length === 0;
    const showRail = !!input && input.pageCount > 1 && showThumbs;

    const hint: ReactNode = noEditableText ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium text-utility-yellow-700">
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-fg-warning-primary" />
            <span>Esta página no tiene texto editable. Si es un documento escaneado,</span>
            <Button href="/tools/ocr" color="link-color" size="xs">
                hazlo editable con OCR
            </Button>
        </span>
    ) : tool === "image" ? (
        <span className="flex min-w-0 items-center gap-2">
            <Image01 aria-hidden="true" className="size-3.5 shrink-0 text-fg-brand-secondary" />
            <span className="min-w-0 truncate font-medium text-secondary">{hintFor("image", mode, isTouch)}</span>
            <Button
                size="xs"
                color="link-gray"
                onClick={() => {
                    setPendingImage(null);
                    setTool(defaultTool);
                }}
            >
                Cancelar
            </Button>
        </span>
    ) : (
        <span className="flex min-w-0 items-center gap-2">
            <InfoCircle aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
            <span className="min-w-0 max-md:line-clamp-2 md:truncate" title={hintFor(tool, mode, isTouch)}>
                {hintFor(tool, mode, isTouch)}
            </span>
        </span>
    );

    return (
        <ToolPageLayout title={copy.title} description={copy.description} width="wide">
            {!input && !opening && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint={copy.drop} onDropFiles={handleFile} />}

            {opening && (
                <div role="status" className="flex items-center gap-3 rounded-2xl bg-primary p-5 ring-1 ring-secondary ring-inset">
                    <Spinner className="size-5 text-fg-brand-primary" />
                    <p className="min-w-0 truncate text-sm font-medium text-secondary">Abriendo «{opening}»…</p>
                </div>
            )}

            {errorNode}

            {input && (
                <section aria-label={copy.title} className="flex flex-col rounded-2xl bg-primary ring-1 ring-secondary ring-inset">
                    {/* File header */}
                    <div className="flex items-center gap-3 px-3 py-3 md:px-4">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-secondary ring-inset">
                            <File04 aria-hidden="true" className="size-5 text-fg-quaternary" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-primary">{input.file.name}</p>
                            <p className="truncate text-xs text-tertiary">
                                {pagesLabel(input.pageCount)} · {readableBytes(input.file.size)}
                                <span className="max-lg:hidden"> · {changesLabel}</span>
                            </p>
                        </div>
                        <Button color="secondary" size="sm" onClick={requestReset}>
                            Cambiar archivo
                        </Button>
                        <Button
                            color="primary"
                            size="sm"
                            iconLeading={Save01}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={items.length === 0}
                            onClick={apply}
                            className="max-lg:hidden"
                        >
                            {isBusy ? copy.busy : copy.verb}
                        </Button>
                    </div>

                    {/* Toolbar (stays on screen while scrolling) */}
                    <div
                        ref={chromeCallbackRef}
                        className="sticky top-14 z-20 border-y border-secondary bg-primary/95 px-3 py-2 backdrop-blur md:px-4 lg:top-0"
                    >
                        <div
                            className="flex flex-wrap items-center gap-x-2 gap-y-2"
                            onFocus={(e) => {
                                // Tabbing into the tool group lands on the selected tool, like any radio group.
                                const t = e.target as HTMLElement;
                                const group = t.closest("[role=radiogroup]");
                                if (
                                    !group ||
                                    group.contains(e.relatedTarget as Node | null) ||
                                    t.getAttribute("aria-checked") === "true" ||
                                    !t.matches(":focus-visible")
                                )
                                    return;
                                group.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus();
                            }}
                        >
                            <AriaToggleButtonGroup
                                aria-label={mode === "annotate" ? "Herramientas de anotación" : "Herramientas de edición"}
                                selectionMode="single"
                                disallowEmptySelection
                                selectedKeys={tool === "image" ? [] : [tool]}
                                onSelectionChange={(keys) => {
                                    const k = [...keys][0];
                                    if (k) changeTool(k as Tool);
                                }}
                                className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5 ring-1 ring-secondary ring-inset"
                            >
                                {TOOLS.map((t) => (
                                    <Tooltip key={t.id} title={t.label} placement="bottom" isDisabled={isMd}>
                                        <AriaToggleButton
                                            id={t.id}
                                            aria-label={isMd ? undefined : t.label}
                                            className={({ isSelected, isFocusVisible }) =>
                                                cx(
                                                    "inline-flex h-9 min-w-9 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold whitespace-nowrap outline-focus-ring transition duration-100 ease-linear md:h-8 md:px-2.5",
                                                    isSelected
                                                        ? "bg-brand-solid text-white shadow-xs"
                                                        : "text-secondary hover:bg-primary_hover hover:text-primary",
                                                    isFocusVisible && "outline-2 outline-offset-2",
                                                )
                                            }
                                        >
                                            <t.icon aria-hidden="true" className="size-4 shrink-0" />
                                            <span className="max-md:sr-only">{t.label}</span>
                                        </AriaToggleButton>
                                    </Tooltip>
                                ))}
                            </AriaToggleButtonGroup>

                            {mode === "edit" && (
                                <Tooltip title="Insertar imagen" placement="bottom" isDisabled={isMd}>
                                    <AriaButton
                                        aria-label={isMd ? undefined : "Imagen"}
                                        aria-pressed={tool === "image"}
                                        onPress={() => imageInputRef.current?.click()}
                                        className={cx(
                                            "inline-flex h-9 min-w-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold whitespace-nowrap ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset focus-visible:outline-2 focus-visible:outline-offset-2 md:h-9 md:px-2.5",
                                            tool === "image"
                                                ? "bg-brand-solid text-white ring-transparent"
                                                : "bg-primary text-secondary ring-secondary hover:bg-primary_hover",
                                        )}
                                    >
                                        <Image01 aria-hidden="true" className="size-4 shrink-0" />
                                        <span className="max-md:sr-only">Imagen</span>
                                    </AriaButton>
                                </Tooltip>
                            )}

                            {optionKey && (
                                // Phones: one row that scrolls sideways and takes the hint's place, so selecting an
                                // element never pushes the page down under the finger.
                                <div className="flex items-center gap-x-3 max-md:order-last max-md:-mx-3 max-md:h-11 max-md:w-[calc(100%+1.5rem)] max-md:[scrollbar-width:none] max-md:overflow-x-auto max-md:px-3 md:flex-wrap md:gap-y-2">
                                    <ColorField
                                        value={optionColor}
                                        presets={PRESETS[optionKey]}
                                        onChange={changeColor}
                                        label={optionKey === "note" ? "Color de la nota" : "Color"}
                                    />
                                    {sizeKey && <SizeStepper label="Tamaño del texto" value={sizePt} min={6} max={144} step={1} onChange={changeSize} />}
                                    {strokeKey && <StrokeField value={strokeValue} onChange={changeStroke} />}
                                    {optionKey === "rectangle" && (
                                        <AriaToggleButton
                                            isSelected={fillOn}
                                            onChange={toggleFill}
                                            className={({ isSelected, isFocusVisible }) =>
                                                cx(
                                                    "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset",
                                                    isSelected
                                                        ? "bg-brand-primary_alt text-brand-secondary ring-brand"
                                                        : "bg-primary text-secondary ring-primary hover:bg-primary_hover",
                                                    isFocusVisible && "outline-2 outline-offset-2",
                                                )
                                            }
                                        >
                                            <PaintPour aria-hidden="true" className="size-4" />
                                            Relleno
                                        </AriaToggleButton>
                                    )}
                                </div>
                            )}

                            <div className="ml-auto flex items-center gap-0.5 max-md:hidden">
                                <ButtonUtility
                                    color="tertiary"
                                    tooltip="Deshacer (Ctrl+Z)"
                                    icon={FlipBackward}
                                    size="xs"
                                    isDisabled={!docState.past.length}
                                    onClick={undo}
                                    className="pointer-coarse:p-2.5"
                                />
                                <ButtonUtility
                                    color="tertiary"
                                    tooltip="Rehacer (Ctrl+Y)"
                                    icon={FlipForward}
                                    size="xs"
                                    isDisabled={!docState.future.length}
                                    onClick={redo}
                                    className="pointer-coarse:p-2.5"
                                />
                                <ButtonUtility
                                    color="tertiary"
                                    tooltip="Eliminar (Supr)"
                                    icon={Trash01}
                                    size="xs"
                                    isDisabled={!selectedItem}
                                    onClick={deleteSelected}
                                    className="pointer-coarse:p-2.5"
                                />
                            </div>
                        </div>
                        <div
                            className={cx(
                                "flex min-h-5 items-center pt-1.5 text-xs text-tertiary max-md:min-h-[3.25rem] max-md:pt-2",
                                optionKey && "max-md:hidden",
                            )}
                        >
                            {hint}
                        </div>
                    </div>

                    {/* Workspace: thumbnails rail + page viewer */}
                    <div className="flex gap-3 p-2 md:p-3">
                        {showRail && (
                            <EditorThumbsRail
                                getDoc={() => getJsDoc(input.file)}
                                file={input.file}
                                pageCount={input.pageCount}
                                activePage={activePage}
                                height={viewerActualH ? `${viewerActualH}px` : viewerHeight}
                                countsByPage={items.reduce<Record<number, number>>((acc, it) => ((acc[it.page] = (acc[it.page] ?? 0) + 1), acc), {})}
                                onPick={goToPage}
                                cache={thumbDataUrls}
                                onCacheUpdate={setThumbDataUrls}
                                noun={[copy.one, copy.many]}
                            />
                        )}

                        <div className="relative min-w-0 flex-1">
                            <ViewerControls
                                zoom={zoom}
                                zoomMode={zoomMode}
                                page={activePage}
                                pageCount={input.pageCount}
                                showThumbs={showThumbs}
                                onToggleThumbs={() => setShowThumbs((v) => !v)}
                                onPage={goToPage}
                                onZoomOut={() => zoomStep(-1)}
                                onZoomIn={() => zoomStep(1)}
                                onActualSize={() => zoomTo("manual", 1)}
                                onFit={() => zoomTo("fit")}
                            />
                            <div
                                ref={viewerCallbackRef}
                                data-editor-viewer
                                className="[scrollbar-gutter:stable] overflow-auto rounded-xl bg-tertiary"
                                style={{ maxHeight: viewerHeight }}
                            >
                                <div className="w-max min-w-full px-3 pt-3 pb-16 md:px-6 md:pt-6">
                                    {pageRender && pageReady ? (
                                        <div
                                            ref={pageFrameRef}
                                            className="relative mx-auto bg-white shadow-lg ring-1 ring-black/10"
                                            style={{ width: pageRender.cssWidth * zoom, height: pageRender.cssHeight * zoom }}
                                        >
                                            <div
                                                style={{
                                                    transform: `scale(${zoom})`,
                                                    transformOrigin: "0 0",
                                                    width: pageRender.cssWidth,
                                                    height: pageRender.cssHeight,
                                                }}
                                            >
                                                <div
                                                    ref={canvasRef}
                                                    onPointerDownCapture={() => {
                                                        editingAtPointerDownRef.current = editingTextId !== null;
                                                        itemPressRef.current = false;
                                                    }}
                                                    onPointerDown={onCanvasPointerDown}
                                                    onPointerMove={onCanvasPointerMove}
                                                    onPointerUp={onCanvasPointerUp}
                                                    onPointerCancel={onCanvasPointerCancel}
                                                    onClick={onCanvasClick}
                                                    data-editor-canvas
                                                    className="relative overflow-hidden bg-white select-none"
                                                    style={{
                                                        width: pageRender.cssWidth,
                                                        height: pageRender.cssHeight,
                                                        // Drawing tools own one-finger gestures (pinch still zooms); the rest let the page pan.
                                                        touchAction: isDrawTool ? "pinch-zoom" : "pan-x pan-y pinch-zoom",
                                                        cursor: isDrawTool
                                                            ? "crosshair"
                                                            : tool === "text" || tool === "note"
                                                              ? "text"
                                                              : tool === "image"
                                                                ? "copy"
                                                                : "default",
                                                    }}
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={
                                                            preview && preview.page === activePage && pageTextEdits.length
                                                                ? preview.dataUrl
                                                                : pageRender.dataUrl
                                                        }
                                                        alt={`Página ${activePage} de ${input.pageCount}`}
                                                        className="pointer-events-none absolute inset-0 size-full"
                                                        draggable={false}
                                                        data-preview={previewFresh ? "edited" : "original"}
                                                    />

                                                    {/* Existing text of the PDF: click a run to change it */}
                                                    {textLayer &&
                                                        (pageTexts ?? []).map((src) => {
                                                            const existing = editsBySource.get(src.id);
                                                            const box =
                                                                existing && previewFresh ? resolveEditedBox(src, existing.newText, preview!.runs) : null;
                                                            const isActive = activeTextEdit?.id === src.id;
                                                            if (isActive) {
                                                                const room = lineRoom(src, pageTexts ?? [], pageRender.cssWidth);
                                                                const boxAlign = box ? alignOfBox(src, box) : null;
                                                                return (
                                                                    <ActiveTextEditor
                                                                        key={src.id}
                                                                        src={src}
                                                                        existing={existing}
                                                                        anchor={box ?? { x: src.cssX, w: src.cssWidth }}
                                                                        align={boxAlign ?? room.align}
                                                                        available={room.available}
                                                                        pageWidth={pageRender.cssWidth}
                                                                        zoom={zoom}
                                                                        pxPerPt={pxPerPt}
                                                                        caret={activeTextEdit.caret}
                                                                        isTouch={isTouch}
                                                                        viewerRef={viewerRef}
                                                                        chromeRef={chromeRef}
                                                                        onCommit={(draft) => commitTextEdit(src, draft)}
                                                                        onCancel={() => setActiveTextEdit(null)}
                                                                    />
                                                                );
                                                            }
                                                            return (
                                                                <SourceTextChip
                                                                    key={src.id}
                                                                    src={src}
                                                                    existing={existing}
                                                                    box={box}
                                                                    zoom={zoom}
                                                                    emphasize={tool === "editText"}
                                                                    previewShowsEdit={previewFresh}
                                                                    editMode={existing && previewFresh ? preview?.modes[existing.id] : undefined}
                                                                    onActivate={(caret) => {
                                                                        setSelectedId(null);
                                                                        setActiveTextEdit({ id: src.id, caret });
                                                                    }}
                                                                />
                                                            );
                                                        })}

                                                    {/* Added elements */}
                                                    {pageItems.map((it) =>
                                                        it.type === "textEdit" ? null : (
                                                            <ItemView
                                                                key={it.id}
                                                                item={it}
                                                                zoom={zoom}
                                                                selected={selectedId === it.id}
                                                                interactive={
                                                                    tool === "select" ||
                                                                    ((tool === "text" || tool === "note") &&
                                                                        it.type === "text" &&
                                                                        !!it.note === (tool === "note"))
                                                                }
                                                                resizable={tool === "select"}
                                                                editingText={editingTextId === it.id}
                                                                onSelect={(id) => setSelectedId(id)}
                                                                onPress={() => {
                                                                    itemPressRef.current = true;
                                                                }}
                                                                onBeginChange={snapshot}
                                                                onMove={(id, dx, dy) =>
                                                                    setItemsLive((prev) => prev.map((p) => (p.id === id ? moveItem(p, dx, dy) : p)))
                                                                }
                                                                onResize={(id, b) =>
                                                                    setItemsLive((prev) =>
                                                                        prev.map((p) =>
                                                                            p.id === id &&
                                                                            (p.type === "rectangle" || p.type === "highlight" || p.type === "image")
                                                                                ? { ...p, x: b.x, y: b.y, width: b.w, height: b.h }
                                                                                : p,
                                                                        ),
                                                                    )
                                                                }
                                                                onStartTextEdit={(id) => {
                                                                    setSelectedId(id);
                                                                    setEditingTextId(id);
                                                                }}
                                                                onTextCommit={onTextCommit}
                                                                onTextCancel={onTextCancel}
                                                            />
                                                        ),
                                                    )}

                                                    {/* Stroke being drawn */}
                                                    {draftDraw && draftDraw.length > 1 && (
                                                        <svg className="pointer-events-none absolute inset-0 size-full">
                                                            <polyline
                                                                points={draftDraw.map((p) => `${p.x},${p.y}`).join(" ")}
                                                                fill="none"
                                                                stroke={colors.draw}
                                                                strokeWidth={strokeWidths.draw}
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                            />
                                                        </svg>
                                                    )}
                                                    {/* Rectangle / highlight / underline being dragged */}
                                                    {draftRect && (
                                                        <div
                                                            className="pointer-events-none absolute"
                                                            style={{
                                                                left: Math.min(draftRect.start.x, draftRect.end.x),
                                                                top: Math.min(draftRect.start.y, draftRect.end.y),
                                                                width: Math.abs(draftRect.end.x - draftRect.start.x),
                                                                height: Math.abs(draftRect.end.y - draftRect.start.y),
                                                                border:
                                                                    tool === "rectangle"
                                                                        ? `${strokeWidths.rectangle}px solid ${colors.rectangle}`
                                                                        : tool === "highlight"
                                                                          ? undefined
                                                                          : `${1 / zoom}px dashed ${colors[tool as ColorKey]}`,
                                                                backgroundColor:
                                                                    tool === "rectangle"
                                                                        ? rectFill
                                                                            ? colors.rectangle
                                                                            : undefined
                                                                        : tool === "highlight"
                                                                          ? colors.highlight
                                                                          : undefined,
                                                                opacity: tool === "highlight" ? HIGHLIGHT_OPACITY : undefined,
                                                                mixBlendMode: tool === "highlight" ? "multiply" : undefined,
                                                            }}
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div
                                            role="status"
                                            aria-label="Cargando la página"
                                            className="mx-auto flex animate-pulse items-center justify-center bg-primary shadow-lg ring-1 ring-black/10"
                                            style={{
                                                width: (pageRender?.cssWidth ?? EDITOR_CSS_WIDTH) * zoom,
                                                height: (pageRender?.cssHeight ?? EDITOR_CSS_WIDTH * 1.294) * zoom,
                                            }}
                                        >
                                            <Spinner className="size-6 text-fg-quaternary" />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {tip && (
                                <div key={tip.key} role="status" className="pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-center md:hidden">
                                    <p className="max-w-full rounded-lg bg-primary-solid px-3 py-2 text-center text-xs font-medium text-white shadow-lg duration-200 animate-in fade-in slide-in-from-top-1">
                                        {tip.text}
                                    </p>
                                </div>
                            )}
                            {previewBusy && (
                                <div
                                    role="status"
                                    className="pointer-events-none absolute top-3 right-5 z-10 inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-secondary shadow-md ring-1 ring-secondary_alt"
                                >
                                    <Spinner className="size-3.5 text-fg-brand-primary" />
                                    Actualizando vista previa…
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            )}

            {input && (
                <>
                    {/* Room for the fixed action bar on small screens */}
                    <div aria-hidden="true" className="h-12 lg:hidden" />
                    <div
                        ref={setBottomBarEl}
                        className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-secondary bg-primary/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
                    >
                        <div className="-ml-1.5 flex items-center md:hidden">
                            <ButtonUtility
                                color="tertiary"
                                tooltip="Deshacer"
                                icon={FlipBackward}
                                size="sm"
                                isDisabled={!docState.past.length}
                                onClick={undo}
                                className="p-2"
                            />
                            <ButtonUtility
                                color="tertiary"
                                tooltip="Rehacer"
                                icon={FlipForward}
                                size="sm"
                                isDisabled={!docState.future.length}
                                onClick={redo}
                                className="p-2"
                            />
                            {selectedItem && (
                                <ButtonUtility color="tertiary" tooltip="Eliminar" icon={Trash01} size="sm" onClick={deleteSelected} className="p-2" />
                            )}
                        </div>
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-tertiary max-[400px]:text-xs">{changesLabel}</p>
                        <Button
                            color="primary"
                            size="md"
                            iconLeading={Save01}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={items.length === 0}
                            onClick={apply}
                        >
                            {isBusy ? copy.busy : isMd ? copy.verb : copy.shortVerb}
                        </Button>
                    </div>
                </>
            )}

            <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImageFile(f);
                    // Allow picking the same file again.
                    e.target.value = "";
                }}
            />

            {confirmDialog}
        </ToolPageLayout>
    );
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const Spinner = ({ className }: { className?: string }) => (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" className={cx("shrink-0", className)}>
        <circle className="stroke-current opacity-30" cx="10" cy="10" r="8" strokeWidth="2" />
        <circle className="origin-center animate-spin stroke-current" cx="10" cy="10" r="8" strokeWidth="2" strokeDasharray="12.5 50" strokeLinecap="round" />
    </svg>
);

/** Preset colours as a radio group, plus a free colour picker. */
const ColorField = ({ value, presets, onChange, label }: { value: string; presets: Swatch[]; onChange: (v: string) => void; label: string }) => {
    const current = value.toLowerCase();
    const isPreset = presets.some((p) => p.value === current);
    return (
        <div className="flex shrink-0 items-center gap-1">
            <AriaRadioGroup
                aria-label={label}
                orientation="horizontal"
                value={isPreset ? current : null}
                onChange={onChange}
                className="flex items-center gap-0.5"
            >
                {presets.map((p) => (
                    <AriaRadio
                        key={p.value}
                        value={p.value}
                        aria-label={p.label}
                        className={({ isSelected, isFocusVisible }) =>
                            cx(
                                "flex size-8 cursor-pointer items-center justify-center rounded-full outline-focus-ring transition duration-100 ease-linear md:size-7",
                                isSelected ? "ring-2 ring-brand ring-inset" : "hover:bg-primary_hover",
                                isFocusVisible && "outline-2 outline-offset-1",
                            )
                        }
                    >
                        <span className="size-5 rounded-full ring-1 ring-black/20 ring-inset dark:ring-white/30" style={{ background: p.value }} />
                    </AriaRadio>
                ))}
            </AriaRadioGroup>
            <label
                title="Otro color"
                className={cx(
                    "relative flex size-8 cursor-pointer items-center justify-center rounded-full transition duration-100 ease-linear has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus-ring md:size-7",
                    !isPreset ? "ring-2 ring-brand ring-inset" : "hover:bg-primary_hover",
                )}
            >
                <span className="sr-only">Otro color</span>
                <input
                    type="color"
                    value={current}
                    onChange={(e) => onChange(e.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
                <span
                    aria-hidden="true"
                    className="size-5 rounded-full ring-1 ring-black/20 ring-inset dark:ring-white/30"
                    style={{ background: isPreset ? "conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)" : current }}
                />
            </label>
        </div>
    );
};

/** Number field with −/+ that accepts free typing (committed on Enter/blur, clamped to the range). */
const SizeStepper = ({
    label,
    value,
    min,
    max,
    step,
    unit = "pt",
    onChange,
    onDone,
    compact,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    onChange: (v: number) => void;
    onDone?: () => void;
    compact?: boolean;
}) => {
    const [draft, setDraft] = useState(fmtNumber(value));
    useEffect(() => setDraft(fmtNumber(value)), [value]);
    const commit = () => {
        const v = parseNumber(draft);
        if (v === null) setDraft(fmtNumber(value));
        else {
            const next = clamp(Math.round(v * 2) / 2, min, max);
            setDraft(fmtNumber(next));
            if (next !== value) onChange(next);
        }
    };
    const btn = cx(
        "flex cursor-pointer items-center justify-center rounded-md text-fg-quaternary outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
        compact ? "size-7 pointer-coarse:size-9" : "size-7",
    );
    return (
        <div
            role="group"
            aria-label={label}
            className="inline-flex h-8 shrink-0 items-center rounded-lg bg-primary p-0.5 ring-1 ring-primary ring-inset pointer-coarse:h-10"
        >
            <button
                type="button"
                aria-label="Reducir tamaño"
                className={btn}
                disabled={value <= min}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(clamp(value - step, min, max))}
            >
                <Minus aria-hidden="true" className="size-3.5" />
            </button>
            <label className="flex items-baseline gap-0.5 px-0.5">
                <span className="sr-only">{label}</span>
                <input
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                            onDone?.();
                        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                            e.preventDefault();
                            onChange(clamp(value + (e.key === "ArrowUp" ? step : -step), min, max));
                        }
                    }}
                    className="w-8 bg-transparent text-center text-sm font-medium text-primary tabular-nums outline-none"
                />
                <span aria-hidden="true" className="text-xs text-tertiary">
                    {unit}
                </span>
            </label>
            <button
                type="button"
                aria-label="Aumentar tamaño"
                className={btn}
                disabled={value >= max}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(clamp(value + step, min, max))}
            >
                <Plus aria-hidden="true" className="size-3.5" />
            </button>
        </div>
    );
};

const StrokeField = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => {
    const id = useId();
    return (
        <div className="flex w-56 shrink-0 items-center gap-2">
            <span id={id} className="text-xs font-medium text-tertiary">
                Grosor
            </span>
            <Slider
                aria-labelledby={id}
                className="min-w-24 flex-1"
                minValue={1}
                maxValue={20}
                step={1}
                value={[value]}
                onChange={(v) => onChange((Array.isArray(v) ? v[0] : v) as number)}
                formatOptions={{ maximumFractionDigits: 0 }}
                labelFormatter={(v) => `${v} px`}
            />
            <span aria-hidden="true" className="w-10 text-right text-xs font-medium text-secondary tabular-nums">
                {value} px
            </span>
        </div>
    );
};

/** Floating page and zoom controls over the bottom of the viewer. */
const ViewerControls = ({
    zoom,
    zoomMode,
    page,
    pageCount,
    showThumbs,
    onToggleThumbs,
    onPage,
    onZoomOut,
    onZoomIn,
    onActualSize,
    onFit,
}: {
    zoom: number;
    zoomMode: ZoomMode;
    page: number;
    pageCount: number;
    showThumbs: boolean;
    onToggleThumbs: () => void;
    onPage: (n: number) => void;
    onZoomOut: () => void;
    onZoomIn: () => void;
    onActualSize: () => void;
    onFit: () => void;
}) => {
    const pct = Math.round(zoom * 100);
    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-2">
            <div className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-xl bg-primary p-1 shadow-lg ring-1 ring-secondary_alt">
                {pageCount > 1 && (
                    <>
                        <ButtonUtility
                            color="tertiary"
                            size="sm"
                            icon={LayoutLeft}
                            tooltip={showThumbs ? "Ocultar miniaturas" : "Mostrar miniaturas"}
                            aria-pressed={showThumbs}
                            onClick={onToggleThumbs}
                            className="max-lg:hidden"
                        />
                        <ButtonUtility
                            color="tertiary"
                            size="sm"
                            icon={ChevronLeft}
                            tooltip="Página anterior"
                            isDisabled={page <= 1}
                            onClick={() => onPage(page - 1)}
                        />
                        <select
                            aria-label="Página"
                            value={page}
                            onChange={(e) => onPage(Number(e.target.value))}
                            className="h-8 cursor-pointer appearance-none rounded-md bg-transparent px-2 text-center text-sm font-semibold text-secondary tabular-nums outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2"
                        >
                            {Array.from({ length: pageCount }, (_, i) => (
                                <option key={i + 1} value={i + 1}>
                                    {i + 1} / {pageCount}
                                </option>
                            ))}
                        </select>
                        <ButtonUtility
                            color="tertiary"
                            size="sm"
                            icon={ChevronRight}
                            tooltip="Página siguiente"
                            isDisabled={page >= pageCount}
                            onClick={() => onPage(page + 1)}
                        />
                        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border-secondary" />
                    </>
                )}
                <ButtonUtility color="tertiary" size="sm" icon={Minus} tooltip="Alejar" isDisabled={zoom <= MIN_ZOOM + 0.001} onClick={onZoomOut} />
                <button
                    type="button"
                    onClick={onActualSize}
                    title="Ver a tamaño real (100 %)"
                    aria-label={`Zoom ${pct} %. Ver a tamaño real`}
                    className="h-8 min-w-14 cursor-pointer rounded-md px-1.5 text-sm font-semibold text-secondary tabular-nums outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2"
                >
                    {pct} %
                </button>
                <ButtonUtility color="tertiary" size="sm" icon={Plus} tooltip="Acercar" isDisabled={zoom >= MAX_ZOOM - 0.001} onClick={onZoomIn} />
                <ButtonUtility
                    color="tertiary"
                    size="sm"
                    icon={Expand06}
                    tooltip="Ajustar al ancho"
                    aria-pressed={zoomMode === "fit"}
                    onClick={onFit}
                    className={cx(zoomMode === "fit" && "bg-active text-fg-brand-secondary")}
                />
            </div>
        </div>
    );
};

/** Vertical rail of page thumbnails on the left of the editor canvas (large screens, multi-page documents). */
const EditorThumbsRail = ({
    getDoc,
    file,
    pageCount,
    activePage,
    height,
    countsByPage,
    onPick,
    cache,
    onCacheUpdate,
    noun,
}: {
    getDoc: () => Promise<PDFDocumentProxy>;
    file: File;
    pageCount: number;
    activePage: number;
    height: string;
    countsByPage: Record<number, number>;
    onPick: (n: number) => void;
    cache: Record<number, string>;
    onCacheUpdate: (next: Record<number, string>) => void;
    noun: [string, string];
}) => {
    const railRef = useRef<HTMLElement>(null);
    useEffect(() => {
        let aborted = false;
        (async () => {
            const doc = await getDoc();
            const next: Record<number, string> = { ...cache };
            for (let i = 1; i <= pageCount; i++) {
                if (aborted) return;
                if (next[i]) continue;
                // Thumbnails are best-effort: a single damaged page must not abort the whole rail.
                try {
                    const page = await doc.getPage(i);
                    const base = page.getViewport({ scale: 1 });
                    const scale = 160 / Math.max(base.width, base.height);
                    const vp = page.getViewport({ scale });
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.ceil(vp.width);
                    canvas.height = Math.ceil(vp.height);
                    const ctx = canvas.getContext("2d", { alpha: false });
                    if (!ctx) continue;
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
                    next[i] = canvas.toDataURL("image/png");
                    if (!aborted) onCacheUpdate({ ...next });
                } catch {
                    /* skip this page's thumbnail */
                }
            }
        })().catch(() => {
            /* the rail stays empty, the main viewer still works */
        });
        return () => {
            aborted = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file, pageCount]);

    // Keep the current page's thumbnail in view.
    useEffect(() => {
        railRef.current?.querySelector(`[data-thumb-rail="${activePage}"]`)?.scrollIntoView({ block: "nearest" });
    }, [activePage]);

    return (
        <nav
            ref={railRef}
            aria-label="Páginas"
            data-thumbs-rail
            className="hidden scrollbar-subtle w-40 shrink-0 flex-col gap-2 overflow-auto rounded-xl bg-secondary p-2.5 ring-1 ring-secondary ring-inset lg:flex"
            style={{ height }}
        >
            <p className="px-0.5 text-xs font-semibold text-quaternary">{pagesLabel(pageCount)}</p>
            {Array.from({ length: pageCount }).map((_, i) => {
                const n = i + 1;
                const count = countsByPage[n] ?? 0;
                const isActive = n === activePage;
                const url = cache[n];
                return (
                    <button
                        key={n}
                        type="button"
                        data-thumb-rail={n}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => onPick(n)}
                        className={cx(
                            "relative flex shrink-0 cursor-pointer flex-col items-center gap-1 rounded-lg p-1.5 outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2",
                            isActive ? "bg-brand-primary_alt ring-2 ring-brand" : "ring-1 ring-secondary ring-inset hover:bg-primary",
                        )}
                    >
                        <div className="relative aspect-[3/4] w-full overflow-hidden rounded-sm bg-white shadow-xs">
                            {url ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={url} alt="" className="absolute inset-0 size-full object-contain" draggable={false} />
                            ) : (
                                <div className="absolute inset-0 animate-pulse bg-tertiary" />
                            )}
                            {count > 0 && (
                                <span
                                    aria-hidden="true"
                                    className="absolute top-1 right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-brand-solid px-1 text-[10px] font-bold text-white ring-2 ring-primary"
                                >
                                    {count}
                                </span>
                            )}
                        </div>
                        <span className={cx("text-xs font-semibold", isActive ? "text-brand-secondary" : "text-secondary")}>
                            {n}
                            {count > 0 && <span className="sr-only">, {plural(count, noun[0], noun[1])}</span>}
                        </span>
                    </button>
                );
            })}
        </nav>
    );
};

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** An added element: selection, drag, corner resize and in-place text editing. */
const ItemView = ({
    item,
    zoom,
    selected,
    interactive,
    resizable,
    editingText,
    onSelect,
    onPress,
    onBeginChange,
    onMove,
    onResize,
    onStartTextEdit,
    onTextCommit,
    onTextCancel,
}: {
    item: Exclude<Item, TextEditItem>;
    zoom: number;
    selected: boolean;
    interactive: boolean;
    resizable: boolean;
    editingText: boolean;
    onSelect: (id: string) => void;
    /** A pointer went down on this element (its click is not a click on the page). */
    onPress: () => void;
    onBeginChange: () => void;
    onMove: (id: string, dx: number, dy: number) => void;
    onResize: (id: string, box: Box) => void;
    onStartTextEdit: (id: string) => void;
    onTextCommit: (id: string, text: string) => void;
    onTextCancel: (id: string) => void;
}) => {
    const drag = useRef<{ x: number; y: number; lastX: number; lastY: number; moved: boolean; wasSelected: boolean; movable: boolean } | null>(null);
    const resize = useRef<{ corner: Corner; x: number; y: number; box: Box; moved: boolean } | null>(null);

    const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
        if (!interactive || editingText) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.stopPropagation();
        // This gesture belongs to the element: the page must not treat its click as a click on empty paper. On touch,
        // cancelling pointerdown also stops the late compatibility mousedown from stealing focus from a text box.
        onPress();
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        const movable = resizable;
        drag.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, wasSelected: selected, movable };
        if (!movable) return; // text tool: a tap edits the text (see onPointerUp)
        onSelect(item.id);
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || !d.movable) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
        if (!d.moved) {
            d.moved = true;
            onBeginChange();
        }
        onMove(item.id, (e.clientX - d.lastX) / zoom, (e.clientY - d.lastY) / zoom);
        d.lastX = e.clientX;
        d.lastY = e.clientY;
    };
    const onPointerUp = () => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved || item.type !== "text") return;
        // Text tool: a tap edits the text. Select tool: tapping an already selected text edits it (touch has no
        // reliable double-tap).
        if (!d.movable || d.wasSelected) onStartTextEdit(item.id);
    };
    const onPointerCancel = () => {
        drag.current = null;
    };

    const box: Box | null =
        item.type === "rectangle" || item.type === "highlight" || item.type === "image" ? { x: item.x, y: item.y, w: item.width, h: item.height } : null;

    const startResize = (e: RPointerEvent<HTMLSpanElement>, corner: Corner) => {
        if (!box) return;
        e.stopPropagation();
        e.preventDefault();
        resize.current = { corner, x: e.clientX, y: e.clientY, box, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const moveResize = (e: RPointerEvent<HTMLSpanElement>) => {
        const r = resize.current;
        if (!r) return;
        if (!r.moved) {
            r.moved = true;
            onBeginChange();
        }
        const dx = (e.clientX - r.x) / zoom;
        const dy = (e.clientY - r.y) / zoom;
        const west = r.corner === "nw" || r.corner === "sw";
        const north = r.corner === "nw" || r.corner === "ne";
        let w = Math.max(8, r.box.w + (west ? -dx : dx));
        let h = Math.max(8, r.box.h + (north ? -dy : dy));
        if (item.type === "image" && !e.shiftKey) {
            // Images keep their proportions (Shift frees them).
            const s = Math.abs(dx) * r.box.h > Math.abs(dy) * r.box.w ? w / r.box.w : h / r.box.h;
            w = Math.max(8, r.box.w * s);
            h = Math.max(8, r.box.h * s);
        }
        onResize(item.id, { x: west ? r.box.x + r.box.w - w : r.box.x, y: north ? r.box.y + r.box.h - h : r.box.y, w, h });
    };
    const endResize = () => {
        resize.current = null;
    };

    const outline: CSSProperties = selected ? { outline: `${2 / zoom}px dashed var(--color-fg-brand-primary)`, outlineOffset: `${3 / zoom}px` } : {};
    const common = {
        role: "button" as const,
        tabIndex: interactive ? 0 : -1,
        "aria-label": itemLabel(item),
        "aria-pressed": selected,
        "data-item": item.type,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onClick: (e: RMouseEvent) => e.stopPropagation(),
        onDoubleClick: (e: RMouseEvent) => {
            e.stopPropagation();
            if (interactive && item.type === "text") onStartTextEdit(item.id);
        },
        onFocus: () => {
            if (interactive && resizable && !selected && !editingText) onSelect(item.id);
        },
        onKeyDown: (e: RKeyboardEvent) => {
            if (e.key === "Enter" && interactive && item.type === "text" && !editingText) {
                e.preventDefault();
                onStartTextEdit(item.id);
            }
        },
    };
    const baseStyle: CSSProperties = {
        position: "absolute",
        cursor: !interactive ? undefined : editingText || (item.type === "text" && !resizable) ? "text" : "move",
        pointerEvents: interactive ? "auto" : "none",
        // A selected element owns one-finger drags; otherwise the finger scrolls the page.
        touchAction: selected ? "none" : "pan-x pan-y pinch-zoom",
        ...outline,
    };

    const handles =
        selected && resizable && box
            ? CORNERS.map((c) => {
                  const hit = 24 / zoom;
                  return (
                      <span
                          key={c}
                          aria-hidden="true"
                          data-resize-handle={c}
                          onPointerDown={(e) => startResize(e, c)}
                          onPointerMove={moveResize}
                          onPointerUp={endResize}
                          onPointerCancel={endResize}
                          onClick={(e) => e.stopPropagation()}
                          className="absolute flex items-center justify-center"
                          style={{
                              width: hit,
                              height: hit,
                              left: (c === "nw" || c === "sw" ? 0 : box.w) - hit / 2,
                              top: (c === "nw" || c === "ne" ? 0 : box.h) - hit / 2,
                              cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize",
                              touchAction: "none",
                          }}
                      >
                          <span
                              style={{
                                  width: 10 / zoom,
                                  height: 10 / zoom,
                                  borderRadius: 2 / zoom,
                                  background: "#ffffff",
                                  boxShadow: `0 0 0 ${1.5 / zoom}px var(--color-fg-brand-primary), 0 ${1 / zoom}px ${3 / zoom}px rgba(0,0,0,.25)`,
                              }}
                          />
                      </span>
                  );
              })
            : null;

    if (item.type === "drawing") {
        const xs = item.points.map((p) => p.x);
        const ys = item.points.map((p) => p.y);
        const pad = Math.max(4, item.width / 2 + 2);
        const minX = Math.min(...xs) - pad;
        const minY = Math.min(...ys) - pad;
        const w = Math.max(...xs) - minX + pad;
        const h = Math.max(...ys) - minY + pad;
        return (
            <div {...common} style={{ ...baseStyle, left: minX, top: minY, width: w, height: h }}>
                <svg width={w} height={h} className="pointer-events-none absolute inset-0 overflow-visible">
                    <polyline
                        points={item.points.map((p) => `${p.x - minX},${p.y - minY}`).join(" ")}
                        fill="none"
                        stroke={item.color}
                        strokeWidth={item.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </div>
        );
    }
    if (item.type === "text") {
        const lh = item.fontSize * ADDED_TEXT_LINE_HEIGHT;
        const pad = item.note ? NOTE_PADDING : { x: 0, y: 0 };
        const bg = item.background ?? DEFAULT_COLORS.note;
        const textStyle: CSSProperties = {
            fontFamily: ADDED_TEXT_FONT_STACK,
            fontSize: item.fontSize,
            lineHeight: `${lh}px`,
            color: item.color,
            fontKerning: "none",
            whiteSpace: "pre",
        };
        return (
            <div
                {...common}
                style={{
                    ...baseStyle,
                    left: item.x - pad.x,
                    top: item.y - pad.y,
                    padding: `${pad.y}px ${pad.x}px`,
                    background: item.note ? bg : undefined,
                    boxShadow: item.note ? `inset 0 0 0 1px ${noteBorderColor(bg)}` : undefined,
                }}
            >
                {editingText ? (
                    <AddedTextEditor
                        initial={item.text}
                        placeholder={item.note ? "Escribe una nota…" : "Escribe aquí"}
                        label={item.note ? "Texto de la nota" : "Texto añadido"}
                        fontSize={item.fontSize}
                        textStyle={textStyle}
                        zoom={zoom}
                        onCommit={(text) => onTextCommit(item.id, text)}
                        onCancel={() => onTextCancel(item.id)}
                    />
                ) : (
                    <div style={textStyle}>{item.text || " "}</div>
                )}
            </div>
        );
    }
    if (item.type === "rectangle") {
        return (
            <div
                {...common}
                style={{
                    ...baseStyle,
                    left: item.x,
                    top: item.y,
                    width: item.width,
                    height: item.height,
                    border: `${item.strokeWidth}px solid ${item.stroke}`,
                    background: item.fill ?? "transparent",
                }}
            >
                {handles}
            </div>
        );
    }
    if (item.type === "highlight") {
        return (
            <div {...common} style={{ ...baseStyle, left: item.x, top: item.y, width: item.width, height: item.height }}>
                <div
                    className="pointer-events-none absolute inset-0"
                    style={{ background: item.color, opacity: HIGHLIGHT_OPACITY, mixBlendMode: "multiply" }}
                />
                {handles}
            </div>
        );
    }
    return (
        <div {...common} style={{ ...baseStyle, left: item.x, top: item.y, width: item.width, height: item.height }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.dataUrl} alt="" className="pointer-events-none size-full select-none" draggable={false} />
            {handles}
        </div>
    );
};

/** Multi-line field for added text and notes. Enter applies (Shift+Enter adds a line), Esc cancels. */
const AddedTextEditor = ({
    initial,
    placeholder,
    label,
    fontSize,
    textStyle,
    zoom,
    onCommit,
    onCancel,
}: {
    initial: string;
    placeholder: string;
    label: string;
    fontSize: number;
    textStyle: CSSProperties;
    zoom: number;
    onCommit: (text: string) => void;
    onCancel: () => void;
}) => {
    const [value, setValue] = useState(initial);
    const ref = useRef<HTMLTextAreaElement>(null);
    const done = useRef(false);
    const shown = value || placeholder;
    const lines = shown.split("\n").length;
    const width = Math.ceil(measureTextWidth(shown, addedTextFont(fontSize))) + 2;
    const lh = fontSize * ADDED_TEXT_LINE_HEIGHT;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.select();
    }, []);

    const finish = (commit: boolean) => {
        if (done.current) return;
        done.current = true;
        if (commit) onCommit(ref.current?.value ?? value);
        else onCancel();
    };

    return (
        <textarea
            ref={ref}
            value={value}
            placeholder={placeholder}
            aria-label={label}
            wrap="off"
            rows={lines}
            spellCheck
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    finish(true);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="block resize-none overflow-hidden border-0 bg-transparent p-0 placeholder:text-placeholder focus:outline-none"
            style={{
                ...textStyle,
                width,
                height: lines * lh,
                margin: 0,
                // Visible editing frame drawn outside the text box, constant on screen at any zoom.
                boxShadow: `0 0 0 ${2 / zoom}px var(--color-fg-brand-primary)`,
                borderRadius: 1,
            }}
        />
    );
};

/** Clickable area over an original run of the PDF.
 *  Idle: transparent (the PDF render shows through); "Editar texto" outlines every run faintly.
 *  Edited: outlined where the engine placed the new text; an approximation is painted until the real preview is ready. */
const SourceTextChip = ({
    src,
    existing,
    box,
    zoom,
    emphasize,
    previewShowsEdit,
    editMode,
    onActivate,
}: {
    src: ExtractedText;
    existing: TextEditItem | undefined;
    box: { x: number; w: number } | null;
    zoom: number;
    emphasize: boolean;
    /** The page image already shows the real edited PDF — no need to paint an approximation. */
    previewShowsEdit: boolean;
    /** How the edit was applied in the preview (native rewrite vs overlay fallback). */
    editMode?: EditMode;
    onActivate: (caret: number | null) => void;
}) => {
    const text = existing ? existing.newText : src.str;
    const fontSize = existing?.cssFontSize ?? src.cssFontSize;
    const bold = existing?.bold ?? src.bold;
    const italic = existing?.italic ?? src.italic;
    const font = runFont(italic, bold, fontSize, src.cssFontFamily);
    const left = box?.x ?? src.cssX;
    const width = box?.w ?? (existing ? Math.max(src.cssWidth, measureTextWidth(text, font)) : src.cssWidth);
    const real = !!existing && previewShowsEdit;
    const warn = editMode === "overlay" || editMode === "failed" || editMode === "clipped";
    const v = runBoxAtSize(src, fontSize);

    return (
        <button
            type="button"
            data-source-text={src.id}
            data-source-text-str={src.str}
            data-edited={existing ? "true" : undefined}
            data-edited-preview={existing ? (real ? "real" : "approx") : undefined}
            data-edit-mode={existing ? (editMode ?? "pending") : undefined}
            aria-label={existing ? `Texto editado: ${text}` : `Editar texto: ${text}`}
            title={
                !existing
                    ? undefined
                    : editMode === "overlay"
                      ? "Editado por superposición: esta línea no se pudo reescribir dentro del PDF, se cubrió y se escribió encima."
                      : editMode === "clipped"
                        ? "El texto nuevo es más largo que su celda o recuadro: la parte que sobra queda recortada. Acórtalo o reduce el tamaño."
                        : editMode === "failed"
                          ? "No se pudo aplicar esta edición."
                          : "Editado directamente en el documento (misma fuente y color)."
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
                e.stopPropagation();
                if (e.detail === 0) {
                    onActivate(null); // keyboard: select the whole run
                    return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                onActivate(caretAt(text, font, width, (e.clientX - r.left) / zoom));
            }}
            className={cx(
                "absolute cursor-text rounded-[1px] p-0 text-left whitespace-pre outline-[length:var(--ol)] transition duration-100 ease-linear focus-visible:outline-[length:var(--olf)] focus-visible:outline-focus-ring focus-visible:outline-solid",
                existing
                    ? cx("outline-dashed", warn ? "outline-fg-warning-primary" : "outline-fg-brand-primary")
                    : emphasize
                      ? "outline-fg-brand-primary/30 outline-dashed hover:bg-fg-brand-primary/10 hover:outline-fg-brand-primary"
                      : "outline-transparent outline-dashed hover:bg-fg-brand-primary/10 hover:outline-fg-brand-primary/70",
            )}
            style={{
                left,
                top: v.top,
                width,
                height: v.height,
                fontSize,
                fontFamily: src.cssFontFamily || "sans-serif",
                fontWeight: bold ? 700 : 400,
                fontStyle: italic ? "italic" : "normal",
                lineHeight: 1,
                ["--ol" as string]: `${(existing ? 1.5 : 1) / zoom}px`,
                ["--olf" as string]: `${2.5 / zoom}px`,
                outlineOffset: 1 / zoom,
                // Until the rebuilt page is ready, paint an approximation so the old text never shows after committing.
                color: existing && !real ? (existing.textColor ?? src.textColor) : "transparent",
                background: existing && !real ? src.bgColor : undefined,
                userSelect: "none",
            }}
        >
            {text}
        </button>
    );
};

/** In-place editor for one run of existing text: the field over the run, and a style popover rendered outside the
 *  zoomed page (so it is never clipped or shrunk). Nothing reaches the document until the edit is committed, as one
 *  undo step; Esc restores the run untouched. */
const ActiveTextEditor = ({
    src,
    existing,
    anchor,
    align,
    available,
    pageWidth,
    zoom,
    pxPerPt,
    caret,
    isTouch,
    viewerRef,
    chromeRef,
    onCommit,
    onCancel,
}: {
    src: ExtractedText;
    existing: TextEditItem | undefined;
    anchor: { x: number; w: number };
    align: Align;
    available: number;
    pageWidth: number;
    zoom: number;
    pxPerPt: number;
    caret: number | null;
    isTouch: boolean;
    viewerRef: RefObject<HTMLDivElement | null>;
    chromeRef: RefObject<HTMLDivElement | null>;
    onCommit: (draft: TextDraft) => void;
    onCancel: () => void;
}) => {
    const original: TextDraft = { text: src.str, textColor: src.textColor, cssFontSize: src.cssFontSize, bold: src.bold, italic: src.italic };
    const [draft, setDraft] = useState<TextDraft>(() =>
        existing
            ? { text: existing.newText, textColor: existing.textColor, cssFontSize: existing.cssFontSize, bold: existing.bold, italic: existing.italic }
            : original,
    );
    const [fontReady, setFontReady] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const cbRef = useRef({ onCommit, onCancel });
    cbRef.current = { onCommit, onCancel };
    const doneRef = useRef(false);
    const inPageRef = useRef<HTMLElement | null>(null);
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);
    // Decided once: switching between in-place and popover field while typing would lose focus.
    const [compact] = useState(() => draft.cssFontSize * zoom < MIN_INPLACE_FONT_PX);
    const origSize = existing?.origCssFontSize ?? src.cssFontSize;

    const finish = useCallback((commit: boolean) => {
        if (doneRef.current) return;
        doneRef.current = true;
        if (commit) cbRef.current.onCommit(draftRef.current);
        else cbRef.current.onCancel();
    }, []);

    // Commit when the user clicks or tabs anywhere outside the field and its popover.
    useEffect(() => {
        const inside = (t: EventTarget | null) => t instanceof Node && (!!inPageRef.current?.contains(t) || !!popRef.current?.contains(t));
        const onDown = (e: PointerEvent) => {
            if (!inside(e.target)) finish(true);
        };
        const onFocusIn = (e: FocusEvent) => {
            if (!inside(e.target)) finish(true);
        };
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("focusin", onFocusIn, true);
        return () => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("focusin", onFocusIn, true);
        };
    }, [finish]);

    // The PDF's own font must be loaded before measuring (otherwise the overflow check is wrong).
    useEffect(() => {
        if (typeof document === "undefined" || !document.fonts) return;
        const f = runFont(draft.italic, draft.bold, draft.cssFontSize, src.cssFontFamily);
        Promise.allSettled([document.fonts.ready, document.fonts.load(f)]).then(() => setFontReady((n) => n + 1));
    }, [draft.italic, draft.bold, draft.cssFontSize, src.cssFontFamily]);

    // Focus the field, with the caret where the user clicked.
    useLayoutEffect(() => {
        const f = fieldRef.current;
        if (!f) return;
        if (compact && isTouch) inPageRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
        f.focus({ preventScroll: !compact || !isTouch });
        if (caret === null) f.select();
        else f.setSelectionRange(caret, caret);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep the popover next to the run, inside the visible part of the viewer (and above the on-screen keyboard).
    useLayoutEffect(() => {
        let raf = 0;
        const place = () => {
            const pop = popRef.current;
            const a = inPageRef.current?.getBoundingClientRect();
            const v = viewerRef.current?.getBoundingClientRect();
            if (pop && a && v) {
                const vv = window.visualViewport;
                const vLeft = vv?.offsetLeft ?? 0;
                const vTop = vv?.offsetTop ?? 0;
                const vW = vv?.width ?? window.innerWidth;
                const vH = vv?.height ?? window.innerHeight;
                const chromeBottom = chromeRef.current?.getBoundingClientRect().bottom ?? 0;
                const pw = pop.offsetWidth;
                const ph = pop.offsetHeight;
                // Horizontally: over the viewer when it fits there, otherwise anywhere on screen.
                let minX = Math.max(v.left, vLeft) + 6;
                let maxX = Math.min(v.right, vLeft + vW) - 6;
                if (pw > maxX - minX) {
                    minX = vLeft + 8;
                    maxX = vLeft + vW - 8;
                }
                const minY = Math.max(v.top, vTop, chromeBottom) + 6;
                const maxY = Math.min(v.bottom, vTop + vH) - 6;
                const gap = 8;
                let top = a.top - ph - gap;
                if (top < minY) top = a.bottom + gap + ph <= maxY ? a.bottom + gap : Math.max(minY, Math.min(a.top - ph - gap, maxY - ph));
                const left = pw >= maxX - minX ? minX : clamp(align === "right" ? a.right - pw : a.left, minX, maxX - pw);
                pop.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
                pop.style.visibility = "visible";
            }
            raf = requestAnimationFrame(place);
        };
        place();
        return () => cancelAnimationFrame(raf);
    }, [viewerRef, chromeRef, align]);

    const font = runFont(draft.italic, draft.bold, draft.cssFontSize, src.cssFontFamily);
    const measured = useMemo(
        () => measureTextWidth(draft.text, font),
        // fontReady triggers a re-measure once the PDF's font is actually available
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [draft.text, font, fontReady],
    );
    const overflow = measured > available * 1.02 + 1;
    const overflowPct = Math.round((measured / Math.max(1, available) - 1) * 100);
    const minSize = origSize * 0.85;
    const fitSize = Math.floor(((draft.cssFontSize * available) / Math.max(1, measured) / pxPerPt) * 2) / 2;
    const reduceTo = Math.max(Math.ceil((minSize / pxPerPt) * 2) / 2, fitSize);
    const canReduce = overflow && reduceTo * pxPerPt < draft.cssFontSize - 0.01;

    const width = Math.max(anchor.w, measured + 4);
    const rawLeft = align === "right" ? anchor.x + anchor.w - width : align === "center" ? anchor.x + anchor.w / 2 - width / 2 : anchor.x;
    const left = clamp(rawLeft, 0, Math.max(0, pageWidth - width));
    const changed =
        draft.text !== src.str ||
        draft.textColor.toLowerCase() !== src.textColor.toLowerCase() ||
        Math.abs(draft.cssFontSize - src.cssFontSize) > 0.01 ||
        draft.bold !== src.bold ||
        draft.italic !== src.italic;

    const vbox = runBoxAtSize(src, draft.cssFontSize);
    const inPageStyle: CSSProperties = {
        position: "absolute",
        left,
        top: vbox.top,
        width,
        height: vbox.height,
        fontSize: draft.cssFontSize,
        fontFamily: src.cssFontFamily || "sans-serif",
        fontWeight: draft.bold ? 700 : 400,
        fontStyle: draft.italic ? "italic" : "normal",
        lineHeight: 1,
        whiteSpace: "pre",
        color: draft.textColor,
        background: src.bgColor,
        padding: 0,
        margin: 0,
        border: 0,
        outline: "none",
        boxShadow: `0 0 0 ${2 / zoom}px ${overflow ? "var(--color-fg-warning-primary)" : "var(--color-fg-brand-primary)"}, 0 ${4 / zoom}px ${14 / zoom}px rgba(0,0,0,.15)`,
        zIndex: 50,
    };

    /** Tab cycles through the field and the popover controls (like a dialog); Esc cancels. */
    const onKeyDownAll = (e: RKeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
            return;
        }
        if (e.key !== "Tab") return;
        const focusables = [
            ...(compact ? [] : [fieldRef.current]),
            ...Array.from(popRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
        ].filter((el): el is HTMLElement => !!el);
        if (!focusables.length) return;
        const i = focusables.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
    };

    const fieldProps = {
        value: draft.text,
        spellCheck: true,
        "aria-label": "Texto",
        onChange: (e: { currentTarget: HTMLInputElement }) => {
            const text = e.currentTarget.value;
            setDraft((d) => ({ ...d, text }));
        },
        onKeyDown: (e: RKeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") {
                e.preventDefault();
                finish(true);
                return;
            }
            onKeyDownAll(e);
        },
        onPointerDown: (e: RPointerEvent) => e.stopPropagation(),
        onClick: (e: RMouseEvent) => e.stopPropagation(),
    };

    const iconBtn =
        "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 pointer-coarse:size-10";
    const keepFocus = (e: RMouseEvent) => e.preventDefault();
    /** Back to typing after a pointer click on a style button (keyboard users keep their place in the popover). */
    const refocusField = () => {
        const a = document.activeElement;
        if (!a || a === document.body || (a instanceof HTMLInputElement && a.type === "color")) fieldRef.current?.focus({ preventScroll: true });
    };

    const popover = (
        <div
            ref={popRef}
            role="group"
            aria-label="Formato del texto"
            data-text-popover
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
                // Clicking the popover's background must not take focus away from the field.
                if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDownAll}
            className={cx(
                "fixed top-0 left-0 z-40 flex flex-col gap-2 rounded-xl bg-primary p-1.5 shadow-xl ring-1 ring-secondary_alt",
                compact && "w-[min(26rem,calc(100vw-1rem))] p-2",
            )}
            style={{ visibility: "hidden" }}
        >
            {compact && (
                <input
                    ref={fieldRef}
                    {...fieldProps}
                    className="h-11 w-full rounded-lg bg-primary px-3 text-md text-primary ring-1 ring-primary outline-none ring-inset focus:ring-2 focus:ring-brand"
                />
            )}
            <div className="flex flex-wrap items-center gap-1">
                <label
                    title="Color del texto"
                    className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition duration-100 ease-linear hover:bg-primary_hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring pointer-coarse:size-10"
                >
                    <input
                        type="color"
                        aria-label="Color del texto"
                        value={draft.textColor}
                        onChange={(e) => {
                            const textColor = e.target.value;
                            setDraft((d) => ({ ...d, textColor }));
                        }}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                    <span aria-hidden="true" className="flex size-5 rounded bg-white p-0.5 ring-1 ring-primary">
                        <span className="size-full rounded-[2px]" style={{ background: draft.textColor }} />
                    </span>
                </label>
                <button
                    type="button"
                    aria-label="Negrita"
                    aria-pressed={draft.bold}
                    onMouseDown={keepFocus}
                    onClick={() => {
                        setDraft((d) => ({ ...d, bold: !d.bold }));
                        refocusField();
                    }}
                    className={cx(iconBtn, "text-sm font-bold", draft.bold ? "bg-brand-solid text-white" : "text-secondary hover:bg-primary_hover")}
                >
                    B
                </button>
                <button
                    type="button"
                    aria-label="Cursiva"
                    aria-pressed={draft.italic}
                    onMouseDown={keepFocus}
                    onClick={() => {
                        setDraft((d) => ({ ...d, italic: !d.italic }));
                        refocusField();
                    }}
                    className={cx(iconBtn, "font-serif text-sm italic", draft.italic ? "bg-brand-solid text-white" : "text-secondary hover:bg-primary_hover")}
                >
                    I
                </button>
                <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border-secondary" />
                <SizeStepper
                    label="Tamaño"
                    compact
                    value={Math.round((draft.cssFontSize / pxPerPt) * 2) / 2}
                    min={4}
                    max={200}
                    step={0.5}
                    onChange={(pt) => setDraft((d) => ({ ...d, cssFontSize: pt * pxPerPt }))}
                    onDone={() => (compact ? undefined : fieldRef.current?.focus())}
                />
                {changed && (
                    <button
                        type="button"
                        aria-label="Restablecer el texto original"
                        title="Restablecer el texto original"
                        onMouseDown={keepFocus}
                        onClick={() => {
                            setDraft(original);
                            refocusField();
                        }}
                        className={cx(iconBtn, "text-fg-quaternary hover:bg-primary_hover hover:text-fg-quaternary_hover")}
                    >
                        <RefreshCcw01 aria-hidden="true" className="size-4" />
                    </button>
                )}
                {!compact && (
                    <>
                        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border-secondary" />
                        <button
                            type="button"
                            aria-label="Aplicar (Enter)"
                            title="Aplicar (Enter)"
                            onMouseDown={keepFocus}
                            onClick={() => finish(true)}
                            className={cx(iconBtn, "text-fg-brand-secondary hover:bg-primary_hover")}
                        >
                            <Check aria-hidden="true" className="size-4" />
                        </button>
                        <button
                            type="button"
                            aria-label="Cancelar (Esc)"
                            title="Cancelar (Esc)"
                            onMouseDown={keepFocus}
                            onClick={() => finish(false)}
                            className={cx(iconBtn, "text-fg-quaternary hover:bg-primary_hover hover:text-fg-quaternary_hover")}
                        >
                            <XClose aria-hidden="true" className="size-4" />
                        </button>
                    </>
                )}
            </div>
            {overflow && (
                <div className="flex flex-wrap items-center gap-2 px-1 pb-0.5">
                    <span
                        data-overflow-indicator
                        title="El texto nuevo es más ancho que el espacio libre de la línea: puede montarse sobre el texto de al lado o salirse del margen."
                        className="inline-flex items-center gap-1 rounded-md bg-utility-yellow-50 px-1.5 py-0.5 text-xs font-semibold text-utility-yellow-700 ring-1 ring-utility-yellow-200 ring-inset"
                    >
                        <AlertTriangle aria-hidden="true" className="size-3.5" />
                        No cabe (+{overflowPct} %)
                    </span>
                    {canReduce && (
                        <button
                            type="button"
                            data-fit-button
                            onMouseDown={keepFocus}
                            onClick={() => {
                                setDraft((d) => ({ ...d, cssFontSize: reduceTo * pxPerPt }));
                                fieldRef.current?.focus({ preventScroll: true });
                            }}
                            className="cursor-pointer rounded-sm text-xs font-semibold text-brand-secondary outline-focus-ring transition duration-100 ease-linear hover:text-brand-secondary_hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            Reducir a {fmtNumber(reduceTo)} pt
                        </button>
                    )}
                </div>
            )}
            {compact && (
                <div className="flex gap-2">
                    <Button color="secondary" size="md" className="flex-1" onClick={() => finish(false)}>
                        Cancelar
                    </Button>
                    <Button color="primary" size="md" className="flex-1" iconLeading={Check} onClick={() => finish(true)}>
                        Aplicar
                    </Button>
                </div>
            )}
        </div>
    );

    return (
        <>
            {compact ? (
                <div ref={(el) => void (inPageRef.current = el)} data-active-text-preview aria-hidden="true" style={inPageStyle}>
                    {draft.text || " "}
                </div>
            ) : (
                <input
                    ref={(el) => {
                        inPageRef.current = el;
                        fieldRef.current = el;
                    }}
                    {...fieldProps}
                    style={inPageStyle}
                />
            )}
            {createPortal(popover, document.body)}
        </>
    );
};

const DiscardDialog = ({
    state,
    count,
    noun,
    onClose,
    onConfirm,
}: {
    state: { kind: "reset" } | { kind: "navigate"; href: string } | null;
    count: number;
    noun: [string, string];
    onClose: () => void;
    onConfirm: () => void;
}) => (
    <AriaModalOverlay
        isOpen={!!state}
        isDismissable
        onOpenChange={(open) => !open && onClose()}
        className={({ isEntering, isExiting }) =>
            cx(
                "fixed inset-0 z-50 flex min-h-dvh items-end justify-center bg-overlay/70 p-4 backdrop-blur-sm sm:items-center",
                isEntering && "duration-150 ease-out animate-in fade-in",
                isExiting && "duration-100 ease-in animate-out fade-out",
            )
        }
    >
        <AriaModal className="w-full max-w-md">
            <AriaDialog role="alertdialog" className="flex flex-col gap-4 rounded-2xl bg-primary p-5 shadow-xl ring-1 ring-secondary_alt outline-hidden sm:p-6">
                <FeaturedIcon icon={AlertTriangle} color="warning" theme="light" size="md" />
                <div className="flex flex-col gap-1">
                    <AriaHeading slot="title" className="text-lg font-semibold text-primary">
                        {state?.kind === "navigate" ? "¿Salir sin guardar?" : "¿Descartar los cambios?"}
                    </AriaHeading>
                    <p className="text-sm text-tertiary">
                        Perderás {plural(count, noun[0], noun[1])} que aún no has guardado en el PDF.
                        {state?.kind === "navigate" ? " Si quieres conservarlos, pulsa «Seguir editando» y guarda antes de salir." : ""}
                    </p>
                </div>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button color="secondary" size="md" onClick={onClose}>
                        Seguir editando
                    </Button>
                    <Button color="primary-destructive" size="md" onClick={onConfirm}>
                        {state?.kind === "navigate" ? "Salir sin guardar" : "Descartar cambios"}
                    </Button>
                </div>
            </AriaDialog>
        </AriaModal>
    </AriaModalOverlay>
);
