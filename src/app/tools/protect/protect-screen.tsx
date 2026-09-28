"use client";

import { type FormEvent, useMemo, useState } from "react";
import { ArrowRight, Check, File04, FileLock02, Trash01 } from "@untitledui/icons";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { ErrorBanner, Notice, SuccessPanel, ToolPageLayout, useToolState } from "@/components/tool-shell";
import { UserFacingError, datedFilename, friendlyError, pagesLabel, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

const TITLE = "Proteger PDF";
const DESCRIPTION = "Pon una contraseña al PDF: hará falta escribirla para abrirlo.";
const MIN_LENGTH = 4;
const ALREADY_PROTECTED_MESSAGE =
    "Este PDF ya tiene contraseña o restricciones. Quítalas primero con «Desproteger PDF» y vuelve aquí para ponerle una contraseña nueva.";

type SourceFile = { file: File; pageCount: number };

type Strength = "weak" | "fair" | "strong" | "excellent";

const measure = (pw: string): { score: number; label: Strength } => {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 14) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    const labels: Strength[] = ["weak", "weak", "fair", "fair", "strong", "excellent"];
    return { score, label: labels[Math.min(score, 5)] };
};

const STRENGTH_STYLES: Record<Strength, { label: string; color: string; bar: string }> = {
    weak: { label: "Débil", color: "text-error-primary", bar: "bg-error-solid" },
    fair: { label: "Aceptable", color: "text-warning-primary", bar: "bg-warning-solid" },
    strong: { label: "Buena", color: "text-success-primary", bar: "bg-success-solid" },
    excellent: { label: "Excelente", color: "text-success-primary", bar: "bg-success-solid" },
};

/** Random owner password nobody knows: with it, readers enforce the print/copy restrictions even for whoever has the password. */
const randomOwnerPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

const passwordHint = (pw: string, weak: boolean) => {
    if (pw.length === 0) return `Mínimo ${MIN_LENGTH} caracteres.`;
    const missing = MIN_LENGTH - pw.length;
    if (missing > 0) return missing === 1 ? "Falta 1 carácter (mínimo 4)." : `Faltan ${missing} caracteres (mínimo 4).`;
    if (weak) return "Mejor si es más larga o mezcla mayúsculas, números y símbolos.";
    return "Buena elección. Guárdala en un lugar seguro.";
};

