"use client";

/** Parse a string like "1-3, 5, 8-10" into a sorted, deduplicated, 1-based page list. */
export const parsePageRanges = (input: string, totalPages: number): { pages: number[]; error?: string } => {
    const trimmed = input.trim();
    if (!trimmed) return { pages: [], error: "Introduce al menos un rango." };

    const pages = new Set<number>();
    const segments = trimmed.split(/[,\s]+/).filter(Boolean);
    for (const seg of segments) {
        const match = seg.match(/^(\d+)(?:-(\d+))?$/);
        if (!match) return { pages: [], error: `"${seg}" no es un rango válido.` };
        const from = parseInt(match[1], 10);
        const to = match[2] ? parseInt(match[2], 10) : from;
        if (from < 1 || to < 1 || from > totalPages || to > totalPages) {
            return { pages: [], error: `Las páginas deben estar entre 1 y ${totalPages}.` };
        }
        const [a, b] = from <= to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) pages.add(i);
    }
    return { pages: Array.from(pages).sort((a, b) => a - b) };
};

/** Trigger a browser download for a Blob with the given filename. */
export const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
};

/** Generate a filename with the current ISO date suffix. */
export const datedFilename = (base: string, ext: string) => {
    const date = new Date().toISOString().slice(0, 10);
    return `${base}-${date}.${ext}`;
};

/** Format bytes as a human-readable string ("840 KB", "1,4 MB"): one decimal from MB up, Spanish decimal comma. */
export const readableBytes = (bytes: number) => {
    if (!bytes) return "0 KB";
    const suffixes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(suffixes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    // Small values keep a decimal so before/after sizes stay distinguishable ("1,7 KB → 1,3 KB").
    return `${value.toLocaleString("es", { maximumFractionDigits: i >= 2 || value < 10 ? 1 : 0 })} ${suffixes[i]}`;
};

/** "1 página", "12 páginas". */
export const plural = (count: number, one: string, many: string) => `${count.toLocaleString("es")} ${count === 1 ? one : many}`;
export const pagesLabel = (count: number) => plural(count, "página", "páginas");

/** An error whose message is already written for the user (Spanish, no jargon). */
export class UserFacingError extends Error {}

export const PROTECTED_PDF_MESSAGE = "Este PDF está protegido con contraseña. Quítale la protección con «Desproteger PDF» y vuelve a intentarlo.";
export const DAMAGED_PDF_MESSAGE = "El archivo no es un PDF válido o está dañado.";
export const UNSUPPORTED_PROTECTION_MESSAGE =
    "Este PDF usa un tipo de protección que no se puede quitar aquí, como un certificado digital. Pide una copia sin proteger a quien lo creó.";

/** Spanish message for anything pdf-lib, pdf.js or tesseract.js may throw. Never shows raw library text. */
export const friendlyError = (error: unknown, fallback = "No se pudo procesar el archivo. Inténtalo de nuevo.") => {
    if (error instanceof UserFacingError) return error.message;
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
    if (/unknown encryption|unsupported (encryption|security)|PubSec|certificate/i.test(message)) return UNSUPPORTED_PROTECTION_MESSAGE;
    if (/password|encrypt/i.test(message)) return PROTECTED_PDF_MESSAGE;
    if (/Failed to parse|PDF header|Invalid ?PDF|InvalidPDFException|xref|trailer|MissingPDF|not a PDF/i.test(message)) {
        return DAMAGED_PDF_MESSAGE;
    }
    if (/memory|allocation|Maximum call stack|too large/i.test(message)) return "El documento es demasiado grande para procesarlo en este navegador.";
    if (/network|Failed to fetch|NetworkError|load failed/i.test(message))
        return "No se pudo descargar un componente necesario. Revisa tu conexión a internet.";
    return fallback;
};

/**
 * Load a PDF with pdf-lib to modify it. Encrypted files are refused with a clear message: pdf-lib can't decrypt them,
 * and saving one produces a corrupt or blank document behind a success screen.
 */
export const loadPdfForEditing = async (source: File | Blob | ArrayBuffer | Uint8Array, options: { updateMetadata?: boolean } = {}) => {
    const { PDFDocument } = await import("pdf-lib");
    const bytes = source instanceof Blob ? await source.arrayBuffer() : source;
    let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
    try {
        doc = await PDFDocument.load(bytes, { ignoreEncryption: true, ...options });
    } catch (error) {
        throw new UserFacingError(friendlyError(error, DAMAGED_PDF_MESSAGE));
    }
    if (doc.isEncrypted) throw new UserFacingError(PROTECTED_PDF_MESSAGE);
    return doc;
};
