"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, ArrowLeft, ArrowRight, DownloadCloud02, File04, RefreshCcw01, Trash01, Zap } from "@untitledui/icons";
import { motion, useReducedMotion } from "motion/react";
import { Label as AriaLabel, Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Slider } from "@/components/base/slider/slider";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, downloadBlob, friendlyError, loadPdfForEditing, pagesLabel, readableBytes } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

type SourceFile = { file: File; pageCount: number };
type Mode = "light" | "strong";
type Outcome = { mode: Mode; inputBytes: number; outputBytes: number };
type Progress = { label: string; pct: number | null };
type Analysis = { hasText: boolean; looksScanned: boolean };

const TITLE = "Comprimir PDF";
const DESCRIPTION = "Reduce el peso manteniendo la calidad que necesites.";
const MODE_LABEL: Record<Mode, string> = { light: "Ligero", strong: "Fuerte" };
/** Below this saving the result is not worth a download (and is often bigger). */
const MIN_SAVING = 0.02;
const DEFAULT_QUALITY = 75;
const DEFAULT_DPI = 100;

const percent = (value: number) => `${Math.round(value)} %`;
/** Rounded down, so a 99.8 % saving never reads as "100 %". */
const savingLabel = (inputBytes: number, outputBytes: number) => `${Math.max(0, Math.floor((1 - outputBytes / inputBytes) * 100))} %`;
const baseName = (file: File) => file.name.replace(/\.pdf$/i, "");

const deflate = async (data: Uint8Array) => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

type LoadedPdf = Awaited<ReturnType<typeof loadPdfForEditing>>;
type Ref = import("pdf-lib").PDFRef;

const sha256 = async (data: Uint8Array) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Lossless clean-up for the "Ligero" level: merges identical streams (the same fonts and images repeated on every page
 * of merged PDFs), drops data no viewer shows (other apps' private data such as a whole Illustrator file in /PieceInfo,
 * page thumbnails, objects nothing points to) and deflates streams stored uncompressed.
 */
const optimizeStructure = async (doc: LoadedPdf) => {
    const { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream } = await import("pdf-lib");
    const ctx = doc.context;
    const PieceInfo = PDFName.of("PieceInfo");
    const Thumb = PDFName.of("Thumb");
    const Page = PDFName.of("Page");
    const Type = PDFName.of("Type");
    const Filter = PDFName.of("Filter");
    const Length = PDFName.of("Length");
    const Metadata = PDFName.of("Metadata");

    for (const [, object] of ctx.enumerateIndirectObjects()) {
        const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : null;
        if (!dict) continue;
        dict.delete(PieceInfo);
        if (dict.get(Type) === Page) dict.delete(Thumb);
    }

    // Identical streams become one shared object. Several passes: once the images' soft masks are merged,
    // the images that use them become identical too.
    if (typeof crypto !== "undefined" && crypto.subtle) {
        const rewrite = (value: unknown, swap: Map<unknown, Ref>) => {
            if (value instanceof PDFDict) {
                for (const [key, entry] of value.entries()) {
                    const next = entry instanceof PDFRef ? swap.get(entry) : undefined;
                    if (next) value.set(key, next);
                    else rewrite(entry, swap);
                }
            } else if (value instanceof PDFArray) {
                for (let i = 0; i < value.size(); i++) {
                    const entry = value.get(i);
                    const next = entry instanceof PDFRef ? swap.get(entry) : undefined;
                    if (next) value.set(i, next);
                    else rewrite(entry, swap);
                }
            } else if (value instanceof PDFStream) {
                rewrite(value.dict, swap);
            }
        };
        for (let pass = 0; pass < 4; pass++) {
            const canonical = new Map<string, Ref>();
            const swap = new Map<unknown, Ref>();
            for (const [ref, object] of ctx.enumerateIndirectObjects()) {
                if (!(object instanceof PDFRawStream)) continue;
                const header = object.dict
                    .entries()
                    .filter(([key]) => key !== Length)
                    .map(([key, value]) => `${key.toString()} ${value.toString()}`)
                    .join("\n");
                const key = `${object.contents.length}|${header}|${await sha256(object.contents)}`;
                const first = canonical.get(key);
                if (first) swap.set(ref, first);
                else canonical.set(key, ref);
            }
            if (!swap.size) break;
            for (const [, object] of ctx.enumerateIndirectObjects()) rewrite(object, swap);
            for (const ref of swap.keys()) ctx.delete(ref as Ref);
        }
    }

    const reachable = new Set<unknown>();
    const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
    while (stack.length) {
        const item = stack.pop();
        if (item instanceof PDFRef) {
            if (reachable.has(item)) continue;
            reachable.add(item);
            stack.push(ctx.lookup(item));
        } else if (item instanceof PDFDict) {
            for (const [, value] of item.entries()) stack.push(value);
        } else if (item instanceof PDFArray) {
            for (let i = 0; i < item.size(); i++) stack.push(item.get(i));
        } else if (item instanceof PDFStream) {
            stack.push(item.dict);
        }
    }
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!reachable.has(ref)) ctx.delete(ref);

    if (typeof CompressionStream === "undefined") return;
    for (const [ref, object] of ctx.enumerateIndirectObjects()) {
        // XMP metadata stays readable (PDF/A requires it uncompressed).
        if (!(object instanceof PDFRawStream) || object.dict.has(Filter) || object.dict.get(Type) === Metadata || object.contents.length < 256) continue;
        const packed = await deflate(object.contents);
        if (packed.length >= object.contents.length) continue;
        object.dict.set(Filter, PDFName.of("FlateDecode"));
        ctx.assign(ref, PDFRawStream.of(object.dict, packed));
    }
};

