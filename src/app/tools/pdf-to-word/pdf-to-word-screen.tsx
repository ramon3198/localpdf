"use client";

import { type ReactNode, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlignLeft, ArrowRight, Check, File04, FileAttachment02, LayoutAlt01, MagicWand02, Trash01 } from "@untitledui/icons";
import { motion, useReducedMotion } from "motion/react";
import type { PDFDict, PDFDocument } from "pdf-lib";
import {
    Checkbox as AriaCheckbox,
    Label as AriaLabel,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
    ToggleButton as AriaToggleButton,
    ToggleButtonGroup as AriaToggleButtonGroup,
} from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import type { ConvertOptions, ConvertStats } from "@/lib/pdf-to-docx";
import type { OcrStatus } from "@/lib/pdf-to-docx/browser";
import { PROTECTED_PDF_MESSAGE, UserFacingError, friendlyError, loadPdfForEditing, pagesLabel, parsePageRanges, plural, readableBytes } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

type SourceFile = { file: File; pageCount: number };
type Mode = "auto" | "flow" | "layout";
type Scope = "all" | "ranges";
type Stage = "preparing" | "reading" | "ocr" | "analysing" | "writing";
type Progress = { stage: Stage; label: string; pct: number };
type Outcome = { stats: ConvertStats; mode: Mode };
type ProgressEvent = Parameters<NonNullable<ConvertOptions["onProgress"]>>[0];

const TITLE = "PDF a Word";
const DESCRIPTION = "Convierte tu PDF en un documento de Word editable, con su formato.";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MODE_LABEL: Record<Mode, string> = { auto: "Automático", flow: "Texto editable", layout: "Diseño exacto" };

const LANGUAGES = [
    { id: "spa", label: "Español" },
    { id: "eng", label: "Inglés" },
    { id: "fra", label: "Francés" },
    { id: "deu", label: "Alemán" },
    { id: "ita", label: "Italiano" },
    { id: "por", label: "Portugués" },
] as const;

type LangId = (typeof LANGUAGES)[number]["id"];

/** What each stage says while it runs (for screen readers, without the changing numbers). */
const STAGE_ANNOUNCEMENT: Record<Stage, string> = {
    preparing: "Preparando la conversión",
    reading: "Leyendo el PDF",
    ocr: "Reconociendo texto con OCR",
    analysing: "Analizando el diseño",
    writing: "Creando el documento de Word",
};

const percent = (value: number) => `${Math.round(value)} %`;
const baseName = (file: File) => file.name.replace(/\.pdf$/i, "") || "documento";
const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

/**
 * Which of the chosen pages are scans ("Las páginas 2, 5 y 7 son imágenes…"; long lists are only counted) and what OCR
 * does for them. `selected` pages are being converted out of the document's `pageCount`.
 */
const scannedDescription = (scanned: number[], selected: number, pageCount: number) => {
    const one = scanned.length === 1;
    const all = scanned.length === selected;
    const subject =
        all && selected === pageCount
            ? one
                ? "La página es una imagen"
                : "Todas las páginas son imágenes"
            : all && !one
              ? "Todas las páginas elegidas son imágenes"
              : one
                ? `La página ${scanned[0]} es una imagen`
                : scanned.length <= 6
                  ? `Las páginas ${scanned.slice(0, -1).join(", ")} y ${scanned[scanned.length - 1]} son imágenes`
                  : `${scanned.length.toLocaleString("es")} páginas son imágenes`;
    return `${subject} sin texto, como un escaneo. Con OCR su texto será editable en Word; sin OCR, ${one ? "se incluirá como imagen" : "se incluirán como imágenes"}.`;
};

/**
 * The conversion worker: browser.ts serves conversions when it is loaded in a worker, so the page stays responsive.
 * Written here (not in browser.ts) so the bundler doesn't see the worker's entry refer to itself.
 */
const spawnConverter = () => new Worker(new URL("../../../lib/pdf-to-docx/browser.ts", import.meta.url), { type: "module", name: "pdf-a-word" });

/** Lets the browser paint the busy state first (it matters when the conversion falls back to running on the page). */
const nextPaint = () =>
    new Promise<void>((resolve) => {
        // requestAnimationFrame never fires in a background tab: the timer is the fallback.
        const timer = setTimeout(resolve, 60);
        requestAnimationFrame(() =>
            setTimeout(() => {
                clearTimeout(timer);
                resolve();
            }, 0),
        );
    });

