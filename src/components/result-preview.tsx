"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize01, Minimize01 } from "@untitledui/icons";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

/** Larger files are not drawn: the preview needs a second copy of the document in memory. */
const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;

const isPdfName = (filename: string) => /\.pdf$/i.test(filename);
const isImageName = (filename: string) => /\.(png|jpe?g)$/i.test(filename);

/** Whether a result with this name and size gets a preview (the panel lays itself out around it). */
export const canPreview = (filename: string, size: number) => size <= MAX_PREVIEW_BYTES && (isPdfName(filename) || isImageName(filename));

/** The document behind `blob`, opened with pdf.js while the preview needs it. `failed` also covers PDFs that ask for a password. */
const usePdfDocument = (blob: Blob | null) => {
    const [state, setState] = useState<{ blob: Blob | null; doc: PDFDocumentProxy | null; failed: boolean }>({ blob: null, doc: null, failed: false });

    useEffect(() => {
        if (!blob) return;
        let cancelled = false;
        let task: PDFDocumentLoadingTask | null = null;
        (async () => {
            try {
                const pdfjs = await getPdfjs();
                const data = new Uint8Array(await blob.arrayBuffer());
                if (cancelled) return;
                task = pdfjs.getDocument({ data });
                const doc = await task.promise;
                if (!cancelled) setState({ blob, doc, failed: false });
            } catch {
                if (!cancelled) setState({ blob, doc: null, failed: true });
            }
        })();
        return () => {
            cancelled = true;
            void task?.destroy();
        };
    }, [blob]);

    // Until the effect has answered for this blob, nothing is known about it.
    return state.blob === blob ? state : { blob, doc: null, failed: false };
};

type Shown = "result" | "original";

/**
 * What the tool has just produced, to check before downloading: the pages of a PDF, one at a time, or the image. With
 * `original`, a switch shows the same page of the file the person started from (what a compression changed).
 */
