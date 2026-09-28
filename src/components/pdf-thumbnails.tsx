"use client";

import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, RefreshCcw01, RefreshCw01, Trash01 } from "@untitledui/icons";
import type { PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Notice } from "@/components/tool-shell";
import { friendlyError } from "@/lib/pdf-utils";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { cx } from "@/utils/cx";

/*
 * Page previews shared by the page tools (split, rotate, delete pages, reorder, merge):
 * - usePdfThumbnails renders every page of a file once, progressively, and cancels cleanly when the file changes.
 * - PdfThumbnails shows them as a grid of selectable or rotatable tiles, with placeholders while they render.
 * - PagePreview and PAGE_GRID_CLASS let other screens (reorder) build their own tiles with the same look.
 */

export type PageThumbnail = {
    /** Object URL of a PNG of the page. Revoked when the file changes or the owner unmounts. */
    url: string;
    /** Bitmap size in pixels: only the ratio matters for layout. */
    width: number;
    height: number;
};

export type PdfThumbnailsState = {
    /** Previews by 1-based page number: `null` when that page could not be drawn. */
    thumbnails: Record<number, PageThumbnail | null>;
    /** Pages processed so far. */
    rendered: number;
    loading: boolean;
    /** Friendly message when the previews could not be generated (the tools still work with page numbers). */
    error: string | null;
};

/** Long edge of a preview in CSS pixels; drawn at up to 2× so it stays sharp on high-density screens. */
const DEFAULT_MAX_EDGE = 220;

/** Height / width of the preview well (3:4). */
const WELL_RATIO = 4 / 3;

/** Page tiles: 2 columns on phones, then as many ~150 px columns as fit. */
export const PAGE_GRID_CLASS = "grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-4";

const IDLE: PdfThumbnailsState = { thumbnails: {}, rendered: 0, loading: false, error: null };

const drawPage = async (page: PDFPageProxy, maxEdge: number): Promise<PageThumbnail | null> => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (maxEdge * pixelRatio) / Math.max(base.width, base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    const size = { width: canvas.width, height: canvas.height };
    // Free the bitmap now instead of waiting for garbage collection (matters with 100+ pages on phones).
    canvas.width = 0;
    canvas.height = 0;
    return blob ? { url: URL.createObjectURL(blob), ...size } : null;
};

/** Renders one page of a PDF (the first by default) as a small preview. The caller revokes `url` when done. */
export const renderPdfThumbnail = async (file: Blob, { page = 1, maxEdge = 64 }: { page?: number; maxEdge?: number } = {}) => {
    const pdfjs = await getPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
        const doc = await task.promise;
        return await drawPage(await doc.getPage(page), maxEdge);
    } finally {
        void task.destroy();
    }
};

/**
 * Renders every page of `file` progressively. Each file gets its own run: removing the file, choosing another one
 * or unmounting stops the previous run, so old pages can never show up under a new document.
 */
export const usePdfThumbnails = (file: File | null, maxEdge = DEFAULT_MAX_EDGE): PdfThumbnailsState => {
    const [state, setState] = useState<PdfThumbnailsState>(IDLE);

    useEffect(() => {
        if (!file) {
            setState(IDLE);
            return;
        }

        let cancelled = false;
        let task: PDFDocumentLoadingTask | null = null;
        const urls: string[] = [];
        setState({ ...IDLE, loading: true });

        (async () => {
            try {
                const pdfjs = await getPdfjs();
                const data = new Uint8Array(await file.arrayBuffer());
                if (cancelled) return;
                task = pdfjs.getDocument({ data });
                const doc = await task.promise;

                for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
                    if (cancelled) return;
                    let thumb: PageThumbnail | null = null;
                    try {
                        const page = await doc.getPage(pageNumber);
                        thumb = await drawPage(page, maxEdge);
                        page.cleanup();
                    } catch (error) {
                        if (cancelled) return;
                        // One broken page must not hide the others: show a "no preview" tile for it.
                        console.error(error);
                    }
                    if (cancelled) {
                        if (thumb) URL.revokeObjectURL(thumb.url);
                        return;
                    }
                    if (thumb) urls.push(thumb.url);
                    setState((current) => ({
                        ...current,
                        rendered: current.rendered + 1,
                        thumbnails: { ...current.thumbnails, [pageNumber]: thumb },
                    }));
                }
                setState((current) => ({ ...current, loading: false }));
            } catch (error) {
                if (cancelled) return;
                console.error(error);
                setState((current) => ({ ...current, loading: false, error: friendlyError(error, "No se pudieron mostrar las vistas previas de este PDF.") }));
            }
        })();

        return () => {
            cancelled = true;
            void task?.destroy();
            urls.forEach((url) => URL.revokeObjectURL(url));
        };
    }, [file, maxEdge]);

    return state;
};

