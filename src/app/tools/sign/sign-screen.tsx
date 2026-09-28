"use client";

import {
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Eraser, File04, FlipBackward, ImagePlus, PenTool02, PencilLine, Plus, Trash01, Type01, XClose } from "@untitledui/icons";
import { degrees } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
    Checkbox as AriaCheckbox,
    FileTrigger as AriaFileTrigger,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
    Tab as AriaTab,
    TabList as AriaTabList,
    TabPanel as AriaTabPanel,
    Tabs as AriaTabs,
} from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import {
    HANDWRITING_FONT,
    type SignatureImage,
    SignaturePad,
    type SignatureStroke,
    processSignatureImage,
    renderStrokesToPng,
    renderTypedSignature,
} from "@/components/signature-pad";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

const TITLE = "Firmar PDF";
const DESCRIPTION = "Dibuja, escribe o sube tu firma y colócala donde quieras del documento.";

type SourceFile = { file: File; pageCount: number };
type Mode = "draw" | "type" | "upload";
type PagePreview = { url: string; width: number; height: number };
/** A placed signature in points of the page as displayed (origin top-left). Its height follows the signature's shape. */
type Placement = { id: string; page: number; x: number; y: number; width: number };
type Drag = { id: string; kind: "move" | "resize"; startX: number; startY: number; origin: Placement };

const INKS = [
    { value: "#111827", label: "Negro" },
    { value: "#1d4ed8", label: "Azul" },
];
const MODES: { id: Mode; label: string; icon: typeof PencilLine }[] = [
    { id: "draw", label: "Dibujar", icon: PencilLine },
    { id: "type", label: "Escribir", icon: Type01 },
    { id: "upload", label: "Imagen", icon: ImagePlus },
];
const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 40;

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Keeps a placement inside its page, with a sensible minimum size. */
const fitPlacement = (p: Placement, pageWidth: number, pageHeight: number, aspect: number): Placement => {
    const width = clamp(p.width, MIN_WIDTH, Math.min(pageWidth, pageHeight / aspect));
    return { ...p, width, x: clamp(p.x, 0, pageWidth - width), y: clamp(p.y, 0, pageHeight - width * aspect) };
};