/** Whether a page draws an image (directly or inside a form XObject): a text-less page without one is just blank. */
const pageHasImages = (lib: typeof import("pdf-lib"), doc: PDFDocument, index: number) => {
    const { PDFName, PDFStream } = lib;
    const seen = new Set<unknown>();
    const visit = (resources: PDFDict | undefined, depth: number): boolean => {
        const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), lib.PDFDict);
        if (!xobjects) return false;
        for (const [, value] of xobjects.entries()) {
            const stream = doc.context.lookup(value);
            if (!(stream instanceof PDFStream) || seen.has(stream)) continue;
            seen.add(stream);
            const subtype = stream.dict.get(PDFName.of("Subtype"));
            if (subtype === PDFName.of("Image")) return true;
            if (subtype === PDFName.of("Form") && depth < 5 && visit(stream.dict.lookupMaybe(PDFName.of("Resources"), lib.PDFDict), depth + 1)) return true;
        }
        return false;
    };
    try {
        return visit(doc.getPage(index).node.Resources(), 0);
    } catch {
        // Unusual structure: offer OCR rather than hide it.
        return true;
    }
};

/**
 * Pages without any text that draw an image: scans, which only become editable text with OCR. Same rule as the
 * converter (a page with any real text, even an invisible OCR layer, is read as it is).
 */
const findScannedPages = async (file: File, doc: PDFDocument, isCurrent: () => boolean, onFound: (scanned: number[]) => void) => {
    const [pdfjs, lib] = await Promise.all([getPdfjs(), import("pdf-lib")]);
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: pdfjs.VerbosityLevel.ERRORS });
    try {
        const pdf = await task.promise;
        const scanned: number[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
            if (!isCurrent()) return scanned;
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            page.cleanup();
            const hasText = content.items.some((item) => "str" in item && item.str.trim() !== "");
            if (!hasText && pageHasImages(lib, doc, n - 1)) {
                scanned.push(n);
                onFound([...scanned]);
            }
        }
        return scanned;
    } finally {
        task.destroy();
    }
};

/**
 * Turns the converter's stage/page events into one steady percentage. Pages weigh by what they cost: reading is quick,
 * OCR is by far the slowest step (its own progress fills the page's slot), analysis includes layout backgrounds.
 */
const progressTracker = (pages: number, expectedOcrPages: number, emit: (progress: Progress) => void) => {
    const READ = 1;
    const OCR = 12;
    const ANALYSE = 1.5;
    const WRITE = Math.max(2, pages * 0.3);
    let ocrPages = 0;
    let current: ProgressEvent = { page: 1, pages, stage: "reading" };
    let last: Progress = { stage: "preparing", label: "", pct: 0 };

    const at = (stage: Stage, units: number, label: string) => {
        const total = pages * (READ + ANALYSE) + Math.max(expectedOcrPages, ocrPages) * OCR + WRITE;
        // Never goes back (a page may need OCR the quick look didn't foresee) and only reaches 100 % when it's done.
        const pct = Math.max(last.pct, Math.min(99, Math.round((units / total) * 100)));
        if (pct === last.pct && label === last.label) return;
        last = { stage, label, pct };
        emit(last);
    };
    const ocrLabel = (page: number) => (pages > 1 ? `Reconociendo texto (OCR) · página ${page} de ${pages}…` : "Reconociendo texto (OCR)…");

    return {
        onProgress: (event: ProgressEvent) => {
            current = event;
            const { page, stage } = event;
            if (stage === "reading")
                at("reading", (page - 1) * READ + ocrPages * OCR, pages > 1 ? `Leyendo página ${page} de ${pages}…` : "Leyendo la página…");
            else if (stage === "ocr") {
                ocrPages++;
                at("ocr", page * READ + (ocrPages - 1) * OCR, ocrLabel(page));
            } else if (stage === "analysing") at("analysing", pages * READ + ocrPages * OCR + (page - 1) * ANALYSE, "Analizando el diseño…");
            else at("writing", pages * (READ + ANALYSE) + ocrPages * OCR, "Creando el documento de Word…");
        },
        onOcrStatus: (status: OcrStatus) => {
            if (current.stage !== "ocr") return;
            const done = current.page * READ + (ocrPages - 1) * OCR;
            if (status.stage === "setup") at("ocr", done, status.label);
            else at("ocr", done + status.progress * OCR, ocrLabel(current.page));
        },
    };
};

