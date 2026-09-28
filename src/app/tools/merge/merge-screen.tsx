"use client";

import type { DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, DotsGrid, File04, LayersThree01, Plus, Trash01, XCircle } from "@untitledui/icons";
import { Reorder, useDragControls } from "motion/react";
import { PDFDocument } from "pdf-lib";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { type PageThumbnail, renderPdfThumbnail } from "@/components/pdf-thumbnails";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, type ToolResult } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type QueuedFile = {
    id: string;
    file: File;
    status: "reading" | "ready" | "error";
    pageCount?: number;
    /** Short reason shown in the row when the file can't be used. */
    problem?: string;
    isProtected?: boolean;
    /** Preview of the first page, once rendered. */
    thumb?: PageThumbnail;
};

const TITLE = "Fusionar PDF";
const DESCRIPTION = "Combina varios PDFs en un solo archivo, en el orden que quieras.";

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

const hasFiles = (event: DragEvent | globalThis.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** Short text for the row; the full explanation goes in the summary below the list. */
const describeProblem = (error: unknown) => {
    const message = friendlyError(error, "No se pudo leer este PDF.");
    if (message === PROTECTED_PDF_MESSAGE) return { problem: "Protegido con contraseña", isProtected: true };
    if (/dañado/i.test(message)) return { problem: "Dañado o no es un PDF válido", isProtected: false };
    return { problem: message, isProtected: false };
};

export const MergeScreen = () => {
    const [items, setItems] = useState<QueuedFile[]>([]);
    const [isMerging, setIsMerging] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [result, setResult] = useState<ToolResult | null>(null);
    const [announcement, setAnnouncement] = useState("");
    const [isDropTarget, setIsDropTarget] = useState(false);

    const itemsRef = useRef(items);
    const addInputRef = useRef<HTMLInputElement>(null);
    const dropRef = useRef<HTMLDivElement>(null);
    const listCardRef = useRef<HTMLElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);
    const focusAfterRender = useRef<"dropzone" | "heading" | "action" | null>(null);
    /** Set by a keyboard move or a removal so the next render can announce it and keep focus in the list. */
    const lastChange = useRef<{ kind: "move"; id: string; focus?: "up" | "down" } | { kind: "remove"; index: number } | null>(null);

    useLayoutEffect(() => {
        itemsRef.current = items;
    });

    // Free the page previews when leaving the tool.
    useEffect(() => () => itemsRef.current.forEach((item) => item.thumb && URL.revokeObjectURL(item.thumb.url)), []);

    // With files in the list, a file dropped next to the card must not replace the page (and lose the list).
    useEffect(() => {
        const keepPage = (event: globalThis.DragEvent) => {
            if (hasFiles(event)) event.preventDefault();
        };
        window.addEventListener("dragover", keepPage);
        window.addEventListener("drop", keepPage);
        return () => {
            window.removeEventListener("dragover", keepPage);
            window.removeEventListener("drop", keepPage);
        };
    }, []);

    useEffect(() => {
        const target = focusAfterRender.current;
        if (!target) return;
        focusAfterRender.current = null;
        if (target === "dropzone") dropRef.current?.querySelector<HTMLElement>("[data-dropzone]")?.focus();
        if (target === "heading") headingRef.current?.focus();
        if (target === "action") listCardRef.current?.querySelector<HTMLElement>("[data-primary-action]")?.focus();
    }, [items.length, result]);

    useEffect(() => {
        if (result) resultRef.current?.focus();
    }, [result]);

    // Announce moves and removals, and keep keyboard focus on the row that moved or next to the one removed.
    useLayoutEffect(() => {
        const change = lastChange.current;
        if (!change) return;
        lastChange.current = null;
        const list = listCardRef.current;
        if (change.kind === "move") {
            const position = items.findIndex((item) => item.id === change.id);
            if (position < 0) return;
            setAnnouncement(`«${items[position].file.name}» ahora es el archivo ${position + 1} de ${items.length}.`);
            if (change.focus) {
                const row = list?.querySelector(`[data-id="${change.id}"]`);
                (
                    row?.querySelector<HTMLElement>(`[data-move="${change.focus}"]:not([disabled])`) ??
                    row?.querySelector<HTMLElement>("[data-move]:not([disabled])")
                )?.focus();
            }
        } else if (items.length) {
            const rows = list?.querySelectorAll<HTMLElement>("[data-remove]");
            rows?.[Math.min(change.index, rows.length - 1)]?.focus();
        }
    }, [items]);

    const updateItem = (id: string, patch: Partial<QueuedFile>) => setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));

    const addFiles = useCallback((list: FileList | File[]) => {
        const files = Array.from(list);
        const pdfs = files.filter(isPdf);
        const rejected = files.filter((file) => !isPdf(file));
        setError(null);
        setNotice(
            rejected.length === 0
                ? null
                : rejected.length === 1
                  ? `«${rejected[0].name}» no es un PDF, así que no se ha añadido.`
                  : `${rejected.length} archivos no son PDFs, así que no se han añadido.`,
        );
        if (!pdfs.length) return;

        const entries: QueuedFile[] = pdfs.map((file) => ({ id: newId(), file, status: "reading" }));
        if (!itemsRef.current.length) focusAfterRender.current = "heading";
        setItems((prev) => [...prev, ...entries]);
        setAnnouncement(`${plural(entries.length, "archivo añadido", "archivos añadidos")} a la lista.`);

        void (async () => {
            // Read every file first (page count, damaged or protected), then draw the first pages.
            const ready: QueuedFile[] = [];
            for (const entry of entries) {
                try {
                    const doc = await loadPdfForEditing(entry.file, { updateMetadata: false });
                    updateItem(entry.id, { status: "ready", pageCount: doc.getPageCount() });
                    ready.push(entry);
                } catch (err) {
                    updateItem(entry.id, { status: "error", ...describeProblem(err) });
                }
            }
            for (const entry of ready) {
                try {
                    const thumb = await renderPdfThumbnail(entry.file, { maxEdge: 56 });
                    if (!thumb) continue;
                    if (!itemsRef.current.some((item) => item.id === entry.id)) {
                        URL.revokeObjectURL(thumb.url);
                        continue;
                    }
                    updateItem(entry.id, { thumb });
                } catch {
                    // Without a preview the row keeps its file icon.
                }
            }
        })();
    }, []);

    const removeItem = (id: string) => {
        const index = itemsRef.current.findIndex((item) => item.id === id);
        const item = itemsRef.current[index];
        if (!item) return;
        if (item.thumb) URL.revokeObjectURL(item.thumb.url);
        if (itemsRef.current.length === 1) focusAfterRender.current = "dropzone";
        else lastChange.current = { kind: "remove", index };
        setItems((prev) => prev.filter((entry) => entry.id !== id));
        setNotice(null);
        setError(null);
        setAnnouncement(`«${item.file.name}» quitado de la lista.`);
    };

    const removeFailed = () => {
        const failed = itemsRef.current.filter((item) => item.status === "error");
        if (failed.length === itemsRef.current.length) focusAfterRender.current = "dropzone";
        else focusAfterRender.current = "action";
        setItems((prev) => prev.filter((item) => item.status !== "error"));
        setError(null);
        setAnnouncement(`${plural(failed.length, "archivo quitado", "archivos quitados")} de la lista.`);
    };

    const clearAll = () => {
        itemsRef.current.forEach((item) => item.thumb && URL.revokeObjectURL(item.thumb.url));
        focusAfterRender.current = "dropzone";
        setItems([]);
        setNotice(null);
        setError(null);
        setAnnouncement("Lista vaciada.");
    };

    const moveItem = (id: string, delta: -1 | 1) => {
        lastChange.current = { kind: "move", id, focus: delta < 0 ? "up" : "down" };
        setItems((prev) => {
            const from = prev.findIndex((item) => item.id === id);
            const to = from + delta;
            if (from < 0 || to < 0 || to >= prev.length) return prev;
            const next = prev.slice();
            [next[from], next[to]] = [next[to], next[from]];
            return next;
        });
    };

    const reorder = (ids: string[]) => setItems((prev) => ids.map((id) => prev.find((item) => item.id === id)).filter((item): item is QueuedFile => !!item));

    const reading = items.some((item) => item.status === "reading");
    const failed = items.filter((item) => item.status === "error");
    const totalPages = items.reduce((sum, item) => sum + (item.pageCount ?? 0), 0);
    const totalSize = items.reduce((sum, item) => sum + item.file.size, 0);
    const canMerge = items.length >= 2 && !reading && failed.length === 0;

    const handleMerge = async () => {
        if (!canMerge || isMerging) return;
        const list = items;
        setError(null);
        setIsMerging(true);
        try {
            const merged = await PDFDocument.create();
            for (let i = 0; i < list.length; i++) {
                setProgress({ done: i, total: list.length });
                const source = await loadPdfForEditing(list[i].file);
                const pages = await merged.copyPages(source, source.getPageIndices());
                pages.forEach((page) => merged.addPage(page));
            }
            const bytes = await merged.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            setResult({
                blob,
                filename: datedFilename(`${list[0].file.name.replace(/\.pdf$/i, "")}-fusionado`, "pdf"),
                summary: `${plural(list.length, "archivo", "archivos")} · ${pagesLabel(merged.getPageCount())} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            setError(friendlyError(err, "No se pudieron fusionar los PDFs. Inténtalo de nuevo."));
        } finally {
            setIsMerging(false);
            setProgress(null);
        }
    };

    const handleReset = () => {
        clearAll();
        setResult(null);
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <div ref={resultRef} tabIndex={-1} className="outline-none">
                    <SuccessPanel
                        title="¡PDF fusionado!"
                        result={result}
                        backLabel="Volver a la lista"
                        onBack={() => {
                            focusAfterRender.current = "action";
                            setResult(null);
                        }}
                        onReset={handleReset}
                    />
                </div>
            </ToolPageLayout>
        );
    }

    const summary: ReactNode = failed.length ? (
        <span className="text-error-primary">
            {failed.length === 1
                ? "Hay 1 archivo que no se puede usar: quítalo para continuar."
                : `Hay ${failed.length} archivos que no se pueden usar: quítalos para continuar.`}
            {failed.some((item) => item.isProtected) && (
                <>
                    {" "}
                    Si conoces la contraseña, quítala antes con{" "}
                    <Button href="/tools/unlock" color="link-color" size="sm">
                        Desproteger PDF
                    </Button>
                    .
                </>
            )}
        </span>
    ) : reading ? (
        "Leyendo los archivos…"
    ) : items.length < 2 ? (
        "Añade al menos otro PDF para poder unirlos."
    ) : (
        `El PDF final tendrá ${pagesLabel(totalPages)}.`
    );

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {items.length === 0 ? (
                <div ref={dropRef}>
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple
                        hint="Suelta aquí los PDFs que quieres unir."
                        onDropFiles={addFiles}
                        // The drop zone explains the rejected format itself; just clear an outdated message.
                        onDropUnacceptedFiles={() => setError(null)}
                    />
                </div>
            ) : (
                <section
                    ref={listCardRef}
                    aria-labelledby="merge-list-title"
                    onDragEnter={(event) => {
                        if (!hasFiles(event)) return;
                        event.preventDefault();
                        setIsDropTarget(true);
                    }}
                    onDragOver={(event) => {
                        if (!hasFiles(event)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                    }}
                    onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                        setIsDropTarget(false);
                    }}
                    onDrop={(event) => {
                        if (!hasFiles(event)) return;
                        event.preventDefault();
                        setIsDropTarget(false);
                        addFiles(event.dataTransfer.files);
                    }}
                    className={cx(
                        "relative flex flex-col gap-4 rounded-2xl bg-primary p-5 ring-1 ring-secondary transition duration-100 ease-linear ring-inset",
                        isDropTarget && "ring-2 ring-brand",
                    )}
                >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h2 id="merge-list-title" ref={headingRef} tabIndex={-1} className="text-md font-semibold text-primary outline-none">
                                {plural(items.length, "archivo", "archivos")}
                            </h2>
                            <p className="text-sm text-tertiary">
                                {pagesLabel(totalPages)} en total · {readableBytes(totalSize)}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                ref={addInputRef}
                                type="file"
                                accept="application/pdf,.pdf"
                                multiple
                                tabIndex={-1}
                                aria-hidden="true"
                                className="sr-only"
                                onChange={(event) => {
                                    if (event.target.files) addFiles(event.target.files);
                                    event.target.value = "";
                                }}
                            />
                            <Button color="secondary" size="sm" iconLeading={Plus} onClick={() => addInputRef.current?.click()}>
                                Añadir PDF
                            </Button>
                            <Button color="tertiary" size="sm" iconLeading={Trash01} onClick={clearAll}>
                                Quitar todos
                            </Button>
                        </div>
                    </div>

                    {notice && <Notice tone="warning">{notice}</Notice>}

                    {items.length > 1 && <p className="text-sm text-tertiary">Se unirán en este orden. Arrástralos o usa las flechas para cambiarlo.</p>}

                    <Reorder.Group as="ol" axis="y" values={items.map((item) => item.id)} onReorder={reorder} className="flex flex-col gap-2">
                        {items.map((item, index) => (
                            <MergeRow
                                key={item.id}
                                item={item}
                                index={index}
                                total={items.length}
                                onMove={moveItem}
                                onRemove={removeItem}
                                onDragEnd={() => {
                                    const position = itemsRef.current.findIndex((entry) => entry.id === item.id);
                                    if (position >= 0)
                                        setAnnouncement(`«${item.file.name}» ahora es el archivo ${position + 1} de ${itemsRef.current.length}.`);
                                }}
                            />
                        ))}
                    </Reorder.Group>

                    <p aria-live="polite" className="sr-only">
                        {announcement}
                    </p>

                    {isDropTarget && (
                        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-primary/85 ring-2 ring-brand backdrop-blur-[1px] ring-inset">
                            <p className="flex items-center gap-2 text-md font-semibold text-brand-secondary">
                                <Plus aria-hidden="true" className="size-5" />
                                Suelta para añadir a la lista
                            </p>
                        </div>
                    )}

                    <ActionBar summary={summary} error={error}>
                        {failed.length > 0 && (
                            <Button color="secondary-destructive" size="lg" iconLeading={Trash01} className="w-full sm:w-auto" onClick={removeFailed}>
                                {failed.length === 1 ? "Quitar el archivo con error" : "Quitar los archivos con error"}
                            </Button>
                        )}
                        <Button
                            data-primary-action
                            color="primary"
                            size="lg"
                            iconLeading={LayersThree01}
                            isLoading={isMerging}
                            showTextWhileLoading
                            isDisabled={!canMerge}
                            // On phones the bar only shows what can be done now: remove the files with errors.
                            className={cx("w-full sm:w-auto", failed.length > 0 && "max-sm:hidden")}
                            onClick={handleMerge}
                        >
                            {isMerging && progress ? `Uniendo ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…` : "Fusionar PDF"}
                        </Button>
                    </ActionBar>
                </section>
            )}
        </ToolPageLayout>
    );
};

const MergeRow = ({
    item,
    index,
    total,
    onMove,
    onRemove,
    onDragEnd,
}: {
    item: QueuedFile;
    index: number;
    total: number;
    onMove: (id: string, delta: -1 | 1) => void;
    onRemove: (id: string) => void;
    onDragEnd: () => void;
}) => {
    const controls = useDragControls();
    const [isDragging, setIsDragging] = useState(false);
    const name = item.file.name;
    return (
        <Reorder.Item
            value={item.id}
            dragListener={false}
            dragControls={controls}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={() => {
                setIsDragging(false);
                onDragEnd();
            }}
            data-id={item.id}
            // The lifted look comes from classes: an inline box-shadow would replace the ring that draws the border.
            animate={{ scale: isDragging ? 1.02 : 1 }}
            className={cx(
                "relative flex items-center gap-2 rounded-xl bg-primary p-2 ring-1 ring-secondary ring-inset sm:gap-3 sm:p-2.5",
                item.status === "error" && "bg-error-primary ring-error_subtle",
                isDragging && "shadow-lg",
            )}
        >
            <span
                aria-hidden="true"
                onPointerDown={(event) => {
                    if (total < 2) return;
                    event.preventDefault(); // No text selection while dragging with a mouse.
                    controls.start(event);
                }}
                className={cx(
                    "flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-fg-quaternary transition duration-100 ease-linear select-none hover:bg-primary_hover active:cursor-grabbing",
                    total < 2 && "invisible",
                )}
            >
                <DotsGrid className="size-4" />
            </span>

            <span className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary ring-1 ring-secondary ring-inset">
                {item.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumb.url} alt="" draggable={false} className="max-h-full max-w-full bg-white" />
                ) : (
                    <File04 aria-hidden="true" className="size-5 text-fg-quaternary" />
                )}
            </span>

            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-primary" title={name}>
                    <span className="text-quaternary tabular-nums">{index + 1}.</span> {name}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-tertiary">
                    <span>{readableBytes(item.file.size)}</span>
                    <span aria-hidden="true">·</span>
                    {item.status === "reading" && <span>Leyendo…</span>}
                    {item.status === "ready" && <span>{pagesLabel(item.pageCount ?? 0)}</span>}
                    {item.status === "error" && (
                        <span className="inline-flex items-center gap-1 font-medium text-error-primary">
                            <XCircle aria-hidden="true" className="size-3.5 shrink-0" />
                            {item.problem}
                        </span>
                    )}
                </p>
            </div>

            <div className="flex shrink-0 flex-col items-center sm:flex-row">
                <ButtonUtility
                    size="xs"
                    color="tertiary"
                    icon={ArrowUp}
                    tooltip="Subir"
                    aria-label={`Subir «${name}»`}
                    data-move="up"
                    isDisabled={index === 0}
                    onClick={() => onMove(item.id, -1)}
                />
                <ButtonUtility
                    size="xs"
                    color="tertiary"
                    icon={ArrowDown}
                    tooltip="Bajar"
                    aria-label={`Bajar «${name}»`}
                    data-move="down"
                    isDisabled={index === total - 1}
                    onClick={() => onMove(item.id, 1)}
                />
            </div>
            <ButtonUtility
                size="xs"
                color="tertiary"
                icon={Trash01}
                tooltip="Quitar"
                aria-label={`Quitar «${name}»`}
                data-remove
                className="pointer-coarse:p-2"
                onClick={() => onRemove(item.id)}
            />
        </Reorder.Item>
    );
};

/** Summary and main action, stuck to the bottom of the screen while the list scrolls. */
const ActionBar = ({ summary, progress, error, children }: { summary: ReactNode; progress?: ReactNode; error: string | null; children: ReactNode }) => (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3 rounded-b-2xl bg-primary/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ring-1 ring-secondary backdrop-blur-sm ring-inset sm:py-4">
        <ErrorBanner message={error} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
                <p aria-live="polite" className="text-sm text-secondary">
                    {summary}
                </p>
                {progress}
            </div>
            <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">{children}</div>
        </div>
    </div>
);