export const ResultPreview = ({
    blob,
    filename,
    original,
    large,
    onToggleLarge,
    className,
}: {
    blob: Blob;
    filename: string;
    /** The file before the tool changed it. */
    original?: Blob;
    large: boolean;
    onToggleLarge: () => void;
    className?: string;
}) => {
    const pdf = isPdfName(filename);
    const [shown, setShown] = useState<Shown>("result");
    const [page, setPage] = useState(1);
    const [drawn, setDrawn] = useState(false);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const result = usePdfDocument(pdf ? blob : null);
    // Opened the first time it is asked for, then kept for switching back and forth.
    const [wantsOriginal, setWantsOriginal] = useState(false);
    const before = usePdfDocument(pdf && original && wantsOriginal ? original : null);
    const current = shown === "original" ? before : result;
    const pageCount = current.doc?.numPages ?? result.doc?.numPages ?? 0;
    const pageNumber = Math.min(page, current.doc?.numPages ?? page);

    useEffect(() => {
        if (pdf) return;
        const url = URL.createObjectURL(blob);
        setImageUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [blob, pdf]);

    useEffect(() => {
        const doc = current.doc;
        if (!doc) return;
        let cancelled = false;
        let task: RenderTask | null = null;
        (async () => {
            const pdfPage = await doc.getPage(pageNumber);
            const frame = frameRef.current;
            const canvas = canvasRef.current;
            if (cancelled || !frame || !canvas) return;
            const base = pdfPage.getViewport({ scale: 1 });
            // As sharp as the screen shows it, and no more: a preview, not an export.
            const pixels = frame.clientWidth * Math.min(window.devicePixelRatio || 1, 2);
            const viewport = pdfPage.getViewport({ scale: Math.min(pixels / base.width, 4) });
            // Drawn aside and copied when done, so the page on screen never shows half painted.
            const buffer = document.createElement("canvas");
            buffer.width = Math.max(1, Math.ceil(viewport.width));
            buffer.height = Math.max(1, Math.ceil(viewport.height));
            const context = buffer.getContext("2d", { alpha: false });
            if (!context) return;
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, buffer.width, buffer.height);
            task = pdfPage.render({ canvas: buffer, canvasContext: context, viewport });
            await task.promise;
            if (cancelled) return;
            canvas.width = buffer.width;
            canvas.height = buffer.height;
            canvas.getContext("2d")?.drawImage(buffer, 0, 0);
            buffer.width = 0;
            buffer.height = 0;
            setDrawn(true);
        })().catch(() => undefined); // A cancelled drawing rejects: the next one is already under way.
        return () => {
            cancelled = true;
            task?.cancel();
        };
    }, [current.doc, pageNumber, large]);

    const show = (next: Shown) => {
        if (next === "original") setWantsOriginal(true);
        setShown(next);
    };

    const unavailable = pdf && current.failed;
    const waiting = pdf && !current.failed && !drawn;

    return (
        <section aria-label="Vista previa del resultado" className={cx("flex w-full flex-col items-center gap-3", className)}>
            {pdf && original && (
                <div role="group" aria-label="Qué versión se muestra" className="flex rounded-lg bg-secondary p-0.5 ring-1 ring-secondary ring-inset">
                    {(["original", "result"] as const).map((option) => (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={shown === option}
                            onClick={() => show(option)}
                            className={cx(
                                "min-h-8 rounded-md px-3 text-sm font-semibold outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2",
                                shown === option ? "bg-primary text-primary shadow-xs" : "text-tertiary hover:text-secondary",
                            )}
                        >
                            {option === "original" ? "Original" : "Resultado"}
                        </button>
                    ))}
                </div>
            )}

            <div
                ref={frameRef}
                className={cx(
                    "relative w-full overflow-hidden rounded-lg bg-secondary ring-1 ring-secondary",
                    large ? "max-w-3xl" : "max-w-xs",
                    (waiting || unavailable) && "aspect-[3/4]",
                )}
            >
                {pdf ? (
                    <canvas
                        ref={canvasRef}
                        role="img"
                        aria-label={pageCount ? `Página ${pageNumber} de ${pageCount}` : "Página del documento"}
                        className={cx("block h-auto w-full", (waiting || unavailable) && "invisible absolute")}
                    />
                ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    imageUrl && <img src={imageUrl} alt="Imagen resultante" className="block h-auto w-full" />
                )}
                {waiting && <div aria-hidden="true" className="absolute inset-0 animate-pulse bg-tertiary" />}
                {unavailable && (
                    <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-tertiary">
                        No se puede mostrar la vista previa.
                    </p>
                )}
            </div>

            <div className="flex items-center gap-1">
                {pdf && pageCount > 1 && (
                    <>
                        <ButtonUtility
                            color="tertiary"
                            size="sm"
                            icon={ChevronLeft}
                            tooltip="Página anterior"
                            isDisabled={pageNumber <= 1}
                            onClick={() => setPage(pageNumber - 1)}
                        />
                        <p aria-live="polite" className="min-w-24 text-center text-sm text-tertiary tabular-nums">
                            Página {pageNumber} de {pageCount}
                        </p>
                        <ButtonUtility
                            color="tertiary"
                            size="sm"
                            icon={ChevronRight}
                            tooltip="Página siguiente"
                            isDisabled={pageNumber >= pageCount}
                            onClick={() => setPage(pageNumber + 1)}
                        />
                    </>
                )}
                {/* On a phone the preview already takes the whole width. */}
                <span className="hidden md:inline-flex">
                    <ButtonUtility
                        color="tertiary"
                        size="sm"
                        icon={large ? Minimize01 : Maximize01}
                        tooltip={large ? "Reducir la vista previa" : "Ampliar la vista previa"}
                        onClick={onToggleLarge}
                    />
                </span>
            </div>
        </section>
    );
};
