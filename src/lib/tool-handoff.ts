"use client";

/**
 * Passes the PDF a tool has just produced to the next tool without a download and a new upload. The file only lives in
 * this tab's memory: the result screen leaves it here, the app navigates, and the next tool's drop zone picks it up.
 */

type Handoff = { slug: string; file: File };

let pending: Handoff | null = null;

/** Tools offered as a next step, most common first. They all take a single PDF. */
const NEXT_TOOL_ORDER = [
    "compress",
    "sign",
    "protect",
    "edit",
    "watermark",
    "split",
    "merge",
    "reorder",
    "rotate",
    "delete-pages",
    "annotate",
    "redact",
    "pdf-to-image",
    "pdf-to-word",
    "ocr",
];

/** Slugs to offer after `currentSlug`, in order. */
export const nextToolSlugs = (currentSlug: string | null) => NEXT_TOOL_ORDER.filter((slug) => slug !== currentSlug);

/** "/tools/merge" → "merge". */
export const toolSlugFromPath = (pathname: string | null | undefined) => pathname?.match(/\/tools\/([^/?#]+)/)?.[1] ?? null;

/** Result names end in the date ("contrato-fusionado-2026-11-20.pdf"); the next tool adds its own, so drop this one. */
const withoutDate = (filename: string) => filename.replace(/-\d{4}-\d{2}-\d{2}(?=\.pdf$)/i, "");

/** Leaves `blob` ready for the tool `slug`. Navigate to that tool right after. */
export const sendToTool = (slug: string, blob: Blob, filename: string) => {
    pending = { slug, file: new File([blob], withoutDate(filename), { type: "application/pdf" }) };
};

/** The file waiting for the tool `slug`, if any. A file meant for another tool is dropped: the person went elsewhere. */
export const takeHandoff = (slug: string | null): File | null => {
    const handoff = pending;
    pending = null;
    return handoff && handoff.slug === slug ? handoff.file : null;
};
