"use client";

import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Droplets02, File04, Trash01 } from "@untitledui/icons";
import { type PDFFont, PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Label as AriaLabel, Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Slider } from "@/components/base/slider/slider";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

const TITLE = "Marca de agua";
const DESCRIPTION = "Añade un texto semitransparente, como «CONFIDENCIAL» o «BORRADOR», en todas las páginas.";

type SourceFile = { file: File; pageCount: number };
type Position = "diagonal" | "center" | "top" | "bottom";
type PagePreview = { url: string; width: number; height: number };

const POSITIONS: { id: Position; label: string }[] = [
    { id: "diagonal", label: "Diagonal" },
    { id: "center", label: "Centro" },
    { id: "top", label: "Arriba" },
    { id: "bottom", label: "Abajo" },
];

const SWATCHES = [
    { value: "#d92d20", label: "Rojo" },
    { value: "#667085", label: "Gris" },
    { value: "#1570ef", label: "Azul" },
    { value: "#7f56d9", label: "Morado" },
];

/** Minimum gap between the watermark and the page edges, in points. */
const MARGIN = 24;
/** Distance from the top or bottom edge for the «Arriba» and «Abajo» positions. */
const EDGE_OFFSET = 36;
/** Cap height of Helvetica Bold as a fraction of the font size: used to centre the letters optically. */
const CAP_HEIGHT = 0.718;

const hexToRgb = (hex: string) => {
    const m = hex.replace("#", "").match(/.{2}/g);
    if (!m) return rgb(0, 0, 0);
    const [r, g, b] = m.map((h) => parseInt(h, 16) / 255);
    return rgb(r, g, b);
};

/**
 * Where the text goes on a page as the reader sees it (origin bottom-left, y up): baseline start, angle and the size
 * actually used, shrunk when the requested size doesn't fit between the margins. Shared by the preview and the PDF.
 */
const layoutWatermark = (pageWidth: number, pageHeight: number, widthAtOnePt: number, requestedSize: number, position: Position) => {
    if (position === "diagonal") {
        const c = Math.SQRT1_2;
        // A 45° text block of length L and height t spans (L + t)·cos45 both across and down the page.
        const fit = (Math.min(pageWidth, pageHeight) - 2 * MARGIN) / ((widthAtOnePt + CAP_HEIGHT) * c);
        const size = Math.max(1, Math.min(requestedSize, fit));
        const length = widthAtOnePt * size;
        const t = CAP_HEIGHT * size;
        return {
            x: pageWidth / 2 - (length / 2) * c + (t / 2) * c,
            y: pageHeight / 2 - (length / 2) * c - (t / 2) * c,
            angle: 45,
            size,
            length,
            shrunk: size < requestedSize - 0.5,
        };
    }
    const fit = (pageWidth - 2 * MARGIN) / widthAtOnePt;
    const size = Math.max(1, Math.min(requestedSize, fit));
    const length = widthAtOnePt * size;
    const t = CAP_HEIGHT * size;
    const y = position === "center" ? (pageHeight - t) / 2 : position === "top" ? pageHeight - EDGE_OFFSET - t : EDGE_OFFSET;
    return { x: (pageWidth - length) / 2, y, angle: 0, size, length, shrunk: size < requestedSize - 0.5 };
};

/** First character Helvetica (WinAnsi) can't draw, or null. */
const unsupportedChar = (font: PDFFont, text: string) => {
    try {
        font.encodeText(text);
        return null;
    } catch {
        for (const ch of text) {
            try {
                font.encodeText(ch);
            } catch {
                return ch;
            }
        }
        return null;
    }
};

const PositionGlyph = ({ position }: { position: Position }) => (
    <svg viewBox="0 0 24 30" fill="none" aria-hidden="true" className="h-7 w-6 shrink-0">
        <rect x="1.5" y="1.5" width="21" height="27" rx="2.5" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />
        <path
            d={position === "diagonal" ? "M6.5 22.5 17.5 7.5" : position === "center" ? "M6 15h12" : position === "top" ? "M6 7h12" : "M6 23h12"}
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
        />
    </svg>
);

