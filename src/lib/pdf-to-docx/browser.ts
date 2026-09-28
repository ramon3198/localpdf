"use client";

// Browser host of the PDF → Word converter. index.ts never imports this file, so the converter itself stays DOM-free.
//  - createBrowserEnvironment: pdf.js + canvas render pages (layout backgrounds, OCR input); tesseract.js reads scans;
//    the app's font pack (public/fonts/pack) provides the fonts the .docx embeds.
//  - convertInBrowser: runs index.ts in a Web Worker whose entry is this same file, so the page keeps painting progress
//    and answers «Cancelar» at once, even on documents that take long. Rendering and OCR stay on the page (they need a
//    canvas and tesseract's own worker): the worker asks for them by message; fonts it fetches itself. If the worker
//    can't start (old browser, bundling problem) the conversion runs on the page instead.
import type Tesseract from "tesseract.js";
import { type FontPackManifest, resolvePackFace } from "@/lib/pdf-text-engine/font-pack";
import { describeFont } from "@/lib/pdf-text-engine/font-style";
import { UserFacingError } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import type { ConvertEnvironment, ConvertOptions, ConvertResult, OcrWord, RenderedImage } from "./types";

type Pdfjs = Awaited<ReturnType<typeof getPdfjs>>;
type LoadingTask = ReturnType<Pdfjs["getDocument"]>;
type RenderTask = { cancel: () => void };
type ProgressEvent = Parameters<NonNullable<ConvertOptions["onProgress"]>>[0];

export type OcrStatus =
    /** Getting the engine ready: the first use downloads it and the languages (a few MB), later uses load them from the cache. */
    | { stage: "setup"; label: string }
    /** Recognition of the current page, 0 → 1. */
    | { stage: "recognizing"; progress: number };

export type BrowserEnvironmentOptions = {
    /** Stops page rendering and OCR in flight (pass the conversion's own signal). */
    signal?: AbortSignal;
    onOcrStatus?: (status: OcrStatus) => void;
};

export type BrowserEnvironment = ConvertEnvironment & {
    /** Terminates the OCR worker and closes the pdf.js documents. Call it once the conversion ends, whatever the outcome. */
    dispose: () => void;
};

/** The OCR engine could not be set up (the first use needs a connection to download it). */
export class OcrSetupError extends UserFacingError {
    constructor() {
        super("No se pudo preparar el OCR: la primera vez hace falta conexión a internet para descargar el motor y los idiomas.");
        this.name = "OcrSetupError";
    }
}

/** Backgrounds are rendered at ≤ 200 dpi: JPEG keeps them light. OCR input (300 dpi) stays lossless. */
const JPEG_MAX_DPI = 200;
const JPEG_QUALITY = 0.85;
/** Canvas limits (iOS Safari refuses more than ~16.7 M pixels): huge pages are rendered at a lower resolution. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
const DEFAULT_LANGUAGES = ["spa", "eng"];
/** A worker that hasn't even started by then won't: convert on the page. */
const WORKER_START_TIMEOUT = 30_000;

/**
 * tesseract.js reports its set-up steps in English; these are shown instead. It reports a language read from the cache
 * and one being downloaded the same way, so the labels don't claim either.
 */
const OCR_SETUP_LABELS: Record<string, string> = {
    "loading tesseract core": "Cargando el motor de OCR…",
    "initializing tesseract": "Iniciando el motor de OCR…",
    "initialized tesseract": "Iniciando el motor de OCR…",
    "loading language traineddata": "Cargando los idiomas del OCR…",
    "loaded language traineddata": "Cargando los idiomas del OCR…",
    "initializing api": "Preparando el reconocimiento de texto…",
    "initialized api": "Preparando el reconocimiento de texto…",
};

/** Resolution each rendered image really has (large pages are capped), so tesseract knows the text size. */
const renderedDpi = new WeakMap<RenderedImage, number>();

// ---------------------------------------------------------------------------------------------------------------------
// Fonts for the .docx: the app's font pack, fetched once per face and kept for later conversions (page and worker).

