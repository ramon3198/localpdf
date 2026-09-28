"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, File04, Scissors01, Trash01 } from "@untitledui/icons";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { Checkbox as AriaCheckbox, Label as AriaLabel, Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { PdfThumbnails, PreviewProgress, usePdfThumbnails } from "@/components/pdf-thumbnails";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, loadPdfForEditing, pagesLabel, plural, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

type Mode = "select" | "ranges" | "each";

type SourceFile = { file: File; pageCount: number };

type OutputFile = { name: string; pages: number[] };

/** What pressing the main button will produce, or why it can't yet. */
type Plan = { ok: true; files: OutputFile[]; zip: boolean; zipName: string } | { ok: false; hint: string };

const MODES: { value: Mode; title: string; description: string }[] = [
    { value: "select", title: "Elegir páginas", description: "Marca las páginas y se guardan en un PDF nuevo." },
    { value: "ranges", title: "Por rangos", description: "Un PDF por cada rango, p. ej. 1-3, 5." },
    { value: "each", title: "Todas por separado", description: "Un PDF por página, dentro de un ZIP." },
];

const RANGES_HELP = "Separa con comas y usa un guion para los rangos. «8-» llega hasta la última página.";

const baseName = (file: File) => file.name.replace(/\.pdf$/i, "");

/** "1-3, 5, 8-" → [[1, 2, 3], [5], [8, …, total]], in the order typed. Reports every problem, not only the first. */
const parseRangeGroups = (text: string, total: number): { groups: number[][]; error?: string } => {
    const tokens = text
        .replace(/[–—]/g, "-")
        .replace(/\s*-\s*/g, "-")
        .split(/[\s,;]+/)
        .filter(Boolean);
    const groups: number[][] = [];
    const invalid: string[] = [];
    let outOfRange = false;

    for (const token of tokens) {
        const range = token.match(/^(\d*)-(\d*)$/);
        let from: number;
        let to: number;
        if (/^\d+$/.test(token)) {
            from = to = Number(token);
        } else if (range && (range[1] || range[2])) {
            from = range[1] ? Number(range[1]) : 1;
            to = range[2] ? Number(range[2]) : total;
        } else {
            invalid.push(token);
            continue;
        }
        if (from < 1 || to < 1 || from > total || to > total) {
            outOfRange = true;
            continue;
        }
        if (from > to) [from, to] = [to, from];
        groups.push(Array.from({ length: to - from + 1 }, (_, i) => from + i));
    }

    const problems: string[] = [];
    if (invalid.length === 1) problems.push(`«${invalid[0]}» no es un número de página ni un rango.`);
    if (invalid.length > 1) problems.push(`${invalid.map((token) => `«${token}»`).join(", ")} no son números de página ni rangos.`);
    if (outOfRange) problems.push(total === 1 ? "Este PDF solo tiene la página 1." : `Este PDF tiene las páginas de la 1 a la ${total}.`);
    return problems.length ? { groups, error: problems.join(" ") } : { groups };
};

const rangeSlug = (pages: number[]) => (pages.length === 1 ? `pagina-${pages[0]}` : `paginas-${pages[0]}-${pages[pages.length - 1]}`);

/** Adds "-2", "-3"… to repeated names so no file inside the ZIP overwrites another. */
const withUniqueNames = (files: OutputFile[]) => {
    const seen = new Map<string, number>();
    return files.map((file) => {
        const count = (seen.get(file.name) ?? 0) + 1;
        seen.set(file.name, count);
        return count === 1 ? file : { ...file, name: `${file.name}-${count}` };
    });
};

