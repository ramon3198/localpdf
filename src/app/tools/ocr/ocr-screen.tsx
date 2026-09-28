"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Copy01, Download01, File04, FileSearch02, RefreshCcw01, Trash01 } from "@untitledui/icons";
import { motion, useReducedMotion } from "motion/react";
import {
    PDFDocument,
    type PDFFont,
    type PDFName,
    type PDFOperator,
    type PDFPage,
    StandardFonts,
    TextRenderingMode,
    beginText,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setCharacterSqueeze,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
} from "pdf-lib";
import {
    Label as AriaLabel,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
    ToggleButton as AriaToggleButton,
    ToggleButtonGroup as AriaToggleButtonGroup,
} from "react-aria-components";
import type Tesseract from "tesseract.js";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import {
    PROTECTED_PDF_MESSAGE,
    UserFacingError,
    datedFilename,
    downloadBlob,
    friendlyError,
    loadPdfForEditing,
    pagesLabel,
    plural,
    readableBytes,
} from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

/** `textPages`/`checkedPages`: how many of the first pages already have real text. */
type SourceFile = { file: File; pageCount: number; textPages: number; checkedPages: number };
type Mode = "searchable" | "text-only";
type Progress = { label: string; pct: number | null };
/** `found` is false when the pages that needed OCR gave no text at all (blank, blurry or another language). */
type Outcome = { mode: Mode; recognized: number; skipped: number; found: boolean; text: string };
type Viewport = { convertToPdfPoint: (x: number, y: number) => number[] };

const TITLE = "OCR (PDF escaneado)";
const DESCRIPTION = "Convierte PDFs escaneados en texto buscable.";

const LANGUAGES = [
    { id: "spa", label: "Español" },
    { id: "eng", label: "Inglés" },
    { id: "fra", label: "Francés" },
    { id: "deu", label: "Alemán" },
    { id: "ita", label: "Italiano" },
    { id: "por", label: "Portugués" },
] as const;

type LangId = (typeof LANGUAGES)[number]["id"];

/** tesseract.js reports its set-up steps in English; these are shown instead. */
const SETUP_LABELS: Record<string, string> = {
    "loading tesseract core": "Cargando el motor de OCR…",
    "initializing tesseract": "Iniciando el motor de OCR…",
    "initialized tesseract": "Iniciando el motor de OCR…",
    "loading language traineddata": "Descargando los idiomas (solo la primera vez)…",
    "loading language traineddata (from cache)": "Cargando los idiomas…",
    "loaded language traineddata": "Cargando los idiomas…",
    "initializing api": "Preparando el reconocimiento…",
    "initialized api": "Preparando el reconocimiento…",
};

/** A page with at least this many characters already has real text: it is kept as is instead of being recognised. */
const PAGE_TEXT_MIN = 100;
/** Resolution the pages are read at: good accuracy for normal-size text without huge images. */
const OCR_DPI = 200;
const MAX_OCR_SIDE = 3500;
const PREVIEW_CHARS = 20000;
const DOWNLOAD_ERROR =
    "No se pudo descargar el motor de OCR. La primera vez hace falta conexión a internet para bajar el motor y los idiomas; después se reutilizan.";

const percent = (value: number) => `${Math.round(value)} %`;

const textFromContent = (items: unknown[]) => {
    let out = "";
    for (const item of items) {
        if (item && typeof item === "object" && "str" in item) {
            const { str, hasEOL } = item as { str: string; hasEOL?: boolean };
            out += str + (hasEOL ? "\n" : "");
        }
    }
    return out.trim();
};

const letterCount = (text: string) => text.replace(/\s/g, "").length;

/** Keeps what Helvetica (WinAnsi) can encode: ligatures are split, unknown accents dropped, the rest skipped. Line breaks stay. */
const toWinAnsi = (text: string, charset: Set<number>) => {
    let out = "";
    for (const char of text.normalize("NFKC")) {
        if (char === "\n") out += char;
        else if (/\s/.test(char)) out += " ";
        else if (charset.has(char.codePointAt(0) ?? -1)) out += char;
        else {
            const base = char.normalize("NFD")[0];
            if (base && charset.has(base.codePointAt(0) ?? -1)) out += base;
        }
    }
    return out;
};