const FONT_PACK = "/fonts/pack/";
let packManifest: Promise<FontPackManifest | null> | null = null;
const packFaces = new Map<string, Promise<Uint8Array | null>>();

const fetchBytes = (url: string): Promise<Uint8Array | null> =>
    fetch(url)
        .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
        .catch(() => null);

/**
 * ConvertEnvironment.loadFont: a face of the family itself (never a stand-in: Word would not find it under the family's
 * name), at the weight and slant nearest to the variant asked for. The writer checks the face's own name and style.
 */
const loadPackFont = async (family: string, bold: boolean, italic: boolean): Promise<Uint8Array | null> => {
    packManifest ??= fetch(`${FONT_PACK}manifest.json`)
        .then((r) => (r.ok ? (r.json() as Promise<FontPackManifest>) : null))
        .catch(() => null);
    const manifest = await packManifest;
    if (!manifest?.families) {
        // A failed download is retried by the next conversion.
        packManifest = null;
        return null;
    }
    // The family's own weight ("Inter SemiBold": 600), or bold's.
    const own = describeFont(family).weight;
    const face = resolvePackFace(manifest, family, { weight: bold ? Math.max(own, 700) : own, italic, family });
    if (!face?.exactFamily) return null;
    let bytes = packFaces.get(face.file);
    if (!bytes) {
        bytes = fetchBytes(FONT_PACK + face.file);
        packFaces.set(face.file, bytes);
        // A failed download is retried by the next request.
        void bytes.then((b) => {
            if (!b && packFaces.get(face.file) === bytes) packFaces.delete(face.file);
        });
    }
    return bytes;
};

const abortError = () => new DOMException("Conversión cancelada", "AbortError");
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

/** `promise`, or an AbortError as soon as one of the signals fires (tesseract.js jobs can't be cancelled, only dropped). */
const unlessAborted = <T>(promise: Promise<T>, signals: (AbortSignal | undefined)[]): Promise<T> => {
    const active = signals.filter((signal): signal is AbortSignal => !!signal);
    if (active.some((signal) => signal.aborted)) return Promise.reject(abortError());
    if (!active.length) return promise;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(abortError());
        };
        const cleanup = () => active.forEach((signal) => signal.removeEventListener("abort", onAbort));
        active.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
};

/**
 * Runs `create` and returns the Web Workers it constructed. tesseract.js builds its worker synchronously inside
 * createWorker but only hands it over once the set-up succeeds: without this, a failed or cancelled set-up (no
 * connection, a cancel mid-download) would leave that worker, with the OCR engine loaded, alive until the page closes.
 */
const withSpawnedWorkers = <T>(create: () => T): { value: T; workers: Worker[] } => {
    const workers: Worker[] = [];
    const Native = globalThis.Worker;
    globalThis.Worker = class extends Native {
        constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            workers.push(this);
        }
    };
    try {
        return { value: create(), workers };
    } finally {
        globalThis.Worker = Native;
    }
};

/** The OCR engine: tesseract's API once ready, and the Web Workers it runs in (to stop them even if it never gets ready). */
type TesseractHandle = { ready: Promise<Tesseract.Worker>; workers: Worker[]; stopped: boolean };

/** OCR words in reading order, numbered by line and paragraph across the whole page. */
const wordsFromPage = (page: Tesseract.Page): OcrWord[] => {
    const words: OcrWord[] = [];
    let line = 0;
    let paragraph = 0;
    for (const block of page.blocks ?? []) {
        for (const para of block.paragraphs) {
            for (const row of para.lines) {
                for (const word of row.words) {
                    const text = word.text.trim();
                    const { x0, y0, x1, y1 } = word.bbox;
                    if (!text || x1 <= x0 || y1 <= y0) continue;
                    words.push({ text, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, confidence: word.confidence, line, paragraph });
                }
                line++;
            }
            paragraph++;
        }
    }
    return words;
};