export const WatermarkScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [text, setText] = useState("CONFIDENCIAL");
    const [opacity, setOpacity] = useState(20);
    const [size, setSize] = useState(72);
    const [color, setColor] = useState(SWATCHES[0].value);
    const [position, setPosition] = useState<Position>("diagonal");
    const [font, setFont] = useState<PDFFont | null>(null);
    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [previewPage, setPreviewPage] = useState(1);
    const [preview, setPreview] = useState<PagePreview | null>(null);
    const [shrunkPages, setShrunkPages] = useState(0);
    const colorLabelId = useId();

    const reset = () => {
        baseReset();
        setPreviewPage(1);
        setPreview(null);
        setShrunkPages(0);
    };

    // Helvetica Bold metrics, to measure and validate the text exactly as pdf-lib will draw it.
    useEffect(() => {
        let alive = true;
        (async () => {
            const doc = await PDFDocument.create();
            const embedded = await doc.embedFont(StandardFonts.HelveticaBold);
            if (alive) setFont(embedded);
        })().catch((err) => console.error(err));
        return () => {
            alive = false;
        };
    }, []);

    // Keep one pdf.js document per input for the preview.
    useEffect(() => {
        if (!input) return;
        let alive = true;
        let loaded: PDFDocumentProxy | null = null;
        (async () => {
            const pdfjs = await getPdfjs();
            loaded = await pdfjs.getDocument({ data: new Uint8Array(await input.file.arrayBuffer()) }).promise;
            if (alive) setPdfDoc(loaded);
            else void loaded.destroy();
        })().catch((err) => {
            if (alive) setError(friendlyError(err, "No se pudo mostrar la vista previa."));
        });
        return () => {
            alive = false;
            setPdfDoc(null);
            void loaded?.destroy();
        };
    }, [input, setError]);

    // Render the previewed page.
    useEffect(() => {
        if (!pdfDoc) return;
        let alive = true;
        let cancel: (() => void) | null = null;
        (async () => {
            const page = await pdfDoc.getPage(previewPage);
            const base = page.getViewport({ scale: 1 });
            const scale = (560 * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext("2d", { alpha: false });
            if (!ctx) throw new Error("Canvas no disponible.");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const task = page.render({ canvas, canvasContext: ctx, viewport });
            cancel = () => task.cancel();
            await task.promise;
            const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
            if (!alive) return;
            setPreview({ url: URL.createObjectURL(blob), width: base.width, height: base.height });
        })().catch((err) => {
            if (alive && (err as { name?: string })?.name !== "RenderingCancelledException") {
                setError(friendlyError(err, "No se pudo mostrar la vista previa."));
            }
        });
        return () => {
            alive = false;
            cancel?.();
        };
    }, [pdfDoc, previewPage, setError]);

    useEffect(() => () => void (preview && URL.revokeObjectURL(preview.url)), [preview]);

    const badChar = useMemo(() => (font ? unsupportedChar(font, text) : null), [font, text]);
    const trimmed = text.trim();
    const textProblem = !trimmed ? "Escribe el texto de la marca de agua." : badChar ? `El carácter «${badChar}» no se puede usar. Usa letras, números y signos habituales.` : null;

    const layout = useMemo(() => {
        if (!font || !preview || !trimmed || badChar) return null;
        return layoutWatermark(preview.width, preview.height, font.widthOfTextAtSize(trimmed, 1), size, position);
    }, [font, preview, trimmed, badChar, size, position]);

    const handleFile = async (files: FileList) => {
        setError(null);
        const file = files[0];
        if (!file) return;
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            setPreview(null);
            setPreviewPage(1);
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            setError(friendlyError(err, "No se pudo leer el PDF."));
        }
    };

    const apply = async (event?: FormEvent) => {
        event?.preventDefault();
        if (!input || isBusy || textProblem) return;
        setError(null);
        setBusy(true);
        try {
            const doc = await loadPdfForEditing(input.file);
            const pdfFont = await doc.embedFont(StandardFonts.HelveticaBold);
            const fillColor = hexToRgb(color);
            const widthAtOnePt = pdfFont.widthOfTextAtSize(trimmed, 1);
            const pages = doc.getPages();
            let shrunk = 0;
            for (const page of pages) {
                // Lay out in the page as displayed, then map back through /Rotate into the page's own coordinates.
                const box = page.getCropBox();
                const rotation = (((page.getRotation().angle ?? 0) % 360) + 360) % 360;
                const sideways = rotation === 90 || rotation === 270;
                const shown = layoutWatermark(sideways ? box.height : box.width, sideways ? box.width : box.height, widthAtOnePt, size, position);
                if (shown.shrunk) shrunk++;
                const { x: vx, y: vy } = shown;
                const [x, y] =
                    rotation === 90
                        ? [box.x + box.width - vy, box.y + vx]
                        : rotation === 180
                          ? [box.x + box.width - vx, box.y + box.height - vy]
                          : rotation === 270
                            ? [box.x + vy, box.y + box.height - vx]
                            : [box.x + vx, box.y + vy];
                page.drawText(trimmed, {
                    x,
                    y,
                    size: shown.size,
                    font: pdfFont,
                    color: fillColor,
                    opacity: opacity / 100,
                    rotate: degrees(shown.angle + rotation),
                });
            }
            const bytes = await doc.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            setShrunkPages(shrunk);
            setResult({
                blob,
                filename: datedFilename(`${base}-marca-de-agua`, "pdf"),
                summary: `Marca de agua en ${pagesLabel(pages.length)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            console.error(err);
            setError(friendlyError(err, "No se pudo aplicar la marca de agua. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} />
                {shrunkPages > 0 && (
                    <Notice tone="info">
                        {shrunkPages === input?.pageCount
                            ? "El texto se ha reducido para que quepa entero en la página."
                            : `En ${plural(shrunkPages, "página", "páginas")} el texto se ha reducido para que quepa entero.`}
                    </Notice>
                )}
            </ToolPageLayout>
        );
    }

    const ratio = preview ? preview.width / preview.height : 612 / 792;
    const isCustomColor = !SWATCHES.some((s) => s.value === color);

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint="Suelta el PDF al que quieres añadir la marca." onDropFiles={handleFile} />}

            <ErrorBanner message={error} />
            {error === PROTECTED_PDF_MESSAGE && (
                <div>
                    <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight}>
                        Ir a Desproteger PDF
                    </Button>
                </div>
            )}

            {input && (
                <form noValidate onSubmit={apply} className="flex flex-col gap-5 rounded-2xl bg-primary p-4 ring-1 ring-secondary ring-inset sm:p-5">
                    <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-quaternary ring-1 ring-secondary ring-inset">
                            <File04 aria-hidden="true" className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-primary">{input.file.name}</p>
                            <p className="text-sm text-tertiary">
                                {pagesLabel(input.pageCount)} · {readableBytes(input.file.size)}
                            </p>
                        </div>
                        <ButtonUtility color="tertiary" tooltip="Quitar archivo" icon={Trash01} size="sm" onClick={reset} />
                    </div>

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:items-start">
                        {/* Preview (first on phones, right column from md) */}
                        <div className="flex flex-col items-center gap-2 md:sticky md:top-6 md:col-start-2 md:row-start-1">
                            <div
                                className="relative w-full max-w-[min(100%,calc(40dvh*var(--page-ratio)))] overflow-hidden rounded-md bg-white shadow-md ring-1 ring-secondary md:max-w-[min(100%,calc(72dvh*var(--page-ratio)))]"
                                style={{ aspectRatio: `${ratio}`, "--page-ratio": ratio } as React.CSSProperties}
                            >
                                {preview ? (
                                    <>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={preview.url} alt={`Vista previa de la página ${previewPage} con la marca de agua`} className="absolute inset-0 size-full" />
                                        {layout && (
                                            <svg viewBox={`0 0 ${preview.width} ${preview.height}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
                                                <text
                                                    x={layout.x}
                                                    y={preview.height - layout.y}
                                                    transform={`rotate(${-layout.angle} ${layout.x} ${preview.height - layout.y})`}
                                                    fontFamily="Helvetica, Arial, sans-serif"
                                                    fontWeight={700}
                                                    fontSize={layout.size}
                                                    textLength={layout.length}
                                                    lengthAdjust="spacingAndGlyphs"
                                                    fill={color}
                                                    fillOpacity={opacity / 100}
                                                >
                                                    {trimmed}
                                                </text>
                                            </svg>
                                        )}
                                    </>
                                ) : (
                                    <div className="absolute inset-0 animate-pulse bg-secondary" />
                                )}
                            </div>
                            {input.pageCount > 1 && (
                                <div className="flex items-center gap-1">
                                    <ButtonUtility
                                        color="tertiary"
                                        size="sm"
                                        icon={ChevronLeft}
                                        tooltip="Página anterior"
                                        isDisabled={previewPage <= 1}
                                        onClick={() => setPreviewPage((n) => Math.max(1, n - 1))}
                                    />
                                    <span className="min-w-28 text-center text-sm font-medium text-secondary" aria-live="polite">
                                        Página {previewPage} de {input.pageCount}
                                    </span>
                                    <ButtonUtility
                                        color="tertiary"
                                        size="sm"
                                        icon={ChevronRight}
                                        tooltip="Página siguiente"
                                        isDisabled={previewPage >= input.pageCount}
                                        onClick={() => setPreviewPage((n) => Math.min(input.pageCount, n + 1))}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Settings */}
                        <div className="flex min-w-0 flex-col gap-5 md:col-start-1 md:row-start-1">
                            <Input
                                label="Texto"
                                placeholder="Ej.: BORRADOR"
                                value={text}
                                onChange={setText}
                                isInvalid={!!textProblem}
                                hint={textProblem ?? "Se escribe igual en todas las páginas."}
                                maxLength={120}
                            />

                            <AriaRadioGroup value={position} onChange={(value) => setPosition(value as Position)} orientation="horizontal" className="flex flex-col gap-2">
                                <AriaLabel className="text-sm font-medium text-secondary">Posición</AriaLabel>
                                <div className="grid grid-cols-4 gap-2">
                                    {POSITIONS.map((p) => (
                                        <AriaRadio
                                            key={p.id}
                                            value={p.id}
                                            className={({ isSelected, isFocusVisible }) =>
                                                cx(
                                                    "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-xs font-semibold ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset",
                                                    isSelected
                                                        ? "bg-brand-primary_alt text-brand-secondary ring-2 ring-brand"
                                                        : "bg-primary text-secondary ring-secondary hover:bg-primary_hover",
                                                    isFocusVisible && "outline-2 outline-offset-2",
                                                )
                                            }
                                        >
                                            <PositionGlyph position={p.id} />
                                            {p.label}
                                        </AriaRadio>
                                    ))}
                                </div>
                            </AriaRadioGroup>

                            <div className="flex flex-col gap-2">
                                <span id={colorLabelId} className="text-sm font-medium text-secondary">
                                    Color
                                </span>
                                <div className="flex flex-wrap items-center gap-2">
                                    <AriaRadioGroup
                                        aria-labelledby={colorLabelId}
                                        value={isCustomColor ? null : color}
                                        onChange={setColor}
                                        orientation="horizontal"
                                        className="flex items-center gap-2"
                                    >
                                        {SWATCHES.map((s) => (
                                            <AriaRadio
                                                key={s.value}
                                                value={s.value}
                                                aria-label={s.label}
                                                className={({ isSelected, isFocusVisible }) =>
                                                    cx(
                                                        "flex cursor-pointer rounded-full p-0.5 ring-2 outline-focus-ring transition duration-100 ease-linear",
                                                        isSelected ? "ring-brand" : "ring-transparent hover:ring-primary",
                                                        isFocusVisible && "outline-2 outline-offset-2",
                                                    )
                                                }
                                            >
                                                <span className="size-7 rounded-full ring-1 ring-black/10 ring-inset" style={{ backgroundColor: s.value }} />
                                            </AriaRadio>
                                        ))}
                                    </AriaRadioGroup>
                                    <label
                                        className={cx(
                                            "ml-1 flex cursor-pointer items-center gap-2 rounded-full py-0.5 pr-3 pl-0.5 text-sm font-medium text-secondary ring-2 transition duration-100 ease-linear focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring",
                                            isCustomColor ? "ring-brand" : "ring-transparent hover:ring-primary",
                                        )}
                                    >
                                        <span
                                            className="relative size-7 rounded-full ring-1 ring-black/10 ring-inset"
                                            style={{
                                                background: isCustomColor ? color : "conic-gradient(#f04438, #fdb022, #17b26a, #2e90fa, #7a5af8, #ee46bc, #f04438)",
                                            }}
                                        >
                                            <input
                                                type="color"
                                                value={color}
                                                onChange={(e) => setColor(e.target.value)}
                                                className="absolute inset-0 size-full cursor-pointer opacity-0"
                                                aria-label="Otro color"
                                            />
                                        </span>
                                        Otro
                                    </label>
                                </div>
                            </div>

                            <div className="flex flex-col gap-5">
                                <div className="flex flex-col gap-1">
                                    <p className="flex items-baseline justify-between gap-2 text-sm font-medium text-secondary">
                                        <span>Tamaño</span>
                                        <span className="text-tertiary tabular-nums">{size} pt</span>
                                    </p>
                                    <Slider
                                        value={size}
                                        onChange={(v) => setSize((Array.isArray(v) ? v[0] : v) as number)}
                                        minValue={16}
                                        maxValue={144}
                                        step={2}
                                        aria-label="Tamaño en puntos"
                                        formatOptions={{ maximumFractionDigits: 0 }}
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <p className="flex items-baseline justify-between gap-2 text-sm font-medium text-secondary">
                                        <span>Opacidad</span>
                                        <span className="text-tertiary tabular-nums">{opacity} %</span>
                                    </p>
                                    <Slider
                                        value={opacity}
                                        onChange={(v) => setOpacity((Array.isArray(v) ? v[0] : v) as number)}
                                        minValue={5}
                                        maxValue={100}
                                        step={5}
                                        aria-label="Opacidad"
                                        formatOptions={{ style: "unit", unit: "percent", maximumFractionDigits: 0 }}
                                    />
                                </div>
                            </div>
                            {layout?.shrunk && (
                                <Notice tone="info">
                                    A {size} pt el texto no cabe en la página, así que se usará el tamaño máximo que cabe ({Math.floor(layout.size)} pt).
                                </Notice>
                            )}
                        </div>
                    </div>

                    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col-reverse gap-3 rounded-b-2xl border-t border-secondary bg-primary/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-5 sm:-mb-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        <p className="hidden text-sm text-tertiary sm:block">
                            Se añadirá a {input.pageCount === 1 ? "la página" : `las ${pagesLabel(input.pageCount)}`}.
                        </p>
                        <Button
                            type="submit"
                            color="primary"
                            size="lg"
                            iconLeading={Droplets02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!!textProblem || !font}
                            className="shrink-0"
                        >
                            {isBusy ? "Aplicando…" : "Aplicar marca de agua"}
                        </Button>
                    </div>
                </form>
            )}
        </ToolPageLayout>
    );
};
