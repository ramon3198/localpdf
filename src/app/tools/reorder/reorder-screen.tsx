"use client";

import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Dataflow02, DotsGrid, File04, RefreshCcw01, SwitchHorizontal01, Trash01 } from "@untitledui/icons";
import { motion } from "motion/react";
import { PDFDocument } from "pdf-lib";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PAGE_GRID_CLASS, PagePreview, type PageThumbnail, PreviewProgress, usePdfThumbnails } from "@/components/pdf-thumbnails";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type SourceFile = { file: File; pageCount: number };

/** Where a dragged page would land: the insertion index, and the tile/side where the marker is drawn. */
type DropTarget = { index: number; position: number; side: "before" | "after" };

type DragSession = {
    page: number;
    from: number;
    pointerId: number;
    element: HTMLElement;
    startX: number;
    startY: number;
    /** Last pointer position, in viewport coordinates. */
    x: number;
    y: number;
    active: boolean;
    /** Tile boxes in document coordinates, by position, measured when the drag starts. */
    boxes: { left: number; top: number; right: number; bottom: number }[];
    rows: { top: number; bottom: number; first: number; last: number }[];
    target: DropTarget | null;
    frame: number;
};

/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD = 6;

const sameTarget = (a: DropTarget | null, b: DropTarget | null) => a?.index === b?.index && a?.side === b?.side && a?.position === b?.position;