export const createBrowserEnvironment = (options: BrowserEnvironmentOptions = {}): BrowserEnvironment => {
    const { signal, onOcrStatus } = options;
    let disposed = false;

    // pdf.js documents by source bytes: the orchestrator renders from the original PDF (OCR) and from its text-less
    // copy (backgrounds), each many times.
    const documents = new Map<Uint8Array, Promise<LoadingTask>>();
    const renders = new Set<RenderTask>();

    let tesseract: TesseractHandle | null = null;
    let tesseractLanguages = "";

    const checkAlive = () => {
        if (disposed || signal?.aborted) throw abortError();
    };

    const openDocument = (pdf: Uint8Array) => {
        let entry = documents.get(pdf);
        if (!entry) {
            // pdf.js takes (detaches) the buffer it is given: it gets a copy, the converter keeps using `pdf`.
            const copy = pdf.slice();
            // Errors only: font-hinting chatter ("TT: undefined function") says nothing about the result.
            entry = getPdfjs().then((pdfjs) => pdfjs.getDocument({ data: copy, verbosity: pdfjs.VerbosityLevel.ERRORS }));
            documents.set(pdf, entry);
            entry.then(
                (task) => task.promise.catch(() => documents.get(pdf) === entry && documents.delete(pdf)),
                () => documents.get(pdf) === entry && documents.delete(pdf),
            );
            // Only two sources are in use at a time; drop the oldest if a third one comes.
            if (documents.size > 2) {
                const [oldest, task] = documents.entries().next().value!;
                documents.delete(oldest);
                task.then((t) => t.destroy()).catch(() => undefined);
            }
        }
        return entry.then((task) => task.promise);
    };

    const renderPage = async (pdf: Uint8Array, pageIndex: number, dpi: number): Promise<RenderedImage> => {
        checkAlive();
        const doc = await openDocument(pdf);
        checkAlive();
        const page = await doc.getPage(pageIndex + 1);
        const canvas = document.createElement("canvas");
        try {
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(base.width, base.height), Math.sqrt(MAX_PIXELS / Math.max(1, base.width * base.height)));
            const viewport = page.getViewport({ scale });
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("canvas");
            // White paper, as in any viewer (and JPEG has no transparency).
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            const task = page.render({ canvas, canvasContext: context, viewport });
            renders.add(task);
            try {
                await task.promise;
            } finally {
                renders.delete(task);
            }
            checkAlive();
            const mime = dpi <= JPEG_MAX_DPI ? "image/jpeg" : "image/png";
            const blob = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("canvas"))), mime, mime === "image/jpeg" ? JPEG_QUALITY : undefined),
            );
            const image: RenderedImage = { data: new Uint8Array(await blob.arrayBuffer()), mime, pixelWidth: canvas.width, pixelHeight: canvas.height };
            renderedDpi.set(image, scale * 72);
            return image;
        } finally {
            // Free the pixels now instead of waiting for the garbage collector (a 300 dpi page is ~35 MB).
            canvas.width = 0;
            canvas.height = 0;
            page.cleanup();
        }
    };

    const stopTesseract = () => {
        const current = tesseract;
        tesseract = null;
        tesseractLanguages = "";
        if (!current) return;
        current.stopped = true;
        // Terminating its Web Worker is all tesseract's own terminate() does, and it works before the set-up ends too.
        current.workers.forEach((w) => w.terminate());
        current.ready.then((w) => w.terminate()).catch(() => undefined);
    };

    const startTesseract = (languages: string[]): TesseractHandle => {
        const workers: Worker[] = [];
        const handle = { workers, stopped: false } as TesseractHandle;
        handle.ready = (async () => {
            const { createWorker, PSM } = await import("tesseract.js");
            // Stopped while the library loaded: don't start an engine nobody will stop.
            if (handle.stopped) throw abortError();
            let failSetup: (reason: unknown) => void = () => undefined;
            // tesseract.js leaves createWorker pending forever when a language fails to download: turn that into an error.
            const setupFailed = new Promise<never>((_, reject) => (failSetup = reject));
            const { value: created, workers: spawned } = withSpawnedWorkers(() =>
                createWorker(languages, undefined, {
                    logger: (message) => {
                        if (disposed || !onOcrStatus) return;
                        if (message.status === "recognizing text") onOcrStatus({ stage: "recognizing", progress: Math.min(1, Math.max(0, message.progress)) });
                        else if (OCR_SETUP_LABELS[message.status]) onOcrStatus({ stage: "setup", label: OCR_SETUP_LABELS[message.status] });
                    },
                    // Without a handler tesseract.js rethrows worker errors as uncaught exceptions; the failing job rejects anyway.
                    errorHandler: (error) => failSetup(error),
                }),
            );
            workers.push(...spawned);
            try {
                const api = await Promise.race([created, setupFailed]);
                // Whole-page layout analysis (columns, blocks, captions) instead of tesseract.js' default single text block.
                await api.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
                return api;
            } catch (error) {
                workers.forEach((w) => w.terminate());
                throw error;
            }
        })();
        return handle;
    };

    const ocr = async (image: RenderedImage, languages: string[], ocrSignal?: AbortSignal): Promise<OcrWord[]> => {
        checkAlive();
        if (ocrSignal?.aborted) throw abortError();
        const langs = languages.length ? languages : DEFAULT_LANGUAGES;
        const key = langs.join("+");
        if (!tesseract || tesseractLanguages !== key) {
            stopTesseract();
            tesseractLanguages = key;
            tesseract = startTesseract(langs);
            // Nobody may be awaiting it when a cancel lands mid-download: never leave the rejection unhandled.
            tesseract.ready.catch(() => undefined);
        }
        const current = tesseract;
        let ready: Tesseract.Worker;
        try {
            ready = await unlessAborted(current.ready, [signal, ocrSignal]);
        } catch (error) {
            if (tesseract === current) stopTesseract();
            if (isAbort(error)) throw error;
            throw new OcrSetupError();
        }
        try {
            const dpi = renderedDpi.get(image);
            if (dpi) await ready.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
            const { data } = await unlessAborted(ready.recognize(new Blob([image.data as BlobPart], { type: image.mime }), {}, { blocks: true, text: false }), [
                signal,
                ocrSignal,
            ]);
            return wordsFromPage(data);
        } catch (error) {
            // A dropped job keeps the worker busy (and it can't be interrupted): start a fresh one next time.
            if (isAbort(error) && tesseract === current) stopTesseract();
            throw error;
        }
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const task of renders) task.cancel();
        renders.clear();
        stopTesseract();
        for (const entry of documents.values()) entry.then((task) => task.destroy()).catch(() => undefined);
        documents.clear();
    };

    signal?.addEventListener("abort", () => {
        for (const task of renders) task.cancel();
        stopTesseract();
    });

    return { renderPage, ocr, loadFont: loadPackFont, dispose };
};

