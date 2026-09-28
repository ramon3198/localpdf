"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useReducer, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, CursorBox, File04, FileShield02, FlipBackward, Hand, Maximize01, Trash01, XClose } from "@untitledui/icons";
import {
    PDFArray,
    PDFDocument,
    type PDFPage,
    PDFDict,
    PDFName,
    PDFNull,
    PDFNumber,
    PDFRawStream,
    PDFRef,
    PDFStream,
    decodePDFRawStream,
} from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
    Dialog as AriaDialog,
    Heading as AriaHeading,
    Modal as AriaModal,
    ModalOverlay as AriaModalOverlay,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
} from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { PROTECTED_PDF_MESSAGE, UserFacingError, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

const TITLE = "Censurar PDF";
const DESCRIPTION = "Tapa con negro datos personales, cifras o firmas. Lo que tapes desaparece del archivo, no solo de la vista.";

/** Resolution of the pages that get censored (they are rebuilt as images). */
const RASTER_DPI = 200;
const MAX_RASTER_SIDE = 5000;

type SourceFile = { file: File; pageCount: number };
/** A censored area, as fractions of the page as displayed (0–1, origin top-left). */
type Box = { id: string; page: number; x: number; y: number; w: number; h: number };
type PagePreview = { url: string; width: number; height: number };

type EditorState = { boxes: Box[]; past: Box[][] };
type EditorAction = { type: "add"; box: Box } | { type: "remove"; id: string } | { type: "clear" } | { type: "undo" } | { type: "reset" };

const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
    const push = (boxes: Box[]) => ({ boxes, past: [...state.past.slice(-49), state.boxes] });
    switch (action.type) {
        case "add":
            return push([...state.boxes, action.box]);
        case "remove":
            return push(state.boxes.filter((b) => b.id !== action.id));
        case "clear":
            return state.boxes.length ? push([]) : state;
        case "undo":
            return state.past.length ? { boxes: state.past[state.past.length - 1], past: state.past.slice(0, -1) } : state;
        case "reset":
            return { boxes: [], past: [] };
    }
};

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** "1", "1 y 4", "1, 3 y 4" */
const joinList = (items: (string | number)[]) => (items.length <= 1 ? String(items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`);

const useCoarsePointer = () => {
    const [coarse, setCoarse] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia("(pointer: coarse)");
        const update = () => setCoarse(mq.matches);
        update();
        mq.addEventListener("change", update);
        return () => mq.removeEventListener("change", update);
    }, []);
    return coarse;
};

// ---------------------------------------------------------------------------------------------------------------
// Building the censored PDF. Censored pages are rendered to an image with the black boxes burnt in, so nothing
// under a box survives. The document is rebuilt from scratch so no hidden copy of those pages (content streams,
// thumbnails, form values, metadata) is carried over.
// ---------------------------------------------------------------------------------------------------------------

const CENSORED_MARK = PDFName.of("LocalPdfCensoredPage");
const KEEP_ON_CENSORED_PAGE = new Set(["/Type", "/Parent", "/MediaBox", "/CropBox", "/Rotate"]);

const decodeName = (name: string) => name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Decoded content of a page, or null when a stream can't be decoded here. */
const pageContent = (doc: PDFDocument, page: PDFPage) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((o) => doc.context.lookup(o)) : contents ? [contents] : [];
    const decoder = new TextDecoder("latin1");
    let text = "";
    for (const stream of streams) {
        if (stream instanceof PDFRawStream) text += decoder.decode(decodePDFRawStream(stream).decode()) + "\n";
        else if (stream instanceof PDFStream) text += decoder.decode(stream.getContents()) + "\n";
        else return null;
    }
    return text;
};

/** Resources shared between pages can hold images only a censored page used: keep just the ones this page draws. */
const pruneUnusedXObjects = (doc: PDFDocument, page: PDFPage) => {
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!resources || !xobjects || xobjects.keys().length === 0) return;
    let content: string | null;
    try {
        content = pageContent(doc, page);
    } catch {
        return;
    }
    if (content === null) return;
    const used = new Set(Array.from(content.matchAll(/\/([^\s/[\]<>(){}%]+)\s*Do\b/g), (m) => decodeName(m[1])));
    const unused = xobjects.keys().filter((key) => !used.has(decodeName(key.asString().slice(1))));
    if (!unused.length) return;
    const pruned = xobjects.clone(doc.context);
    for (const key of unused) pruned.delete(key);
    const own = resources.clone(doc.context);
    own.set(PDFName.of("XObject"), pruned);
    page.node.set(PDFName.of("Resources"), own);
};

/**
 * Copying pages also copies what their annotations point to (link targets, a form field's page), which can create
 * stray duplicates of other pages. Point those references at the real pages instead (or at nothing).
 */
const remapStrayPages = (out: PDFDocument, rasterByIndex: Map<number, PDFRef>) => {
    const context = out.context;
    const pages = out.getPages();
    const real = new Set(pages.map((p) => p.ref.toString()));
    const byContents = new Map<string, PDFRef>();
    for (const p of pages) {
        const contents = p.node.get(PDFName.of("Contents"));
        if (contents && !byContents.has(contents.toString())) byContents.set(contents.toString(), p.ref);
    }
    const replace = new Map<string, PDFRef | typeof PDFNull>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type")) !== PDFName.of("Page") || real.has(ref.toString())) continue;
        const mark = obj.get(CENSORED_MARK);
        const contents = obj.get(PDFName.of("Contents"));
        const target = mark instanceof PDFNumber ? rasterByIndex.get(mark.asNumber()) : contents ? byContents.get(contents.toString()) : undefined;
        replace.set(ref.toString(), target ?? PDFNull);
    }
    if (!replace.size) return;
    const swap = (value: unknown) => (value instanceof PDFRef ? replace.get(value.toString()) : undefined);
    for (const [, obj] of context.enumerateIndirectObjects()) {
        const stack: unknown[] = [obj instanceof PDFStream ? obj.dict : obj];
        while (stack.length) {
            const current = stack.pop();
            if (current instanceof PDFDict) {
                for (const [key, value] of current.entries()) {
                    const next = swap(value);
                    if (next) current.set(key, next);
                    else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
                }
            } else if (current instanceof PDFArray) {
                for (let i = 0; i < current.size(); i++) {
                    const value = current.get(i);
                    const next = swap(value);
                    if (next) current.set(i, next);
                    else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
                }
            }
        }
    }
};

/** pdf-lib writes every object it holds, even unreferenced ones: drop what no page or catalog entry can reach. */
const dropUnreachableObjects = (doc: PDFDocument) => {
    const context = doc.context;
    const seen = new Set<string>();
    const stack: unknown[] = [context.trailerInfo.Root, context.trailerInfo.Info];
    while (stack.length) {
        const obj = stack.pop();
        if (obj instanceof PDFRef) {
            if (seen.has(obj.toString())) continue;
            seen.add(obj.toString());
            stack.push(context.lookup(obj));
        } else if (obj instanceof PDFDict) {
            for (const [, value] of obj.entries()) stack.push(value);
        } else if (obj instanceof PDFArray) {
            stack.push(...obj.asArray());
        } else if (obj instanceof PDFStream) {
            stack.push(obj.dict);
        }
    }
    for (const [ref] of context.enumerateIndirectObjects()) {
        if (!seen.has(ref.toString())) context.delete(ref);
    }
};

const canvasToBytes = async (canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number) => {
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), type, quality));
    return new Uint8Array(await blob.arrayBuffer());
};

const buildCensoredPdf = async (file: File, boxes: Box[], onProgress: (done: number, total: number) => void) => {
    const src = await loadPdfForEditing(file, { updateMetadata: false });
    const total = src.getPageCount();
    const censored = Array.from(new Set(boxes.map((b) => b.page))).sort((a, b) => a - b);
    const censoredSet = new Set(censored);

    // Empty the censored pages in the source first, so nothing that gets copied can drag their content along.
    for (const n of censored) {
        const leaf = src.getPage(n - 1).node;
        for (const key of leaf.keys()) if (!KEEP_ON_CENSORED_PAGE.has(key.asString())) leaf.delete(key);
        leaf.set(PDFName.of("Resources"), src.context.obj({}));
        leaf.set(CENSORED_MARK, PDFNumber.of(n - 1));
    }

    const out = await PDFDocument.create();
    const keptIndexes = Array.from({ length: total }, (_, i) => i).filter((i) => !censoredSet.has(i + 1));
    const copied = await out.copyPages(src, keptIndexes);
    const copiedByIndex = new Map(keptIndexes.map((index, k) => [index, copied[k]]));
    const rasterByIndex = new Map<number, PDFRef>();

    const pdfjs = await getPdfjs();
    const jsDoc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
        let done = 0;
        for (let i = 0; i < total; i++) {
            const kept = copiedByIndex.get(i);
            if (kept) {
                out.addPage(kept);
                // Form widgets keep their look but lose the link to their field (other fields could sit on censored pages).
                for (const annot of kept.node.Annots()?.asArray() ?? []) {
                    const dict = out.context.lookup(annot);
                    if (dict instanceof PDFDict && dict.get(PDFName.of("Subtype")) === PDFName.of("Widget")) dict.delete(PDFName.of("Parent"));
                }
                pruneUnusedXObjects(out, kept);
                continue;
            }
            onProgress(done + 1, censored.length);
            const page = await jsDoc.getPage(i + 1);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(RASTER_DPI / 72, MAX_RASTER_SIDE / Math.max(base.width, base.height));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext("2d", { alpha: false });
            if (!ctx) throw new Error("Canvas no disponible.");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, canvasContext: ctx, viewport }).promise;
            page.cleanup();
            ctx.fillStyle = "#000000";
            for (const b of boxes) {
                if (b.page !== i + 1) continue;
                // One extra pixel on every side so anti-aliased edges can't leave a readable fringe.
                const x0 = Math.floor(b.x * canvas.width) - 1;
                const y0 = Math.floor(b.y * canvas.height) - 1;
                const x1 = Math.ceil((b.x + b.w) * canvas.width) + 1;
                const y1 = Math.ceil((b.y + b.h) * canvas.height) + 1;
                ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            }
            let bytes = await canvasToBytes(canvas, "image/png");
            let isPng = true;
            if (bytes.length > 1_500_000) {
                // Photos and scans compress far better as JPEG.
                const jpg = await canvasToBytes(canvas, "image/jpeg", 0.92);
                if (jpg.length < bytes.length) {
                    bytes = jpg;
                    isPng = false;
                }
            }
            canvas.width = canvas.height = 0;
            const image = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
            const newPage = out.addPage([base.width, base.height]);
            newPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
            rasterByIndex.set(i, newPage.ref);
            done++;
        }
    } finally {
        await jsDoc.destroy();
    }

    remapStrayPages(out, rasterByIndex);
    dropUnreachableObjects(out);
    const bytes = await out.save();

    // Check the result before offering it: same page count, and no text at all left on the censored pages.
    const check = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    try {
        if (check.numPages !== total) throw new UserFacingError("No se pudo generar el PDF censurado. Inténtalo de nuevo.");
        for (const n of censored) {
            const content = await (await check.getPage(n)).getTextContent();
            if (content.items.some((item) => ((item as { str?: string }).str ?? "").trim())) {
                throw new UserFacingError("No se pudo comprobar que la censura sea completa, así que no se ha generado el archivo.");
            }
        }
    } finally {
        await check.destroy();
    }
    return { bytes, censored };
};

// ---------------------------------------------------------------------------------------------------------------

export const RedactScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [{ boxes, past }, dispatch] = useReducer(editorReducer, { boxes: [], past: [] });
    const [activePage, setActivePage] = useState(1);
    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [preview, setPreview] = useState<PagePreview | null>(null);
    const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [censoredPages, setCensoredPages] = useState<number[]>([]);
    const [touchMode, setTouchMode] = useState<"scroll" | "mark">("scroll");
    const coarse = useCoarsePointer();
    const surfaceRef = useRef<HTMLDivElement>(null);

    const reset = () => {
        baseReset();
        dispatch({ type: "reset" });
        setActivePage(1);
        setPreview(null);
        setConfirmOpen(false);
        setCensoredPages([]);
    };

    const handleFile = async (files: FileList) => {
        setError(null);
        const file = files[0];
        if (!file) return;
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            dispatch({ type: "reset" });
            setPreview(null);
            setActivePage(1);
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            setError(friendlyError(err, "No se pudo leer el PDF."));
        }
    };

    // One pdf.js document per input.
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
            if (alive) setError(friendlyError(err, "No se pudo mostrar la página."));
        });
        return () => {
            alive = false;
            setPdfDoc(null);
            void loaded?.destroy();
        };
    }, [input, setError]);

    // Render the active page.
    useEffect(() => {
        if (!pdfDoc) return;
        let alive = true;
        let cancel: (() => void) | null = null;
        (async () => {
            const page = await pdfDoc.getPage(activePage);
            const base = page.getViewport({ scale: 1 });
            const scale = (900 * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
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
            if (alive) setPreview({ url: URL.createObjectURL(blob), width: base.width, height: base.height });
        })().catch((err) => {
            if (alive && (err as { name?: string })?.name !== "RenderingCancelledException") setError(friendlyError(err, "No se pudo mostrar la página."));
        });
        return () => {
            alive = false;
            cancel?.();
        };
    }, [pdfDoc, activePage, setError]);

    useEffect(() => () => void (preview && URL.revokeObjectURL(preview.url)), [preview]);

    // Ctrl+Z / Cmd+Z undoes the last change while the editor is open.
    useEffect(() => {
        if (!input || result || confirmOpen) return;
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
                event.preventDefault();
                dispatch({ type: "undo" });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [input, result, confirmOpen]);

    const toFraction = (event: ReactPointerEvent) => {
        const rect = surfaceRef.current!.getBoundingClientRect();
        return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0 || !preview) return;
        if (event.pointerType === "touch" && touchMode === "scroll") return;
        if ((event.target as HTMLElement).closest("[data-redact-remove]")) return;
        event.preventDefault();
        surfaceRef.current?.setPointerCapture(event.pointerId);
        const p = toFraction(event);
        setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!draft) return;
        const p = toFraction(event);
        setDraft((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
    };
    const onPointerUp = () => {
        if (!draft) return;
        const rect = surfaceRef.current!.getBoundingClientRect();
        const x = Math.min(draft.x0, draft.x1);
        const y = Math.min(draft.y0, draft.y1);
        const w = Math.abs(draft.x1 - draft.x0);
        const h = Math.abs(draft.y1 - draft.y0);
        if (w * rect.width >= 4 && h * rect.height >= 4) dispatch({ type: "add", box: { id: newId(), page: activePage, x, y, w, h } });
        setDraft(null);
    };

    const apply = async () => {
        if (!input || isBusy || boxes.length === 0) return;
        setBusy(true);
        setError(null);
        setProgress(null);
        try {
            const { bytes, censored } = await buildCensoredPdf(input.file, boxes, (done, total) => setProgress({ done, total }));
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            setCensoredPages(censored);
            setConfirmOpen(false);
            setResult({
                blob,
                filename: datedFilename(`${base}-censurado`, "pdf"),
                summary: `${plural(boxes.length, "área censurada", "áreas censuradas")} en ${pagesLabel(censored.length)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            console.error(err);
            setConfirmOpen(false);
            setError(friendlyError(err, "No se pudo censurar el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
            setProgress(null);
        }
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} title="¡PDF censurado!" />
                <Notice tone="info">
                    {censoredPages.length === 1 ? `La página ${censoredPages[0]} se ha guardado` : `Las páginas ${joinList(censoredPages)} se han guardado`} como
                    imagen: lo que tapaste ya no existe en el archivo. Revisa el PDF antes de compartirlo.
                </Notice>
            </ToolPageLayout>
        );
    }

    const pageBoxes = boxes.filter((b) => b.page === activePage);
    const pagesWithBoxes = Array.from(new Set(boxes.map((b) => b.page))).sort((a, b) => a - b);
    const ratio = preview ? preview.width / preview.height : 612 / 792;
    const drawing = !coarse || touchMode === "mark";

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint="Suelta el PDF que quieres censurar." onDropFiles={handleFile} />}

            <ErrorBanner message={error} />
            {error === PROTECTED_PDF_MESSAGE && (
                <div>
                    <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight}>
                        Ir a Desproteger PDF
                    </Button>
                </div>
            )}

            {input && (
                <div className="flex flex-col gap-4 rounded-2xl bg-primary p-4 ring-1 ring-secondary ring-inset sm:p-5">
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

                    <Notice tone="info" title="Las páginas que censures se guardan como imagen">
                        Así lo tapado desaparece de verdad del archivo, pero el resto del texto de esas páginas ya no se podrá seleccionar ni buscar. Las demás
                        páginas no cambian.
                    </Notice>

                    {coarse && (
                        <AriaRadioGroup
                            aria-label="Qué hace el dedo sobre la página"
                            value={touchMode}
                            onChange={(value) => setTouchMode(value as "scroll" | "mark")}
                            orientation="horizontal"
                            className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1 ring-1 ring-secondary ring-inset"
                        >
                            {(
                                [
                                    { id: "scroll", label: "Desplazar", icon: Hand },
                                    { id: "mark", label: "Marcar áreas", icon: CursorBox },
                                ] as const
                            ).map(({ id, label, icon: Icon }) => (
                                <AriaRadio
                                    key={id}
                                    value={id}
                                    className={({ isSelected, isFocusVisible }) =>
                                        cx(
                                            "flex cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold outline-focus-ring transition duration-100 ease-linear",
                                            isSelected ? "bg-primary text-primary shadow-sm ring-1 ring-secondary" : "text-tertiary",
                                            isFocusVisible && "outline-2 outline-offset-2",
                                        )
                                    }
                                >
                                    <Icon aria-hidden="true" className="size-4" />
                                    {label}
                                </AriaRadio>
                            ))}
                        </AriaRadioGroup>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-tertiary">
                            {drawing ? "Arrastra sobre el texto o la imagen que quieras tapar." : "Elige «Marcar áreas» y arrastra el dedo sobre lo que quieras tapar."}
                        </p>
                        <div className="flex items-center gap-1">
                            <Button
                                color="tertiary"
                                size="sm"
                                iconLeading={Maximize01}
                                onClick={() => dispatch({ type: "add", box: { id: newId(), page: activePage, x: 0, y: 0, w: 1, h: 1 } })}
                            >
                                Tapar página entera
                            </Button>
                            <Button color="tertiary" size="sm" iconLeading={Trash01} isDisabled={boxes.length === 0} onClick={() => dispatch({ type: "clear" })}>
                                Quitar todas
                            </Button>
                        </div>
                    </div>

                    <div className="mx-auto w-full max-w-[820px]">
                        <div
                            ref={surfaceRef}
                            data-editor-canvas
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                            onPointerCancel={() => setDraft(null)}
                            className={cx("relative w-full overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-secondary select-none", drawing && "cursor-crosshair")}
                            style={{ aspectRatio: `${ratio}`, touchAction: coarse && touchMode === "scroll" ? "pan-x pan-y pinch-zoom" : "none" }}
                        >
                            {preview ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={preview.url} alt={`Página ${activePage}`} className="pointer-events-none absolute inset-0 size-full" draggable={false} />
                            ) : (
                                <div className="absolute inset-0 animate-pulse bg-secondary" />
                            )}
                            {pageBoxes.map((b, index) => (
                                <div
                                    key={b.id}
                                    data-redact-box
                                    className="group absolute bg-black outline-focus-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2"
                                    style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                                >
                                    <button
                                        type="button"
                                        data-redact-remove
                                        aria-label={`Quitar el área ${index + 1} de la página ${activePage}`}
                                        onClick={() => dispatch({ type: "remove", id: b.id })}
                                        onKeyDown={(event) => {
                                            if (event.key === "Delete" || event.key === "Backspace") {
                                                event.preventDefault();
                                                dispatch({ type: "remove", id: b.id });
                                            }
                                        }}
                                        className={cx(
                                            "absolute z-10 flex size-7 cursor-pointer items-center justify-center rounded-full bg-error-solid text-white shadow-md ring-2 ring-white outline-hidden transition duration-100 ease-linear pointer-fine:size-6 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100",
                                            b.x + b.w > 0.96 ? "right-1" : "-right-3",
                                            b.y < 0.03 ? "top-1" : "-top-3",
                                        )}
                                    >
                                        <XClose aria-hidden="true" className="size-4" />
                                    </button>
                                </div>
                            ))}
                            {draft && (
                                <div
                                    className="pointer-events-none absolute border-2 border-dashed border-fg-error-primary bg-black/40"
                                    style={{
                                        left: `${Math.min(draft.x0, draft.x1) * 100}%`,
                                        top: `${Math.min(draft.y0, draft.y1) * 100}%`,
                                        width: `${Math.abs(draft.x1 - draft.x0) * 100}%`,
                                        height: `${Math.abs(draft.y1 - draft.y0) * 100}%`,
                                    }}
                                />
                            )}
                        </div>
                    </div>

                    {input.pageCount > 1 && (
                        <div className="flex flex-col items-center gap-2">
                            <div className="flex items-center gap-1">
                                <ButtonUtility
                                    color="tertiary"
                                    size="sm"
                                    icon={ChevronLeft}
                                    tooltip="Página anterior"
                                    isDisabled={activePage <= 1}
                                    onClick={() => setActivePage((n) => Math.max(1, n - 1))}
                                />
                                <span className="min-w-28 text-center text-sm font-medium text-secondary" aria-live="polite">
                                    Página {activePage} de {input.pageCount}
                                </span>
                                <ButtonUtility
                                    color="tertiary"
                                    size="sm"
                                    icon={ChevronRight}
                                    tooltip="Página siguiente"
                                    isDisabled={activePage >= input.pageCount}
                                    onClick={() => setActivePage((n) => Math.min(input.pageCount, n + 1))}
                                />
                            </div>
                            {pagesWithBoxes.length > 0 && (
                                <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-tertiary">
                                    <span>Con áreas:</span>
                                    {pagesWithBoxes.map((n) => (
                                        <button
                                            key={n}
                                            type="button"
                                            onClick={() => setActivePage(n)}
                                            aria-current={n === activePage ? "page" : undefined}
                                            className={cx(
                                                "rounded-md px-2 py-0.5 text-sm font-medium ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset focus-visible:outline-2 focus-visible:outline-offset-2",
                                                n === activePage ? "bg-brand-primary_alt text-brand-secondary ring-brand" : "bg-primary text-secondary ring-secondary hover:bg-primary_hover",
                                            )}
                                        >
                                            pág. {n} ({boxes.filter((b) => b.page === n).length})
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex items-center justify-between gap-3 rounded-b-2xl border-t border-secondary bg-primary/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-5 sm:-mb-5 sm:px-5">
                        <div className="flex min-w-0 items-center gap-2">
                            <ButtonUtility
                                color="secondary"
                                size="sm"
                                icon={FlipBackward}
                                tooltip="Deshacer (Ctrl+Z)"
                                isDisabled={past.length === 0}
                                onClick={() => dispatch({ type: "undo" })}
                            />
                            <p className="truncate text-sm text-tertiary" aria-live="polite">
                                {boxes.length === 0
                                    ? "Ninguna área marcada"
                                    : `${plural(boxes.length, "área", "áreas")}${pagesWithBoxes.length > 1 ? ` en ${pagesLabel(pagesWithBoxes.length)}` : ""}`}
                            </p>
                        </div>
                        <Button color="primary" size="lg" iconLeading={FileShield02} isDisabled={boxes.length === 0} onClick={() => setConfirmOpen(true)} className="shrink-0">
                            Censurar
                        </Button>
                    </div>
                </div>
            )}

            <AriaModalOverlay
                isOpen={confirmOpen}
                onOpenChange={(open) => {
                    if (!isBusy) setConfirmOpen(open);
                }}
                isDismissable={!isBusy}
                isKeyboardDismissDisabled={isBusy}
                className={({ isEntering, isExiting }) =>
                    cx(
                        "fixed inset-0 z-50 flex min-h-dvh items-end justify-center overflow-y-auto bg-overlay/70 p-4 backdrop-blur-sm sm:items-center",
                        isEntering && "duration-150 ease-out animate-in fade-in",
                        isExiting && "duration-100 ease-in animate-out fade-out",
                    )
                }
            >
                <AriaModal className="w-full max-w-md">
                    <AriaDialog className="flex flex-col gap-5 rounded-2xl bg-primary p-5 shadow-xl ring-1 ring-secondary outline-hidden sm:p-6">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                            <FeaturedIcon icon={AlertTriangle} color="error" theme="light" size="md" className="shrink-0" />
                            <div className="flex flex-col gap-1.5">
                                <AriaHeading slot="title" className="text-lg font-semibold text-primary">
                                    ¿Aplicar la censura?
                                </AriaHeading>
                                <p className="text-sm text-tertiary">
                                    Se {boxes.length === 1 ? "tapará" : "taparán"} {plural(boxes.length, "área", "áreas")} en{" "}
                                    {pagesWithBoxes.length === 1
                                        ? `la página ${pagesWithBoxes[0]}, que se guardará como imagen`
                                        : `las páginas ${joinList(pagesWithBoxes)}, que se guardarán como imagen`}
                                    . Lo tapado no se podrá recuperar del nuevo PDF. Tu archivo original no se modifica.
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                            <Button color="secondary" size="lg" isDisabled={isBusy} onClick={() => setConfirmOpen(false)}>
                                Cancelar
                            </Button>
                            <Button color="primary-destructive" size="lg" iconLeading={FileShield02} isLoading={isBusy} showTextWhileLoading onClick={apply}>
                                {isBusy ? (progress ? `Censurando página ${progress.done} de ${progress.total}…` : "Censurando…") : "Sí, censurar"}
                            </Button>
                        </div>
                    </AriaDialog>
                </AriaModal>
            </AriaModalOverlay>
        </ToolPageLayout>
    );
};
