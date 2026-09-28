// Planar helpers for the graphics interpreter: paths in display space, rectilinear regions (sets of disjoint
// axis-aligned boxes) for fills and clips, and the shape tests that decide whether a path is a plain box, a rounded
// box, a thin (rule-like) shape or genuinely complex vector art.

/** Axis-aligned box in display space (x0 < x1, y0 < y1). */
export type Box = { x0: number; y0: number; x1: number; y1: number };

export type Seg = { kind: "L"; x: number; y: number } | { kind: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

/** One subpath in display space. `rect` marks subpaths built by the `re` operator. */
export type SubPath = { x: number; y: number; segs: Seg[]; closed: boolean; rect?: boolean };

/** A clip: disjoint boxes when it is known exactly; otherwise its bounding box and how much of it the real shape fills. */
/** The outline of a shaped clip: flattened polygons (display space) and the fill rule that makes their inside. */
export type ClipShape = { polys: number[][]; evenOdd: boolean };

export type ClipRegion = {
    boxes: Box[];
    exact: boolean;
    bbox: Box;
    fillRatio: number;
    /** Shaped (curved or slanted) clips in force, all of which a point must be inside; absent when unknown. */
    shapes?: ClipShape[];
};

const MAX_SHAPE_POINTS = 4000;

export const EPS = 0.01;

export const boxW = (b: Box) => b.x1 - b.x0;
export const boxH = (b: Box) => b.y1 - b.y0;
export const boxArea = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

export const intersectBox = (a: Box, b: Box): Box | null => {
    const x0 = Math.max(a.x0, b.x0);
    const y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1);
    const y1 = Math.min(a.y1, b.y1);
    return x1 - x0 > 1e-6 && y1 - y0 > 1e-6 ? { x0, y0, x1, y1 } : null;
};

export const unionBox = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

export const containsBox = (outer: Box, inner: Box, tol = 0.5) =>
    inner.x0 >= outer.x0 - tol && inner.y0 >= outer.y0 - tol && inner.x1 <= outer.x1 + tol && inner.y1 <= outer.y1 + tol;

export const boundsOf = (boxes: Box[]): Box | null => (boxes.length ? boxes.reduce(unionBox) : null);

export const intersectRegions = (a: Box[], b: Box[]): Box[] => {
    const out: Box[] = [];
    for (const p of a)
        for (const q of b) {
            const r = intersectBox(p, q);
            if (r) out.push(r);
        }
    return out;
};

export const clipOf = (boxes: Box[], exact: boolean, fillRatio = 1): ClipRegion => {
    const bbox = boundsOf(boxes) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { boxes, exact, bbox, fillRatio };
};

/** Narrows a clip by a new region; many boxes collapse to their bounds to keep the work bounded. */
export const intersectClip = (clip: ClipRegion, region: ClipRegion): ClipRegion => {
    const boxes = intersectRegions(clip.boxes, region.boxes);
    const exact = clip.exact && region.exact;
    const ratio = Math.min(clip.exact ? 1 : clip.fillRatio, region.exact ? 1 : region.fillRatio);
    const out = boxes.length > 64 ? clipOf([boundsOf(boxes)!], false, ratio) : clipOf(boxes, exact, exact ? 1 : ratio);
    // Shaped clips accumulate (a point must be inside every one); an inexact clip without a known shape ends the record.
    const known = (c: ClipRegion) => c.exact || !!c.shapes;
    if (!exact && known(clip) && known(region)) {
        const shapes = [...(clip.shapes ?? []), ...(region.shapes ?? [])];
        if (shapes.length <= 8 && shapes.reduce((n, s) => n + s.polys.reduce((m, p) => m + p.length / 2, 0), 0) <= MAX_SHAPE_POINTS) out.shapes = shapes;
    }
    return out;
};

/**
 * Horizontal spans [x0, x1) inside a clip shape on the line y (even-odd or nonzero), sorted and disjoint.
 */
