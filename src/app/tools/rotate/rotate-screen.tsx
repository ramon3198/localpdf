"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, File04, RefreshCcw01, RefreshCw01, Trash01 } from "@untitledui/icons";
import { degrees } from "pdf-lib";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PdfThumbnails, PreviewProgress, usePdfThumbnails } from "@/components/pdf-thumbnails";
import { ErrorBanner, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type SourceFile = { file: File; pageCount: number };

const normalize = (n: number) => ((n % 360) + 360) % 360;

export const RotateScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const previews = usePdfThumbnails(input?.file ?? null);
    /** Rotation delta per page (1-based). Always a multiple of 90 in [90, 270]; pages without a turn are absent. */
    const [rotations, setRotations] = useState<Record<number, number>>({});
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
        setRotations({});
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
            setRotations({});
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            if (run === openRun.current) setError(friendlyError(err, "No se pudo abrir el PDF."));
        } finally {
            if (run === openRun.current) setOpening(false);
        }
    };

    const rotatePage = useCallback(
        (page: number, delta: 90 | -90) =>
            setRotations((prev) => {
                const next = normalize((prev[page] ?? 0) + delta);
                const out = { ...prev };
                if (next === 0) delete out[page];
                else out[page] = next;
                return out;
            }),
        [],
    );

    const rotateAll = (delta: 90 | -90) => {
        if (!input) return;
        setRotations((prev) => {
            const next: Record<number, number> = {};
            for (let page = 1; page <= input.pageCount; page++) {
                const rotation = normalize((prev[page] ?? 0) + delta);
                if (rotation !== 0) next[page] = rotation;
            }
            return next;
        });
    };

    const changed = Object.keys(rotations).length;

    const apply = async () => {
        if (!input || changed === 0) return;
        setError(null);
        setBusy(true);
        try {
            const doc = await loadPdfForEditing(input.file);
            for (const [pageNumber, delta] of Object.entries(rotations)) {
                const page = doc.getPage(Number(pageNumber) - 1);
                page.setRotation(degrees(normalize(page.getRotation().angle + delta)));
            }
            const bytes = await doc.save();
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            setResult({
                blob,
                filename: datedFilename(`${input.file.name.replace(/\.pdf$/i, "")}-rotado`, "pdf"),
                summary: `${plural(changed, "página girada", "páginas giradas")} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            setError(friendlyError(err, "No se pudo rotar el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result && input) {
        return (
            <ToolPageLayout title="Rotar PDF" description="Gira páginas sueltas o todo el documento." width="wide">
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

    return (
        <ToolPageLayout title="Rotar PDF" description="Gira páginas sueltas o todo el documento." width="wide">
            {!input && (
                <div ref={dropRef} className="flex flex-col gap-3">
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={opening}
                        hint="Suelta el PDF que quieres rotar."
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

                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <p className="text-sm text-tertiary">Gira cada página con sus botones, o pulsa sobre ella para girarla a la derecha.</p>
                        {/* Phones: label and "Restablecer" on the first row, the two turn buttons sharing the second one. */}
                        <div role="group" aria-labelledby="rotate-all-label" className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                            <span id="rotate-all-label" className="text-sm font-medium text-secondary">
                                Girar todas:
                            </span>
                            <Button color="secondary" size="sm" iconLeading={RefreshCcw01} className="max-sm:row-start-2" onClick={() => rotateAll(-90)}>
                                Izquierda
                            </Button>
                            <Button color="secondary" size="sm" iconLeading={RefreshCw01} className="max-sm:row-start-2" onClick={() => rotateAll(90)}>
                                Derecha
                            </Button>
                            <Button
                                color="tertiary"
                                size="sm"
                                isDisabled={changed === 0}
                                className="max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end"
                                onClick={() => setRotations({})}
                            >
                                Restablecer
                            </Button>
                        </div>
                    </div>

                    <PdfThumbnails mode="rotate" pageCount={input.pageCount} previews={previews} rotations={rotations} onRotate={rotatePage} />

                    <ActionBar
                        summary={changed === 0 ? "Aún no has girado ninguna página." : plural(changed, "página girada", "páginas giradas")}
                        progress={<PreviewProgress previews={previews} pageCount={input.pageCount} />}
                        error={error}
                    >
                        <Button
                            data-primary-action
                            color="primary"
                            size="lg"
                            iconLeading={RefreshCw01}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={changed === 0}
                            className="w-full sm:w-auto"
                            onClick={apply}
                        >
                            {isBusy ? "Rotando…" : "Rotar PDF"}
                        </Button>
                    </ActionBar>
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