/** The converter's report, tolerant of missing fields so a partial report never breaks the result screen. */
const normalizeStats = (stats: Partial<ConvertStats> | undefined, pages: number): ConvertStats => ({
    pages: stats?.pages ?? pages,
    paragraphs: stats?.paragraphs ?? 0,
    tables: stats?.tables ?? 0,
    images: stats?.images ?? 0,
    ocrPages: stats?.ocrPages ?? 0,
    layoutPages: stats?.layoutPages ?? 0,
    warnings: Array.from(new Set((Array.isArray(stats?.warnings) ? stats.warnings : []).filter((w) => typeof w === "string" && w.trim() !== ""))),
});

const resultSummary = (stats: ConvertStats, bytes: number) =>
    [
        pagesLabel(stats.pages),
        stats.tables ? plural(stats.tables, "tabla", "tablas") : "",
        stats.images ? plural(stats.images, "imagen", "imágenes") : "",
        stats.ocrPages ? plural(stats.ocrPages, "página con OCR", "páginas con OCR") : "",
        readableBytes(bytes),
    ]
        .filter(Boolean)
        .join(" · ");

export const PdfToWordScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [isReading, setReading] = useState(false);
    const [mode, setMode] = useState<Mode>("auto");
    const [scope, setScope] = useState<Scope>("all");
    const [ranges, setRanges] = useState("");
    const [ocrEnabled, setOcrEnabled] = useState(true);
    const [langs, setLangs] = useState<Set<LangId>>(new Set(["spa", "eng"]));
    /** 1-based pages that are images without any text (scans), found by a quick look after loading. */
    const [scanned, setScanned] = useState<number[]>([]);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    /** The last error came from setting up OCR: offer to convert without it. */
    const [ocrFailed, setOcrFailed] = useState(false);
    // Every run (and every loaded file) gets an id: work whose id is stale was cancelled and must not touch the screen.
    const runRef = useRef(0);
    const fileRef = useRef(0);
    const controllerRef = useRef<AbortController | null>(null);
    const resultRef = useRef<HTMLDivElement>(null);
    const actionRef = useRef<HTMLDivElement>(null);
    const focusAction = useRef(false);

    useEffect(
        () => () => {
            runRef.current++;
            fileRef.current++;
            controllerRef.current?.abort();
        },
        [],
    );

    useEffect(() => {
        if (result) resultRef.current?.focus();
    }, [result]);

    useEffect(() => {
        if (result || !focusAction.current) return;
        focusAction.current = false;
        actionRef.current?.querySelector<HTMLElement>("[data-primary-action]")?.focus();
    }, [result]);

    // Checked while typing, so the problem shows on the field itself and the button can't start a doomed run.
    const rangeCheck = useMemo(() => {
        if (!input || scope !== "ranges" || !ranges.trim()) return null;
        return parsePageRanges(ranges, input.pageCount);
    }, [input, scope, ranges]);

    /** 1-based pages to convert. */
    const selectedPages = useMemo(() => {
        if (!input) return [];
        if (scope === "all" || input.pageCount === 1) return Array.from({ length: input.pageCount }, (_, i) => i + 1);
        return rangeCheck && !rangeCheck.error ? rangeCheck.pages : [];
    }, [input, scope, rangeCheck]);

    const scannedInRange = useMemo(() => {
        if (!scanned.length) return [];
        const chosen = new Set(selectedPages);
        return scanned.filter((page) => chosen.has(page));
    }, [scanned, selectedPages]);

    const stopRun = () => {
        runRef.current++;
        controllerRef.current?.abort();
        controllerRef.current = null;
    };

    const reset = () => {
        stopRun();
        fileRef.current++;
        baseReset();
        setProgress(null);
        setOutcome(null);
        setScanned([]);
        setOcrFailed(false);
        setScope("all");
        setRanges("");
    };

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        const fileId = ++fileRef.current;
        const isCurrentFile = () => fileRef.current === fileId;
        setError(null);
        setOcrFailed(false);
        setReading(true);
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            if (!isCurrentFile()) return;
            // The conversion type, OCR and languages are kept from the previous file; the pages are per file.
            setScope("all");
            setRanges("");
            setScanned([]);
            setInput({ file, pageCount: doc.getPageCount() });
            // Fetch the conversion host while the options are being chosen (the converter itself loads in its worker).
            import("@/lib/pdf-to-docx/browser").catch(() => undefined);
            // In the background: the OCR options show up as soon as a scanned page is found. Without the answer, OCR stays on.
            findScannedPages(file, doc, isCurrentFile, (found) => isCurrentFile() && setScanned(found)).catch(() => undefined);
        } catch (err) {
            if (isCurrentFile()) setError(friendlyError(err, "No se pudo leer el PDF."));
        } finally {
            if (isCurrentFile()) setReading(false);
        }
    };

    /** The button that had focus (Cancelar, Convertir sin OCR) goes away: keep keyboard users on the main action. */
    const focusPrimaryAction = () =>
        requestAnimationFrame(() => actionRef.current?.querySelector<HTMLElement>("[data-primary-action]")?.focus({ preventScroll: true }));

    const cancel = () => {
        stopRun();
        setBusy(false);
        setProgress(null);
        focusPrimaryAction();
    };

    const convert = async (withOcr = ocrEnabled) => {
        if (!input || selectedPages.length === 0) return;
        const run = ++runRef.current;
        const isCurrent = () => runRef.current === run;
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        const pages = selectedPages;
        setError(null);
        setOcrFailed(false);
        setBusy(true);
        setProgress({ stage: "preparing", label: "Preparando la conversión…", pct: 0 });
        try {
            // The converter itself is loaded by the worker convertInBrowser starts (or on the page if there's no worker).
            const { convertInBrowser } = await import("@/lib/pdf-to-docx/browser");
            const bytes = new Uint8Array(await input.file.arrayBuffer());
            if (!isCurrent()) return;
            const tracker = progressTracker(pages.length, withOcr ? scannedInRange.length : 0, (next) => {
                if (isCurrent()) setProgress(next);
            });
            await nextPaint();
            if (!isCurrent()) return;
            const { docx, stats } = await convertInBrowser(bytes, {
                mode,
                ocr: withOcr,
                ocrLanguages: Array.from(langs),
                pages: pages.map((page) => page - 1),
                onProgress: tracker.onProgress,
                onOcrStatus: tracker.onOcrStatus,
                signal: controller.signal,
                worker: spawnConverter,
            });
            if (!isCurrent()) return;
            // Safety net: a .docx is a ZIP package; never offer a download that Word can't open.
            if (!(docx instanceof Uint8Array) || docx.length < 4 || docx[0] !== 0x50 || docx[1] !== 0x4b) throw new Error("docx: not a ZIP package");
            const blob = new Blob([docx as BlobPart], { type: DOCX_MIME });
            const summary = normalizeStats(stats, pages.length);
            setOutcome({ stats: summary, mode });
            setResult({ blob, filename: `${baseName(input.file)}.docx`, primaryLabel: "Descargar .docx", summary: resultSummary(summary, blob.size) });
        } catch (err) {
            if (!isCurrent() || isAbortError(err)) return;
            // Unexpected failures are logged for whoever debugs the converter (a warning: in development an error would
            // raise Next's issue badge over the sticky action bar); the user gets a plain message.
            if (!(err instanceof UserFacingError)) console.warn("PDF a Word:", err);
            setOcrFailed(err instanceof Error && err.name === "OcrSetupError");
            setError(friendlyError(err, "No se pudo convertir el PDF a Word. Inténtalo de nuevo."));
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
            if (isCurrent()) {
                setBusy(false);
                setProgress(null);
            }
        }
    };

    const convertWithoutOcr = () => {
        setOcrEnabled(false);
        void convert(false);
        focusPrimaryAction();
    };

    /** Back to the options with the same file, e.g. to try another conversion type. */
    const backToOptions = () => {
        focusAction.current = true;
        setResult(null);
        setOutcome(null);
    };

    if (result && outcome) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
                    <SuccessPanel result={result} onReset={reset} onBack={backToOptions} title="¡Documento de Word listo!" />
                    {outcome.stats.warnings.length > 0 && <WarningsNotice warnings={outcome.stats.warnings} />}
                    <Notice tone="info">
                        <ResultLimits outcome={outcome} />
                    </Notice>
                </div>
            </ToolPageLayout>
        );
    }

    const rangeInvalid = scope === "ranges" && input !== null && input.pageCount > 1 && (!rangeCheck || !!rangeCheck.error);
    const count = selectedPages.length;

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && (
                <>
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={isReading}
                        hint={isReading ? "Leyendo el PDF…" : "Suelta el PDF que quieres convertir a Word."}
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
                            <p className="truncate text-sm font-medium text-primary" title={input.file.name}>
                                {input.file.name}
                            </p>
                            <p className="text-sm text-tertiary">
                                {pagesLabel(input.pageCount)} · {readableBytes(input.file.size)}
                            </p>
                        </div>
                        <ButtonUtility color="tertiary" tooltip="Quitar archivo" icon={Trash01} size="sm" isDisabled={isBusy} onClick={reset} />
                    </div>

                    <AriaRadioGroup value={mode} onChange={(value) => setMode(value as Mode)} isDisabled={isBusy} className="flex flex-col gap-3">
                        <AriaLabel className="text-sm font-medium text-secondary">Tipo de conversión</AriaLabel>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <OptionCard
                                value="auto"
                                icon={<MagicWand02 aria-hidden="true" className="size-4 text-fg-brand-secondary" />}
                                title={MODE_LABEL.auto}
                                badge={
                                    <Badge color="brand" type="pill-color" size="sm">
                                        Recomendado
                                    </Badge>
                                }
                                description="Texto editable y, en páginas muy diseñadas, se respeta el diseño."
                            />
                            <OptionCard
                                value="flow"
                                icon={<AlignLeft aria-hidden="true" className="size-4 text-fg-quaternary" />}
                                title={MODE_LABEL.flow}
                                description="Párrafos que fluyen: ideal para editar y reutilizar el texto."
                            />
                            <OptionCard
                                value="layout"
                                icon={<LayoutAlt01 aria-hidden="true" className="size-4 text-fg-quaternary" />}
                                title={MODE_LABEL.layout}
                                description="Cada bloque en su sitio sobre el fondo original: ideal para folletos y facturas."
                            />
                        </div>
                    </AriaRadioGroup>

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
                                    autoComplete="off"
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

                    {scannedInRange.length > 0 && (
                        <OcrOptions
                            description={scannedDescription(scannedInRange, count, input.pageCount)}
                            isEnabled={ocrEnabled}
                            onEnabledChange={setOcrEnabled}
                            languages={langs}
                            onLanguagesChange={setLangs}
                            isDisabled={isBusy}
                        />
                    )}

                    {/* Progress and errors live in the action bar: on phones it's the part of the card that stays in view. */}
                    <ActionBar
                        ref={actionRef}
                        error={<ErrorArea error={error} />}
                        status={
                            progress ? (
                                <ProgressBar progress={progress} />
                            ) : (
                                <p className="text-sm text-tertiary">
                                    {count > 0
                                        ? count === 1
                                            ? "Se convertirá 1 página en un documento de Word (.docx)."
                                            : `Se convertirán ${pagesLabel(count)} en un documento de Word (.docx).`
                                        : rangeCheck?.error
                                          ? "Revisa las páginas elegidas para continuar."
                                          : "Escribe qué páginas quieres convertir."}
                                </p>
                            )
                        }
                    >
                        {isBusy && (
                            <Button color="secondary" size="lg" className="w-full sm:w-auto" onClick={cancel}>
                                Cancelar
                            </Button>
                        )}
                        {ocrFailed && !isBusy && (
                            <Button color="secondary" size="lg" className="w-full sm:w-auto" onClick={convertWithoutOcr}>
                                Convertir sin OCR
                            </Button>
                        )}
                        <Button
                            data-primary-action
                            color="primary"
                            size="lg"
                            iconLeading={FileAttachment02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!isBusy && (rangeInvalid || count === 0)}
                            className="w-full sm:w-auto"
                            onClick={() => convert()}
                        >
                            {isBusy ? "Convirtiendo…" : "Convertir a Word"}
                        </Button>
                    </ActionBar>
                </div>
            )}
        </ToolPageLayout>
    );
};

