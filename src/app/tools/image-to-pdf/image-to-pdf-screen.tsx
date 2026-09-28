"use client";

import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, FilePlus02, Plus, Trash01 } from "@untitledui/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PDFDocument, type PDFImage, degrees } from "pdf-lib";
import { Label as AriaLabel, Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ErrorBanner, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { UserFacingError, datedFilename, friendlyError, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type ImageKind = "png" | "jpeg" | "other";

type QueuedImage = {
    id: string;
    file: File;
    previewUrl: string;
    status: "checking" | "ready" | "error";
    /** Upright size in pixels, with the EXIF orientation applied (0 until checked). */
    width: number;
    height: number;
    /** Real format, from the file's first bytes (the extension can lie). */
    kind: ImageKind;
    /** EXIF orientation 1-8 (JPEG only). */
    orientation: number;
};

type FitMode = "fit" | "fill";
type PageSize = "a4" | "letter" | "image";
type Progress = { label: string; pct: number | null };

const TITLE = "Imagen a PDF";
const DESCRIPTION = "Crea un PDF a partir de imágenes JPG o PNG.";
const ACCEPT = "image/jpeg,image/png,.jpg,.jpeg,.png";
const PAGE_SIZES = { a4: { width: 595.28, height: 841.89 }, letter: { width: 612, height: 792 } } as const;
/** Blank border around the image with "Ajustar", in points. */
const MARGIN = 24;
/** "Tamaño original": 1 px = 1/96 in, as on screen. */
const PX_TO_PT = 0.75;
const MAX_PAGE = 14400;
const UNDO_MS = 8000;
/** Rotation (counter-clockwise, degrees) that makes a JPEG upright for EXIF orientations without mirroring. */
const EXIF_ROTATION: Record<number, number> = { 1: 0, 3: 180, 6: -90, 8: 90 };
const PAGE_SIZE_HINT: Record<PageSize, string> = {
    a4: "21 × 29,7 cm, en vertical u horizontal según cada imagen.",
    letter: "21,6 × 27,9 cm, en vertical u horizontal según cada imagen.",
    image: "Cada página mide lo mismo que su imagen, sin márgenes.",
};

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const percent = (value: number) => `${Math.round(value)} %`;
const imagesLabel = (count: number) => plural(count, "imagen", "imágenes");
const isAcceptedImage = (file: File) => /^image\/(png|jpeg)$/i.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);

const sniffKind = (head: Uint8Array): ImageKind => {
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
    return "other";
};

/** EXIF orientation (1-8) of a JPEG, read from its first bytes; 1 when there is none. */
const jpegOrientation = (bytes: Uint8Array): number => {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 2;
        while (offset + 4 <= bytes.length) {
            if (view.getUint8(offset) !== 0xff) return 1;
            const marker = view.getUint8(offset + 1);
            if (marker === 0xff) {
                offset += 1;
                continue;
            }
            if (marker === 0xda || marker === 0xd9) return 1;
            const length = view.getUint16(offset + 2);
            if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966) {
                const tiff = offset + 10;
                const little = view.getUint16(tiff) === 0x4949;
                const ifd = tiff + view.getUint32(tiff + 4, little);
                const entries = view.getUint16(ifd, little);
                for (let i = 0; i < entries; i++) {
                    const entry = ifd + 2 + i * 12;
                    if (view.getUint16(entry, little) === 0x0112) {
                        const value = view.getUint16(entry + 8, little);
                        return value >= 1 && value <= 8 ? value : 1;
                    }
                }
                return 1;
            }
            offset += 2 + length;
        }
    } catch {
        // Truncated or malformed header: treat as upright.
    }
    return 1;
};

/** Checks that the browser can decode the image, and reads its real format, orientation and upright size. */
const inspectImage = async (file: File) => {
    const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
    const kind = sniffKind(head);
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    bitmap.close();
    if (!width || !height) throw new Error("empty image");
    return { kind, orientation: kind === "jpeg" ? jpegOrientation(head) : 1, width, height };
};

/** Re-encodes the image upright through a canvas (mirrored EXIF orientations, odd PNGs, misnamed formats). */
const redraw = async (file: File, type: "image/png" | "image/jpeg") => {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    if (type === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), type, 0.92));
    canvas.width = 0;
    canvas.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
};