// ---------------------------------------------------------------------------------------------------------------------
// Conversion off the main thread.

/** What crosses between the page and the conversion worker (structured-clone data only). */
type WireOptions = Pick<ConvertOptions, "mode" | "ocr" | "ocrLanguages" | "pages">;
type WireError = { name: string; message: string; stack?: string; userFacing: boolean };
type ToWorker = { kind: "convert"; pdf: Uint8Array; options: WireOptions } | { kind: "reply"; id: number; value?: unknown; error?: WireError };
type FromWorker =
    | { kind: "ready" }
    | { kind: "progress"; progress: ProgressEvent }
    /** `pdf` travels only the first time a source is used; later requests name it by `source`. */
    | { kind: "render"; id: number; source: number; pdf?: Uint8Array; pageIndex: number; dpi: number }
    | { kind: "ocr"; id: number; image: RenderedImage; dpi?: number; languages: string[] }
    | { kind: "done"; result: ConvertResult }
    /** `load`: the converter code could not be loaded in the worker (the page can still try). */
    | { kind: "failed"; stage: "load" | "convert"; error: WireError };
type WorkerScope = { postMessage: (message: FromWorker, transfer?: Transferable[]) => void; onmessage: ((event: MessageEvent<ToWorker>) => void) | null };

const toWire = (error: unknown): WireError =>
    error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack, userFacing: error instanceof UserFacingError }
        : { name: "Error", message: String(error), userFacing: false };