export const shapeSpans = (shape: ClipShape, y: number): [number, number][] => {
    const hits: { x: number; dir: number }[] = [];
    for (const p of shape.polys) {
        const n = p.length / 2;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const y0 = p[2 * i + 1];
            const y1 = p[2 * j + 1];
            if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
                const x0 = p[2 * i];
                const x1 = p[2 * j];
                hits.push({ x: x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), dir: y1 > y0 ? 1 : -1 });
            }
        }
    }
    hits.sort((a, b) => a.x - b.x);
    const spans: [number, number][] = [];
    let w = 0;
    for (let k = 0; k < hits.length; k++) {
        const before = shape.evenOdd ? k % 2 === 1 : w !== 0;
        w += hits[k].dir;
        const after = shape.evenOdd ? (k + 1) % 2 === 1 : w !== 0;
        if (!before && after) spans.push([hits[k].x, hits[k].x]);
        else if (before && !after && spans.length) spans[spans.length - 1][1] = hits[k].x;
    }
    return spans.filter(([a, b]) => b > a);
};

// ── Path analysis ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Replaces cubic segments whose control points lie on the chord (straight "curves") with lines. */
export const straighten = (sp: SubPath): SubPath => {
    let px = sp.x;
    let py = sp.y;
    const segs: Seg[] = sp.segs.map((s) => {
        let out: Seg = s;
        if (s.kind === "C") {
            const dx = s.x - px;
            const dy = s.y - py;
            const len = Math.hypot(dx, dy);
            const dist = (x: number, y: number) => (len < 1e-9 ? Math.hypot(x - px, y - py) : Math.abs((x - px) * dy - (y - py) * dx) / len);
            if (dist(s.x1, s.y1) < 0.05 && dist(s.x2, s.y2) < 0.05) out = { kind: "L", x: s.x, y: s.y };
        }
        px = s.x;
        py = s.y;
        return out;
    });
    return { ...sp, segs };
};

export const hasCurves = (sp: SubPath) => sp.segs.some((s) => s.kind === "C");

/** Polyline of a subpath (curves flattened), as [x0, y0, x1, y1, …]. */
export const flatten = (sp: SubPath): number[] => {
    const pts = [sp.x, sp.y];
    let px = sp.x;
    let py = sp.y;
    for (const s of sp.segs) {
        if (s.kind === "L") pts.push(s.x, s.y);
        else {
            const len = Math.hypot(s.x1 - px, s.y1 - py) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2);
            const n = Math.max(2, Math.min(16, Math.ceil(len / 3)));
            for (let i = 1; i <= n; i++) {
                const t = i / n;
                const u = 1 - t;
                pts.push(
                    u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
                    u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
                );
            }
        }
        px = s.x;
        py = s.y;
    }
    return pts;
};

export const polyBounds = (pts: number[]): Box => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
};

/** Absolute area enclosed by a closed polyline (shoelace). */
export const polyArea = (pts: number[]) => {
    let a = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
    }
    return Math.abs(a) / 2;
};

const snap = (v: number) => Math.round(v * 100) / 100;

/** Vertices of a straight-edged subpath when every edge is horizontal or vertical, else null. */
export const rectilinearVertices = (sp: SubPath): number[] | null => {
    if (hasCurves(sp)) return null;
    const pts = [snap(sp.x), snap(sp.y)];
    for (const s of sp.segs) {
        if (s.kind !== "L") return null;
        const x = snap(s.x);
        const y = snap(s.y);
        const lx = pts[pts.length - 2];
        const ly = pts[pts.length - 1];
        if (Math.abs(x - lx) <= EPS && Math.abs(y - ly) <= EPS) continue;
        if (Math.abs(x - lx) > EPS && Math.abs(y - ly) > EPS) return null;
        pts.push(x, y);
    }
    // Closing edge (fills close every subpath implicitly).
    const n = pts.length;
    if (n >= 4 && Math.abs(pts[0] - pts[n - 2]) > EPS && Math.abs(pts[1] - pts[n - 1]) > EPS) return null;
    return pts;
};

/**
 * The filled area of rectilinear polygons as disjoint boxes (nonzero or even-odd rule), or null when the path is
 * not rectilinear or too large to grid.
 */
