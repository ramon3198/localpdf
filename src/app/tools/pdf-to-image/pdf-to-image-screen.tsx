"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, File04, Image01, Trash01 } from "@untitledui/icons";
import JSZip from "jszip";
import { motion, useReducedMotion } from "motion/react";
import { Label as AriaLabel, Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Slider } from "@/components/base/slider/slider";
import { ErrorBanner, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, pagesLabel, parsePageRanges, plural, readableBytes } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

/** `pageSize` is page 1 in points, used to tell the user how big the images will be. */
type SourceFile = { file: File; pageCount: number; pageSize: { width: number; height: number } };
type Format = "png" | "jpeg";
type Scope = "all" | "ranges";
type Progress = { label: string; pct: number | null };

const TITLE = "PDF a Imagen";
const DESCRIPTION = "Convierte cada página a PNG o JPG.";
const FORMAT_LABEL: Record<Format, string> = { png: "PNG", jpeg: "JPG" };
const FORMAT_EXT: Record<Format, string> = { png: "png", jpeg: "jpg" };
const DEFAULT_DPI = 150;

const percent = (value: number) => `${Math.round(value)} %`;
const imagesLabel = (count: number) => plural(count, "imagen", "imágenes");
/** Same rounding as the canvas the page is drawn on. */
const pixels = (points: number, dpi: number) => Math.max(1, Math.ceil((points * dpi) / 72));

