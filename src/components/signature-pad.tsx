"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { cx } from "@/utils/cx";

export type SignaturePoint = { x: number; y: number };
/** One continuous line, in CSS pixels of the pad. */
export type SignatureStroke = SignaturePoint[];
/** A transparent PNG ready to be placed on a page. */
export type SignatureImage = { dataUrl: string; widthPx: number; heightPx: number };

const LINE_WIDTH = 2.6;

/**
 * Draws strokes as one smooth path each: straight to the first midpoint, quadratic curves through every point, and a
 * final segment to the last point. The pad draws live segments with exactly the same maths, so redraws never shift.
 */
const drawStrokes = (ctx: CanvasRenderingContext2D, strokes: SignatureStroke[], color: string, lineWidth = LINE_WIDTH) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
        if (stroke.length === 0) continue;
        if (stroke.length === 1) {
            ctx.beginPath();
            ctx.arc(stroke[0].x, stroke[0].y, lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
            continue;
        }
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) {
            const prev = stroke[i - 1];
            const p = stroke[i];
            ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
        }
        const last = stroke[stroke.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
    }
};

/** Transparent PNG of the strokes, cropped to the ink and rendered at `scale`× so it stays sharp once placed. */
export const renderStrokesToPng = (strokes: SignatureStroke[], color: string, scale = 3): SignatureImage | null => {
    const points = strokes.flat();
    if (points.length === 0 || typeof document === "undefined") return null;
    const pad = LINE_WIDTH + 2;
    const minX = Math.min(...points.map((p) => p.x)) - pad;
    const minY = Math.min(...points.map((p) => p.y)) - pad;
    const maxX = Math.max(...points.map((p) => p.x)) + pad;
    const maxY = Math.max(...points.map((p) => p.y)) + pad;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((maxX - minX) * scale);
    canvas.height = Math.ceil((maxY - minY) * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
    drawStrokes(ctx, strokes, color);
    return { dataUrl: canvas.toDataURL("image/png"), widthPx: canvas.width, heightPx: canvas.height };
};

/** Handwriting-like fonts that ship with Windows, macOS, iOS and Android, with the generic fallback last. */
export const HANDWRITING_FONT = '"Segoe Script", "Lucida Handwriting", "Snell Roundhand", "Apple Chancery", "Brush Script MT", "Dancing Script", cursive';

/** Transparent PNG of a typed name in a handwriting font. */
export const renderTypedSignature = (text: string, color: string, fontFamily = HANDWRITING_FONT): SignatureImage | null => {
    const value = text.trim();
    if (!value || typeof document === "undefined") return null;
    const size = 120;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const font = `${size}px ${fontFamily}`;
    ctx.font = font;
    const metrics = ctx.measureText(value);
    const ascent = metrics.actualBoundingBoxAscent || size * 0.8;
    const descent = metrics.actualBoundingBoxDescent || size * 0.3;
    const left = metrics.actualBoundingBoxLeft || 0;
    const right = metrics.actualBoundingBoxRight || metrics.width;
    const pad = 12;
    canvas.width = Math.ceil(left + right + pad * 2);
    canvas.height = Math.ceil(ascent + descent + pad * 2);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(value, pad + left, pad + ascent);
    return { dataUrl: canvas.toDataURL("image/png"), widthPx: canvas.width, heightPx: canvas.height };
};

/**
 * Turns a photo or scan of a signature into a transparent PNG: near-white paper becomes transparent (optional) and the
 * result is cropped to the ink. Returns null when nothing is left.
 */
export const processSignatureImage = async (file: Blob, removeBackground: boolean): Promise<SignatureImage | null> => {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (removeBackground) {
                const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                // Paper (≥ 225) disappears; light greys fade out so the edges stay smooth.
                if (luminance >= 225) data[i + 3] = 0;
                else if (luminance > 170) data[i + 3] = Math.round(data[i + 3] * ((225 - luminance) / 55));
            }
            if (data[i + 3] > 24) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    ctx.putImageData(image, 0, 0);
    const pad = 4;
    const cropX = Math.max(0, minX - pad);
    const cropY = Math.max(0, minY - pad);
    const cropW = Math.min(width, maxX + pad + 1) - cropX;
    const cropH = Math.min(height, maxY + pad + 1) - cropY;
    const out = document.createElement("canvas");
    out.width = cropW;
    out.height = cropH;
    out.getContext("2d")?.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    return { dataUrl: out.toDataURL("image/png"), widthPx: cropW, heightPx: cropH };
};

/**
 * Handwriting pad. Controlled: the strokes live in the parent, so the drawing survives window resizes, phone rotation
 * and remounts, and exporting never depends on what is visible. The surface stands for paper: white in both themes.
 */
export const SignaturePad = ({
    strokes,
    onStrokesChange,
    color = "#111827",
    height = 180,
    className,
    label = "Recuadro para dibujar la firma",
    describedBy,
}: {
    strokes: SignatureStroke[];
    onStrokesChange: (strokes: SignatureStroke[]) => void;
    color?: string;
    height?: number;
    className?: string;
    label?: string;
    describedBy?: string;
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const current = useRef<SignatureStroke | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    // Follow the element's real size (window resize, rotation, layout changes) and redraw instead of wiping.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    const context = () => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return null;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !size.width || !size.height) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(size.width * dpr);
        const h = Math.round(size.height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = context();
        if (!ctx) return;
        ctx.clearRect(0, 0, size.width, size.height);
        drawStrokes(ctx, current.current ? [...strokes, current.current] : strokes, color);
    }, [size, strokes, color]);

    const pointFrom = (event: { clientX: number; clientY: number }) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        canvasRef.current?.setPointerCapture(event.pointerId);
        const p = pointFrom(event);
        current.current = [p];
        const ctx = context();
        if (ctx) drawStrokes(ctx, [[p]], color);
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const stroke = current.current;
        if (!stroke) return;
        const ctx = context();
        // Coalesced events carry every sample the pointer produced between frames: fast strokes stay continuous.
        const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const sample of samples.length ? samples : [event.nativeEvent]) {
            const p = pointFrom(sample);
            const prev = stroke[stroke.length - 1];
            if (Math.hypot(p.x - prev.x, p.y - prev.y) < 0.6) continue;
            if (ctx) {
                const from = stroke.length === 1 ? prev : { x: (stroke[stroke.length - 2].x + prev.x) / 2, y: (stroke[stroke.length - 2].y + prev.y) / 2 };
                ctx.strokeStyle = color;
                ctx.lineWidth = LINE_WIDTH;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                ctx.moveTo(from.x, from.y);
                ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
                ctx.stroke();
            }
            stroke.push(p);
        }
    };

    const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const stroke = current.current;
        if (!stroke) return;
        current.current = null;
        try {
            canvasRef.current?.releasePointerCapture(event.pointerId);
        } catch {
            /* already released */
        }
        onStrokesChange([...strokes, stroke]);
    };

    return (
        <div data-signature-pad className={cx("relative overflow-hidden rounded-xl bg-white shadow-xs ring-1 ring-secondary", className)} style={{ height }}>
            <canvas
                ref={canvasRef}
                role="img"
                aria-label={label}
                aria-describedby={describedBy}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finish}
                onPointerCancel={finish}
                className="block size-full cursor-crosshair touch-none"
            />
            {/* Fixed paper colours on purpose: the pad is always white, whatever the theme. */}
            <div aria-hidden="true" className="pointer-events-none absolute right-4 bottom-9 left-4 h-px bg-neutral-300" />
            <span aria-hidden="true" className="pointer-events-none absolute bottom-3 left-4 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Firma aquí
            </span>
        </div>
    );
};
