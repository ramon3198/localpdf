"use client";

import { useId, useRef, useState } from "react";
import { UploadCloud02 } from "@untitledui/icons";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { readableBytes } from "@/lib/pdf-utils";
import { cx } from "@/utils/cx";

/**
 * Returns a human-readable file size.
 * @param bytes - The size of the file in bytes.
 * @returns A string representing the file size in a human-readable format.
 */
export const getReadableFileSize = (bytes: number) => readableBytes(bytes);

interface FileUploadDropZoneProps {
    /** The class name of the drop zone. */
    className?: string;
    /** What to drop, shown as the drop zone's title (e.g. "Suelta el PDF que quieres comprimir."). */
    hint?: string;
    /** Disables dropping or uploading files. */
    isDisabled?: boolean;
    /**
     * Specifies the types of files that are accepted.
     * Examples: "image/*", ".pdf,image/*", "image/*,video/mpeg,application/pdf"
     */
    accept?: string;
    /** Allows multiple files. */
    allowsMultiple?: boolean;
    /** Maximum file size in bytes. */
    maxSize?: number;
    /** Called with the accepted files. */
    onDropFiles?: (files: FileList) => void;
    /** Called with the files whose type is not accepted. */
    onDropUnacceptedFiles?: (files: FileList) => void;
    /** Called with the files that exceed the size limit. */
    onSizeLimitExceed?: (files: FileList) => void;
}

/** Human description of `accept` for the drop zone ("Solo archivos PDF", "Imágenes JPG o PNG"). */
const describeAccept = (accept?: string) => {
    if (!accept) return null;
    const a = accept.toLowerCase();
    const pdf = a.includes("pdf");
    const image = a.includes("image") || a.includes(".png") || a.includes(".jpg");
    if (pdf && !image) return "Solo archivos PDF";
    if (image && !pdf) return "Imágenes JPG o PNG";
    return null;
};