export const PdfToImageScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [isReading, setReading] = useState(false);
    const [scope, setScope] = useState<Scope>("all");
    const [ranges, setRanges] = useState("");
    const [format, setFormat] = useState<Format>("png");
    const [dpi, setDpi] = useState(DEFAULT_DPI);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [resultCount, setResultCount] = useState(0);
    const runRef = useRef(0);
    const fileRef = useRef(0);

    useEffect(
        () => () => {
            runRef.current++;
            fileRef.current++;
        },
        [],
    );

    // Checked while typing, so the problem shows on the field itself and the button can't start a doomed run.
    const rangeCheck = useMemo(() => {
        if (!input || scope !== "ranges" || !ranges.trim()) return null;
        return parsePageRanges(ranges, input.pageCount);
    }, [input, scope, ranges]);

    const selectedPages = useMemo(() => {
        if (!input) return [];
        if (scope === "all" || input.pageCount === 1) return Array.from({ length: input.pageCount }, (_, i) => i + 1);
        return rangeCheck && !rangeCheck.error ? rangeCheck.pages : [];
    }, [input, scope, rangeCheck]);

    const reset = () => {
        runRef.current++;
        fileRef.current++;
        baseReset();
        setProgress(null);
        setScope("all");
        setRanges("");
    };

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        const fileId = ++fileRef.current;
        setError(null);
        setReading(true);
        try {
            const pdfjs = await getPdfjs();
            const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
            try {
                const doc = await task.promise;
                const viewport = (await doc.getPage(1)).getViewport({ scale: 1 });
                if (fileRef.current !== fileId) return;
                setScope("all");
                setRanges("");
                setInput({ file, pageCount: doc.numPages, pageSize: { width: viewport.width, height: viewport.height } });
            } finally {
                task.destroy();
            }
        } catch (err) {
            if (fileRef.current === fileId) setError(friendlyError(err, "No se pudo leer el PDF."));
        } finally {
            if (fileRef.current === fileId) setReading(false);
        }
    };

    const cancel = () => {
        runRef.current++;
        setBusy(false);
        setProgress(null);
    };

    const convert = async () => {
        if (!input || selectedPages.length === 0) return;
        const run = ++runRef.current;
        const isCurrent = () => runRef.current === run;
        const pages = selectedPages;
        const base = input.file.name.replace(/\.pdf$/i, "");
        const mime = format === "png" ? "image/png" : "image/jpeg";
        const ext = FORMAT_EXT[format];
        const pageName = (n: number) => `${base}-pagina-${String(n).padStart(3, "0")}`;
        setError(null);
        setBusy(true);
        setProgress({ label: pages.length > 1 ? `Convirtiendo página 1 de ${pages.length}…` : "Convirtiendo la página…", pct: pages.length > 1 ? 0 : null });
        try {
            const pdfjs = await getPdfjs();
            const task = pdfjs.getDocument({ data: new Uint8Array(await input.file.arrayBuffer()) });
            try {
                const doc = await task.promise;
                const renderOne = async (n: number) => {
                    const page = await doc.getPage(n);
                    const viewport = page.getViewport({ scale: dpi / 72 });
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.ceil(viewport.width));
                    canvas.height = Math.max(1, Math.ceil(viewport.height));
                    const ctx = canvas.getContext("2d", { alpha: false });
                    if (!ctx) throw new Error("canvas");
                    // White paper, as in any PDF viewer: a transparent PNG shows black text on black in dark image viewers.
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
                    const blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), mime, format === "jpeg" ? 0.92 : undefined);
                    });
                    const size = { width: canvas.width, height: canvas.height };
                    canvas.width = 0;
                    canvas.height = 0;
                    page.cleanup();
                    return { blob, size };
                };

                if (pages.length === 1) {
                    const { blob, size } = await renderOne(pages[0]);
                    if (!isCurrent()) return;
                    setResultCount(1);
                    setResult({
                        blob,
                        filename: datedFilename(pageName(pages[0]), ext),
                        primaryLabel: "Descargar imagen",
                        summary: `Imagen ${FORMAT_LABEL[format]} · ${size.width} × ${size.height} px · ${readableBytes(blob.size)}`,
                    });
                    return;
                }

                const zip = new JSZip();
                for (let i = 0; i < pages.length; i++) {
                    if (!isCurrent()) return;
                    setProgress({ label: `Convirtiendo página ${i + 1} de ${pages.length}…`, pct: Math.round((i / pages.length) * 100) });
                    const { blob } = await renderOne(pages[i]);
                    zip.file(`${pageName(pages[i])}.${ext}`, blob);
                }
                if (!isCurrent()) return;
                setProgress({ label: "Creando el archivo ZIP…", pct: null });
                // PNG and JPG are already compressed: storing them is as small and much faster.
                const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
                if (!isCurrent()) return;
                setResultCount(pages.length);
                setResult({
                    blob: zipBlob,
                    filename: datedFilename(`${base}-imagenes`, "zip"),
                    primaryLabel: "Descargar ZIP",
                    summary: `${imagesLabel(pages.length)} ${FORMAT_LABEL[format]} en un ZIP · ${readableBytes(zipBlob.size)}`,
                });
            } finally {
                task.destroy();
            }
        } catch (err) {
            if (isCurrent()) setError(friendlyError(err, "No se pudo convertir el PDF. Inténtalo de nuevo."));
        } finally {
            if (isCurrent()) {
                setBusy(false);
                setProgress(null);
            }
        }
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} title={resultCount > 1 ? "¡Imágenes listas!" : "¡Imagen lista!"} />
            </ToolPageLayout>
        );
    }

    const rangeInvalid = scope === "ranges" && input !== null && input.pageCount > 1 && (!rangeCheck || !!rangeCheck.error);
    const count = selectedPages.length;
    const firstSize = input ? `${pixels(input.pageSize.width, dpi)} × ${pixels(input.pageSize.height, dpi)} px` : "";

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && (
                <>
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={isReading}
                        hint={isReading ? "Leyendo el PDF…" : "Suelta el PDF que quieres convertir en imágenes."}
                        onDropFiles={handleFile}
                        // The drop zone explains the wrong format itself; only clear an older error.
                        onDropUnacceptedFiles={() => setError(null)}
                    />
                    <ErrorArea error={error} />
                </>
            )}

            {input && (
                <div className="flex flex-col gap-6 rounded-2xl bg-primary p-5 ring-1 ring-secondary ring-inset md:p-6">
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
                        <ButtonUtility color="tertiary" tooltip="Quitar archivo" icon={Trash01} size="sm" isDisabled={isBusy} onClick={reset} />
                    </div>

                    <AriaRadioGroup value={format} onChange={(value) => setFormat(value as Format)} isDisabled={isBusy} className="flex flex-col gap-3">
                        <AriaLabel className="text-sm font-medium text-secondary">Formato</AriaLabel>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <OptionCard value="png" title="PNG" description="Máxima nitidez. Ideal para texto, tablas y gráficos." />
                            <OptionCard value="jpeg" title="JPG" description="Archivos más ligeros. Ideal para fotos y para enviar por correo." />
                        </div>
                    </AriaRadioGroup>

                    <div className={cx("flex flex-col gap-2", isBusy && "opacity-50")}>
                        <p className="flex items-center justify-between gap-3 text-sm font-medium text-secondary">
                            <span>Resolución</span>
                            <span className="text-tertiary tabular-nums">{dpi} ppp</span>
                        </p>
                        <Slider
                            value={[dpi]}
                            onChange={(v) => setDpi((Array.isArray(v) ? v[0] : v) as number)}
                            minValue={75}
                            maxValue={300}
                            step={25}
                            isDisabled={isBusy}
                            formatOptions={{ maximumFractionDigits: 0 }}
                            aria-label="Resolución en puntos por pulgada"
                        />
                        <p className="text-sm text-tertiary">
                            {input.pageCount > 1 ? `La página 1 medirá ${firstSize}.` : `La imagen medirá ${firstSize}.`} Más resolución: más nitidez y más
                            peso.
                        </p>
                    </div>

                    {input.pageCount > 1 && (
                        <AriaRadioGroup value={scope} onChange={(value) => setScope(value as Scope)} isDisabled={isBusy} className="flex flex-col gap-3">
                            <AriaLabel className="text-sm font-medium text-secondary">Páginas</AriaLabel>
                            <div className="flex flex-wrap gap-2">
                                <OptionChip value="all">Todas ({input.pageCount})</OptionChip>
                                <OptionChip value="ranges">Elegir páginas</OptionChip>
                            </div>
                            {scope === "ranges" && (
                                <Input
                                    size="md"
                                    label="Páginas que quieres convertir"
                                    placeholder="Ej.: 1-3, 5, 8-10"
                                    value={ranges}
                                    onChange={setRanges}
                                    isDisabled={isBusy}
                                    isInvalid={!!rangeCheck?.error}
                                    hint={
                                        rangeCheck?.error ??
                                        (rangeCheck
                                            ? `${plural(rangeCheck.pages.length, "página seleccionada", "páginas seleccionadas")}.`
                                            : `Escribe números o rangos separados por comas, entre 1 y ${input.pageCount}.`)
                                    }
                                />
                            )}
                        </AriaRadioGroup>
                    )}

                    {progress && <ProgressBar label={progress.label} pct={progress.pct} />}

                    <ErrorArea error={error} />

                    <ActionBar
                        summary={
                            count > 0
                                ? count === 1
                                    ? `Se descargará 1 imagen ${FORMAT_LABEL[format]}.`
                                    : `Se descargarán ${imagesLabel(count)} ${FORMAT_LABEL[format]} en un ZIP.`
                                : rangeCheck?.error
                                  ? "Revisa las páginas elegidas para continuar."
                                  : "Escribe qué páginas quieres convertir."
                        }
                    >
                        {isBusy && (
                            <Button color="secondary" size="lg" className="w-full sm:w-auto" onClick={cancel}>
                                Cancelar
                            </Button>
                        )}
                        <Button
                            color="primary"
                            size="lg"
                            iconLeading={Image01}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!isBusy && (rangeInvalid || count === 0)}
                            className="w-full sm:w-auto"
                            onClick={convert}
                        >
                            {isBusy ? "Convirtiendo…" : count > 1 ? "Convertir a imágenes" : "Convertir a imagen"}
                        </Button>
                    </ActionBar>
                </div>
            )}
        </ToolPageLayout>
    );
};