/** What to expect when editing the result, honest about what a conversion can't carry over. */
const ResultLimits = ({ outcome }: { outcome: Outcome }) => {
    const { stats, mode } = outcome;
    const sentences = [
        "Si una fuente del PDF no está instalada en tu ordenador, Word la sustituye por otra parecida y algunas líneas pueden cambiar de sitio.",
    ];
    if (stats.ocrPages > 0) {
        sentences.push(
            `Revisa el texto de ${stats.ocrPages === 1 ? "la página escaneada" : "las páginas escaneadas"}: el reconocimiento (OCR) puede confundir alguna letra.`,
        );
    }
    if (mode === "layout") {
        sentences.push(
            `Con «${MODE_LABEL.layout}» el texto va en cuadros sobre el fondo original: se edita cuadro a cuadro. Para reutilizar el texto, elige «${MODE_LABEL.flow}».`,
        );
    } else if (mode === "auto" && stats.layoutPages > 0) {
        const which =
            stats.layoutPages === stats.pages
                ? stats.pages === 1
                    ? "La página tiene un diseño complejo y se ha reproducido"
                    : "Todas las páginas tienen un diseño complejo y se han reproducido"
                : stats.layoutPages === 1
                  ? "1 página tiene un diseño complejo y se ha reproducido"
                  : `${stats.layoutPages.toLocaleString("es")} páginas tienen un diseño complejo y se han reproducido`;
        sentences.push(`${which} con «${MODE_LABEL.layout}»: su texto va en cuadros sobre el fondo original.`);
    } else {
        sentences.push(`Los diseños muy complejos, como folletos o carteles, conservan mejor su aspecto con «${MODE_LABEL.layout}».`);
    }
    return <p>{sentences.join(" ")}</p>;
};