/** The same kind of error on this side, so callers can tell cancels, OCR set-up problems and user-facing messages apart. */
const fromWire = (wire: WireError): Error => {
    if (wire.name === "AbortError") return abortError();
    if (wire.name === "OcrSetupError") return new OcrSetupError();
    const error = wire.userFacing ? new UserFacingError(wire.message) : new Error(wire.message);
    if (!wire.userFacing) error.name = wire.name;
    if (wire.stack) error.stack = wire.stack;
    return error;
};

/** Inside the conversion worker: runs index.ts with an environment that asks the page for renders and OCR. */
const serveConversions = (scope: WorkerScope) => {
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
    const sources = new WeakMap<Uint8Array, number>();
    const dpis = new WeakMap<RenderedImage, number>();
    let nextId = 1;

    const ask = <T>(message: FromWorker & { id: number }, transfer: Transferable[] = []) =>
        new Promise<T>((resolve, reject) => {
            pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject });
            scope.postMessage(message, transfer);
        });

    const env: ConvertEnvironment = {
        renderPage: async (pdf, pageIndex, dpi) => {
            let source = sources.get(pdf);
            let bytes: Uint8Array<ArrayBuffer> | undefined;
            if (source === undefined) {
                source = nextId++;
                sources.set(pdf, source);
                bytes = pdf.slice();
            }
            const { image, dpi: real } = await ask<{ image: RenderedImage; dpi: number }>(
                { kind: "render", id: nextId++, source, pdf: bytes, pageIndex, dpi },
                bytes ? [bytes.buffer] : [],
            );
            dpis.set(image, real);
            return image;
        },
        ocr: (image, languages) => ask<OcrWord[]>({ kind: "ocr", id: nextId++, image, dpi: dpis.get(image), languages }),
        // Fonts need neither a canvas nor the page: the worker fetches them itself.
        loadFont: loadPackFont,
    };

    scope.onmessage = async ({ data }) => {
        if (data.kind === "reply") {
            const waiting = pending.get(data.id);
            pending.delete(data.id);
            if (data.error) waiting?.reject(fromWire(data.error));
            else waiting?.resolve(data.value);
            return;
        }
        let convert: (typeof import("./index"))["convertPdfToDocx"];
        try {
            ({ convertPdfToDocx: convert } = await import("./index"));
        } catch (error) {
            scope.postMessage({ kind: "failed", stage: "load", error: toWire(error) });
            return;
        }
        try {
            const result = await convert(data.pdf, env, { ...data.options, onProgress: (progress) => scope.postMessage({ kind: "progress", progress }) });
            scope.postMessage({ kind: "done", result }, [result.docx.buffer as ArrayBuffer]);
        } catch (error) {
            scope.postMessage({ kind: "failed", stage: "convert", error: toWire(error) });
        }
    };
    scope.postMessage({ kind: "ready" });
};