/** Single-choice card: a real radio (arrow keys move the choice) with a visible dot, not only a colour change. */
const OptionCard = ({ value, title, description }: { value: string; title: ReactNode; description: string }) => (
    <AriaRadio
        value={value}
        className={({ isSelected, isFocusVisible, isDisabled }) =>
            cx(
                "flex cursor-pointer items-start gap-3 rounded-xl bg-primary p-4 text-left ring-1 ring-secondary outline-focus-ring transition duration-100 ease-linear ring-inset hover:bg-primary_hover",
                isSelected && "bg-brand-primary_alt ring-2 ring-brand hover:bg-brand-primary_alt",
                isFocusVisible && "outline-2 outline-offset-2",
                isDisabled && "cursor-not-allowed opacity-50",
            )
        }
    >
        {({ isSelected }) => (
            <>
                <RadioDot isSelected={isSelected} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-semibold text-primary">{title}</span>
                    <span className="text-sm text-tertiary">{description}</span>
                </span>
            </>
        )}
    </AriaRadio>
);

/** Compact single-choice pill for short options. */
const OptionChip = ({ value, children }: { value: string; children: ReactNode }) => (
    <AriaRadio
        value={value}
        className={({ isSelected, isFocusVisible, isDisabled }) =>
            cx(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-semibold text-secondary ring-1 ring-primary outline-focus-ring transition duration-100 ease-linear ring-inset hover:bg-primary_hover",
                isSelected && "bg-brand-primary_alt text-primary ring-2 ring-brand hover:bg-brand-primary_alt",
                isFocusVisible && "outline-2 outline-offset-2",
                isDisabled && "cursor-not-allowed opacity-50",
            )
        }
    >
        {({ isSelected }) => (
            <>
                <RadioDot isSelected={isSelected} className="mt-0" />
                {children}
            </>
        )}
    </AriaRadio>
);