export const SplitScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const previews = usePdfThumbnails(input?.file ?? null);
    const [mode, setMode] = useState<Mode>("select");
    const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
    const [ranges, setRanges] = useState("");
    const [joinRanges, setJoinRanges] = useState(false);
    const [opening, setOpening] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const openRun = useRef(0);
    const dropRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);
    const focusAfterRender = useRef<"dropzone" | "action" | null>(null);

    const pageCount = input?.pageCount ?? 0;
    const singlePage = pageCount === 1;

    const parsedRanges = useMemo(() => parseRangeGroups(ranges, Math.max(pageCount, 1)), [ranges, pageCount]);

    const plan = useMemo<Plan>(() => {
        if (!input) return { ok: false, hint: "" };
        const base = baseName(input.file);
        if (mode === "select") {
            const pages = [...selected].sort((a, b) => a - b);
            return pages.length
                ? { ok: true, zip: false, zipName: base, files: [{ name: `${base}-extracto`, pages }] }
                : { ok: false, hint: "Aún no has seleccionado ninguna página." };
        }
        if (mode === "each") {
            const digits = Math.max(2, String(input.pageCount).length);
            return {
                ok: true,
                zip: true,
                zipName: `${base}-paginas`,
                files: Array.from({ length: input.pageCount }, (_, i) => ({ name: `${base}-pagina-${String(i + 1).padStart(digits, "0")}`, pages: [i + 1] })),
            };
        }
        if (parsedRanges.error) return { ok: false, hint: "Revisa los rangos para continuar." };
        if (!parsedRanges.groups.length) return { ok: false, hint: "Escribe qué páginas quieres separar." };
        if (joinRanges || parsedRanges.groups.length === 1) {
            const pages = [...new Set(parsedRanges.groups.flat())];
            const name = parsedRanges.groups.length === 1 ? `${base}-${rangeSlug(pages)}` : `${base}-extracto`;
            return { ok: true, zip: false, zipName: base, files: [{ name, pages }] };
        }
        return {
            ok: true,
            zip: true,
            zipName: `${base}-rangos`,
            files: withUniqueNames(parsedRanges.groups.map((pages) => ({ name: `${base}-${rangeSlug(pages)}`, pages }))),
        };
    }, [input, mode, selected, parsedRanges, joinRanges]);

    // Pages covered by the typed ranges, and which output file each one goes to.
    const rangePreview = useMemo(() => {
        const covered = new Set(parsedRanges.groups.flat());
        const badges: Record<number, string> = {};
        if (plan.ok && plan.zip && mode === "ranges") {
            parsedRanges.groups.forEach((group, index) =>
                group.forEach((page) => {
                    badges[page] = badges[page] ? `${badges[page]}, ${index + 1}` : String(index + 1);
                }),
            );
        }
        return { covered, badges };
    }, [parsedRanges, plan, mode]);

    // Keyboard and screen reader users keep their place when the screen changes under them.
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
        setRanges("");
        setJoinRanges(false);
        setMode("select");
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
            setRanges("");
            setJoinRanges(false);
            setMode("select");
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

    const allSelected = pageCount > 0 && selected.size === pageCount;
    const toggleAll = () => setSelected(allSelected ? new Set() : new Set(Array.from({ length: pageCount }, (_, i) => i + 1)));

    const split = async () => {
        if (!input || !plan.ok) return;
        setError(null);
        setBusy(true);
        try {
            const source = await loadPdfForEditing(input.file);
            const build = async (pages: number[]) => {
                const out = await PDFDocument.create();
                const copied = await out.copyPages(
                    source,
                    pages.map((page) => page - 1),
                );
                copied.forEach((page) => out.addPage(page));
                return out.save();
            };

            if (plan.zip) {
                const zip = new JSZip();
                for (let i = 0; i < plan.files.length; i++) {
                    setProgress({ done: i, total: plan.files.length });
                    zip.file(`${plan.files[i].name}.pdf`, await build(plan.files[i].pages));
                }
                setProgress({ done: plan.files.length, total: plan.files.length });
                const blob = await zip.generateAsync({ type: "blob" });
                setResult({
                    blob,
                    filename: datedFilename(plan.zipName, "zip"),
                    primaryLabel: "Descargar ZIP",
                    summary: `${plural(plan.files.length, "archivo PDF", "archivos PDF")} · ${readableBytes(blob.size)}`,
                });
            } else {
                const [output] = plan.files;
                const bytes = await build(output.pages);
                const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
                setResult({ blob, filename: datedFilename(output.name, "pdf"), summary: `${pagesLabel(output.pages.length)} · ${readableBytes(blob.size)}` });
            }
        } catch (err) {
            setError(friendlyError(err, "No se pudo dividir el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
            setProgress(null);
        }
    };

    if (result && input) {
        const isZip = result.filename.endsWith(".zip");
        return (
            <ToolPageLayout title="Dividir PDF" description="Extrae páginas o separa el documento en varios archivos." width="wide">
                <div ref={resultRef} tabIndex={-1} className="outline-none">
                    <SuccessPanel
                        title={isZip ? "¡ZIP listo!" : "¡PDF listo!"}
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

    const summary = !plan.ok
        ? plan.hint
        : plan.zip
          ? mode === "each"
              ? `Se crearán ${plural(plan.files.length, "archivo PDF", "archivos PDF")}, uno por página, en un ZIP.`
              : `Se crearán ${plural(plan.files.length, "archivo PDF", "archivos PDF")}, uno por rango, en un ZIP.`
          : `Se creará un PDF con ${pagesLabel(plan.files[0].pages.length)}.`;

    const busyLabel = progress && progress.total > 1 ? `Creando ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…` : "Dividiendo…";

    return (
        <ToolPageLayout title="Dividir PDF" description="Extrae páginas o separa el documento en varios archivos." width="wide">
            {!input && (
                <div ref={dropRef} className="flex flex-col gap-3">
                    <FileUploadDropZone
                        accept="application/pdf,.pdf"
                        allowsMultiple={false}
                        isDisabled={opening}
                        hint="Suelta el PDF que quieres dividir."
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

                    <AriaRadioGroup value={mode} onChange={(value) => setMode(value as Mode)} className="flex flex-col gap-2">
                        <AriaLabel className="text-sm font-medium text-secondary">¿Cómo quieres dividirlo?</AriaLabel>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {MODES.map((option) => (
                                <AriaRadio
                                    key={option.value}
                                    value={option.value}
                                    isDisabled={singlePage && option.value !== "select"}
                                    className={({ isSelected, isFocusVisible, isDisabled }) =>
                                        cx(
                                            "flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-secondary outline-focus-ring transition duration-100 ease-linear ring-inset",
                                            isSelected ? "bg-brand-primary_alt ring-2 ring-brand" : "bg-primary hover:bg-primary_hover",
                                            isFocusVisible && "outline-2 outline-offset-2",
                                            isDisabled && "cursor-not-allowed opacity-50 hover:bg-primary",
                                        )
                                    }
                                >
                                    {({ isSelected }) => (
                                        <>
                                            <span
                                                aria-hidden="true"
                                                className={cx(
                                                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                                                    isSelected ? "bg-brand-solid ring-brand-solid" : "bg-primary ring-primary",
                                                )}
                                            >
                                                {isSelected && <span className="size-1.5 rounded-full bg-white" />}
                                            </span>
                                            <span className="flex min-w-0 flex-col gap-0.5">
                                                <span className="text-sm font-semibold text-primary">{option.title}</span>
                                                <span className="text-xs text-tertiary">{option.description}</span>
                                            </span>
                                        </>
                                    )}
                                </AriaRadio>
                            ))}
                        </div>
                    </AriaRadioGroup>

                    {singlePage && <Notice tone="info">Este PDF solo tiene 1 página, así que no se puede separar en varios archivos.</Notice>}

                    {mode === "select" && (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm text-tertiary">
                                    {selected.size ? (
                                        plural(selected.size, "página seleccionada", "páginas seleccionadas")
                                    ) : (
                                        <>
                                            Selecciona las páginas que quieres extraer.
                                            <span className="hidden pointer-fine:inline"> Con Mayús + clic seleccionas varias seguidas.</span>
                                        </>
                                    )}
                                </p>
                                <Button color="secondary" size="sm" onClick={toggleAll}>
                                    {allSelected ? "Quitar la selección" : "Seleccionar todas"}
                                </Button>
                            </div>
                            <PdfThumbnails
                                mode="select"
                                pageCount={input.pageCount}
                                previews={previews}
                                selected={selected}
                                onToggle={toggle}
                                onSelectRange={selectRange}
                                label="Páginas del documento: selecciona las que quieres extraer"
                            />
                        </div>
                    )}

                    {mode === "ranges" && (
                        <div className="flex flex-col gap-4">
                            <div className="flex flex-col gap-3 sm:max-w-md">
                                <Input
                                    label="Páginas que quieres separar"
                                    placeholder="p. ej. 1-3, 5, 8-10"
                                    value={ranges}
                                    onChange={setRanges}
                                    isInvalid={!!parsedRanges.error}
                                    hint={parsedRanges.error ?? RANGES_HELP}
                                    autoComplete="off"
                                />
                                <AriaCheckbox
                                    isSelected={joinRanges}
                                    onChange={setJoinRanges}
                                    className={({ isFocusVisible }) =>
                                        cx(
                                            "flex w-max max-w-full cursor-pointer items-center gap-2 rounded-md text-sm text-secondary outline-focus-ring",
                                            isFocusVisible && "outline-2 outline-offset-2",
                                        )
                                    }
                                >
                                    {({ isSelected }) => (
                                        <>
                                            <span
                                                aria-hidden="true"
                                                className={cx(
                                                    "flex size-4 shrink-0 items-center justify-center rounded ring-1 transition duration-100 ease-linear ring-inset",
                                                    isSelected ? "bg-brand-solid ring-brand-solid" : "bg-primary ring-primary",
                                                )}
                                            >
                                                {isSelected && <Check className="size-3 text-white" strokeWidth={3} />}
                                            </span>
                                            Unir todos los rangos en un solo PDF
                                        </>
                                    )}
                                </AriaCheckbox>
                            </div>
                            <PdfThumbnails
                                mode="select"
                                pageCount={input.pageCount}
                                previews={previews}
                                selected={rangePreview.covered}
                                badges={rangePreview.badges}
                                label="Vista previa: páginas incluidas en los rangos"
                            />
                        </div>
                    )}

                    {mode === "each" && (
                        <Notice tone="info">
                            Se creará un ZIP con {plural(input.pageCount, "archivo PDF", "archivos PDF")}, uno por cada página del documento.
                        </Notice>
                    )}

                    <ActionBar summary={summary} progress={<PreviewProgress previews={previews} pageCount={input.pageCount} />} error={error}>
                        <Button
                            data-primary-action
                            color="primary"
                            size="lg"
                            iconLeading={Scissors01}
                            isLoading={isBusy}
                            showTextWhileLoading
                            isDisabled={!plan.ok}
                            className="w-full sm:w-auto"
                            onClick={split}
                        >
                            {isBusy ? busyLabel : mode === "select" ? "Extraer páginas" : "Dividir PDF"}
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

/** Summary of what will be created and the main action, stuck to the bottom of the screen while the pages scroll. */
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
