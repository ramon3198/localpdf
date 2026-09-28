"use client";

import type * as PDFJS from "pdfjs-dist";

let cached: typeof PDFJS | null = null;

/** Lazily import pdfjs-dist and wire the worker once. */
export const getPdfjs = async (): Promise<typeof PDFJS> => {
    if (cached) return cached;
    const pdfjs = await import("pdfjs-dist");
    // Resolve the worker URL via the package's own ESM entry — Turbopack & Webpack both honour
    // `new URL(..., import.meta.url)` and produce a hashed asset URL pointing at the worker file.
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString();
    cached = pdfjs;
    return pdfjs;
};