/**
 * Looks at the first pages: `hasText` when there is real text to lose with "Fuerte"; `looksScanned` when pages are heavy
 * and have (almost) no text, i.e. scans, which only shrink by being turned into lighter images.
 */
const analyze = async (file: File, pageCount: number): Promise<Analysis> => {
    const pdfjs = await getPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
        const doc = await task.promise;
        const checked = Math.min(doc.numPages, 3);
        let chars = 0;
        for (let i = 1; i <= checked; i++) {
            const content = await (await doc.getPage(i)).getTextContent();
            for (const item of content.items) if ("str" in item) chars += item.str.replace(/\s/g, "").length;
        }
        return { hasText: chars >= 20, looksScanned: chars / checked < 100 && file.size / pageCount > 100 * 1024 };
    } finally {
        task.destroy();
    }
};

export const CompressScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [isReading, setReading] = useState(false);
    const [mode, setMode] = useState<Mode>("light");
    const [quality, setQuality] = useState(DEFAULT_QUALITY);
    const [dpi, setDpi] = useState(DEFAULT_DPI);
    const [analysis, setAnalysis] = useState<Analysis | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    // Every run (and every loaded file) gets an id: work whose id is stale was cancelled and must not touch the screen.
    const runRef = useRef(0);
    const fileRef = useRef(0);
    const modeTouched = useRef(false);

    useEffect(
        () => () => {
            runRef.current++;
            fileRef.current++;
        },
        [],
    );

    const reset = () => {
        runRef.current++;
        fileRef.current++;
        baseReset();
        setProgress(null);
        setOutcome(null);
        setAnalysis(null);
    };

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        const fileId = ++fileRef.current;
        setError(null);
        setReading(true);
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            if (fileRef.current !== fileId) return;
            modeTouched.current = false;
            setMode("light");
            setAnalysis(null);
            setInput({ file, pageCount: doc.getPageCount() });
            // Recommend a level: scans only shrink by turning pages into lighter images; text PDFs keep their text with "Ligero".
            analyze(file, doc.getPageCount())
                .then((found) => {
                    if (fileRef.current !== fileId) return;
                    setAnalysis(found);
                    if (!modeTouched.current) setMode(found.looksScanned ? "strong" : "light");
                })
                .catch(() => undefined);
        } catch (err) {
            if (fileRef.current === fileId) setError(friendlyError(err, "No se pudo leer el PDF."));
        } finally {
            if (fileRef.current === fileId) setReading(false);
        }
    };

    const chooseMode = (value: Mode) => {
        modeTouched.current = true;
        setMode(value);
    };

    const cancel = () => {
        runRef.current++;
        setBusy(false);
        setProgress(null);
    };

    const compress = async () => {
        if (!input) return;
        const run = ++runRef.current;
        const isCurrent = () => runRef.current === run;
        const inputBytes = input.file.size;
        setError(null);
        setBusy(true);
        try {
            let bytes: Uint8Array;
            if (mode === "light") {
                setProgress({ label: "Optimizando la estructura del PDF…", pct: null });
                const doc = await loadPdfForEditing(input.file, { updateMetadata: false });
                if (!isCurrent()) return;
                await optimizeStructure(doc);
                bytes = await doc.save({ useObjectStreams: true });
                // Safety net: never hand out a file that can't be opened again.
                await loadPdfForEditing(bytes, { updateMetadata: false });
            } else {
                const [{ PDFDocument }, pdfjs] = await Promise.all([import("pdf-lib"), getPdfjs()]);
                const task = pdfjs.getDocument({ data: new Uint8Array(await input.file.arrayBuffer()) });
                try {
                    const doc = await task.promise;
                    const out = await PDFDocument.create();
                    const total = doc.numPages;
                    const scale = dpi / 72;
                    for (let i = 1; i <= total; i++) {
                        if (!isCurrent()) return;
                        setProgress({
                            label: total > 1 ? `Comprimiendo página ${i} de ${total}…` : "Comprimiendo la página…",
                            pct: Math.round(((i - 1) / total) * 100),
                        });
                        const page = await doc.getPage(i);
                        const baseVp = page.getViewport({ scale: 1 });
                        const vp = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.max(1, Math.ceil(vp.width));
                        canvas.height = Math.max(1, Math.ceil(vp.height));
                        const ctx = canvas.getContext("2d", { alpha: false });
                        if (!ctx) throw new Error("canvas");
                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
                        const jpeg = await new Promise<Blob>((resolve, reject) => {
                            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), "image/jpeg", quality / 100);
                        });
                        canvas.width = 0;
                        canvas.height = 0;
                        page.cleanup();
                        const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
                        out.addPage([baseVp.width, baseVp.height]).drawImage(img, { x: 0, y: 0, width: baseVp.width, height: baseVp.height });
                    }
                    if (!isCurrent()) return;
                    setProgress({ label: "Guardando el PDF…", pct: 100 });
                    bytes = await out.save({ useObjectStreams: true });
                } finally {
                    task.destroy();
                }
            }
            if (!isCurrent()) return;
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            setOutcome({ mode, inputBytes, outputBytes: blob.size });
            setResult({
                blob,
                filename: datedFilename(`${baseName(input.file)}-comprimido`, "pdf"),
                primaryLabel: "Descargar PDF",
                summary: `Ahorro del ${savingLabel(inputBytes, blob.size)} · ${readableBytes(inputBytes)} → ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            if (isCurrent()) setError(friendlyError(err, "No se pudo comprimir el PDF. Inténtalo de nuevo."));
        } finally {
            if (isCurrent()) {
                setBusy(false);
                setProgress(null);
            }
        }
    };

    /** Back to the options with the same file, e.g. to try the other level or other settings. */
    const backToOptions = (nextMode?: Mode) => {
        if (nextMode) chooseMode(nextMode);
        setResult(null);
        setOutcome(null);
    };

    if (result && outcome) {
        const worthIt = outcome.outputBytes <= outcome.inputBytes * (1 - MIN_SAVING);
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                {worthIt ? (
                    <SuccessPanel result={result} onReset={reset} onBack={() => backToOptions()} title="¡PDF comprimido!" />
                ) : (
                    <NoSavingsPanel
                        outcome={outcome}
                        looksScanned={analysis?.looksScanned ?? false}
                        onTryOther={() => backToOptions(outcome.mode === "light" ? "strong" : "light")}
                        onAdjust={() => backToOptions()}
                        onDownload={outcome.outputBytes < outcome.inputBytes ? () => downloadBlob(result.blob, result.filename) : undefined}
                        onReset={reset}
                    />
                )}
            </ToolPageLayout>
        );
    }

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && (
                <>
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={isReading}
                        hint={isReading ? "Leyendo el PDF…" : "Suelta el PDF que quieres comprimir."}
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

                    <AriaRadioGroup value={mode} onChange={(value) => chooseMode(value as Mode)} isDisabled={isBusy} className="flex flex-col gap-3">
                        <AriaLabel className="text-sm font-medium text-secondary">Nivel de compresión</AriaLabel>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <OptionCard
                                value="light"
                                title="Ligero"
                                badge={analysis && !analysis.looksScanned ? <RecommendedBadge /> : null}
                                description="Optimiza la estructura del PDF y quita datos internos que no se ven. El texto sigue siendo seleccionable y la calidad no cambia."
                            />
                            <OptionCard
                                value="strong"
                                title={
                                    <span className="inline-flex items-center gap-1.5">
                                        <Zap aria-hidden="true" className="size-4 text-fg-warning-primary" />
                                        Fuerte
                                    </span>
                                }
                                badge={analysis?.looksScanned ? <RecommendedBadge /> : null}
                                description="Convierte cada página en una imagen JPG. Reduce mucho el peso, sobre todo en escaneos, pero el texto deja de ser seleccionable."
                            />
                        </div>
                    </AriaRadioGroup>

                    {mode === "strong" && analysis?.hasText && (
                        <Notice tone="warning" title="Tu PDF tiene texto seleccionable">
                            Con el nivel Fuerte las páginas se convierten en imágenes: ya no podrás buscar ni copiar el texto, y se perderán los enlaces y
                            formularios.
                        </Notice>
                    )}
                    {mode === "light" && analysis?.looksScanned && (
                        <Notice tone="info" title="Parece un PDF escaneado">
                            El nivel Ligero apenas reducirá su peso. El nivel Fuerte lo comprimirá mucho más.
                        </Notice>
                    )}

                    {mode === "strong" && (
                        <div
                            className={cx(
                                "grid grid-cols-1 gap-6 rounded-xl bg-secondary p-4 ring-1 ring-secondary ring-inset md:grid-cols-2",
                                isBusy && "opacity-50",
                            )}
                        >
                            <div className="flex flex-col gap-2">
                                <p className="flex items-center justify-between gap-3 text-sm font-medium text-secondary">
                                    <span>Calidad de imagen</span>
                                    <span className="text-tertiary tabular-nums">{percent(quality)}</span>
                                </p>
                                <Slider
                                    value={[quality]}
                                    onChange={(v) => setQuality((Array.isArray(v) ? v[0] : v) as number)}
                                    minValue={30}
                                    maxValue={95}
                                    step={5}
                                    isDisabled={isBusy}
                                    formatOptions={{ style: "unit", unit: "percent", maximumFractionDigits: 0 }}
                                    aria-label="Calidad de imagen"
                                />
                                <p className="text-sm text-tertiary">Más calidad: mejor aspecto, pero más peso.</p>
                            </div>
                            <div className="flex flex-col gap-2">
                                <p className="flex items-center justify-between gap-3 text-sm font-medium text-secondary">
                                    <span>Resolución</span>
                                    <span className="text-tertiary tabular-nums">{dpi} ppp</span>
                                </p>
                                <Slider
                                    value={[dpi]}
                                    onChange={(v) => setDpi((Array.isArray(v) ? v[0] : v) as number)}
                                    minValue={50}
                                    maxValue={200}
                                    step={10}
                                    isDisabled={isBusy}
                                    formatOptions={{ maximumFractionDigits: 0 }}
                                    aria-label="Resolución en puntos por pulgada"
                                />
                                <p className="text-sm text-tertiary">Más resolución: se lee mejor al ampliar, pero pesa más.</p>
                            </div>
                        </div>
                    )}

                    {progress && <ProgressBar label={progress.label} pct={progress.pct} />}

                    <ErrorArea error={error} />

                    <ActionBar>
                        {isBusy && (
                            <Button color="secondary" size="lg" className="w-full sm:w-auto" onClick={cancel}>
                                Cancelar
                            </Button>
                        )}
                        <Button
                            color="primary"
                            size="lg"
                            iconLeading={Archive}
                            isLoading={isBusy}
                            showTextWhileLoading
                            className="w-full sm:w-auto"
                            onClick={compress}
                        >
                            {isBusy ? "Comprimiendo…" : "Comprimir PDF"}
                        </Button>
                    </ActionBar>
                </div>
            )}
        </ToolPageLayout>
    );
};

const NoSavingsPanel = ({
    outcome,
    looksScanned,
    onTryOther,
    onAdjust,
    onDownload,
    onReset,
}: {
    outcome: Outcome;
    looksScanned: boolean;
    onTryOther: () => void;
    onAdjust: () => void;
    onDownload?: () => void;
    onReset: () => void;
}) => {
    const sizes = `${readableBytes(outcome.inputBytes)} → ${readableBytes(outcome.outputBytes)}`;
    const grew = outcome.outputBytes > outcome.inputBytes;
    const other: Mode = outcome.mode === "light" ? "strong" : "light";
    const advice =
        outcome.mode === "strong"
            ? "Baja la calidad o la resolución, o prueba el nivel Ligero, que conserva el texto."
            : looksScanned
              ? "Es un PDF escaneado: el nivel Fuerte puede reducirlo mucho más."
              : "Si no necesitas seleccionar el texto, el nivel Fuerte puede reducirlo más.";
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            role="status"
            className="flex flex-col items-center gap-5 rounded-2xl bg-primary p-6 text-center ring-1 ring-secondary ring-inset md:p-8"
        >
            <FeaturedIcon icon={AlertTriangle} color="warning" theme="light" size="xl" />
            <div className="flex max-w-md flex-col items-center gap-2">
                <h2 className="text-lg font-semibold text-primary">No hemos podido reducir este PDF</h2>
                <p className="text-sm text-tertiary">
                    {grew
                        ? `Con el nivel ${MODE_LABEL[outcome.mode]} pesaría más que el original (${sizes}).`
                        : `Con el nivel ${MODE_LABEL[outcome.mode]} el peso apenas cambia (${sizes}).`}{" "}
                    Tu PDF ya está bastante optimizado. {advice}
                </p>
            </div>
            <div className="flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button color="primary" size="lg" iconLeading={Archive} onClick={onTryOther}>
                    Probar el nivel {MODE_LABEL[other]}
                </Button>
                {outcome.mode === "strong" && (
                    <Button color="secondary" size="lg" iconLeading={ArrowLeft} onClick={onAdjust}>
                        Volver y ajustar
                    </Button>
                )}
                {onDownload && (
                    <Button color="secondary" size="lg" iconLeading={DownloadCloud02} onClick={onDownload}>
                        Descargar igualmente
                    </Button>
                )}
                <Button color="tertiary" size="lg" iconLeading={RefreshCcw01} onClick={onReset}>
                    Empezar de nuevo
                </Button>
            </div>
        </motion.div>
    );
};

const RecommendedBadge = () => (
    <Badge color="brand" type="pill-color" size="sm">
        Recomendado
    </Badge>
);

/** Single-choice card: a real radio (arrow keys move the choice) with a visible dot, not only a colour change. */
const OptionCard = ({ value, title, description, badge }: { value: Mode; title: ReactNode; description: string; badge?: ReactNode }) => (
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
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-primary">
                        {title}
                        {badge}
                    </span>
                    <span className="text-sm text-tertiary">{description}</span>
                </span>
            </>
        )}
    </AriaRadio>
);

const RadioDot = ({ isSelected }: { isSelected: boolean }) => (
    <span
        aria-hidden="true"
        className={cx(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary ring-1 ring-primary transition duration-100 ease-linear ring-inset",
            isSelected && "bg-brand-solid ring-transparent",
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
const ActionBar = ({ children }: { children: ReactNode }) => (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-2xl bg-primary/95 px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] ring-1 ring-secondary backdrop-blur-sm ring-inset sm:static sm:m-0 sm:flex-row sm:items-center sm:justify-end sm:rounded-none sm:border-t sm:border-secondary sm:bg-transparent sm:px-0 sm:pt-5 sm:pb-0 sm:ring-0 sm:backdrop-blur-none">
        {children}
    </div>
);