export const FileUploadDropZone = ({
    className,
    hint,
    isDisabled,
    accept,
    allowsMultiple = true,
    maxSize,
    onDropFiles,
    onDropUnacceptedFiles,
    onSizeLimitExceed,
}: FileUploadDropZoneProps) => {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [isInvalid, setIsInvalid] = useState(false);
    const [isDraggingOver, setIsDraggingOver] = useState(false);

    const isFileTypeAccepted = (file: File): boolean => {
        if (!accept) return true;

        // Split the accept string into individual types
        const acceptedTypes = accept.split(",").map((type) => type.trim());

        return acceptedTypes.some((acceptedType) => {
            // Handle file extensions (e.g., .pdf, .doc)
            if (acceptedType.startsWith(".")) {
                const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
                return extension === acceptedType.toLowerCase();
            }

            // Handle wildcards (e.g., image/*)
            if (acceptedType.endsWith("/*")) {
                const typePrefix = acceptedType.split("/")[0];
                return file.type.startsWith(`${typePrefix}/`);
            }

            // Handle exact MIME types (e.g., application/pdf)
            return file.type === acceptedType;
        });
    };

    const handleDragIn = (event: React.DragEvent<HTMLDivElement>) => {
        if (isDisabled) return;

        event.preventDefault();
        event.stopPropagation();
        setIsDraggingOver(true);
    };

    const handleDragOut = (event: React.DragEvent<HTMLDivElement>) => {
        if (isDisabled) return;

        event.preventDefault();
        event.stopPropagation();
        // Moving over a child fires dragleave on the zone: only reset when the pointer really left it.
        if (event.type === "dragleave" && event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDraggingOver(false);
    };

    const processFiles = (files: File[]): void => {
        // Reset the invalid state when processing files.
        setIsInvalid(false);

        const acceptedFiles: File[] = [];
        const unacceptedFiles: File[] = [];
        const oversizedFiles: File[] = [];

        // If multiple files are not allowed, only process the first file
        const filesToProcess = allowsMultiple ? files : files.slice(0, 1);

        filesToProcess.forEach((file) => {
            // Check file size first
            if (maxSize && file.size > maxSize) {
                oversizedFiles.push(file);
                return;
            }

            // Then check file type
            if (isFileTypeAccepted(file)) {
                acceptedFiles.push(file);
            } else {
                unacceptedFiles.push(file);
            }
        });

        // Handle oversized files
        if (oversizedFiles.length > 0 && typeof onSizeLimitExceed === "function") {
            const dataTransfer = new DataTransfer();
            oversizedFiles.forEach((file) => dataTransfer.items.add(file));

            setIsInvalid(true);
            onSizeLimitExceed(dataTransfer.files);
        }

        // Handle accepted files
        if (acceptedFiles.length > 0 && typeof onDropFiles === "function") {
            const dataTransfer = new DataTransfer();
            acceptedFiles.forEach((file) => dataTransfer.items.add(file));
            onDropFiles(dataTransfer.files);
        }

        // Handle unaccepted files
        if (unacceptedFiles.length > 0) {
            setIsInvalid(true);
            if (typeof onDropUnacceptedFiles === "function") {
                const unacceptedDataTransfer = new DataTransfer();
                unacceptedFiles.forEach((file) => unacceptedDataTransfer.items.add(file));
                onDropUnacceptedFiles(unacceptedDataTransfer.files);
            }
        }

        // Clear the input value to ensure the same file can be selected again
        if (inputRef.current) {
            inputRef.current.value = "";
        }
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        if (isDisabled) return;

        event.preventDefault();
        event.stopPropagation();
        setIsDraggingOver(false);
        processFiles(Array.from(event.dataTransfer.files));
    };

    const handleInputFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        processFiles(Array.from(event.target.files || []));
    };

    const openPicker = () => {
        if (!isDisabled) inputRef.current?.click();
    };

    const accepted = describeAccept(accept);
    const title = isDraggingOver ? "Suelta para añadir" : (hint ?? (allowsMultiple ? "Arrastra tus archivos aquí" : "Arrastra tu archivo aquí"));

    return (
        <div
            data-dropzone
            role="button"
            tabIndex={isDisabled ? -1 : 0}
            aria-disabled={isDisabled || undefined}
            aria-describedby={`${id}-info`}
            onClick={openPicker}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openPicker();
                }
            }}
            onDragOver={handleDragIn}
            onDragEnter={handleDragIn}
            onDragLeave={handleDragOut}
            onDragEnd={handleDragOut}
            onDrop={handleDrop}
            className={cx(
                "group relative flex min-h-56 cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-primary bg-primary px-6 py-8 text-center outline-focus-ring transition duration-100 ease-linear hover:border-brand hover:bg-brand-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2",
                isDraggingOver && "border-brand bg-brand-primary/60",
                isInvalid && !isDraggingOver && "border-error_subtle",
                isDisabled && "cursor-not-allowed opacity-50 hover:border-primary hover:bg-primary",
                className,
            )}
        >
            <FeaturedIcon
                icon={UploadCloud02}
                color="brand"
                theme="light"
                size="lg"
                className={cx("transition duration-150 ease-out", isDraggingOver && "scale-110")}
            />

            <div className="flex flex-col items-center gap-3">
                <p className="text-md font-semibold text-primary">{title}</p>
                <input
                    ref={inputRef}
                    id={id}
                    type="file"
                    className="sr-only"
                    tabIndex={-1}
                    disabled={isDisabled}
                    accept={accept}
                    multiple={allowsMultiple}
                    onChange={handleInputFileChange}
                    onClick={(event) => event.stopPropagation()}
                />
                {/* Looks like a button; the whole zone is the control. */}
                <span className="inline-flex items-center rounded-lg bg-brand-solid px-3.5 py-2 text-sm font-semibold text-white shadow-xs transition duration-100 ease-linear group-hover:bg-brand-solid_hover">
                    {allowsMultiple ? "Elegir archivos" : "Elegir archivo"}
                </span>
                <p id={`${id}-info`} className={cx("text-xs text-tertiary", isInvalid && "font-medium text-error-primary")}>
                    {isInvalid && accepted ? `Formato no admitido. ${accepted}.` : [accepted, "se procesan en tu equipo"].filter(Boolean).join(" · ")}
                </p>
            </div>
        </div>
    );
};