const PermissionOption = ({
    label,
    description,
    isSelected,
    onChange,
}: {
    label: string;
    description: string;
    isSelected: boolean;
    onChange: (value: boolean) => void;
}) => (
    <AriaCheckbox
        isSelected={isSelected}
        onChange={onChange}
        className={({ isSelected }) =>
            cx(
                "group flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 transition duration-100 ease-linear ring-inset",
                isSelected ? "bg-brand-primary_alt ring-brand" : "bg-primary ring-secondary hover:bg-primary_hover",
            )
        }
    >
        {({ isSelected, isFocusVisible }) => (
            <>
                <span
                    aria-hidden="true"
                    className={cx(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded ring-1 transition duration-100 ease-linear ring-inset",
                        isSelected ? "bg-brand-solid ring-transparent" : "bg-primary ring-primary",
                        isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                    )}
                >
                    {isSelected && <Check className="size-3 text-white" strokeWidth={3} />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-primary">{label}</span>
                    <span className="text-sm text-tertiary">{description}</span>
                </span>
            </>
        )}
    </AriaCheckbox>
);

export const ProtectScreen = () => {
    const { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset: baseReset } = useToolState<SourceFile>();
    const [pw, setPw] = useState("");
    const [confirm, setConfirm] = useState("");
    const [restrictPrint, setRestrictPrint] = useState(false);
    const [restrictCopy, setRestrictCopy] = useState(false);
    const [triedSubmit, setTriedSubmit] = useState(false);

    const strength = useMemo(() => measure(pw), [pw]);
    const tooShort = pw.length < MIN_LENGTH;
    const mismatch = confirm.length > 0 && confirm !== pw;
    const confirmMissing = triedSubmit && confirm.length === 0;
    const canSubmit = !tooShort && confirm === pw;
    const restricted = restrictPrint || restrictCopy;

    const reset = () => {
        baseReset();
        setPw("");
        setConfirm("");
        setRestrictPrint(false);
        setRestrictCopy(false);
        setTriedSubmit(false);
    };

    const handleFile = async (files: FileList) => {
        setError(null);
        const file = files[0];
        if (!file) return;
        try {
            // Read-only check with pdf-lib: page count, and refuse files that already carry encryption
            // (encrypting them again would scramble their content).
            const { PDFDocument } = await import("pdf-lib");
            let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
            try {
                doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
            } catch (err) {
                throw new UserFacingError(friendlyError(err, "El archivo no es un PDF válido o está dañado."));
            }
            if (doc.isEncrypted) throw new UserFacingError(ALREADY_PROTECTED_MESSAGE);
            setInput({ file, pageCount: doc.getPageCount() });
        } catch (err) {
            setError(friendlyError(err, "No se pudo leer el PDF."));
        }
    };

    const apply = async (event?: FormEvent) => {
        event?.preventDefault();
        if (!input || isBusy) return;
        setTriedSubmit(true);
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const cantoo = await import("@cantoo/pdf-lib");
            const doc = await cantoo.PDFDocument.load(await input.file.arrayBuffer(), { updateMetadata: false });
            // @cantoo/pdf-lib picks the cipher from the header version: 1.6/1.7 means AES-128 (older headers get RC4).
            doc.context.header = cantoo.PDFHeader.forVersion(1, 7);
            doc.encrypt({
                userPassword: pw,
                // Same password for both roles unless something is restricted: whoever opens it as owner gets every permission.
                ownerPassword: restricted ? randomOwnerPassword() : pw,
                permissions: {
                    printing: restrictPrint ? false : "highResolution",
                    copying: !restrictCopy,
                    modifying: true,
                    annotating: true,
                    fillingForms: true,
                    contentAccessibility: true,
                    documentAssembly: true,
                },
            });
            const bytes = await doc.save({ useObjectStreams: false });
            const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
            const base = input.file.name.replace(/\.pdf$/i, "");
            setResult({
                blob,
                filename: datedFilename(`${base}-protegido`, "pdf"),
                summary: `Cifrado AES de 128 bits · ${pagesLabel(input.pageCount)} · ${readableBytes(blob.size)}`,
            });
        } catch (err) {
            console.error(err);
            setError(friendlyError(err, "No se pudo proteger el PDF. Inténtalo de nuevo."));
        } finally {
            setBusy(false);
        }
    };

    if (result) {
        const restrictionsText = [restrictPrint && "imprimir", restrictCopy && "copiar el texto"].filter(Boolean).join(" ni ");
        return (
            <ToolPageLayout title={TITLE} description={DESCRIPTION}>
                <SuccessPanel result={result} onReset={reset} onBack={() => setResult(null)} backLabel="Volver y cambiar" />
                <Notice tone="warning" title="Guarda la contraseña en un lugar seguro">
                    Si la olvidas, no hay forma de recuperarla ni de abrir el documento.
                    {restrictionsText && ` Además, los lectores de PDF no dejarán ${restrictionsText}, aunque se abra con la contraseña.`}
                </Notice>
            </ToolPageLayout>
        );
    }

    return (
        <ToolPageLayout title={TITLE} description={DESCRIPTION}>
            {!input && <FileUploadDropZone accept="application/pdf,.pdf" allowsMultiple={false} hint="Suelta el PDF que quieres proteger." onDropFiles={handleFile} />}

            <ErrorBanner message={error} />
            {error === ALREADY_PROTECTED_MESSAGE && (
                <div>
                    <Button href="/tools/unlock" color="link-color" size="md" iconTrailing={ArrowRight}>
                        Ir a Desproteger PDF
                    </Button>
                </div>
            )}

            {input && (
                <form noValidate onSubmit={apply} className="flex flex-col gap-6 rounded-2xl bg-primary p-4 ring-1 ring-secondary ring-inset sm:p-5">
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

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Input
                                type="password"
                                label="Contraseña"
                                autoComplete="new-password"
                                value={pw}
                                onChange={setPw}
                                isRequired
                                hideRequiredIndicator
                                isInvalid={triedSubmit && tooShort}
                                hint={passwordHint(pw, strength.label === "weak" || strength.label === "fair")}
                                autoFocus
                            />
                            {pw.length > 0 && (
                                <div className="flex items-center gap-2" aria-hidden="true">
                                    <div className="flex h-1.5 flex-1 gap-1">
                                        {[0, 1, 2, 3, 4].map((i) => (
                                            <div
                                                key={i}
                                                className={cx(
                                                    "h-full flex-1 rounded-full transition duration-100 ease-linear",
                                                    i < Math.max(1, strength.score) ? STRENGTH_STYLES[strength.label].bar : "bg-quaternary",
                                                )}
                                            />
                                        ))}
                                    </div>
                                    <span className={cx("w-16 text-right text-xs font-semibold", STRENGTH_STYLES[strength.label].color)}>
                                        {tooShort ? "Muy corta" : STRENGTH_STYLES[strength.label].label}
                                    </span>
                                </div>
                            )}
                        </div>
                        <Input
                            type="password"
                            label="Repite la contraseña"
                            autoComplete="new-password"
                            value={confirm}
                            onChange={setConfirm}
                            isRequired
                            hideRequiredIndicator
                            isInvalid={mismatch || confirmMissing}
                            hint={mismatch ? "No coincide con la contraseña." : confirmMissing ? "Vuelve a escribir la contraseña." : undefined}
                        />
                    </div>

                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-2 text-sm font-medium text-secondary">Restricciones (opcional)</legend>
                        <PermissionOption
                            label="Impedir la impresión"
                            description="Los lectores de PDF no dejarán imprimirlo, aunque se abra con la contraseña."
                            isSelected={restrictPrint}
                            onChange={setRestrictPrint}
                        />
                        <PermissionOption
                            label="Impedir copiar el texto"
                            description="No se podrá seleccionar ni copiar el contenido. Los lectores de pantalla seguirán pudiendo leerlo."
                            isSelected={restrictCopy}
                            onChange={setRestrictCopy}
                        />
                    </fieldset>

                    <div className="flex flex-col-reverse gap-3 border-t border-secondary pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-tertiary">Se cifra con AES de 128 bits. Si olvidas la contraseña, no se puede recuperar.</p>
                        <Button
                            type="submit"
                            color="primary"
                            size="lg"
                            iconLeading={FileLock02}
                            isLoading={isBusy}
                            showTextWhileLoading
                            className="shrink-0"
                        >
                            {isBusy ? "Cifrando…" : "Proteger PDF"}
                        </Button>
                    </div>
                </form>
            )}
        </ToolPageLayout>
    );
};