/** Embeds the original bytes whenever possible (no quality loss); `rotation` turns EXIF-rotated photos upright. */
const embedImage = async (doc: PDFDocument, item: QueuedImage): Promise<{ image: PDFImage; rotation: number }> => {
    if (item.kind === "jpeg" && item.orientation in EXIF_ROTATION) {
        try {
            return { image: await doc.embedJpg(new Uint8Array(await item.file.arrayBuffer())), rotation: EXIF_ROTATION[item.orientation] };
        } catch {
            // Fall back to re-encoding below.
        }
    }
    if (item.kind === "png") {
        try {
            return { image: await doc.embedPng(new Uint8Array(await item.file.arrayBuffer())), rotation: 0 };
        } catch {
            // Fall back to re-encoding below.
        }
    }
    if (item.kind === "jpeg") return { image: await doc.embedJpg(await redraw(item.file, "image/jpeg")), rotation: 0 };
    return { image: await doc.embedPng(await redraw(item.file, "image/png")), rotation: 0 };
};

/** Page size in points for an upright image of `width` × `height` px. */
const pageFor = (width: number, height: number, pageSize: PageSize) => {
    if (pageSize === "image") {
        const scale = Math.min(PX_TO_PT, MAX_PAGE / Math.max(width, height));
        return { width: Math.max(3, width * scale), height: Math.max(3, height * scale) };
    }
    const size = PAGE_SIZES[pageSize];
    return width > height ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
};