/** How many of the first pages already carry real text (a digital PDF, or a scan that already went through OCR). */
const detectText = async (file: File) => {
    const pdfjs = await getPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
        const doc = await task.promise;
        const checkedPages = Math.min(doc.numPages, 3);
        let textPages = 0;
        for (let i = 1; i <= checkedPages; i++) {
            const content = await (await doc.getPage(i)).getTextContent();
            if (letterCount(textFromContent(content.items)) >= PAGE_TEXT_MIN) textPages++;
        }
        return { textPages, checkedPages };
    } finally {
        task.destroy();
    }
};

/**
 * Invisible text (render mode 3) over the original page, one run per word, stretched to the word's box so that
 * search hits and selections line up with the image. Works on rotated pages: positions go through pdf.js' viewport.
 */
const addTextLayer = (page: PDFPage, lines: Tesseract.Line[], viewport: Viewport, font: PDFFont, charset: Set<number>) => {
    const fontKey: PDFName = page.node.newFontDictionary("OCR", font.ref);
    const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    let words = 0;
    for (const line of lines) {
        const items = line.words.map((word) => ({ box: word.bbox, text: toWinAnsi(word.text, charset).trim() })).filter((word) => word.text);
        if (!items.length) continue;
        const { baseline, bbox } = line;
        const baselineAt = (x: number) =>
            baseline && baseline.x1 !== baseline.x0 ? baseline.y0 + ((baseline.y1 - baseline.y0) * (x - baseline.x0)) / (baseline.x1 - baseline.x0) : bbox.y1;
        // Helvetica: ascender 0.72 and descender 0.21 of the font size.
        const sizePx = Math.max((baselineAt(bbox.x0) - bbox.y0) / 0.72, (bbox.y1 - bbox.y0) / 0.93, 1);
        items.forEach((word, index) => {
            const next = items[index + 1];
            // A trailing space (stretched up to the next word) gives copy & paste real spaces between words.
            const text = next ? `${word.text} ` : word.text;
            const x0 = word.box.x0;
            const x1 = next && next.box.x0 > x0 ? next.box.x0 : word.box.x1;
            const [ax, ay] = viewport.convertToPdfPoint(x0, baselineAt(x0));
            const [bx, by] = viewport.convertToPdfPoint(x1, baselineAt(x1));
            const [ux, uy] = viewport.convertToPdfPoint(x0, baselineAt(x0) - sizePx);
            const length = Math.hypot(bx - ax, by - ay);
            const size = Math.hypot(ux - ax, uy - ay);
            const natural = font.widthOfTextAtSize(text, size);
            if (length < 0.5 || size < 1 || natural <= 0) return;
            const cos = (bx - ax) / length;
            const sin = (by - ay) / length;
            ops.push(
                setFontAndSize(fontKey, size),
                setCharacterSqueeze(Math.min(1000, Math.max(5, (length / natural) * 100))),
                setTextMatrix(cos, sin, -sin, cos, ax, ay),
                showText(font.encodeText(text)),
            );
            words++;
        });
    }
    ops.push(endText(), popGraphicsState());
    if (words) page.pushOperators(...ops);
    return words;
};

/** Splits text into lines that fit `maxWidth`; words longer than a line are cut. */
const wrapText = (text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] => {
    const lines: string[] = [];
    const fits = (value: string) => font.widthOfTextAtSize(value, fontSize) <= maxWidth;
    for (const paragraph of text.split(/\r?\n/)) {
        if (!paragraph.trim()) {
            lines.push("");
            continue;
        }
        let line = "";
        for (let word of paragraph.split(/\s+/).filter(Boolean)) {
            while (!fits(word)) {
                let cut = word.length - 1;
                while (cut > 1 && !fits(word.slice(0, cut))) cut--;
                if (line) lines.push(line);
                lines.push(word.slice(0, cut));
                line = "";
                word = word.slice(cut);
            }
            const candidate = line ? `${line} ${word}` : word;
            if (fits(candidate)) line = candidate;
            else {
                lines.push(line);
                line = word;
            }
        }
        if (line) lines.push(line);
    }
    return lines;
};