/** OCR for the scanned pages among the chosen ones: on/off and the languages to read them in. */
const OcrOptions = ({
    description,
    isEnabled,
    onEnabledChange,
    languages,
    onLanguagesChange,
    isDisabled,
}: {
    description: string;
    isEnabled: boolean;
    onEnabledChange: (value: boolean) => void;
    languages: Set<LangId>;
    onLanguagesChange: (value: Set<LangId>) => void;
    isDisabled: boolean;
}) => {
    const [langHint, setLangHint] = useState(false);
    const labelId = useId();
    return (
        <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-4 rounded-xl bg-secondary p-4 ring-1 ring-secondary ring-inset"
        >
            <OptionCheckbox
                isSelected={isEnabled}
                onChange={onEnabledChange}
                isDisabled={isDisabled}
                label="Reconocer el texto de las páginas escaneadas (OCR)"
                description={description}
            />
            {isEnabled && (
                <div className="flex flex-col gap-3 sm:pl-7">
                    <p id={labelId} className="text-sm font-medium text-secondary">
                        Idiomas del documento
                    </p>
                    <AriaToggleButtonGroup
                        aria-labelledby={labelId}
                        selectionMode="multiple"
                        selectedKeys={languages}
                        isDisabled={isDisabled}
                        onSelectionChange={(keys) => {
                            // At least one language is needed: keep the last one selected and say why.
                            if (keys.size === 0) {
                                setLangHint(true);
                                return;
                            }
                            setLangHint(false);
                            onLanguagesChange(new Set(keys) as Set<LangId>);
                        }}
                        className="flex flex-wrap gap-2"
                    >
                        {LANGUAGES.map((language) => (
                            <AriaToggleButton
                                key={language.id}
                                id={language.id}
                                className={({ isSelected, isFocusVisible, isDisabled }) =>
                                    cx(
                                        "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset",
                                        isSelected
                                            ? "bg-brand-solid text-white ring-transparent hover:bg-brand-solid_hover"
                                            : "bg-primary text-secondary ring-primary hover:bg-primary_hover",
                                        isFocusVisible && "outline-2 outline-offset-2",
                                        isDisabled && "cursor-not-allowed opacity-50",
                                    )
                                }
                            >
                                {({ isSelected }) => (
                                    <>
                                        {isSelected && <Check aria-hidden="true" className="size-4" />}
                                        {language.label}
                                    </>
                                )}
                            </AriaToggleButton>
                        ))}
                    </AriaToggleButtonGroup>
                    <p className={cx("text-sm text-tertiary", langHint && "font-medium text-warning-primary")} aria-live="polite">
                        {langHint
                            ? "Debe quedar al menos un idioma seleccionado."
                            : "El reconocimiento se hace en tu navegador. La primera vez se descargan el motor de OCR y los idiomas elegidos; después se reutilizan."}
                    </p>
                </div>
            )}
        </motion.div>
    );
};