/** Short, signed label for a rotation delta: 90 → "+90°", 180 → "180°", 270 → "−90°". */
export const rotationLabel = (rotation: number) => {
    const r = ((rotation % 360) + 360) % 360;
    return r === 90 ? "+90°" : r === 270 ? "−90°" : `${r}°`;
};

/**
 * The page on a neutral 3:4 well, with a pulse while it renders. Rotations are applied with CSS and quarter turns
 * are scaled down so the whole page stays visible (the edges are what people check when rotating).
 */
export const PagePreview = ({
    thumb,
    angle = 0,
    dimmed = false,
    className,
    children,
}: {
    /** `undefined` while rendering, `null` when the page has no preview. */
    thumb: PageThumbnail | null | undefined;
    /** Visual rotation in degrees, any multiple of 90 (not normalized, so turns animate the short way). */
    angle?: number;
    dimmed?: boolean;
    className?: string;
    /** Overlays (badges) positioned over the well. */
    children?: ReactNode;
}) => {
    const quarterTurn = Math.abs(Math.round(angle / 90)) % 2 === 1;
    const ratio = thumb ? thumb.height / thumb.width : WELL_RATIO;
    const fit = !quarterTurn ? 1 : ratio >= WELL_RATIO ? 1 / WELL_RATIO : Math.min(1, 1 / ratio);

    return (
        <span className={cx("relative block aspect-[3/4] w-full overflow-hidden rounded-lg bg-secondary", className)}>
            <span className="absolute inset-[7%] flex items-center justify-center">
                {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={thumb.url}
                        alt=""
                        width={thumb.width}
                        height={thumb.height}
                        draggable={false}
                        className={cx(
                            "h-auto max-h-full w-auto max-w-full rounded-xs bg-white shadow-xs ring-1 ring-secondary transition duration-300 ease-out",
                            dimmed && "opacity-35 grayscale",
                        )}
                        style={{ transform: `rotate(${angle}deg) scale(${fit})` }}
                    />
                ) : thumb === null ? (
                    <span className="flex size-full items-center justify-center rounded-xs bg-primary px-2 text-center text-xs text-quaternary ring-1 ring-secondary">
                        Sin vista previa
                    </span>
                ) : (
                    <span className="size-full animate-pulse rounded-xs bg-tertiary" />
                )}
            </span>
            {children}
        </span>
    );
};

/** Keeps a visual angle that follows `rotation` the short way round (270° → 0° turns +90°, not −270°). */
const useSpinAngle = (rotation: number) => {
    const [spin, setSpin] = useState({ target: rotation, angle: rotation });
    if (spin.target === rotation) return spin.angle;
    const delta = ((((rotation - spin.angle) % 360) + 540) % 360) - 180;
    const next = { target: rotation, angle: spin.angle + delta };
    setSpin(next);
    return next.angle;
};

const TILE_CLASS =
    "relative flex w-full flex-col gap-1.5 rounded-xl bg-primary p-2 text-left ring-1 ring-secondary ring-inset outline-focus-ring transition duration-100 ease-linear";

