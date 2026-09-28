"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, File04, Trash01 } from "@untitledui/icons";
import { PDFDocument } from "pdf-lib";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PdfThumbnails, PreviewProgress, usePdfThumbnails } from "@/components/pdf-thumbnails";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type SourceFile = { file: File; pageCount: number };

/** "quedará 1 página", "quedarán 11 páginas". */
const remainingLabel = (count: number, future = true) =>
    future ? (count === 1 ? "quedará 1 página" : `quedarán ${pagesLabel(count)}`) : count === 1 ? "queda 1 página" : `quedan ${pagesLabel(count)}`;

export const DeletePagesScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const previews = usePdfThumbnails(input?.file ?? null);
    const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
    const [opening, setOpening] = useState(false);

    const openRun = useRef(0);
    const dropRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);
    const focusAfterRender = useRef<"dropzone" | "action" | null>(null);

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

    const reset = () => {
        focusAfterRender.current = "dropzone";
        openRun.current++;
        setOpening(false);
        setSelected(new Set());
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
            setSelected(new Set());
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            if (run === openRun.current) setError(friendlyError(err, "No se pudo abrir el PDF."));
        } finally {
            if (run === openRun.current) setOpening(false);
        }
    };

    const toggle = useCallback(
        (page: number) =>
            setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(page)) next.delete(page);
                else next.add(page);
                return next;
            }),
        [],
    );

    const selectRange = useCallback(
        (from: number, to: number, select: boolean) =>
            setSelected((prev) => {
                const next = new Set(prev);
                for (let page = Math.min(from, to); page <= Math.max(from, to); page++) {
                    if (select) next.add(page);
                    else next.delete(page);
                }
                return next;
            }),
        [],
    );

    const pageCount = input?.pageCount ?? 0;
    const invertSelection = () => setSelected((prev) => new Set(Array.from({ length: pageCount }, (_, i) => i + 1).filter((page) => !prev.has(page))));

    const marked = selected.size;
    const remaining = pageCount - marked;
    const allMarked = pageCount > 0 && marked === pageCount;

    const removePages = async () => {
        if (!input || marked === 0 || allMarked) return;
        setError(null);
        setBusy(true);
        try {
            const source = await loadPdfForEditing(input.file);
            const keep = Array.from({ length: source.getPageCount() }, (_, i) => i).filter((index) => !selected.has(index + 1));
            const out = await PDFDocument.create();
            const pages = await out.copyPages(source, keep);
            pages.forEach((page) => out.addPage(page));
            const bytes = await out.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            setResult({
                blob,
                filename: datedFilename(`${input.file.name.replace(/\.pdf$/i, "")}-recortado`, "pdf"),
                summary: `${plural(marked, "página eliminada", "páginas eliminadas")} · ${remainingLabel(keep.length, false)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            setError(friendlyError(err, "No se pudieron eliminar las páginas. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result && input) {
        return (
            <ToolPageLayout title="Eliminar páginas" description="Quita las páginas que no necesitas de un PDF." width="wide">
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

    const summary =
        marked === 0 ? (
            "Aún no has marcado ninguna página."
        ) : allMarked ? (
            <span className="text-error-primary">Has marcado todas las páginas. Debe quedar al menos 1.</span>
        ) : (
            `${plural(marked, "página marcada", "páginas marcadas")} · ${remainingLabel(remaining)}`
        );

    return (
        <ToolPageLayout title="Eliminar páginas" description="Quita las páginas que no necesitas de un PDF." width="wide">
            {!input && (
                <div ref={dropRef} className="flex flex-col gap-3">
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={opening}
                        hint="Suelta el PDF del que quieres quitar páginas."
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
                                Este PDF solo tiene 1 página, así que no hay páginas que eliminar.
                            </Notice>
                            <Button color="secondary" size="md" onClick={reset}>
                                Elegir otro PDF
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm text-tertiary">
                                    Pulsa las páginas que quieres eliminar.
                                    <span className="hidden pointer-fine:inline"> Con Mayús + clic marcas varias seguidas.</span>
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button color="secondary" size="sm" isDisabled={marked === 0} onClick={invertSelection}>
                                        Invertir selección
                                    </Button>
                                    {marked > 0 && (
                                        <Button color="tertiary" size="sm" onClick={() => setSelected(new Set())}>
                                            Desmarcar todas
                                        </Button>
                                    )}
                                </div>
                            </div>

                            <PdfThumbnails
                                mode="select"
                                tone="error"
                                pageCount={input.pageCount}
                                previews={previews}
                                selected={selected}
                                onToggle={toggle}
                                onSelectRange={selectRange}
                                label="Páginas del documento: marca las que quieres eliminar"
                            />

                            <ActionBar summary={summary} progress={<PreviewProgress previews={previews} pageCount={input.pageCount} />} error={error}>
                                <Button
                                    data-primary-action
                                    color="primary-destructive"
                                    size="lg"
                                    iconLeading={Trash01}
                                    isLoading={isBusy}
                                    showTextWhileLoading
                                    isDisabled={marked === 0 || allMarked}
                                    className="w-full sm:w-auto"
                                    onClick={removePages}
                                >
                                    {isBusy ? "Eliminando…" : marked === 0 || allMarked ? "Eliminar páginas" : `Eliminar ${pagesLabel(marked)}`}
                                </Button>
                            </ActionBar>
                        </>
                    )}
                </div>
            )}
        </ToolPageLayout>
    );
};

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