const RadioDot = ({ isSelected, className }: { isSelected: boolean; className?: string }) => (
    <span
        aria-hidden="true"
        className={cx(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary ring-1 ring-primary transition duration-100 ease-linear ring-inset",
            isSelected && "bg-brand-solid ring-transparent",
            className,
        )}
    >
        <span className={cx("size-1.5 rounded-full bg-white", !isSelected && "opacity-0")} />
    </span>
);

/** Screen error plus, for protected files, the way out. */
const ErrorArea = ({ error }: { error: string | null }) => (
    <div className="flex flex-col items-start gap-2 empty:hidden">
        <ErrorBanner message={error} />
        {error === PROTECTED_PDF_MESSAGE && (
            <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight}>
                Ir a Desproteger PDF
            </Button>
        )}
    </div>
);

const ProgressBar = ({ label, pct }: Progress) => {
    const reduceMotion = useReducedMotion();
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium text-secondary">{label}</span>
                {pct !== null && <span className="shrink-0 text-tertiary tabular-nums">{percent(pct)}</span>}
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                className="relative h-2 overflow-hidden rounded-full bg-quaternary"
            >
                {pct !== null ? (
                    <div className="h-full rounded-full bg-brand-solid transition-[width] duration-200 ease-linear" style={{ width: `${pct}%` }} />
                ) : (
                    <motion.div
                        className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-brand-solid"
                        initial={{ x: "-100%" }}
                        animate={{ x: reduceMotion ? "100%" : ["-100%", "300%"] }}
                        transition={reduceMotion ? { duration: 0 } : { duration: 1.2, ease: "linear", repeat: Infinity }}
                    />
                )}
            </div>
        </div>
    );
};

/** Main actions: a sticky bar at the bottom of the screen on phones, a plain footer from `sm` up. */
const ActionBar = ({ summary, children }: { summary?: ReactNode; children: ReactNode }) => (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3 rounded-b-2xl bg-primary/95 px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] ring-1 ring-secondary backdrop-blur-sm ring-inset sm:static sm:m-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-none sm:border-t sm:border-secondary sm:bg-transparent sm:px-0 sm:pt-5 sm:pb-0 sm:ring-0 sm:backdrop-blur-none">
        {summary ? <p className="text-sm text-tertiary">{summary}</p> : <span className="max-sm:hidden" />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">{children}</div>
    </div>
);