export const OcrScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [isReading, setReading] = useState(false);
    const [langs, setLangs] = useState<Set<LangId>>(new Set(["spa", "eng"]));
    const [langHint, setLangHint] = useState(false);
    const [mode, setMode] = useState<Mode>("searchable");
    const [progress, setProgress] = useState<Progress | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [downloadFailed, setDownloadFailed] = useState(false);
    const workerRef = useRef<Tesseract.Worker | null>(null);
    const runRef = useRef(0);
    const fileRef = useRef(0);
    const langLabelId = useId();

    const stopWorker = () => {
        const worker = workerRef.current;
        workerRef.current = null;
        worker?.terminate().catch(() => undefined);
    };

    useEffect(
        () => () => {
            runRef.current++;
            fileRef.current++;
            stopWorker();
        },
        [],
    );

    const reset = () => {
        runRef.current++;
        fileRef.current++;
        stopWorker();
        baseReset();
        setProgress(null);
        setOutcome(null);
        setDownloadFailed(false);
    };

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        const fileId = ++fileRef.current;
        setError(null);
        setReading(true);
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            const found = await detectText(file).catch(() => ({ textPages: 0, checkedPages: 0 }));
            if (fileRef.current !== fileId) return;
            setInput({ file, pageCount: doc.getPageCount(), ...found });
        } catch (err) {
            if (fileRef.current === fileId) setError(friendlyError(err, "No se pudo leer el PDF."));
        } finally {
            if (fileRef.current === fileId) setReading(false);
        }
    };

    const cancel = () => {
        runRef.current++;
        stopWorker();
        setBusy(false);
        setProgress(null);
    };

    const run = async () => {
        if (!input) return;
        const runId = ++runRef.current;
        const isCurrent = () => runRef.current === runId;
        let downloading = false;
        let worker: Tesseract.Worker | null = null;
        setError(null);
        setDownloadFailed(false);
        setBusy(true);
        setProgress({ label: "Analizando el PDF…", pct: null });
        try {
            const pdfjs = await getPdfjs();
            const source = mode === "searchable" ? await loadPdfForEditing(input.file, { updateMetadata: false }) : null;
            const task = pdfjs.getDocument({ data: new Uint8Array(await input.file.arrayBuffer()) });
            try {
                const pdf = await task.promise;
                const total = pdf.numPages;

                // Pages that already have real text keep it: no OCR, no duplicate invisible layer.
                const existing: (string | null)[] = [];
                for (let i = 1; i <= total; i++) {
                    if (!isCurrent()) return;
                    const text = textFromContent((await (await pdf.getPage(i)).getTextContent()).items);
                    existing.push(letterCount(text) >= PAGE_TEXT_MIN ? text : null);
                }
                const pending = existing.filter((text) => text === null).length;

                let current = 0;
                let done = 0;
                if (pending > 0) {
                    setProgress({ label: "Preparando el motor de OCR…", pct: null });
                    downloading = true;
                    const { createWorker } = await import("tesseract.js");
                    worker = await createWorker(Array.from(langs), undefined, {
                        logger: (message) => {
                            if (!isCurrent()) return;
                            if (message.status === "recognizing text") {
                                setProgress({
                                    label: total > 1 ? `Reconociendo texto · página ${current} de ${total}` : "Reconociendo texto…",
                                    pct: Math.round(((done + Math.min(1, Math.max(0, message.progress))) / pending) * 100),
                                });
                            } else if (downloading) {
                                setProgress({ label: SETUP_LABELS[message.status] ?? "Preparando el motor de OCR…", pct: null });
                            }
                        },
                    });
                    downloading = false;
                    if (!isCurrent()) {
                        worker.terminate().catch(() => undefined);
                        return;
                    }
                    workerRef.current = worker;
                }

                const font = source ? await source.embedFont(StandardFonts.Helvetica) : null;
                const charset = font ? new Set(font.getCharacterSet()) : null;
                const texts: string[] = [];
                let recognizedChars = 0;

                for (let i = 1; i <= total; i++) {
                    if (!isCurrent()) return;
                    const known = existing[i - 1];
                    if (known !== null) {
                        texts.push(known);
                        continue;
                    }
                    current = i;
                    setProgress({ label: total > 1 ? `Leyendo la página ${i} de ${total}…` : "Leyendo la página…", pct: Math.round((done / pending) * 100) });
                    const page = await pdf.getPage(i);
                    const base = page.getViewport({ scale: 1 });
                    const viewport = page.getViewport({ scale: Math.min(OCR_DPI / 72, MAX_OCR_SIDE / Math.max(base.width, base.height)) });
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.ceil(viewport.width));
                    canvas.height = Math.max(1, Math.ceil(viewport.height));
                    const ctx = canvas.getContext("2d", { alpha: false });
                    if (!ctx) throw new Error("canvas");
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
                    if (!isCurrent() || !worker) return;
                    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
                    canvas.width = 0;
                    canvas.height = 0;
                    page.cleanup();
                    if (!isCurrent()) return;
                    const text = (data.text ?? "").trim();
                    texts.push(text);
                    recognizedChars += letterCount(text);
                    if (source && font && charset) {
                        const lines = (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
                        addTextLayer(source.getPage(i - 1), lines, viewport, font, charset);
                    }
                    done++;
                }

                const fullText = total > 1 ? texts.map((text, i) => `— Página ${i + 1} —\n${text}`).join("\n\n") : (texts[0] ?? "");
                const skipped = total - pending;
                const base = input.file.name.replace(/\.pdf$/i, "");
                if (pending > 0 && recognizedChars === 0) {
                    setOutcome({ mode, recognized: pending, skipped, found: false, text: "" });
                    return;
                }

                setProgress({ label: "Guardando el PDF…", pct: pending ? 100 : null });
                let bytes: Uint8Array;
                let outputPages = total;
                if (source) {
                    bytes = await source.save({ useObjectStreams: true });
                } else {
                    const out = await PDFDocument.create();
                    const outFont = await out.embedFont(StandardFonts.Helvetica);
                    const outCharset = new Set(outFont.getCharacterSet());
                    const margin = 48;
                    const fontSize = 11;
                    const leading = fontSize * 1.4;
                    for (let i = 0; i < texts.length; i++) {
                        const text = toWinAnsi(texts[i], outCharset);
                        if (!text.trim()) continue;
                        const size = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
                        const width = Math.max(size.width, 300);
                        const height = Math.max(size.height, 300);
                        const newPage = () => {
                            const added = out.addPage([width, height]);
                            added.setFont(outFont);
                            added.setFontSize(fontSize);
                            return added;
                        };
                        let page = newPage();
                        let y = height - margin - fontSize;
                        for (const line of wrapText(text, outFont, fontSize, width - margin * 2)) {
                            // A page that fills up continues on a new one instead of dropping the rest.
                            if (y < margin) {
                                page = newPage();
                                y = height - margin - fontSize;
                            }
                            if (line) page.drawText(line, { x: margin, y });
                            y -= leading;
                        }
                    }
                    outputPages = out.getPageCount();
                    bytes = await out.save();
                }
                if (!isCurrent()) return;

                setOutcome({ mode, recognized: pending, skipped, found: true, text: fullText });
                const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
                const parts =
                    mode === "text-only"
                        ? [`${plural(outputPages, "página de texto", "páginas de texto")}`]
                        : [
                              pending ? plural(pending, "página reconocida", "páginas reconocidas") : "No ha hecho falta reconocer ninguna página",
                              skipped && pending ? `${pagesLabel(skipped)} ya ${skipped === 1 ? "tenía" : "tenían"} texto` : "",
                          ];
                setResult({
                    blob,
                    filename: datedFilename(`${base}-${mode === "text-only" ? "texto" : "ocr"}`, "pdf"),
                    primaryLabel: "Descargar PDF",
                    summary: [...parts, readableBytes(blob.size)].filter(Boolean).join(" · "),
                });
            } finally {
                task.destroy();
            }
        } catch (err) {
            if (!isCurrent()) return;
            const raw = err instanceof Error ? `${err.name} ${err.message}` : String((err as { message?: string } | null)?.message ?? err ?? "");
            const isDownloadProblem =
                !(err instanceof UserFacingError) && (downloading || /importScripts|NetworkError|Failed to fetch|Load failed|network/i.test(raw));
            setDownloadFailed(isDownloadProblem);
            setError(isDownloadProblem ? DOWNLOAD_ERROR : friendlyError(err, "No se pudo completar el OCR. Inténtalo de nuevo."));
        } finally {
            if (worker) {
                (worker as Tesseract.Worker).terminate().catch(() => undefined);
                if (workerRef.current === worker) workerRef.current = null;
            }
            if (isCurrent()) {
                setBusy(false);
                setProgress(null);
            }
        }
    };

    const backToOptions = () => {
        setResult(null);
        setOutcome(null);
    };

    if (outcome && !outcome.found) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <NoTextPanel onBack={backToOptions} onReset={reset} />
            </ToolPageLayout>
        );
    }

    if (result && outcome) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <div className="flex flex-col gap-6">
                    <SuccessPanel
                        result={result}
                        onReset={reset}
                        onBack={backToOptions}
                        title={outcome.mode === "text-only" ? "¡Texto extraído!" : outcome.recognized ? "¡PDF buscable listo!" : "Este PDF ya tenía texto"}
                    />
                    <TextPreview text={outcome.text} filename={result.filename.replace(/\.pdf$/i, ".txt")} />
                </div>
            </ToolPageLayout>
        );
    }

    const allText = input !== null && input.checkedPages > 0 && input.textPages === input.checkedPages;
    const someText = input !== null && input.textPages > 0 && !allText;

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && (
                <>
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={isReading}
                        hint={isReading ? "Leyendo el PDF…" : "Suelta un PDF escaneado o con imágenes."}
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

                    {allText && (
                        <Notice tone="info" title="Este PDF ya tiene texto seleccionable">
                            <p>
                                No necesitas OCR para buscar o copiar su texto. Si quieres cambiarlo, usa Editar PDF. Si continúas, las páginas que ya tienen
                                texto se dejarán como están.
                            </p>
                            <Button href="/tools/edit" color="link-color" size="sm" iconTrailing={ArrowRight} className="mt-2">
                                Ir a Editar PDF
                            </Button>
                        </Notice>
                    )}
                    {someText && (
                        <Notice tone="info">Algunas páginas ya tienen texto seleccionable: se dejarán como están y solo se reconocerán las demás.</Notice>
                    )}

                    <div className="flex flex-col gap-3">
                        <p id={langLabelId} className="text-sm font-medium text-secondary">
                            Idiomas del documento
                        </p>
                        <AriaToggleButtonGroup
                            aria-labelledby={langLabelId}
                            selectionMode="multiple"
                            selectedKeys={langs}
                            isDisabled={isBusy}
                            onSelectionChange={(keys) => {
                                // At least one language is needed: keep the last one selected and say why.
                                if (keys.size === 0) {
                                    setLangHint(true);
                                    return;
                                }
                                setLangHint(false);
                                setLangs(new Set(keys) as Set<LangId>);
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
                            {langHint ? "Debe quedar al menos un idioma seleccionado." : "Selecciona varios si el documento mezcla idiomas."}
                        </p>
                    </div>

                    <AriaRadioGroup value={mode} onChange={(value) => setMode(value as Mode)} isDisabled={isBusy} className="flex flex-col gap-3">
                        <AriaLabel className="text-sm font-medium text-secondary">Tipo de salida</AriaLabel>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <OptionCard
                                value="searchable"
                                title="PDF buscable"
                                description="Conserva cada página tal cual y añade una capa de texto invisible: podrás buscar (Ctrl+F), seleccionar y copiar."
                            />
                            <OptionCard
                                value="text-only"
                                title="Solo texto"
                                description="Crea un PDF nuevo solo con el texto reconocido, sin las imágenes originales."
                            />
                        </div>
                    </AriaRadioGroup>

                    <Notice tone="info">
                        El reconocimiento se hace en tu navegador. La primera vez se descargan el motor de OCR y los idiomas elegidos; después se reutilizan y
                        todo va más rápido.
                    </Notice>

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
                            iconLeading={downloadFailed && !isBusy ? RefreshCcw01 : FileSearch02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            className="w-full sm:w-auto"
                            onClick={run}
                        >
                            {isBusy ? "Reconociendo…" : downloadFailed ? "Reintentar" : "Reconocer texto"}
                        </Button>
                    </ActionBar>
                </div>
            )}
        </ToolPageLayout>
    );
};