type SelectTileProps = {
    page: number;
    thumb: PageThumbnail | null | undefined;
    selected: boolean;
    tone: "brand" | "error";
    badge?: string;
    /** Read-only previews dim the pages that are not part of the result. */
    dimUnselected: boolean;
    /** `extend`: Shift was held, so the pages since the previous click change too. */
    onToggle?: (page: number, extend: boolean) => void;
};

const SelectTile = memo(function SelectTile({ page, thumb, selected, tone, badge, dimUnselected, onToggle }: SelectTileProps) {
    const isError = tone === "error";
    const content = (
        <>
            <PagePreview thumb={thumb} dimmed={(selected && isError) || (!selected && dimUnselected)}>
                {onToggle && (
                    <span
                        aria-hidden="true"
                        className={cx(
                            "absolute top-2 right-2 flex size-6 items-center justify-center rounded-full shadow-xs ring-1 transition duration-100 ease-linear ring-inset",
                            selected
                                ? isError
                                    ? "bg-error-solid text-white ring-transparent"
                                    : "bg-brand-solid text-white ring-transparent"
                                : "bg-primary text-transparent ring-primary",
                        )}
                    >
                        {isError ? <Trash01 className="size-3.5" /> : <Check className="size-3.5" strokeWidth={3} />}
                    </span>
                )}
                {badge && (
                    <span className="absolute top-2 left-2 rounded-full bg-brand-solid px-2 py-0.5 text-xs font-semibold text-white shadow-xs">{badge}</span>
                )}
                {selected && isError && (
                    <span
                        aria-hidden="true"
                        className="absolute inset-x-2 bottom-2 rounded-md bg-error-solid px-1.5 py-0.5 text-center text-xs font-semibold text-white shadow-xs"
                    >
                        Se eliminará
                    </span>
                )}
            </PagePreview>
            <span className={cx("px-1 text-xs font-medium", selected ? (isError ? "text-error-primary" : "text-brand-secondary") : "text-secondary")}>
                Página {page}
                {selected && isError && <span className="sr-only">, se eliminará</span>}
                {!onToggle && selected && <span className="sr-only"> (incluida)</span>}
            </span>
        </>
    );

    if (!onToggle) {
        return <div className={cx(TILE_CLASS, selected && "ring-2 ring-brand")}>{content}</div>;
    }

    return (
        <button
            type="button"
            aria-pressed={selected}
            onClick={(event) => onToggle(page, event.shiftKey)}
            className={cx(
                TILE_CLASS,
                "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2",
                selected
                    ? isError
                        ? "bg-error-primary ring-2 ring-error"
                        : "bg-brand-primary_alt ring-2 ring-brand"
                    : "hover:bg-primary_hover hover:ring-primary",
            )}
        >
            {content}
        </button>
    );
});

type RotateTileProps = {
    page: number;
    thumb: PageThumbnail | null | undefined;
    rotation: number;
    onRotate: (page: number, delta: 90 | -90) => void;
};

const RotateTile = memo(function RotateTile({ page, thumb, rotation, onRotate }: RotateTileProps) {
    const angle = useSpinAngle(rotation);
    return (
        <div className={cx(TILE_CLASS, rotation ? "ring-2 ring-brand" : "hover:ring-primary")}>
            {/* Clicking the page is a mouse shortcut for "turn right"; the buttons below are the accessible controls. */}
            <div className="cursor-pointer" onClick={() => onRotate(page, 90)}>
                <PagePreview thumb={thumb} angle={angle}>
                    {rotation !== 0 && (
                        <span className="absolute top-2 left-2 rounded-full bg-brand-solid px-2 py-0.5 text-xs font-semibold text-white tabular-nums shadow-xs">
                            {rotationLabel(rotation)}
                        </span>
                    )}
                </PagePreview>
            </div>
            <div className="flex items-center justify-between gap-1 pl-1">
                <span className={cx("min-w-0 truncate text-xs font-medium", rotation ? "text-brand-secondary" : "text-secondary")}>
                    Página {page}
                    {rotation !== 0 && <span className="sr-only">, girada {rotationLabel(rotation)}</span>}
                </span>
                <span className="flex shrink-0 items-center">
                    <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={RefreshCcw01}
                        tooltip="Girar a la izquierda"
                        aria-label={`Girar la página ${page} a la izquierda`}
                        className="pointer-coarse:p-2"
                        onClick={() => onRotate(page, -90)}
                    />
                    <ButtonUtility
                        size="xs"
                        color="tertiary"
                        icon={RefreshCw01}
                        tooltip="Girar a la derecha"
                        aria-label={`Girar la página ${page} a la derecha`}
                        className="pointer-coarse:p-2"
                        onClick={() => onRotate(page, 90)}
                    />
                </span>
            </div>
        </div>
    );
});