const WARNINGS_SHOWN = 4;

const WarningsNotice = ({ warnings }: { warnings: string[] }) => {
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? warnings : warnings.slice(0, WARNINGS_SHOWN);
    const hidden = warnings.length - shown.length;
    return (
        <Notice tone="warning" title="Revisa estos detalles">
            <ul className="flex flex-col gap-1">
                {shown.map((warning, index) => (
                    <li key={index}>{warning}</li>
                ))}
            </ul>
            {(hidden > 0 || expanded) && warnings.length > WARNINGS_SHOWN && (
                <Button color="link-gray" size="sm" className="mt-2" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? "Mostrar menos" : `Mostrar ${plural(hidden, "aviso más", "avisos más")}`}
                </Button>
            )}
        </Notice>
    );
};

/** Single-choice card: a real radio (arrow keys move the choice) with a visible dot, not only a colour change. */
const OptionCard = ({ value, icon, title, description, badge }: { value: Mode; icon: ReactNode; title: string; description: string; badge?: ReactNode }) => (
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
                        <span className="inline-flex items-center gap-1.5">
                            {icon}
                            {title}
                        </span>
                        {badge}
                    </span>
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

const OptionCheckbox = ({
    label,
    description,
    isSelected,
    isDisabled,
    onChange,
}: {
    label: string;
    description: string;
    isSelected: boolean;
    isDisabled?: boolean;
    onChange: (value: boolean) => void;
}) => (
    <AriaCheckbox
        isSelected={isSelected}
        isDisabled={isDisabled}
        onChange={onChange}
        className={({ isDisabled }) => cx("group flex cursor-pointer items-start gap-3", isDisabled && "cursor-not-allowed opacity-50")}
    >
        {({ isSelected, isFocusVisible }) => (
            <>
                <span
                    aria-hidden="true"
                    className={cx(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded ring-1 transition duration-100 ease-linear ring-inset",
                        isSelected ? "bg-brand-solid ring-transparent" : "bg-primary ring-primary",
                        isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                    )}
                >
                    {isSelected && <Check className="size-3 text-white" strokeWidth={3} />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-semibold text-primary">{label}</span>
                    <span className="text-sm text-tertiary">{description}</span>
                </span>
            </>
        )}
    </AriaCheckbox>
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

const ProgressBar = ({ progress }: { progress: Progress }) => {
    const reduceMotion = useReducedMotion();
    const { label, pct, stage } = progress;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium text-secondary">{label}</span>
                <span className="shrink-0 text-tertiary tabular-nums">{percent(pct)}</span>
            </div>
            <div
                role="progressbar"
                aria-label="Progreso de la conversión"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={`${percent(pct)} · ${label}`}
                className="relative h-2 overflow-hidden rounded-full bg-quaternary"
            >
                <motion.div
                    className="h-full rounded-full bg-brand-solid"
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: "linear" }}
                />
            </div>
            {/* Announces each stage once; the changing numbers stay in the bar. */}
            <p className="sr-only" aria-live="polite">
                {STAGE_ANNOUNCEMENT[stage]}
            </p>
        </div>
    );
};

/**
 * Main actions: a sticky bar at the bottom of the screen on phones, a plain footer from `sm` up. `status` (summary or
 * progress) sits next to the buttons and `error` above them, so both stay in view while the options scroll.
 */
const ActionBar = ({ ref, error, status, children }: { ref?: Ref<HTMLDivElement>; error?: ReactNode; status: ReactNode; children: ReactNode }) => (
    <div
        ref={ref}
        className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3 rounded-b-2xl bg-primary/95 px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] ring-1 ring-secondary backdrop-blur-sm ring-inset sm:static sm:m-0 sm:gap-4 sm:rounded-none sm:border-t sm:border-secondary sm:bg-transparent sm:px-0 sm:pt-5 sm:pb-0 sm:ring-0 sm:backdrop-blur-none"
    >
        {error}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 sm:flex-1">{status}</div>
            <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">{children}</div>
        </div>
    </div>
);