export const rectilinearRegion = (polys: number[][], evenOdd: boolean): Box[] | null => {
    const xsSet = new Set<number>();
    const ysSet = new Set<number>();
    type VEdge = { x: number; y0: number; y1: number; dir: number };
    const edges: VEdge[] = [];
    for (const p of polys) {
        const n = p.length / 2;
        if (n < 3) continue;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const x0 = p[2 * i];
            const y0 = p[2 * i + 1];
            const x1 = p[2 * j];
            const y1 = p[2 * j + 1];
            xsSet.add(x0);
            ysSet.add(y0);
            if (Math.abs(x0 - x1) <= EPS && Math.abs(y0 - y1) > EPS) edges.push({ x: x0, y0: Math.min(y0, y1), y1: Math.max(y0, y1), dir: y1 > y0 ? 1 : -1 });
        }
    }
    const xs = [...xsSet].sort((a, b) => a - b);
    const ys = [...ysSet].sort((a, b) => a - b);
    if (xs.length < 2 || ys.length < 2) return [];
    if (xs.length * ys.length > 40000 || edges.length > 4000) return null;
    // Fast path: a single rectangle.
    if (polys.length === 1 && xs.length === 2 && ys.length === 2) return [{ x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] }];
    const rows: { y0: number; y1: number; spans: [number, number][] }[] = [];
    for (let j = 0; j + 1 < ys.length; j++) {
        const cy = (ys[j] + ys[j + 1]) / 2;
        const crossing = edges.filter((e) => e.y0 < cy && e.y1 > cy).sort((a, b) => a.x - b.x);
        const spans: [number, number][] = [];
        // Winding of the cell left of each crossing: sum of the directions of the edges to its right.
        let w = crossing.reduce((s, e) => s + e.dir, 0);
        let start: number | null = null;
        let ei = 0;
        for (let i = 0; i + 1 < xs.length; i++) {
            const cx = (xs[i] + xs[i + 1]) / 2;
            while (ei < crossing.length && crossing[ei].x < cx) {
                w -= crossing[ei].dir;
                ei++;
            }
            const inside = evenOdd ? Math.abs(w) % 2 === 1 : w !== 0;
            if (inside && start === null) start = xs[i];
            if (!inside && start !== null) {
                spans.push([start, xs[i]]);
                start = null;
            }
        }
        if (start !== null) spans.push([start, xs[xs.length - 1]]);
        rows.push({ y0: ys[j], y1: ys[j + 1], spans });
    }
    // Merge vertically: a span continues the box above when it has the same x extent.
    const out: Box[] = [];
    let open: Box[] = [];
    for (const row of rows) {
        const next: Box[] = [];
        for (const [x0, x1] of row.spans) {
            const prev = open.find((b) => b.x0 === x0 && b.x1 === x1 && Math.abs(b.y1 - row.y0) < 1e-9);
            if (prev) {
                prev.y1 = row.y1;
                next.push(prev);
            } else {
                const b = { x0, y0: row.y0, x1, y1: row.y1 };
                out.push(b);
                next.push(b);
            }
        }
        open = next;
    }
    return out.filter((b) => b.x1 - b.x0 > 1e-6 && b.y1 - b.y0 > 1e-6);
};

/**
 * A closed subpath that is a box with rounded corners (all straight edges axis-aligned, curves only in the corners,
 * and real straight sides — circles and ellipses are not boxes).
 */
export const isRoundedBox = (sp: SubPath): boolean => {
    if (!hasCurves(sp)) return false;
    const pts = flatten(sp);
    const b = polyBounds(pts);
    const w = boxW(b);
    const h = boxH(b);
    if (w < 1 || h < 1) return false;
    const r = Math.min(w, h) / 2 + 0.01;
    let px = sp.x;
    let py = sp.y;
    let straight = 0;
    let curves = 0;
    const inCorner = (x: number, y: number) => Math.min(x - b.x0, b.x1 - x) <= r && Math.min(y - b.y0, b.y1 - y) <= r;
    for (const s of sp.segs) {
        if (s.kind === "L") {
            const dx = Math.abs(s.x - px);
            const dy = Math.abs(s.y - py);
            if (dx > 0.05 && dy > 0.05) return false;
            straight += dx + dy;
        } else {
            curves++;
            if (!inCorner(px, py) || !inCorner(s.x1, s.y1) || !inCorner(s.x2, s.y2) || !inCorner(s.x, s.y)) return false;
        }
        px = s.x;
        py = s.y;
    }
    // Closing edge.
    const dx = Math.abs(sp.x - px);
    const dy = Math.abs(sp.y - py);
    if (dx > 0.05 && dy > 0.05) return false;
    straight += dx + dy;
    return curves <= 16 && straight >= 0.2 * 2 * (w + h);
};