export const ImageToPdfScreen = () => {
    const { isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState();
    const [items, setItems] = useState<QueuedImage[]>([]);
    const [pageSize, setPageSize] = useState<PageSize>("a4");
    const [fit, setFit] = useState<FitMode>("fit");
    const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
    const [overIdx, setOverIdx] = useState<number | null>(null);
    const [isFileOver, setFileOver] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const [undo, setUndo] = useState<{ message: string; items: QueuedImage[] } | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const runRef = useRef(0);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const undoRef = useRef(undo);
    undoRef.current = undo;
    /** Results of the checks, kept by id so an image restored with "Deshacer" doesn't lose them. */
    const checkedRef = useRef(new Map<string, Partial<QueuedImage>>());

    /** Frees the previews of images that were removed for good. */
    const releaseUnused = useCallback((candidates: QueuedImage[]) => {
        const alive = new Set(itemsRef.current.map((it) => it.id));
        candidates.forEach((it) => {
            if (!alive.has(it.id)) URL.revokeObjectURL(it.previewUrl);
        });
    }, []);

    const dismissUndo = useCallback(() => {
        const pending = undoRef.current;
        if (!pending) return;
        undoRef.current = null;
        setUndo(null);
        releaseUnused(pending.items);
    }, [releaseUnused]);

    useEffect(() => {
        if (!undo) return;
        const timer = setTimeout(dismissUndo, UNDO_MS);
        return () => clearTimeout(timer);
    }, [undo, dismissUndo]);

    useEffect(
        () => () => {
            runRef.current++;
            itemsRef.current.forEach((it) => URL.revokeObjectURL(it.previewUrl));
            undoRef.current?.items.forEach((it) => URL.revokeObjectURL(it.previewUrl));
        },
        [],
    );

    /** Removes images with a few seconds to take it back. */
    const removeWithUndo = (next: QueuedImage[], message: string) => {
        dismissUndo();
        const snapshot = itemsRef.current;
        runRef.current++;
        setBusy(false);
        setProgress(null);
        setError(null);
        setAddError(null);
        setItems(next);
        setUndo({ message, items: snapshot });
    };

    const restore = () => {
        const pending = undoRef.current;
        if (!pending) return;
        undoRef.current = null;
        setUndo(null);
        setItems(pending.items.map((it) => ({ ...it, ...checkedRef.current.get(it.id) })));
    };

    const reset = () => {
        runRef.current++;
        itemsRef.current.forEach((it) => URL.revokeObjectURL(it.previewUrl));
        undoRef.current?.items.forEach((it) => URL.revokeObjectURL(it.previewUrl));
        undoRef.current = null;
        setUndo(null);
        setItems([]);
        setAddError(null);
        setProgress(null);
        baseReset();
    };

    const checkImages = async (queue: QueuedImage[]) => {
        for (const item of queue) {
            let patch: Partial<QueuedImage>;
            try {
                patch = { status: "ready", ...(await inspectImage(item.file)) };
            } catch {
                patch = { status: "error" };
            }
            checkedRef.current.set(item.id, patch);
            setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...patch } : it)));
        }
    };

    const addFiles = (files: FileList | File[]) => {
        const list = Array.from(files);
        const accepted = list.filter(isAcceptedImage);
        const rejected = list.length - accepted.length;
        setAddError(
            rejected === 0
                ? null
                : rejected === 1
                  ? "Un archivo no es una imagen JPG o PNG y no se ha añadido."
                  : `${rejected} archivos no son imágenes JPG o PNG y no se han añadido.`,
        );
        if (!accepted.length) return;
        setError(null);
        const next: QueuedImage[] = accepted.map((file) => ({
            id: newId(),
            file,
            previewUrl: URL.createObjectURL(file),
            status: "checking",
            width: 0,
            height: 0,
            kind: "other",
            orientation: 1,
        }));
        setItems((prev) => [...prev, ...next]);
        void checkImages(next);
    };

    const removeItem = (id: string) => {
        const item = items.find((it) => it.id === id);
        if (!item) return;
        removeWithUndo(
            items.filter((it) => it.id !== id),
            `Has quitado «${item.file.name}».`,
        );
    };

    const clearAll = () => removeWithUndo([], `Has quitado ${imagesLabel(items.length)}.`);

    const moveTo = (from: number, to: number) => {
        if (from === to) return;
        setItems((prev) => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
    };

    const moveItem = (id: string, dir: -1 | 1) => {
        const idx = items.findIndex((it) => it.id === id);
        if (idx !== -1 && idx + dir >= 0 && idx + dir < items.length) moveTo(idx, idx + dir);
    };

    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

    const totalSize = useMemo(() => items.reduce((sum, it) => sum + it.file.size, 0), [items]);
    const checking = items.filter((it) => it.status === "checking").length;
    const broken = items.filter((it) => it.status === "error").length;

    const cancel = () => {
        runRef.current++;
        setBusy(false);
        setProgress(null);
    };

    const buildPdf = async () => {
        const list = items;
        if (list.length === 0 || list.some((it) => it.status !== "ready")) return;
        const run = ++runRef.current;
        const isCurrent = () => runRef.current === run;
        setError(null);
        setBusy(true);
        try {
            const doc = await PDFDocument.create();
            for (let i = 0; i < list.length; i++) {
                if (!isCurrent()) return;
                setProgress({
                    label: list.length > 1 ? `Añadiendo imagen ${i + 1} de ${list.length}…` : "Creando el PDF…",
                    pct: list.length > 1 ? Math.round((i / list.length) * 100) : null,
                });
                const item = list[i];
                let embedded: Awaited<ReturnType<typeof embedImage>>;
                try {
                    embedded = await embedImage(doc, item);
                } catch {
                    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: "error" } : it)));
                    checkedRef.current.set(item.id, { status: "error" });
                    throw new UserFacingError(`No se pudo procesar «${item.file.name}». Quítala o sustitúyela por otra imagen.`);
                }
                const { image, rotation } = embedded;
                const upright = rotation % 180 === 0 ? { width: image.width, height: image.height } : { width: image.height, height: image.width };
                const pageBox = pageFor(upright.width, upright.height, pageSize);
                const page = doc.addPage([pageBox.width, pageBox.height]);
                const margin = pageSize === "image" || fit === "fill" ? 0 : MARGIN;
                const ratioW = (pageBox.width - margin * 2) / upright.width;
                const ratioH = (pageBox.height - margin * 2) / upright.height;
                const ratio = fit === "fill" && pageSize !== "image" ? Math.max(ratioW, ratioH) : Math.min(ratioW, ratioH);
                const w = upright.width * ratio;
                const h = upright.height * ratio;
                const x = (pageBox.width - w) / 2;
                const y = (pageBox.height - h) / 2;
                // pdf-lib rotates around the image's own origin, so each turn starts from a different corner of the box.
                if (rotation === 0) page.drawImage(image, { x, y, width: w, height: h });
                else if (rotation === -90) page.drawImage(image, { x, y: y + h, width: h, height: w, rotate: degrees(-90) });
                else if (rotation === 90) page.drawImage(image, { x: x + w, y, width: h, height: w, rotate: degrees(90) });
                else page.drawImage(image, { x: x + w, y: y + h, width: w, height: h, rotate: degrees(180) });
            }
            if (!isCurrent()) return;
            setProgress({ label: "Guardando el PDF…", pct: list.length > 1 ? 100 : null });
            const bytes = await doc.save();
            if (!isCurrent()) return;
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const name = list.length === 1 ? list[0].file.name.replace(/\.[^.]+$/, "") : "imagenes";
            setResult({
                blob,
                filename: datedFilename(name, "pdf"),
                primaryLabel: "Descargar PDF",
                summary: `${pagesLabel(list.length)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            if (isCurrent()) setError(friendlyError(err, "No se pudieron procesar las imágenes. Inténtalo de nuevo."));
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
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} />
            </ToolPageLayout>
        );
    }

    const ctaBlocked = checking > 0 || broken > 0;
    // Mirrored EXIF photos and misnamed formats go through a canvas: only claim "máxima calidad" when nothing is re-encoded.
    const untouched = items.every((it) => it.kind === "png" || (it.kind === "jpeg" && it.orientation in EXIF_ROTATION));
    const footerNote =
        broken > 0 ? (
            <span className="font-medium text-error-primary">
                {broken === 1 ? "Quita la imagen marcada en rojo para continuar." : "Quita las imágenes marcadas en rojo para continuar."}
            </span>
        ) : checking > 0 ? (
            "Comprobando imágenes…"
        ) : (
            `${pagesLabel(items.length)} · ${readableBytes(totalSize)}${untouched ? " · las imágenes se conservan a máxima calidad." : ""}`
        );

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {items.length === 0 && (
                <>
                    <FileUploadDropZone
                        accept={ACCEPT}
                        allowsMultiple
                        hint="Arrastra tus imágenes JPG o PNG."
                        onDropFiles={addFiles}
                        // The drop zone explains the wrong format itself; only clear an older error.
                        onDropUnacceptedFiles={() => setError(null)}
                    />
                    <ErrorBanner message={error} />
                </>
            )}

            <AnimatePresence initial={false}>
                {undo && (
                    <motion.div
                        key="undo"
                        role="status"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="flex items-center justify-between gap-3 rounded-lg bg-secondary py-2 pr-2 pl-4 text-sm text-secondary ring-1 ring-secondary ring-inset"
                    >
                        <span className="min-w-0 truncate">{undo.message}</span>
                        <Button color="secondary" size="sm" onClick={restore}>
                            Deshacer
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>

            {items.length > 0 && (
                <div
                    onDragOver={(event) => {
                        if (!hasFiles(event) || isBusy) return;
                        event.preventDefault();
                        setFileOver(true);
                    }}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileOver(false);
                    }}
                    onDrop={(event) => {
                        if (!hasFiles(event) || isBusy) return;
                        event.preventDefault();
                        setFileOver(false);
                        addFiles(event.dataTransfer.files);
                    }}
                    className={cx(
                        "flex flex-col gap-6 rounded-2xl bg-primary p-5 ring-1 ring-secondary transition duration-100 ease-linear ring-inset md:p-6",
                        isFileOver && "bg-brand-primary_alt ring-2 ring-brand",
                    )}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="text-md font-semibold text-primary">Imágenes ({items.length})</h2>
                            <p className="text-sm text-tertiary">
                                {isFileOver ? (
                                    "Suelta para añadir las imágenes."
                                ) : (
                                    <>
                                        <span className="pointer-fine:hidden">Usa las flechas de cada imagen para cambiar el orden.</span>
                                        <span className="hidden pointer-fine:inline">Arrastra las imágenes o usa sus flechas para cambiar el orden.</span>
                                    </>
                                )}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <Button color="secondary" size="sm" iconLeading={Plus} isDisabled={isBusy} onClick={() => fileInputRef.current?.click()}>
                                Añadir
                            </Button>
                            <Button color="tertiary" size="sm" iconLeading={Trash01} isDisabled={isBusy} onClick={clearAll}>
                                Vaciar
                            </Button>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={ACCEPT}
                            multiple
                            tabIndex={-1}
                            aria-hidden="true"
                            className="sr-only"
                            onChange={(event) => {
                                if (event.target.files) addFiles(event.target.files);
                                event.target.value = "";
                            }}
                        />
                    </div>

                    {addError && <ErrorBanner message={addError} />}

                    <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
                        <AnimatePresence initial={false}>
                            {items.map((item, idx) => {
                                const page = pageFor(item.width || 210, item.height || 297, pageSize);
                                const padding = pageSize !== "image" && fit === "fit" ? `${(MARGIN / page.width) * 100}%` : 0;
                                const isBroken = item.status === "error";
                                return (
                                    <motion.li
                                        key={item.id}
                                        layout="position"
                                        initial={{ opacity: 0, scale: 0.96 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.96 }}
                                        data-img-slot={idx}
                                        draggable={!isBusy}
                                        onDragStart={(e) => {
                                            // Native HTML drag: motion forwards onDrag* to the DOM on `draggable` elements,
                                            // but types them as its own pan gesture.
                                            const { dataTransfer } = e as unknown as React.DragEvent;
                                            setDragFromIdx(idx);
                                            dataTransfer.effectAllowed = "move";
                                            dataTransfer.setData("text/plain", String(idx));
                                        }}
                                        onDragEnter={() => setOverIdx(idx)}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDragLeave={() => setOverIdx((cur) => (cur === idx ? null : cur))}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            if (dragFromIdx !== null) moveTo(dragFromIdx, idx);
                                            setDragFromIdx(null);
                                            setOverIdx(null);
                                        }}
                                        onDragEnd={() => {
                                            setDragFromIdx(null);
                                            setOverIdx(null);
                                        }}
                                        className={cx("group flex min-w-0 flex-col gap-2", !isBusy && "cursor-grab active:cursor-grabbing")}
                                    >
                                        <div
                                            className={cx(
                                                "flex w-full flex-col gap-2 rounded-xl bg-secondary p-2 ring-1 ring-secondary transition duration-100 ease-linear ring-inset",
                                                dragFromIdx === idx && "opacity-30",
                                                overIdx === idx && dragFromIdx !== null && dragFromIdx !== idx && "ring-2 ring-brand",
                                                isBroken && "bg-error-primary ring-2 ring-error",
                                            )}
                                        >
                                            <div className="flex h-8 shrink-0 items-start justify-between gap-1">
                                                <span className="mt-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-secondary shadow-xs ring-1 ring-primary ring-inset">
                                                    {idx + 1}
                                                </span>
                                                <div
                                                    className={cx(
                                                        "flex gap-0.5 rounded-lg bg-primary p-0.5 shadow-xs ring-1 ring-secondary transition duration-100 ease-linear",
                                                        // Always visible on touch screens; on desktop it appears on hover or keyboard focus.
                                                        !isBroken &&
                                                            "md:pointer-fine:opacity-0 md:pointer-fine:group-focus-within:opacity-100 md:pointer-fine:group-hover:opacity-100",
                                                    )}
                                                >
                                                    {!isBroken && (
                                                        <>
                                                            <ButtonUtility
                                                                color="tertiary"
                                                                size="sm"
                                                                tooltip="Mover antes"
                                                                icon={ArrowLeft}
                                                                className="text-fg-tertiary hover:text-fg-secondary"
                                                                isDisabled={isBusy || idx === 0}
                                                                onClick={() => moveItem(item.id, -1)}
                                                            />
                                                            <ButtonUtility
                                                                color="tertiary"
                                                                size="sm"
                                                                tooltip="Mover después"
                                                                icon={ArrowRight}
                                                                className="text-fg-tertiary hover:text-fg-secondary"
                                                                isDisabled={isBusy || idx === items.length - 1}
                                                                onClick={() => moveItem(item.id, 1)}
                                                            />
                                                        </>
                                                    )}
                                                    <ButtonUtility
                                                        color="tertiary"
                                                        size="sm"
                                                        tooltip="Quitar"
                                                        icon={Trash01}
                                                        className="text-fg-tertiary hover:text-fg-error-secondary"
                                                        isDisabled={isBusy}
                                                        onClick={() => removeItem(item.id)}
                                                    />
                                                </div>
                                            </div>
                                            {/* The page keeps its real proportions inside a square, so even a 6:1 banner stays visible. */}
                                            <div className="flex aspect-square w-full items-center justify-center">
                                                {isBroken ? (
                                                    <div className="flex flex-col items-center gap-2 px-2 text-center">
                                                        <AlertCircle aria-hidden="true" className="size-5 text-fg-error-secondary" />
                                                        <p className="text-sm font-medium text-error-primary">No se puede leer esta imagen</p>
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="relative overflow-hidden bg-white shadow-xs ring-1 ring-secondary"
                                                        style={{
                                                            aspectRatio: `${page.width} / ${page.height}`,
                                                            ...(page.width >= page.height ? { width: "100%" } : { height: "100%" }),
                                                        }}
                                                    >
                                                        <div className="absolute inset-0" style={{ padding }}>
                                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                                            <img
                                                                src={item.previewUrl}
                                                                alt=""
                                                                draggable={false}
                                                                className={cx(
                                                                    "size-full",
                                                                    pageSize === "image" ? "object-fill" : fit === "fill" ? "object-cover" : "object-contain",
                                                                    item.status === "checking" && "opacity-40",
                                                                )}
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="min-w-0 px-0.5">
                                            <p className="truncate text-sm font-medium text-secondary" title={item.file.name}>
                                                {item.file.name}
                                            </p>
                                            <p className={cx("text-xs text-tertiary", isBroken && "text-error-primary")}>
                                                {isBroken
                                                    ? "Archivo dañado o no compatible"
                                                    : item.status === "checking"
                                                      ? "Comprobando…"
                                                      : `${item.width} × ${item.height} px · ${readableBytes(item.file.size)}`}
                                            </p>
                                        </div>
                                    </motion.li>
                                );
                            })}
                        </AnimatePresence>
                    </ul>

                    <div className="grid grid-cols-1 gap-6 border-t border-secondary pt-5 md:grid-cols-2">
                        <AriaRadioGroup
                            value={pageSize}
                            onChange={(value) => setPageSize(value as PageSize)}
                            orientation="horizontal"
                            isDisabled={isBusy}
                            className="flex flex-col gap-3"
                        >
                            <AriaLabel className="text-sm font-medium text-secondary">Tamaño de página</AriaLabel>
                            <div className="flex flex-wrap gap-2">
                                <OptionChip value="a4">A4</OptionChip>
                                <OptionChip value="letter">Carta</OptionChip>
                                <OptionChip value="image">Tamaño original</OptionChip>
                            </div>
                            <p className="text-sm text-tertiary">{PAGE_SIZE_HINT[pageSize]}</p>
                        </AriaRadioGroup>
                        {pageSize !== "image" ? (
                            <AriaRadioGroup
                                value={fit}
                                onChange={(value) => setFit(value as FitMode)}
                                orientation="horizontal"
                                isDisabled={isBusy}
                                className="flex flex-col gap-3"
                            >
                                <AriaLabel className="text-sm font-medium text-secondary">Ajuste de la imagen</AriaLabel>
                                <div className="flex flex-wrap gap-2">
                                    <OptionChip value="fit">Ajustar</OptionChip>
                                    <OptionChip value="fill">Llenar la página</OptionChip>
                                </div>
                                <p className="text-sm text-tertiary">
                                    {fit === "fit" ? "La imagen entera, con un margen blanco." : "Sin márgenes: los bordes de la imagen pueden recortarse."}
                                </p>
                            </AriaRadioGroup>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm font-medium text-secondary">Ajuste de la imagen</p>
                                <p className="text-sm text-tertiary">No hace falta con «Tamaño original»: la imagen ocupa toda la página, sin recortes.</p>
                            </div>
                        )}
                    </div>

                    {progress && <ProgressBar label={progress.label} pct={progress.pct} />}

                    <ErrorBanner message={error} />

                    <ActionBar summary={footerNote}>
                        {isBusy && (
                            <Button color="secondary" size="lg" className="w-full sm:w-auto" onClick={cancel}>
                                Cancelar
                            </Button>
                        )}
                        <Button
                            color="primary"
                            size="lg"
                            iconLeading={FilePlus02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!isBusy && ctaBlocked}
                            className="w-full sm:w-auto"
                            onClick={buildPdf}
                        >
                            {isBusy ? "Creando PDF…" : "Crear PDF"}
                        </Button>
                    </ActionBar>
                </div>
            )}
        </ToolPageLayout>
    );
};

/** Compact single-choice pill: a real radio (arrow keys move the choice) with a visible dot, not only a colour change. */
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
                <span
                    aria-hidden="true"
                    className={cx(
                        "flex size-4 shrink-0 items-center justify-center rounded-full bg-primary ring-1 ring-primary transition duration-100 ease-linear ring-inset",
                        isSelected && "bg-brand-solid ring-transparent",
                    )}
                >
                    <span className={cx("size-1.5 rounded-full bg-white", !isSelected && "opacity-0")} />
                </span>
                {children}
            </>
        )}
    </AriaRadio>
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