export const ReorderScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const previews = usePdfThumbnails(input?.file ?? null);
    /** Original page numbers (1-based) in their new order. Independent of the previews, which may still be rendering. */
    const [order, setOrder] = useState<number[]>([]);
    const [drag, setDrag] = useState<{ page: number; target: DropTarget | null } | null>(null);
    const [announcement, setAnnouncement] = useState("");
    const [opening, setOpening] = useState(false);

    const openRun = useRef(0);
    const dropRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLUListElement>(null);
    const ghostRef = useRef<HTMLDivElement>(null);
    const session = useRef<DragSession | null>(null);
    const orderRef = useRef(order);
    const busyRef = useRef(isBusy);
    const focusAfterRender = useRef<"dropzone" | "action" | null>(null);
    /** Set by a move so the next render can announce it and keep focus on the moved page. */
    const lastMove = useRef<{ page: number; focus?: "prev" | "next" } | null>(null);

    useLayoutEffect(() => {
        orderRef.current = order;
        busyRef.current = isBusy;
    });

    useEffect(() => {
        const target = focusAfterRender.current;
        if (!target) return;
        focusAfterRender.current = null;
        if (target === "dropzone") dropRef.current?.querySelector<HTMLElement>("[data-dropzone]")?.focus();
        if (target === "action") editorRef.current?.querySelector<HTMLElement>("[data-primary-action]")?.focus();
    }, [input, result]);

    useEffect(() => {
        if (result) resultRef.current?.focus();
    }, [result]);

    // Announce each move and keep keyboard focus on the page that moved (React may have moved its DOM node).
    useLayoutEffect(() => {
        const move = lastMove.current;
        if (!move) return;
        lastMove.current = null;
        const position = order.indexOf(move.page);
        if (position < 0) return;
        setAnnouncement(`Página ${move.page} movida a la posición ${position + 1} de ${order.length}.`);
        if (move.focus) {
            const tile = gridRef.current?.querySelector(`[data-page="${move.page}"]`);
            const button =
                tile?.querySelector<HTMLElement>(`[data-move="${move.focus}"]:not([disabled])`) ??
                tile?.querySelector<HTMLElement>("[data-move]:not([disabled])");
            button?.focus();
        }
    }, [order]);

    const reset = () => {
        focusAfterRender.current = "dropzone";
        openRun.current++;
        setOpening(false);
        setOrder([]);
        setAnnouncement("");
        baseReset();
    };

    const handleFile = async (files: FileList) => {
        const file = files[0];
        if (!file) return;
        const run = ++openRun.current;
        setError(null);
        setOpening(true);
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            if (run !== openRun.current) return;
            const pageCount = doc.getPageCount();
            setOrder(Array.from({ length: pageCount }, (_, i) => i + 1));
            setAnnouncement("");
            setInput({ file, pageCount });
        } catch (err) {
            if (run === openRun.current) setError(friendlyError(err, "No se pudo abrir el PDF."));
        } finally {
            if (run === openRun.current) setOpening(false);
        }
    };

    const moveBy = useCallback((page: number, delta: -1 | 1) => {
        lastMove.current = { page, focus: delta < 0 ? "prev" : "next" };
        setOrder((prev) => {
            const from = prev.indexOf(page);
            const to = from + delta;
            if (from < 0 || to < 0 || to >= prev.length) return prev;
            const next = prev.slice();
            [next[from], next[to]] = [next[to], next[from]];
            return next;
        });
    }, []);

    const reverseOrder = () => {
        lastMove.current = null;
        setOrder((prev) => prev.slice().reverse());
        setAnnouncement("Orden invertido.");
    };

    const resetOrder = () => {
        lastMove.current = null;
        setOrder((prev) => prev.slice().sort((a, b) => a - b));
        setAnnouncement("Orden original restablecido.");
    };

    /* ---------- Drag and drop (pointer events: mouse anywhere on the tile, touch and pen from the handle) ---------- */

    const onTilePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, page: number) => {
        if (event.button !== 0 || busyRef.current) return;
        const target = event.target as HTMLElement;
        const onHandle = !!target.closest("[data-drag-handle]");
        // On touch screens the page itself must keep scrolling the list, so only the handle starts a drag.
        if (!onHandle && (event.pointerType !== "mouse" || target.closest("button, a, input"))) return;
        const from = orderRef.current.indexOf(page);
        if (from < 0) return;
        session.current = {
            page,
            from,
            pointerId: event.pointerId,
            element: event.currentTarget,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            active: false,
            boxes: [],
            rows: [],
            target: null,
            frame: 0,
        };
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Capture is a nicety: window listeners still see the pointer.
        }
        if (event.pointerType === "mouse") event.preventDefault(); // No text selection or native image drag.
    }, []);

    useEffect(() => {
        const updateTarget = (s: DragSession) => {
            if (!s.rows.length) return;
            const x = s.x + window.scrollX;
            const y = s.y + window.scrollY;
            // The row whose band (down to the middle of the gap below it) contains the pointer.
            let row = s.rows[s.rows.length - 1];
            for (let i = 0; i < s.rows.length - 1; i++) {
                if (y < (s.rows[i].bottom + s.rows[i + 1].top) / 2) {
                    row = s.rows[i];
                    break;
                }
            }
            let index = row.last + 1;
            for (let i = row.first; i <= row.last; i++) {
                const box = s.boxes[i];
                if (x < (box.left + box.right) / 2) {
                    index = i;
                    break;
                }
            }
            // Dropping right before or right after itself changes nothing: no marker.
            const target: DropTarget | null =
                index === s.from || index === s.from + 1
                    ? null
                    : index <= row.last
                      ? { index, position: index, side: "before" }
                      : { index, position: row.last, side: "after" };
            if (!sameTarget(target, s.target)) {
                s.target = target;
                setDrag({ page: s.page, target });
            }
        };

        const placeGhost = (s: DragSession) => {
            if (ghostRef.current) ghostRef.current.style.transform = `translate(${s.x - 44}px, ${s.y - 36}px) rotate(-3deg)`;
        };

        // Scroll the page while the pointer is near the top or bottom edge (above the sticky header / action bar).
        const autoScroll = () => {
            const s = session.current;
            if (!s?.active) return;
            const top = 96;
            const bottom = window.innerHeight - 150;
            const dy = s.y < top ? -Math.min(24, Math.ceil((top - s.y) / 3)) : s.y > bottom ? Math.min(24, Math.ceil((s.y - bottom) / 3)) : 0;
            if (dy) {
                const before = window.scrollY;
                window.scrollBy(0, dy);
                if (window.scrollY !== before) updateTarget(s);
            }
            s.frame = requestAnimationFrame(autoScroll);
        };

        const begin = (s: DragSession) => {
            const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLElement>(":scope > [data-page]") ?? []);
            s.boxes = tiles.map((tile) => {
                const box = tile.getBoundingClientRect();
                return {
                    left: box.left + window.scrollX,
                    top: box.top + window.scrollY,
                    right: box.right + window.scrollX,
                    bottom: box.bottom + window.scrollY,
                };
            });
            s.rows = [];
            s.boxes.forEach((box, i) => {
                const row = s.rows[s.rows.length - 1];
                if (row && Math.abs(row.top - box.top) < 4) {
                    row.last = i;
                    row.bottom = Math.max(row.bottom, box.bottom);
                } else {
                    s.rows.push({ top: box.top, bottom: box.bottom, first: i, last: i });
                }
            });
            s.active = true;
            setDrag({ page: s.page, target: null });
            s.frame = requestAnimationFrame(autoScroll);
        };

        const finish = (s: DragSession, commit: boolean) => {
            cancelAnimationFrame(s.frame);
            try {
                if (s.element.hasPointerCapture(s.pointerId)) s.element.releasePointerCapture(s.pointerId);
            } catch {
                // The tile may already be gone.
            }
            session.current = null;
            setDrag(null);
            if (!commit || !s.active || !s.target) return;
            const to = s.target.index > s.from ? s.target.index - 1 : s.target.index;
            lastMove.current = { page: s.page };
            setOrder((prev) => {
                const from = prev.indexOf(s.page);
                if (from < 0 || from === to) return prev;
                const next = prev.slice();
                next.splice(from, 1);
                next.splice(to, 0, s.page);
                return next;
            });
        };

        const onMove = (event: PointerEvent) => {
            const s = session.current;
            if (!s || event.pointerId !== s.pointerId) return;
            s.x = event.clientX;
            s.y = event.clientY;
            if (!s.active) {
                if (Math.hypot(s.x - s.startX, s.y - s.startY) < DRAG_THRESHOLD) return;
                begin(s);
            }
            event.preventDefault();
            placeGhost(s);
            updateTarget(s);
        };
        const onUp = (event: PointerEvent) => {
            const s = session.current;
            if (s && event.pointerId === s.pointerId) finish(s, true);
        };
        const onCancel = (event: PointerEvent) => {
            const s = session.current;
            if (s && event.pointerId === s.pointerId) finish(s, false);
        };
        const onKey = (event: KeyboardEvent) => {
            const s = session.current;
            if (s?.active && event.key === "Escape") {
                event.preventDefault();
                finish(s, false);
            }
        };
        const onBlur = () => {
            if (session.current) finish(session.current, false);
        };

        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKey);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("blur", onBlur);
            if (session.current) cancelAnimationFrame(session.current.frame);
            session.current = null;
        };
    }, []);

    // Put the floating copy under the pointer as soon as it mounts.
    const draggedPage = drag?.page ?? null;
    useLayoutEffect(() => {
        const s = session.current;
        if (draggedPage !== null && s && ghostRef.current) ghostRef.current.style.transform = `translate(${s.x - 44}px, ${s.y - 36}px) rotate(-3deg)`;
    }, [draggedPage]);

    /* ---------- Save ---------- */

    const movedCount = order.filter((page, i) => page !== i + 1).length;
    const isDirty = movedCount > 0;

    const save = async () => {
        if (!input || !isDirty) return;
        setError(null);
        setBusy(true);
        try {
            const source = await loadPdfForEditing(input.file);
            const out = await PDFDocument.create();
            const pages = await out.copyPages(
                source,
                order.map((page) => page - 1),
            );
            pages.forEach((page) => out.addPage(page));
            const bytes = await out.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            setResult({
                blob,
                filename: datedFilename(`${input.file.name.replace(/\.pdf$/i, "")}-reordenado`, "pdf"),
                summary: `${pagesLabel(order.length)} · ${plural(movedCount, "cambia de posición", "cambian de posición")} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            setError(friendlyError(err, "No se pudo guardar el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result && input) {
        return (
            <ToolPageLayout title="Reordenar páginas" description="Cambia el orden de las páginas de un PDF." width="wide">
                <div ref={resultRef} tabIndex={-1} className="outline-none">
                    <SuccessPanel
                        result={result}
                        onBack={() => {
                            focusAfterRender.current = "action";
                            setResult(null);
                        }}
                        onReset={reset}
                    />
                </div>
            </ToolPageLayout>
        );
    }

    const draggedThumb = drag ? previews.thumbnails[drag.page] : undefined;

    return (
        <ToolPageLayout title="Reordenar páginas" description="Cambia el orden de las páginas de un PDF." width="wide">
            {!input && (
                <div ref={dropRef} className="flex flex-col gap-3">
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={opening}
                        hint="Suelta el PDF que quieres reordenar."
                        onDropFiles={handleFile}
                        // The drop zone explains the rejected format itself; just clear an outdated message.
                        onDropUnacceptedFiles={() => setError(null)}
                    />
                    <OpeningStatus active={opening} />
                    <ErrorBanner message={error} />
                    {error === PROTECTED_PDF_MESSAGE && <UnlockLink />}
                </div>
            )}

            {input && (
                <div ref={editorRef} className="flex flex-col gap-5 rounded-2xl bg-primary p-5 ring-1 ring-secondary ring-inset">
                    <FileSummary file={input.file} pageCount={input.pageCount} onRemove={reset} />

                    {input.pageCount === 1 ? (
                        <div className="flex flex-col items-start gap-3">
                            <Notice tone="info" className="w-full">
                                Este PDF solo tiene 1 página, así que no hay nada que reordenar.
                            </Notice>
                            <Button color="secondary" size="md" onClick={reset}>
                                Elegir otro PDF
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm text-tertiary">Arrastra las páginas o usa sus flechas para moverlas.</p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button color="secondary" size="sm" iconLeading={SwitchHorizontal01} onClick={reverseOrder}>
                                        Invertir orden
                                    </Button>
                                    <Button color="tertiary" size="sm" iconLeading={RefreshCcw01} isDisabled={!isDirty} onClick={resetOrder}>
                                        Restablecer
                                    </Button>
                                </div>
                            </div>

                            <div className="flex flex-col gap-3">
                                {previews.error && <Notice tone="warning">{previews.error} Puedes seguir ordenando por número de página.</Notice>}
                                <ul ref={gridRef} aria-label="Páginas en el nuevo orden" className={PAGE_GRID_CLASS}>
                                    {order.map((page, position) => (
                                        <ReorderTile
                                            key={page}
                                            page={page}
                                            position={position}
                                            total={order.length}
                                            thumb={previews.thumbnails[page]}
                                            isDragSource={drag?.page === page}
                                            marker={drag?.target?.position === position ? drag.target.side : null}
                                            onMove={moveBy}
                                            onPointerDown={onTilePointerDown}
                                        />
                                    ))}
                                </ul>
                            </div>

                            <p aria-live="polite" className="sr-only">
                                {announcement}
                            </p>

                            <ActionBar
                                summary={
                                    isDirty
                                        ? `Orden modificado: ${plural(movedCount, "página cambia", "páginas cambian")} de posición.`
                                        : "Aún no has cambiado el orden."
                                }
                                progress={<PreviewProgress previews={previews} pageCount={input.pageCount} />}
                                error={error}
                            >
                                <Button
                                    data-primary-action
                                    color="primary"
                                    size="lg"
                                    iconLeading={Dataflow02}
                                    isLoading={isBusy}
                                    showTextWhileLoading
                                    isDisabled={!isDirty}
                                    className="w-full sm:w-auto"
                                    onClick={save}
                                >
                                    {isBusy ? "Guardando…" : "Guardar nuevo orden"}
                                </Button>
                            </ActionBar>
                        </>
                    )}
                </div>
            )}

            {drag && (
                <div
                    ref={ghostRef}
                    aria-hidden="true"
                    className="pointer-events-none fixed top-0 left-0 z-50 w-22 rounded-lg bg-primary p-1 shadow-xl ring-1 ring-secondary"
                >
                    <PagePreview thumb={draggedThumb} />
                </div>
            )}
        </ToolPageLayout>
    );
};

type ReorderTileProps = {
    page: number;
    position: number;
    total: number;
    thumb: PageThumbnail | null | undefined;
    isDragSource: boolean;
    marker: "before" | "after" | null;
    onMove: (page: number, delta: -1 | 1) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>, page: number) => void;
};

const ReorderTile = memo(function ReorderTile({ page, position, total, thumb, isDragSource, marker, onMove, onPointerDown }: ReorderTileProps) {
    const moved = page !== position + 1;
    return (
        <motion.li
            layout="position"
            transition={{ layout: { duration: 0.2, ease: "easeOut" } }}
            data-page={page}
            onPointerDown={(event) => onPointerDown(event, page)}
            className={cx(
                "group relative flex flex-col gap-1.5 rounded-xl bg-primary p-2 ring-1 ring-secondary transition-opacity duration-100 ease-linear select-none ring-inset pointer-fine:cursor-grab",
                isDragSource && "opacity-40",
                // Insertion marker, centered in the gap next to the tile.
                "before:absolute before:inset-y-2 before:-left-1.5 before:hidden before:w-1 before:-translate-x-1/2 before:rounded-full before:bg-brand-solid sm:before:-left-2",
                "after:absolute after:inset-y-2 after:-right-1.5 after:hidden after:w-1 after:translate-x-1/2 after:rounded-full after:bg-brand-solid sm:after:-right-2",
                marker === "before" && "before:block",
                marker === "after" && "after:block",
            )}
        >
            <PagePreview thumb={thumb}>
                {/* Touch screens drag from here (the page itself keeps scrolling); with a mouse the whole tile drags. */}
                <span
                    data-drag-handle
                    aria-hidden="true"
                    className="absolute top-1.5 left-1.5 flex size-8 cursor-grab touch-none items-center justify-center rounded-md bg-primary/90 text-fg-quaternary shadow-xs ring-1 ring-secondary transition-opacity duration-100 ease-linear ring-inset pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                >
                    <DotsGrid className="size-4" />
                </span>
            </PagePreview>
            <div className="flex items-center justify-between gap-1 pl-1">
                <span className={cx("min-w-0 truncate text-xs font-medium", moved ? "text-brand-secondary" : "text-secondary")}>Página {page}</span>
                <span className="flex shrink-0 items-center">
                    <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={ArrowLeft}
                        tooltip="Mover antes"
                        aria-label={`Mover la página ${page} una posición antes`}
                        data-move="prev"
                        isDisabled={position === 0}
                        className="pointer-coarse:p-2"
                        onClick={() => onMove(page, -1)}
                    />
                    <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={ArrowRight}
                        tooltip="Mover después"
                        aria-label={`Mover la página ${page} una posición después`}
                        data-move="next"
                        isDisabled={position === total - 1}
                        className="pointer-coarse:p-2"
                        onClick={() => onMove(page, 1)}
                    />
                </span>
            </div>
        </motion.li>
    );
});

/** Name, pages and size of the chosen file, with a button to choose another one. */
const FileSummary = ({ file, pageCount, onRemove }: { file: File; pageCount: number; onRemove: () => void }) => (
    <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-quaternary ring-1 ring-secondary ring-inset">
            <File04 aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-primary" title={file.name}>
                {file.name}
            </p>
            <p className="text-xs text-tertiary">
                {pagesLabel(pageCount)} · {readableBytes(file.size)}
            </p>
        </div>
        <ButtonUtility color="tertiary" size="sm" icon={Trash01} tooltip="Quitar archivo" onClick={onRemove} />
    </div>
);

/** Shown under the drop zone while a large PDF is being opened. */
const OpeningStatus = ({ active }: { active: boolean }) => (
    <p role="status" className={cx("flex items-center justify-center gap-2 text-sm text-tertiary", !active && "sr-only")}>
        {active && (
            <>
                <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-brand-solid" />
                Abriendo el PDF…
            </>
        )}
    </p>
);

const UnlockLink = () => (
    <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight} className="self-start">
        Ir a Desproteger PDF
    </Button>
);

/** Summary of the changes and the main action, stuck to the bottom of the screen while the pages scroll. */
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