export const SignScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [mode, setMode] = useState<Mode>("draw");
    const [color, setColor] = useState(INKS[0].value);
    const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
    const [typed, setTyped] = useState("");
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [removeBackground, setRemoveBackground] = useState(true);
    const [uploaded, setUploaded] = useState<SignatureImage | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [signature, setSignature] = useState<SignatureImage | null>(null);
    const [placements, setPlacements] = useState<Placement[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [focusId, setFocusId] = useState<string | null>(null);
    const [activePage, setActivePage] = useState(1);
    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [preview, setPreview] = useState<PagePreview | null>(null);
    const pageRef = useRef<HTMLDivElement>(null);
    const drag = useRef<Drag | null>(null);
    const ids = { draw: useId(), help: useId(), ink: useId() };

    const aspect = signature ? signature.heightPx / signature.widthPx : 0.4;

    const reset = () => {
        baseReset();
        setStrokes([]);
        setTyped("");
        setUploadFile(null);
        setPlacements([]);
        setSelectedId(null);
        setActivePage(1);
        setPreview(null);
    };

    const handleFile = async (files: FileList) => {
        setError(null);
        const file = files[0];
        if (!file) return;
        try {
            const doc = await loadPdfForEditing(file, { updateMetadata: false });
            setPlacements([]);
            setPreview(null);
            setActivePage(1);
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            setError(friendlyError(err, "No se pudo leer el PDF."));
        }
    };

    // The signature is captured automatically from whichever tab is active.
    useEffect(() => {
        if (mode === "draw") setSignature(renderStrokesToPng(strokes, color));
        else if (mode === "type") setSignature(renderTypedSignature(typed, color));
        else setSignature(uploaded);
    }, [mode, strokes, typed, color, uploaded]);

    useEffect(() => {
        if (!uploadFile) {
            setUploaded(null);
            setUploadError(null);
            return;
        }
        let alive = true;
        processSignatureImage(uploadFile, removeBackground)
            .then((image) => {
                if (!alive) return;
                setUploaded(image);
                setUploadError(image ? null : "No se ve ninguna firma en la imagen: parece estar en blanco.");
            })
            .catch(() => {
                if (!alive) return;
                setUploaded(null);
                setUploadError("No se pudo abrir la imagen. Usa un archivo PNG o JPG.");
            });
        return () => {
            alive = false;
        };
    }, [uploadFile, removeBackground]);

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

    useEffect(() => {
        if (!pdfDoc) return;
        let alive = true;
        let cancel: (() => void) | null = null;
        (async () => {
            const page = await pdfDoc.getPage(activePage);
            const base = page.getViewport({ scale: 1 });
            const scale = (820 * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
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

    // Keyboard users land on the signature they just added.
    useEffect(() => {
        if (!focusId) return;
        document.querySelector<HTMLElement>(`[data-placement-id="${focusId}"]`)?.focus();
        setFocusId(null);
    }, [focusId, placements]);

    const updatePlacement = (id: string, next: Placement) => {
        if (!preview) return;
        setPlacements((prev) => prev.map((p) => (p.id === id ? fitPlacement(next, preview.width, preview.height, aspect) : p)));
    };

    const removePlacement = (id: string) => {
        setPlacements((prev) => prev.filter((p) => p.id !== id));
        setSelectedId((current) => (current === id ? null : current));
    };

    const addPlacement = (centerX?: number, centerY?: number) => {
        if (!preview) return null;
        const width = Math.min(DEFAULT_WIDTH, preview.width * 0.4);
        const height = width * aspect;
        const already = placements.filter((p) => p.page === activePage).length;
        // Without a click position, start near the bottom right, where signatures usually go.
        const x = centerX !== undefined ? centerX - width / 2 : preview.width - width - 56 - already * 16;
        const y = centerY !== undefined ? centerY - height / 2 : preview.height - height - 96 - already * 16;
        const placement = fitPlacement({ id: newId(), page: activePage, x, y, width }, preview.width, preview.height, aspect);
        setPlacements((prev) => [...prev, placement]);
        setSelectedId(placement.id);
        return placement;
    };

    const toPagePoint = (event: { clientX: number; clientY: number }) => {
        const rect = pageRef.current!.getBoundingClientRect();
        const scale = preview!.width / rect.width;
        return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };

    const onPageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!preview) return;
        const { x, y } = toPagePoint(event);
        const onPage = placements.filter((p) => p.page === activePage);
        if (onPage.length === 0) {
            addPlacement(x, y);
            return;
        }
        // Clicking elsewhere moves the selected signature (or the last one) there.
        const target = onPage.find((p) => p.id === selectedId) ?? onPage[onPage.length - 1];
        updatePlacement(target.id, { ...target, x: x - target.width / 2, y: y - (target.width * aspect) / 2 });
        setSelectedId(target.id);
    };

    const startDrag = (event: ReactPointerEvent<HTMLElement>, placement: Placement, kind: Drag["kind"]) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelectedId(placement.id);
        drag.current = { id: placement.id, kind, startX: event.clientX, startY: event.clientY, origin: placement };
    };

    const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || !preview || !pageRef.current) return;
        const scale = preview.width / pageRef.current.getBoundingClientRect().width;
        const dx = (event.clientX - d.startX) * scale;
        const dy = (event.clientY - d.startY) * scale;
        updatePlacement(d.id, d.kind === "move" ? { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy } : { ...d.origin, width: d.origin.width + dx });
    };

    const endDrag = () => {
        drag.current = null;
    };

    const onPlacementKey = (event: ReactKeyboardEvent<HTMLElement>, placement: Placement) => {
        if (event.target !== event.currentTarget) return;
        const step = event.shiftKey ? 10 : 2;
        const moves: Record<string, Partial<Placement>> = {
            ArrowLeft: { x: placement.x - step },
            ArrowRight: { x: placement.x + step },
            ArrowUp: { y: placement.y - step },
            ArrowDown: { y: placement.y + step },
            "+": { width: placement.width * 1.1 },
            "=": { width: placement.width * 1.1 },
            "-": { width: placement.width / 1.1 },
            _: { width: placement.width / 1.1 },
        };
        if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            removePlacement(placement.id);
            return;
        }
        const change = moves[event.key];
        if (!change) return;
        event.preventDefault();
        updatePlacement(placement.id, { ...placement, ...change });
    };

    const apply = async () => {
        if (!input || !signature || placements.length === 0 || isBusy) return;
        setBusy(true);
        setError(null);
        try {
            const doc = await loadPdfForEditing(input.file);
            const png = await doc.embedPng(await (await fetch(signature.dataUrl)).arrayBuffer());
            for (const placement of placements) {
                const page = doc.getPage(placement.page - 1);
                const box = page.getCropBox();
                const rotation = (((page.getRotation().angle ?? 0) % 360) + 360) % 360;
                const sideways = rotation === 90 || rotation === 270;
                const shownWidth = sideways ? box.height : box.width;
                const shownHeight = sideways ? box.width : box.height;
                const { x, y, width } = fitPlacement(placement, shownWidth, shownHeight, aspect);
                const height = width * aspect;
                // Bottom-left corner as displayed (y up), then back through /Rotate into the page's own coordinates.
                const vx = x;
                const vy = shownHeight - y - height;
                const [px, py] =
                    rotation === 90
                        ? [box.x + box.width - vy, box.y + vx]
                        : rotation === 180
                          ? [box.x + box.width - vx, box.y + box.height - vy]
                          : rotation === 270
                            ? [box.x + vy, box.y + box.height - vx]
                            : [box.x + vx, box.y + vy];
                page.drawImage(png, { x: px, y: py, width, height, rotate: degrees(rotation) });
            }
            const bytes = await doc.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            const pages = new Set(placements.map((p) => p.page)).size;
            setResult({
                blob,
                filename: datedFilename(`${base}-firmado`, "pdf"),
                summary: `${plural(placements.length, "firma", "firmas")} en ${pagesLabel(pages)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            console.error(err);
            setError(friendlyError(err, "No se pudo firmar el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION} width="wide">
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} title="¡PDF firmado!" />
                <Notice tone="info">La firma se añade como imagen, igual que una firma a mano escaneada. No es una firma digital con certificado.</Notice>
            </ToolPageLayout>
        );
    }

    const pagePlacements = placements.filter((p) => p.page === activePage);
    const pagesWithSignatures = Array.from(new Set(placements.map((p) => p.page))).sort((a, b) => a - b);
    const ratio = preview ? preview.width / preview.height : 612 / 792;
    const status = !signature
        ? placements.length
            ? "Crea tu firma para rellenar los huecos."
            : "Crea tu firma y pulsa en la página."
        : placements.length
          ? `${plural(placements.length, "firma", "firmas")} en ${pagesLabel(pagesWithSignatures.length)}`
          : "Pulsa en la página para colocarla.";

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION} width="wide">
            {!input && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint="Suelta el PDF que vas a firmar." onDropFiles={handleFile} />}

            <ErrorBanner message={error} />
            {error === PROTECTED_PDF_MESSAGE && (
                <div>
                    <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight}>
                        Ir a Desproteger PDF
                    </Button>
                </div>
            )}

            {input && (
                <div className="flex flex-col gap-5 rounded-2xl bg-primary p-4 ring-1 ring-secondary ring-inset sm:p-5">
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

                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
                        {/* Step 1: create the signature */}
                        <section aria-label="1. Crea tu firma" className="flex flex-col gap-3 lg:sticky lg:top-6">
                            <h2 className="text-sm font-semibold text-primary">1. Crea tu firma</h2>
                            <AriaTabs selectedKey={mode} onSelectionChange={(key) => setMode(key as Mode)} className="flex flex-col gap-3">
                                <AriaTabList aria-label="Forma de crear la firma" className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1 ring-1 ring-secondary ring-inset">
                                    {MODES.map(({ id, label, icon: Icon }) => (
                                        <AriaTab
                                            key={id}
                                            id={id}
                                            className={({ isSelected, isFocusVisible }) =>
                                                cx(
                                                    "flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-semibold outline-focus-ring transition duration-100 ease-linear",
                                                    isSelected ? "bg-primary text-primary shadow-sm ring-1 ring-secondary" : "text-tertiary hover:text-secondary",
                                                    isFocusVisible && "outline-2 outline-offset-2",
                                                )
                                            }
                                        >
                                            <Icon aria-hidden="true" className="size-4 shrink-0" />
                                            {label}
                                        </AriaTab>
                                    ))}
                                </AriaTabList>

                                <AriaTabPanel id="draw" className="flex flex-col gap-2 outline-hidden">
                                    <SignaturePad strokes={strokes} onStrokesChange={setStrokes} color={color} height={170} describedBy={ids.draw} />
                                    <div className="flex items-center justify-between gap-2">
                                        <p id={ids.draw} className="text-sm text-tertiary">
                                            Mantén pulsado el ratón o usa el dedo para dibujar.
                                        </p>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <ButtonUtility
                                                color="tertiary"
                                                size="sm"
                                                icon={FlipBackward}
                                                tooltip="Deshacer el último trazo"
                                                isDisabled={strokes.length === 0}
                                                onClick={() => setStrokes((s) => s.slice(0, -1))}
                                            />
                                            <Button color="tertiary" size="sm" iconLeading={Eraser} isDisabled={strokes.length === 0} onClick={() => setStrokes([])}>
                                                Borrar
                                            </Button>
                                        </div>
                                    </div>
                                </AriaTabPanel>

                                <AriaTabPanel id="type" className="flex flex-col gap-3 outline-hidden">
                                    <Input label="Tu nombre" placeholder="Ej.: Laura Giménez" value={typed} onChange={setTyped} maxLength={60} autoComplete="name" />
                                    <div className="flex h-28 items-center justify-center overflow-hidden rounded-xl bg-white px-4 shadow-xs ring-1 ring-secondary">
                                        {typed.trim() ? (
                                            <span className="truncate text-4xl leading-normal" style={{ fontFamily: HANDWRITING_FONT, color }}>
                                                {typed.trim()}
                                            </span>
                                        ) : (
                                            <span className="text-sm text-neutral-500">Aquí verás tu firma</span>
                                        )}
                                    </div>
                                </AriaTabPanel>

                                <AriaTabPanel id="upload" className="flex flex-col gap-3 outline-hidden">
                                    <div className="flex h-28 items-center justify-center overflow-hidden rounded-xl bg-white p-3 shadow-xs ring-1 ring-secondary">
                                        {uploaded ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={uploaded.dataUrl} alt="Tu firma" className="max-h-full max-w-full object-contain" />
                                        ) : (
                                            <span className="px-2 text-center text-sm text-neutral-500">Una foto o escaneo de tu firma, en PNG o JPG</span>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <AriaFileTrigger
                                            acceptedFileTypes={["image/png", "image/jpeg", "image/webp"]}
                                            onSelect={(files) => {
                                                const file = files?.[0];
                                                if (file) setUploadFile(file);
                                            }}
                                        >
                                            <Button color="secondary" size="sm" iconLeading={ImagePlus}>
                                                {uploadFile ? "Cambiar imagen" : "Elegir imagen"}
                                            </Button>
                                        </AriaFileTrigger>
                                        <AriaCheckbox isSelected={removeBackground} onChange={setRemoveBackground} className="group flex cursor-pointer items-center gap-2">
                                            {({ isSelected, isFocusVisible }) => (
                                                <>
                                                    <span
                                                        aria-hidden="true"
                                                        className={cx(
                                                            "flex size-4 shrink-0 items-center justify-center rounded ring-1 transition duration-100 ease-linear ring-inset",
                                                            isSelected ? "bg-brand-solid ring-transparent" : "bg-primary ring-primary",
                                                            isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                                                        )}
                                                    >
                                                        {isSelected && <Check className="size-3 text-white" strokeWidth={3} />}
                                                    </span>
                                                    <span className="text-sm text-secondary">Quitar el fondo blanco</span>
                                                </>
                                            )}
                                        </AriaCheckbox>
                                    </div>
                                    {uploadError && (
                                        <p role="alert" className="text-sm text-error-primary">
                                            {uploadError}
                                        </p>
                                    )}
                                </AriaTabPanel>
                            </AriaTabs>

                            {mode !== "upload" && (
                                <div className="flex items-center gap-3">
                                    <span id={ids.ink} className="text-sm font-medium text-secondary">
                                        Tinta
                                    </span>
                                    <AriaRadioGroup aria-labelledby={ids.ink} value={color} onChange={setColor} orientation="horizontal" className="flex items-center gap-2">
                                        {INKS.map((ink) => (
                                            <AriaRadio
                                                key={ink.value}
                                                value={ink.value}
                                                aria-label={ink.label}
                                                className={({ isSelected, isFocusVisible }) =>
                                                    cx(
                                                        "flex cursor-pointer rounded-full p-0.5 ring-2 outline-focus-ring transition duration-100 ease-linear",
                                                        isSelected ? "ring-brand" : "ring-transparent hover:ring-primary",
                                                        isFocusVisible && "outline-2 outline-offset-2",
                                                    )
                                                }
                                            >
                                                <span className="size-6 rounded-full ring-1 ring-white/20 ring-inset" style={{ backgroundColor: ink.value }} />
                                            </AriaRadio>
                                        ))}
                                    </AriaRadioGroup>
                                </div>
                            )}
                            <p className="text-sm text-tertiary">Se añade como imagen, igual que una firma a mano escaneada.</p>
                        </section>

                        {/* Step 2: place it */}
                        <section aria-label="2. Colócala en la página" className="flex min-w-0 flex-col gap-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h2 className="text-sm font-semibold text-primary">2. Colócala en la página</h2>
                                <Button
                                    color="secondary"
                                    size="sm"
                                    iconLeading={Plus}
                                    isDisabled={!preview}
                                    onClick={() => {
                                        const placement = addPlacement();
                                        if (placement) setFocusId(placement.id);
                                    }}
                                >
                                    {pagePlacements.length ? "Añadir otra firma" : "Poner firma en esta página"}
                                </Button>
                            </div>
                            <p id={ids.help} className="text-sm text-tertiary">
                                Pulsa en la página para colocarla. Arrástrala para moverla y usa el círculo de la esquina para cambiar su tamaño.
                                <span className="pointer-coarse:sr-only"> Con el teclado: flechas para mover, + y − para el tamaño y Suprimir para quitarla.</span>
                            </p>

                            <div
                                ref={pageRef}
                                data-page-preview
                                onClick={onPageClick}
                                className="relative mx-auto w-full max-w-[min(100%,calc((100dvh_-_13rem)*var(--page-ratio)))] cursor-crosshair bg-white shadow-md ring-1 ring-secondary select-none"
                                style={{ aspectRatio: `${ratio}`, "--page-ratio": ratio } as React.CSSProperties}
                            >
                                {preview ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={preview.url} alt={`Página ${activePage}`} className="absolute inset-0 size-full" draggable={false} />
                                ) : (
                                    <div className="absolute inset-0 animate-pulse bg-secondary" />
                                )}
                                {preview &&
                                    pagePlacements.map((placement, index) => {
                                        const shown = fitPlacement(placement, preview.width, preview.height, aspect);
                                        const selected = placement.id === selectedId;
                                        return (
                                            <div
                                                key={placement.id}
                                                data-placement-id={placement.id}
                                                role="group"
                                                tabIndex={0}
                                                aria-label={`Firma ${index + 1} de la página ${activePage}`}
                                                aria-describedby={ids.help}
                                                onFocus={() => setSelectedId(placement.id)}
                                                onKeyDown={(event) => onPlacementKey(event, placement)}
                                                onPointerDown={(event) => startDrag(event, placement, "move")}
                                                onPointerMove={onDragMove}
                                                onPointerUp={endDrag}
                                                onPointerCancel={endDrag}
                                                onClick={(event) => event.stopPropagation()}
                                                className={cx(
                                                    "group absolute cursor-move touch-none rounded-sm outline-focus-ring transition-shadow duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-4",
                                                    selected ? "ring-2 ring-brand" : "ring-brand/60 pointer-fine:hover:ring-1",
                                                )}
                                                style={{
                                                    left: `${(shown.x / preview.width) * 100}%`,
                                                    top: `${(shown.y / preview.height) * 100}%`,
                                                    width: `${(shown.width / preview.width) * 100}%`,
                                                    height: `${((shown.width * aspect) / preview.height) * 100}%`,
                                                }}
                                            >
                                                {signature ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={signature.dataUrl} alt="" draggable={false} className="pointer-events-none size-full select-none" />
                                                ) : (
                                                    <span className="flex size-full items-center justify-center rounded-sm border-2 border-dashed border-brand bg-brand-primary/40 text-xs font-semibold text-brand-secondary">
                                                        Tu firma
                                                    </span>
                                                )}
                                                {selected && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            aria-label={`Quitar la firma ${index + 1}`}
                                                            onPointerDown={(event) => event.stopPropagation()}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                removePlacement(placement.id);
                                                            }}
                                                            className="absolute -top-3.5 -right-3.5 flex size-7 cursor-pointer items-center justify-center rounded-full bg-error-solid text-white shadow-md ring-2 ring-white outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2 pointer-fine:size-6"
                                                        >
                                                            <XClose aria-hidden="true" className="size-4" />
                                                        </button>
                                                        <span
                                                            aria-hidden="true"
                                                            data-resize-handle
                                                            onPointerDown={(event) => startDrag(event, placement, "resize")}
                                                            onPointerMove={onDragMove}
                                                            onPointerUp={endDrag}
                                                            onPointerCancel={endDrag}
                                                            className="absolute -right-3 -bottom-3 flex size-7 cursor-nwse-resize touch-none items-center justify-center pointer-fine:size-5 pointer-fine:-right-2.5 pointer-fine:-bottom-2.5"
                                                        >
                                                            <span className="size-4 rounded-full bg-white shadow-md ring-2 ring-brand pointer-fine:size-3.5" />
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
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
                                    {pagesWithSignatures.length > 0 && (
                                        <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-tertiary">
                                            <span>Con firma:</span>
                                            {pagesWithSignatures.map((n) => (
                                                <button
                                                    key={n}
                                                    type="button"
                                                    onClick={() => setActivePage(n)}
                                                    aria-current={n === activePage ? "page" : undefined}
                                                    className={cx(
                                                        "rounded-md px-2 py-0.5 text-sm font-medium ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset focus-visible:outline-2 focus-visible:outline-offset-2",
                                                        n === activePage
                                                            ? "bg-brand-primary_alt text-brand-secondary ring-brand"
                                                            : "bg-primary text-secondary ring-secondary hover:bg-primary_hover",
                                                    )}
                                                >
                                                    pág. {n}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </section>
                    </div>

                    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex items-center justify-between gap-3 rounded-b-2xl border-t border-secondary bg-primary/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-5 sm:-mb-5 sm:px-5">
                        <p className="min-w-0 text-sm text-tertiary" aria-live="polite">
                            {status}
                        </p>
                        <Button
                            color="primary"
                            size="lg"
                            iconLeading={PenTool02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!signature || placements.length === 0}
                            onClick={apply}
                            className="shrink-0"
                        >
                            {isBusy ? "Firmando…" : "Aplicar firma"}
                        </Button>
                    </div>
                </div>
            )}
        </ToolPageLayout>
    );
};