/** On the page: one conversion in a fresh worker. Resolves null when the worker can't start (then convert on the page). */
const convertInWorker = (pdf: Uint8Array, env: BrowserEnvironment, options: ConvertOptions, spawn: () => Worker): Promise<ConvertResult | null> =>
    new Promise((resolve, reject) => {
        const { signal, onProgress } = options;
        let worker: Worker;
        try {
            worker = spawn();
        } catch (error) {
            console.warn("PDF a Word: se convierte en la página, sin worker:", error);
            resolve(null);
            return;
        }
        let started = false;
        let settled = false;
        /** Source PDFs the worker renders from (the original, its text-less copy), by the id the worker gave them. */
        const sources = new Map<number, Uint8Array>();

        const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            worker.terminate();
            finish();
        };
        const onAbort = () => settle(() => reject(abortError()));
        const fallBack = (reason: unknown) =>
            settle(() => {
                console.warn("PDF a Word: se convierte en la página, sin worker:", reason);
                resolve(null);
            });
        const timer = setTimeout(() => !started && fallBack("el worker no arrancó"), WORKER_START_TIMEOUT);
        const reply = (id: number, value: unknown, transfer: Transferable[] = []) => {
            if (!settled) worker.postMessage({ kind: "reply", id, value } satisfies ToWorker, transfer);
        };
        const replyError = (id: number, error: unknown) => {
            if (!settled) worker.postMessage({ kind: "reply", id, error: toWire(error) } satisfies ToWorker);
        };

        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });

        worker.onerror = (event) => {
            // Handled here: keep it out of the console as an uncaught error.
            event.preventDefault();
            if (started) settle(() => reject(new Error(`worker: ${event.message || "error"}`)));
            else fallBack(event.message || "error al cargar el worker");
        };
        worker.onmessageerror = () => settle(() => reject(new Error("worker: mensaje ilegible")));
        worker.onmessage = async ({ data }: MessageEvent<FromWorker>) => {
            switch (data.kind) {
                case "ready": {
                    started = true;
                    clearTimeout(timer);
                    const copy = pdf.slice();
                    const wire: WireOptions = { mode: options.mode, ocr: options.ocr, ocrLanguages: options.ocrLanguages, pages: options.pages };
                    worker.postMessage({ kind: "convert", pdf: copy, options: wire } satisfies ToWorker, [copy.buffer]);
                    return;
                }
                case "progress":
                    onProgress?.(data.progress);
                    return;
                case "render": {
                    if (data.pdf) sources.set(data.source, data.pdf);
                    const source = sources.get(data.source);
                    try {
                        if (!source || !env.renderPage) throw new Error("render: fuente desconocida");
                        const image = await env.renderPage(source, data.pageIndex, data.dpi);
                        reply(data.id, { image, dpi: renderedDpi.get(image) ?? data.dpi }, [image.data.buffer as ArrayBuffer]);
                    } catch (error) {
                        replyError(data.id, error);
                    }
                    return;
                }
                case "ocr": {
                    try {
                        if (!env.ocr) throw new Error("ocr: no disponible");
                        if (data.dpi) renderedDpi.set(data.image, data.dpi);
                        reply(data.id, await env.ocr(data.image, data.languages, signal));
                    } catch (error) {
                        replyError(data.id, error);
                    }
                    return;
                }
                case "done":
                    settle(() => resolve(data.result));
                    return;
                case "failed":
                    if (data.stage === "load") fallBack(data.error);
                    else settle(() => reject(fromWire(data.error)));
                    return;
            }
        };
    });

export type BrowserConvertOptions = ConvertOptions & {
    onOcrStatus?: (status: OcrStatus) => void;
    /**
     * Starts the conversion worker, whose entry is this file:
     * `() => new Worker(new URL("<relative path>/lib/pdf-to-docx/browser.ts", import.meta.url), { type: "module" })`.
     * The caller writes it (not this file) so that the bundler doesn't see the worker's entry referring to itself.
     * Without it (or if it fails) the conversion runs on the page: fine for debugging with breakpoints and profiles.
     */
    worker?: () => Worker;
};

/**
 * Converts in the browser with everything it needs: pdf.js rendering, tesseract.js OCR and a worker that keeps the page
 * responsive. Cancel with `signal` (the worker is stopped at once).
 */
export const convertInBrowser = async (pdf: Uint8Array, options: BrowserConvertOptions = {}): Promise<ConvertResult> => {
    const { onOcrStatus, worker, ...convertOptions } = options;
    const env = createBrowserEnvironment({ signal: convertOptions.signal, onOcrStatus });
    try {
        const result = worker && typeof Worker !== "undefined" ? await convertInWorker(pdf, env, convertOptions, worker) : null;
        if (result) return result;
        const { convertPdfToDocx } = await import("./index");
        return await convertPdfToDocx(pdf, env, convertOptions);
    } finally {
        env.dispose();
    }
};

// This file is also the conversion worker's entry: there, serve conversions. (Not `typeof window`: Next folds it to
// "object" at build time in client code, which would drop this branch from the worker too.)
const workerGlobal = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
if (typeof workerGlobal === "function" && globalThis instanceof workerGlobal) serveConversions(globalThis as unknown as WorkerScope);