type CommonProps = {
    pageCount: number;
    previews: PdfThumbnailsState;
    /** Accessible name of the page list. */
    label?: string;
    className?: string;
};

type SelectModeProps = CommonProps & {
    mode: "select";
    selected: ReadonlySet<number>;
    /** Without it the grid is a read-only preview that highlights `selected`. */
    onToggle?: (page: number) => void;
    /** Shift + click: select (or unselect) every page between the previous click and this one. */
    onSelectRange?: (from: number, to: number, select: boolean) => void;
    tone?: "brand" | "error";
    /** Short text over a page, e.g. the number of the output file it goes to. */
    badges?: Record<number, string>;
};

type RotateModeProps = CommonProps & {
    mode: "rotate";
    /** Rotation delta per page (1-based), a multiple of 90 in [0, 270]. */
    rotations: Record<number, number>;
    onRotate: (page: number, delta: 90 | -90) => void;
};

/**
 * "Cargando vistas previas… 12 de 150" while the previews render. Meant for the sticky action bar: it stays visible
 * on long documents and, unlike a line above the grid, going away does not shift the pages under the pointer.
 */
export const PreviewProgress = ({ previews, pageCount }: { previews: PdfThumbnailsState; pageCount: number }) => (
    <p role="status" className={cx("flex items-center gap-1.5 text-xs text-tertiary", !previews.loading && "sr-only")}>
        {previews.loading && (
            <>
                <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand-solid" />
                Cargando vistas previas…
                <span aria-hidden="true" className="tabular-nums">
                    {Math.min(previews.rendered, pageCount)} de {pageCount}
                </span>
            </>
        )}
    </p>
);

export const PdfThumbnails = (props: SelectModeProps | RotateModeProps) => {
    const { pageCount, previews, label = "Páginas del documento", className } = props;
    const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);

    // One stable click handler for every tile (they are memoized), reading the latest props from a ref.
    const latest = useRef(props);
    const anchor = useRef<number | null>(null);
    useLayoutEffect(() => {
        latest.current = props;
    });
    const handleToggle = useCallback((page: number, extend: boolean) => {
        const current = latest.current;
        if (current.mode !== "select" || !current.onToggle) return;
        if (extend && anchor.current !== null && anchor.current !== page && current.onSelectRange) {
            current.onSelectRange(anchor.current, page, !current.selected.has(page));
        } else {
            current.onToggle(page);
        }
        anchor.current = page;
    }, []);

    return (
        <div className={cx("flex flex-col gap-3", className)}>
            {previews.error && <Notice tone="warning">{previews.error} Puedes seguir trabajando con los números de página.</Notice>}
            <ul aria-label={label} className={PAGE_GRID_CLASS}>
                {pages.map((page) => (
                    <li key={page} data-thumb={page} className="flex">
                        {props.mode === "rotate" ? (
                            <RotateTile page={page} thumb={previews.thumbnails[page]} rotation={props.rotations[page] ?? 0} onRotate={props.onRotate} />
                        ) : (
                            <SelectTile
                                page={page}
                                thumb={previews.thumbnails[page]}
                                selected={props.selected.has(page)}
                                tone={props.tone ?? "brand"}
                                badge={props.badges?.[page]}
                                dimUnselected={!props.onToggle && props.selected.size > 0}
                                onToggle={props.onToggle ? handleToggle : undefined}
                            />
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
};
