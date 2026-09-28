"use client";

import { type FormEvent, useState } from "react";
import { File04, LockUnlocked02, RefreshCcw01, Trash01 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { getPdfjs } from "@/lib/pdfjs-loader";
import { PROTECTED_PDF_MESSAGE, datedFilename, friendlyError, pagesLabel, readableBytes } from "@/lib/pdf-utils";

const TITLE = "Desproteger PDF";
const DESCRIPTION = "Quita la contraseña de apertura y las restricciones de impresión o copia de un PDF.";

/** locked: asks for a password to open · restricted: opens without one but limits printing/copying · none: nothing to remove. */
type Protection = "locked" | "restricted" | "none";
type SourceFile = { file: File; protection: Protection; pageCount: number | null; restrictions: string[] };
type Outcome = { mode: "lossless" | "raster"; protection: Protection };

/** "a", "a ni b", "a, b ni c" */
const joinNegative = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ni ${items[items.length - 1]}`);

const isPasswordError = (err: unknown) => {
    const e = err as { name?: string; message?: string } | null;
    return e?.name === "PasswordException" || /password/i.test(e?.message ?? "");
};

/** friendlyError, minus the advice to use «Desproteger PDF» (we are already here). */
const unlockErrorMessage = (err: unknown, fallback: string) => {
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
    if (/unknown encryption|unsupported encryption|PubSec/i.test(text)) {
        return "Este PDF usa un tipo de protección que no se puede quitar aquí, como un certificado digital.";
    }
    const message = friendlyError(err, fallback);
    return message === PROTECTED_PDF_MESSAGE ? fallback : message;
};

/** Text of the first pages, to check that a decrypted copy still says the same as the original. */
const pageTexts = async (doc: { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> }) => {
    const texts: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 2); n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        texts.push(content.items.map((item) => (item as { str?: string }).str ?? "").join(""));
    }
    return texts;
};

export const UnlockScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [pw, setPw] = useState("");
    const [pwError, setPwError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);

    const reset = () => {
        baseReset();
        setPw("");
        setPwError(null);
        setProgress(null);
        setOutcome(null);
    };

    const handleFile = async (files: FileList) => {
        setError(null);
        setPwError(null);
        setPw("");
        const file = files[0];
        if (!file) return;
        try {
            const pdfjs = await getPdfjs();
            let protection: Protection = "none";
            let pageCount: number | null = null;
            const restrictions: string[] = [];
            try {
                const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
                pageCount = doc.numPages;
                const { info } = await doc.getMetadata();
                if ((info as { EncryptFilterName?: string | null })?.EncryptFilterName) {
                    protection = "restricted";
                    const allowed = await doc.getPermissions();
                    if (allowed) {
                        const { PermissionFlag } = pdfjs;
                        if (!allowed.includes(PermissionFlag.PRINT)) restrictions.push("imprimirlo");
                        if (!allowed.includes(PermissionFlag.COPY)) restrictions.push("copiar el texto");
                        if (!allowed.includes(PermissionFlag.MODIFY_CONTENTS)) restrictions.push("modificarlo");
                    }
                }
                await doc.destroy();
            } catch (err) {
                if ((err as { name?: string })?.name !== "PasswordException") throw err;
                protection = "locked";
            }
            setInput({ file, protection, pageCount, restrictions });
        } catch (err) {
            setError(unlockErrorMessage(err, "No se pudo leer el PDF."));
        }
    };

    /** Lossless path: decrypt with @cantoo/pdf-lib and save without the Encrypt dictionary. Returns null if the result can't be trusted. */
    const decryptLossless = async (file: File, password: string) => {
        const cantoo = await import("@cantoo/pdf-lib");
        const doc = await cantoo.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, password, updateMetadata: false });
        if (doc.isEncrypted) return null;
        // Object streams written after decrypting can come out corrupt: keep every object on its own.
        const bytes = await doc.save({ useObjectStreams: false });

        // Check the copy: it must open without a password, keep every page and say the same as the original.
        const pdfjs = await getPdfjs();
        const copy = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        const original = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: password || undefined }).promise;
        try {
            const { info } = await copy.getMetadata();
            if ((info as { EncryptFilterName?: string | null })?.EncryptFilterName) return null;
            if (copy.numPages !== original.numPages) return null;
            const [a, b] = await Promise.all([pageTexts(copy), pageTexts(original)]);
            if (a.join("\n") !== b.join("\n")) return null;
            return { bytes, pageCount: copy.numPages };
        } finally {
            await Promise.all([copy.destroy(), original.destroy()]);
        }
    };

    /** Last resort: pdf.js can open it, so rebuild every page as an image. Loses text, links and forms. */
    const rasterize = async (file: File, password: string) => {
        const pdfjs = await getPdfjs();
        const src = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: password || undefined }).promise;
        try {
            const { PDFDocument } = await import("pdf-lib");
            const out = await PDFDocument.create();
            for (let i = 1; i <= src.numPages; i++) {
                setProgress({ page: i, total: src.numPages });
                const page = await src.getPage(i);
                const baseVp = page.getViewport({ scale: 1 });
                const vp = page.getViewport({ scale: 2 });
                const canvas = document.createElement("canvas");
                canvas.width = Math.ceil(vp.width);
                canvas.height = Math.ceil(vp.height);
                const ctx = canvas.getContext("2d", { alpha: false });
                if (!ctx) throw new Error("Canvas no disponible.");
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
                page.cleanup();
                const jpg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.9));
                const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
                out.addPage([baseVp.width, baseVp.height]).drawImage(img, { x: 0, y: 0, width: baseVp.width, height: baseVp.height });
            }
            return { bytes: await out.save(), pageCount: src.numPages };
        } finally {
            await src.destroy();
        }
    };

    const apply = async (event?: FormEvent) => {
        event?.preventDefault();
        if (!input || isBusy || input.protection === "none") return;
        if (input.protection === "locked" && !pw) {
            setPwError("Escribe la contraseña del PDF.");
            return;
        }
        const password = input.protection === "locked" ? pw : "";
        setBusy(true);
        setError(null);
        setPwError(null);
        setProgress(null);
        try {
            let produced: { bytes: Uint8Array; pageCount: number } | null = null;
            let mode: Outcome["mode"] = "lossless";
            try {
                produced = await decryptLossless(input.file, password);
            } catch (err) {
                if (isPasswordError(err)) {
                    setPwError("Contraseña incorrecta. Revisa las mayúsculas y vuelve a intentarlo.");
                    return;
                }
                console.warn("Desproteger PDF: no se pudo descifrar sin pérdidas; se convierte a imágenes.", err);
            }
            if (!produced) {
                mode = "raster";
                try {
                    produced = await rasterize(input.file, password);
                } catch (err) {
                    if (isPasswordError(err)) {
                        setPwError("Contraseña incorrecta. Revisa las mayúsculas y vuelve a intentarlo.");
                        return;
                    }
                    throw err;
                }
            }
            const blob = new Blob([produced.bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            const what = mode === "raster" ? "Convertido a imágenes" : input.protection === "locked" ? "Contraseña quitada" : "Restricciones quitadas";
            setOutcome({ mode, protection: input.protection });
            setResult({
                blob,
                filename: datedFilename(`${base}-desprotegido`, "pdf"),
                summary: `${what} · ${pagesLabel(produced.pageCount)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            console.error(err);
            setError(unlockErrorMessage(err, "No se pudo desproteger el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
            setProgress(null);
        }
    };

    if (result) {
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <SuccessPanel
                    result={result}
                    onReset={reset}
                    title={outcome?.protection === "restricted" ? "¡Restricciones quitadas!" : "¡PDF desprotegido!"}
                />
                {outcome?.mode === "raster" ? (
                    <Notice tone="warning" title="Las páginas se han convertido en imágenes">
                        No se pudo quitar la protección conservando el documento tal cual. El PDF se ve igual, pero su texto ya no se puede seleccionar ni
                        buscar, y se pierden los enlaces y formularios.
                    </Notice>
                ) : (
                    <Notice tone="success">
                        {outcome?.protection === "restricted"
                            ? "Ya se puede imprimir, copiar y editar sin límites. Todo lo demás se conserva: texto, enlaces y calidad."
                            : "Ya se abre sin contraseña. Todo lo demás se conserva: texto, enlaces y calidad."}
                    </Notice>
                )}
            </ToolPageLayout>
        );
    }

    const busyLabel = progress ? `Convirtiendo página ${progress.page} de ${progress.total}…` : "Desprotegiendo…";

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint="Suelta el PDF que quieres desproteger." onDropFiles={handleFile} />}

            <ErrorBanner message={error} />

            {input && (
                <form noValidate onSubmit={apply} className="flex flex-col gap-5 rounded-2xl bg-primary p-4 ring-1 ring-secondary ring-inset sm:p-5">
                    <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-quaternary ring-1 ring-secondary ring-inset">
                            <File04 aria-hidden="true" className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-primary">{input.file.name}</p>
                            <p className="text-sm text-tertiary">
                                {[input.pageCount !== null && pagesLabel(input.pageCount), readableBytes(input.file.size)].filter(Boolean).join(" · ")}
                            </p>
                        </div>
                        <ButtonUtility color="tertiary" tooltip="Quitar archivo" icon={Trash01} size="sm" onClick={reset} />
                    </div>

                    {input.protection === "locked" && (
                        <>
                            <Notice tone="info" title="Este PDF pide contraseña para abrirse">
                                Escríbela para guardar una copia que se abra sin ella. Sirve tanto la contraseña de apertura como la de propietario.
                            </Notice>
                            <Input
                                type="password"
                                label="Contraseña del PDF"
                                autoComplete="current-password"
                                value={pw}
                                onChange={(value) => {
                                    setPw(value);
                                    setPwError(null);
                                }}
                                isInvalid={!!pwError}
                                hint={pwError ?? "No se envía a ningún sitio: todo ocurre en tu equipo."}
                                autoFocus
                            />
                        </>
                    )}

                    {input.protection === "restricted" && (
                        <Notice tone="info" title="Se abre sin contraseña, pero tiene restricciones">
                            {input.restrictions.length
                                ? `No permite ${joinNegative(input.restrictions)}. Puedes quitar esas restricciones sin cambiar nada más del documento.`
                                : "Está cifrado aunque no pide contraseña. Puedes guardar una copia sin cifrar sin cambiar nada más del documento."}
                        </Notice>
                    )}

                    {input.protection === "none" && (
                        <Notice tone="success" title="Este PDF no está protegido">
                            No tiene contraseña ni restricciones, así que no hay nada que quitar. Puedes usarlo tal cual.
                        </Notice>
                    )}

                    <div className="flex flex-col-reverse gap-3 border-t border-secondary pt-4 sm:flex-row sm:items-center sm:justify-end">
                        {input.protection === "none" ? (
                            <Button color="secondary" size="lg" iconLeading={RefreshCcw01} onClick={reset}>
                                Elegir otro archivo
                            </Button>
                        ) : (
                            <Button type="submit" color="primary" size="lg" iconLeading={LockUnlocked02} isLoading={isBusy} showTextWhileLoading>
                                {isBusy ? busyLabel : input.protection === "locked" ? "Quitar contraseña" : "Quitar restricciones"}
                            </Button>
                        )}
                    </div>
                </form>
            )}
        </ToolPageLayout>
    );
};