const NoTextPanel = ({ onBack, onReset }: { onBack: () => void; onReset: () => void }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        role="status"
        className="flex flex-col items-center gap-5 rounded-2xl bg-primary p-6 text-center ring-1 ring-secondary ring-inset md:p-8"
    >
        <FeaturedIcon icon={AlertTriangle} color="warning" theme="light" size="xl" />
        <div className="flex max-w-md flex-col items-center gap-2">
            <h2 className="text-lg font-semibold text-primary">No hemos encontrado texto</h2>
            <p className="text-sm text-tertiary">
                Puede que las páginas no tengan texto, que el escaneo sea muy borroso o que el idioma elegido no sea el del documento. Revisa los idiomas y
                vuelve a intentarlo.
            </p>
        </div>
        <div className="flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button color="primary" size="lg" iconLeading={ArrowLeft} onClick={onBack}>
                Volver y ajustar
            </Button>
            <Button color="secondary" size="lg" iconLeading={RefreshCcw01} onClick={onReset}>
                Empezar de nuevo
            </Button>
        </div>
    </motion.div>
);

const TextPreview = ({ text, filename }: { text: string; filename: string }) => {
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const shown = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

    useEffect(() => {
        if (copyState === "idle") return;
        const timer = setTimeout(() => setCopyState("idle"), 2500);
        return () => clearTimeout(timer);
    }, [copyState]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopyState("copied");
        } catch {
            setCopyState("failed");
        }
    };

    return (
        <section aria-label="Texto reconocido" className="flex flex-col gap-3 rounded-2xl bg-primary p-5 ring-1 ring-secondary ring-inset md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-md font-semibold text-primary">Texto reconocido</h3>
                <div className="flex flex-wrap gap-2">
                    <Button color="secondary" size="sm" iconLeading={copyState === "copied" ? Check : Copy01} onClick={copy}>
                        {copyState === "copied" ? "Copiado" : copyState === "failed" ? "No se pudo copiar" : "Copiar texto"}
                    </Button>
                    <Button
                        color="secondary"
                        size="sm"
                        iconLeading={Download01}
                        onClick={() => downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename)}
                    >
                        Descargar .txt
                    </Button>
                </div>
            </div>
            <div
                tabIndex={0}
                className="scrollbar-subtle max-h-80 overflow-auto rounded-lg bg-secondary p-4 text-sm whitespace-pre-wrap text-secondary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                {shown}
            </div>
            {text.length > PREVIEW_CHARS && (
                <p className="text-sm text-tertiary">
                    Se muestran los primeros {PREVIEW_CHARS.toLocaleString("es")} caracteres. Copia o descarga el texto para tenerlo completo.
                </p>
            )}
        </section>
    );
};

/** Single-choice card: a real radio (arrow keys move the choice) with a visible dot, not only a colour change. */
const OptionCard = ({ value, title, description }: { value: Mode; title: ReactNode; description: string }) => (
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
                <span
                    aria-hidden="true"
                    className={cx(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary ring-1 ring-primary transition duration-100 ease-linear ring-inset",
                        isSelected && "bg-brand-solid ring-transparent",
                    )}
                >
                    <span className={cx("size-1.5 rounded-full bg-white", !isSelected && "opacity-0")} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-semibold text-primary">{title}</span>
                    <span className="text-sm text-tertiary">{description}</span>
                </span>
            </>
        )}
    </AriaRadio>
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
