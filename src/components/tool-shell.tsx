"use client";

import { type ReactNode, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle, DownloadCloud02, File06, InfoCircle, RefreshCcw01, XCircle } from "@untitledui/icons";
import { AnimatePresence, motion } from "motion/react";
import { LocalBadge, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/base/buttons/button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { downloadBlob, readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

export type ToolResult = {
    blob: Blob;
    filename: string;
    primaryLabel?: string;
    /** Short summary like "5 páginas · 80 KB" to show in the result panel. */
    summary?: string;
};

export const ToolPageLayout = ({
    title,
    description,
    children,
    width = "default",
}: {
    title: string;
    description: string;
    children: ReactNode;
    /** "wide" for screens that show whole pages side by side (editor, page grids). */
    width?: "default" | "wide";
}) => (
    <>
        <PageHeader title={title} description={description} actions={<LocalBadge />} />
        <div className={cx("mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-6 md:py-8 lg:px-10", width === "wide" ? "max-w-7xl" : "max-w-4xl")}>
            {children}
        </div>
    </>
);

export const ErrorBanner = ({ message }: { message: string | null }) => (
    <AnimatePresence>
        {message && (
            <motion.div
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="flex items-start gap-2 rounded-lg bg-error-primary p-3 text-sm font-medium text-error-primary ring-1 ring-error_subtle ring-inset"
            >
                <XCircle aria-hidden="true" className="mt-px size-4 shrink-0" />
                {message}
            </motion.div>
        )}
    </AnimatePresence>
);

const NOTICE_TONES = {
    info: { icon: InfoCircle, className: "bg-secondary text-secondary ring-secondary", iconClassName: "text-fg-quaternary" },
    warning: { icon: AlertTriangle, className: "bg-warning-primary text-warning-primary ring-fg-warning-secondary/30", iconClassName: "" },
    error: { icon: XCircle, className: "bg-error-primary text-error-primary ring-error_subtle", iconClassName: "" },
    success: { icon: CheckCircle, className: "bg-success-primary text-success-primary ring-fg-success-secondary/30", iconClassName: "" },
} as const;

/** Inline callout for hints, warnings and outcomes inside a tool (use ErrorBanner for errors of the whole screen). */
export const Notice = ({
    tone = "info",
    title,
    children,
    className,
}: {
    tone?: keyof typeof NOTICE_TONES;
    title?: ReactNode;
    children?: ReactNode;
    className?: string;
}) => {
    const { icon: Icon, className: toneClassName, iconClassName } = NOTICE_TONES[tone];
    return (
        <div
            role={tone === "error" ? "alert" : undefined}
            className={cx("flex items-start gap-2.5 rounded-lg p-3 text-sm ring-1 ring-inset", toneClassName, className)}
        >
            <Icon aria-hidden="true" className={cx("mt-px size-4 shrink-0", iconClassName)} />
            <div className="flex min-w-0 flex-col gap-0.5">
                {title && <p className="font-semibold">{title}</p>}
                {children && <div className={cx(title && "opacity-90")}>{children}</div>}
            </div>
        </div>
    );
};

export const SuccessPanel = ({
    result,
    onReset,
    onBack,
    backLabel = "Volver y ajustar",
    title = "¡PDF listo!",
}: {
    result: ToolResult;
    onReset: () => void;
    /** Return to the tool with the same file and settings, e.g. to change an option and export again. */
    onBack?: () => void;
    backLabel?: string;
    title?: string;
}) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center gap-5 rounded-2xl bg-primary p-6 ring-1 ring-secondary ring-inset md:p-8"
    >
        <FeaturedIcon icon={CheckCircle} color="success" theme="light" size="xl" />
        <div className="flex flex-col items-center gap-1 text-center">
            <h2 className="text-lg font-semibold text-primary">{title}</h2>
            <p className="text-sm text-tertiary">{result.summary ?? readableBytes(result.blob.size)}</p>
        </div>
        <div className="flex max-w-full items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-secondary ring-1 ring-secondary ring-inset">
            <File06 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
            <span className="truncate">{result.filename}</span>
        </div>
        <div className="flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button color="primary" size="lg" iconLeading={DownloadCloud02} onClick={() => downloadBlob(result.blob, result.filename)}>
                {result.primaryLabel ?? "Descargar"}
            </Button>
            {onBack && (
                <Button color="secondary" size="lg" iconLeading={ArrowLeft} onClick={onBack}>
                    {backLabel}
                </Button>
            )}
            <Button color={onBack ? "tertiary" : "secondary"} size="lg" iconLeading={RefreshCcw01} onClick={onReset}>
                Empezar de nuevo
            </Button>
        </div>
    </motion.div>
);

/** Convenience hook for the common "pick → process → result" loop. */
export const useToolState = <Input,>() => {
    const [input, setInput] = useState<Input | null>(null);
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ToolResult | null>(null);
    const reset = () => {
        setInput(null);
        setBusy(false);
        setError(null);
        setResult(null);
    };
    return { input, setInput, isBusy, setBusy, error, setError, result, setResult, reset };
};
