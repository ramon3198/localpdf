/**
 * PageTextEditor — true in-place text replacement inside a page's content stream(s).
 *
 * For each edit it:
 *   1. locates the glyphs of the target run (pdfjs TextItem) by geometry and validates them by text;
 *   2. rewrites only the text-showing operators that contain them: removed glyphs become exact TJ
 *      displacements (so every other glyph keeps its position), and the new text is inserted at the
 *      first removed glyph, in the same text object, with the same font/size/colour/spacing state;
 *   3. re-interprets the page and verifies that every untouched glyph is exactly where it was and
 *      the new glyphs start at the original origin. Any discrepancy → the edit is rolled back and
 *      reported as failed so the caller can use a safe fallback.
 *
 * No rectangle is painted: the page background, gradients, images and neighbouring lines are never
 * touched, and text extraction returns the new text (no "ghost" of the old one).
 */
import { PDFArray, type PDFContext, PDFDict, type PDFDocument, type PDFFont, PDFName, type PDFObject, type PDFRef, PDFStream } from "pdf-lib";
import { type ContentOp, type Operand, formatNumber, hexOf, num, parseContentStream, serializeOp, str } from "./content-lexer";
import { type EncodedChar, FontModel, type FontRegistry, type Glyph } from "./font-model";
import { type Interpretation, type Placement, type StreamCtx, interpretPage } from "./text-interpreter";

export type RunTarget = {
    /** pdfjs TextItem.transform (PDF user space, no viewport). */
    transform: number[];
    /** pdfjs TextItem.width — user-space advance along the text direction. */
    width: number;
    str: string;
};

export type FallbackRequest = {
    /** Best available name of the original font (BaseFont, or FontDescriptor FontName/FontFamily). */
    baseFont: string;
    /** Family slug from the FontDescriptor or name (e.g. "anton", "inter"). */
    family: string;
    weight: number;
    bold: boolean;
    italic: boolean;
    serif: boolean;
    mono: boolean;
    /** Second chance: the typeface match lacked a glyph — return a Standard 14 face. */
    standardOnly?: boolean;
    /** Last resort, character by character: a wide-coverage face (Greek, Cyrillic, arrows, maths, symbols). */
    universal?: boolean;
};
export type FallbackProvider = (req: FallbackRequest) => Promise<PDFFont | null>;

export type EditStyle = {
    /** DeviceRGB override (0..1) — null keeps the original colour. */
    color?: [number, number, number] | null;
    /** Multiplier applied to the original font size (1 = unchanged). */
    sizeScale?: number | null;
    /** Weight/style differing from the original run (null = keep the original font). */
    forceStyle?: { bold: boolean; italic: boolean } | null;
};

export type EditRequest = { target: RunTarget; newText: string; style?: EditStyle };

export type EditResult =
    /** `invisible`: the run was an invisible text layer (OCR); it was rewritten, but the visible pixels are an image. */
    | {
          ok: true;
          fallbackChars: number;
          usedSiblingFont: boolean;
          invisible?: boolean;
          /** Only the changed characters were rewritten. */
          partial?: boolean;
          /** Number of overprinted copies rewritten (fill/stroke layers, shadow, fake bold). */
          copies?: number;
          /** Part of the new text falls outside the clip (e.g. a table cell) and won't show. */
          clipped?: boolean;
      }
    | { ok: false; reason: string; invisible?: boolean };

const N = (s: string) => PDFName.of(s);
/** PDF text string → JS string (UTF-16BE with BOM, else PDFDocEncoding ≈ Latin-1). */
const decodeTextString = (b: Uint8Array) => {
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        let s = "";
        for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
        return s;
    }
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return s;
};
const encodeTextString = (s: string) => {
    const out = new Uint8Array(2 + s.length * 2);
    out[0] = 0xfe;
    out[1] = 0xff;
    for (let i = 0; i < s.length; i++) {
        out[2 + i * 2] = s.charCodeAt(i) >> 8;
        out[3 + i * 2] = s.charCodeAt(i) & 0xff;
    }
    return out;
};
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];
/** True when the text position was set absolutely (Tm, or a new BT) since the last operator that drew text before
 *  op `i` — relative moves in between don't matter: whatever shift came before is lost. */
const positionReset = (ops: ContentOp[], i: number) => {
    for (let k = i - 1; k >= 0; k--) {
        const o = ops[k].op;
        if (o === "Tm" || o === "BT") return true;
        if (o === "Tj" || o === "TJ" || o === "'" || o === '"') return false;
    }
    return true;
};
/** True when op `i` is positioned by a relative line move (Td, TD, T*, or a quote operator) rather than continuing
 *  by advance from the previous glyphs. */
const startsRelative = (ops: ContentOp[], i: number) => {
    if (ops[i].op === "'" || ops[i].op === '"') return true;
    for (let k = i - 1; k >= 0; k--) {
        const o = ops[k].op;
        if (o === "Td" || o === "TD" || o === "T*" || o === "Tm" || o === "BT") return true;
        if (o === "Tj" || o === "TJ" || o === "'" || o === '"') return false;
    }
    return true;
};
/** A glyph's own advance, without the letter- and word-spacing (Tc, Tw) that follows it: where its ink ends, which
 *  is what alignment compares (inserted glyphs carry letter-spacing in Tc, original ones may carry it in Td). */
const inkAdvance = (g: Placement) => (g.advPre ? (g.advUser * g.glyph.w0 * g.state.Tfs) / g.advPre : g.advUser);
/** Advance without the word spacing (Tw) that justification adds to space glyphs: what a plain space measures. */
const plainAdvance = (g: Placement) => (g.advPre && g.glyph.isSpace && g.state.Tw ? (g.advUser * (g.advPre - g.state.Tw)) / g.advPre : g.advUser);
/** First and last glyphs that leave ink (Word ends lines with a space glyph that must not count as the edge). */
const inkEnds = (seg: Placement[]): [Placement, Placement] => {
    const ink = (g: Placement) => !g.glyph.isSpace && !/^\s*$/.test(g.glyph.unicode ?? "x");
    return [seg.find(ink) ?? seg[0], [...seg].reverse().find(ink) ?? seg[seg.length - 1]];
};
/** Text rise (Ts) of a glyph in user space: superscripts sit on the same line as their base text. */
const riseOf = (g: Placement) => (g.state.Tfs ? (g.state.Ts * g.sizeUser) / g.state.Tfs : 0);
/** The fill colour operators rewritten to set the stroke colour instead (rg→RG, g→G, k→K, cs/sc/scn→CS/SC/SCN). */
const fillAsStroke = (fill: string) =>
    fill
        .split("\n")
        .map((l) => l.replace(/\b(rg|g|k|cs|sc|scn)$/, (o) => o.toUpperCase()))
        .join("\n");
/** A text-showing operator that draws no glyph (a TJ of numbers only): it just moves the text position. */
const drawsNothing = (op: ContentOp) =>
    op.op === "TJ"
        ? op.args[0]?.t === "arr" && op.args[0].items.every((it) => it.t !== "str" || it.bytes.length === 0)
        : op.op === "Tj" && op.args[0]?.t === "str" && op.args[0].bytes.length === 0;
/** Glyphs on one line: same baseline (after Ts rise), or a smaller glyph raised or lowered next to it (superscripts,
 *  subscripts and footnote marks placed with their own Td/Tm). */
const onSameLine = (prev: Placement, g: Placement, ax: number, ay: number) => {
    const off = (g.origin[0] - prev.origin[0]) * -ay + (g.origin[1] - prev.origin[1]) * ax - riseOf(g) + riseOf(prev);
    const big = Math.max(g.sizeUser, prev.sizeUser);
    if (Math.abs(off) <= 0.1 * (prev.sizeUser || 1)) return true;
    return Math.min(g.sizeUser, prev.sizeUser) <= 0.85 * big && Math.abs(off) <= 0.6 * big;
};
const normText = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const latin1 = (b: Uint8Array) => {
    let s = "";
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return s;
};
const fromLatin1 = (s: string) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};

export { describeFont } from "./font-style";

type Seg = { font: "orig" | { name: string; model: DecodableFont; pdfFont?: PDFFont }; chars: EncodedChar[] };

/** Anything the interpreter can decode — real FontModel or a virtual one for newly embedded fonts. */
type DecodableFont = Pick<FontModel, "decode" | "markUsed">;

/** Decoder for a pdf-lib font that is only embedded at save time: we know exactly which codes we wrote. */
class VirtualFont {
    readonly widths = new Map<number, number>();
    readonly unicode = new Map<number, string>();
    constructor(readonly byteLen: number) {}
    decode(bytes: Uint8Array): Glyph[] {
        const out: Glyph[] = [];
        for (let i = 0; i + this.byteLen <= bytes.length; i += this.byteLen) {
            let code = 0;
            for (let k = 0; k < this.byteLen; k++) code = code * 256 + bytes[i + k];
            out.push({
                code,
                bytes: bytes.slice(i, i + this.byteLen),
                w0: this.widths.get(code) ?? 0,
                unicode: this.unicode.get(code) ?? null,
                isSpace: this.byteLen === 1 && code === 32,
            });
        }
        return out;
    }
    markUsed() {}
}

export class PageTextEditor {
    private readonly context: PDFContext;
    private readonly pageDict: PDFDict;
    private overrides = new Map<string, Uint8Array>();
    private interp: Interpretation;
    private readonly fallbackNames = new Map<string, Map<PDFFont, string>>();
    private readonly virtualFonts = new Map<PDFFont, VirtualFont>();
    /** Edits whose lines must get their alignment back once every edit of the page is in (first glyph, glyph delta). */
    private alignQueue: { firstSeq: number; dn: number }[] = [];

    constructor(
        private readonly doc: PDFDocument,
        readonly pageIndex: number,
        private readonly registry: FontRegistry,
        private readonly fallback: FallbackProvider,
        /** Learn glyph coverage from the rest of the document; returns false if already done. */
        private readonly scanDocument: () => boolean = () => false,
    ) {
        this.context = doc.context;
        this.pageDict = doc.getPage(pageIndex).node;
        this.interp = this.interpret();
    }

    private pageResources(): PDFDict | null {
        const r = this.pageDict.lookup(N("Resources"));
        if (r instanceof PDFDict) return r;
        // Inherited resources: give the page its own shallow copy so additions stay local.
        const inherited = (this.pageDict as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
        if (inherited instanceof PDFDict) {
            const copy = inherited.clone(this.context);
            this.pageDict.set(N("Resources"), copy);
            return copy;
        }
        return null;
    }

    private interpret(overrides = this.overrides): Interpretation {
        return interpretPage(this.context, this.pageDict, this.pageResources(), this.registry, overrides);
    }

    /** All glyph placements currently on the page (content order). */
    get placements(): Placement[] {
        return this.interp.placements;
    }

    /** Optional diagnostics sink (why a minimal-diff attempt fell back, etc.). */
    debug: ((msg: string) => void) | null = null;
    private skip(reason: string): null {
        this.debug?.(reason);
        return null;
    }
    private skipFalse(reason: string): false {
        this.debug?.(reason);
        return false;
    }

    // ── Matching ─────────────────────────────────────────────────────────────────────────────────

    locate(
        target: RunTarget,
        placements = this.interp.placements,
    ): { glyphs: Placement[]; copies: Placement[][]; invisible: boolean } | { error: string; invisible?: boolean } {
        const [a, b, c, d, e, f] = target.transform;
        const xl = Math.hypot(a, b);
        if (!xl) return { error: "degenerate transform" };
        const ux: [number, number] = [a / xl, b / xl];
        const vx: [number, number] = [-ux[1], ux[0]];
        const fs = Math.hypot(c, d) || xl;
        const W = Math.max(0, target.width);
        const eps = Math.max(0.02 * fs, 0.05);

        const glyphs = placements.filter((p) => {
            if (dot(p.xAxis, ux) < 0.985) return false;
            if (Math.abs(p.sizeUser - fs) > 0.2 * fs + 0.3) return false;
            const rel: [number, number] = [p.origin[0] - e, p.origin[1] - f];
            if (Math.abs(dot(rel, vx)) > 0.3 * fs) return false;
            const u = dot(rel, ux);
            const center = u + p.advUser / 2;
            return center >= -eps && center <= W + eps && u >= -0.3 * fs;
        });
        if (!glyphs.length) return { error: "run not found in content stream" };
        const invisible = glyphs.every((p) => p.state.Tr === 3 || p.state.Tr === 7);

        // Text validation — never rewrite glyphs that don't spell the target.
        const want = normText(target.str);
        const unicodes = glyphs.map((p) => p.glyph.unicode);
        const got = normText(unicodes.map((u) => u ?? "�").join(""));
        const knownAll = unicodes.every((u) => u !== null);
        let textOk = got === want;
        if (!textOk && want && got.length % want.length === 0 && got === want.repeat(got.length / want.length)) textOk = true; // overprinted (fake bold)
        if (!textOk && !knownAll) {
            const nonSpace = glyphs.filter((p) => !(p.glyph.unicode && /^\s+$/.test(p.glyph.unicode))).length;
            textOk = nonSpace === want.length;
        }
        if (!textOk) return { error: `text mismatch (pdf="${got}" vs item="${want}")` };

        // Overprinted copies (fill + stroke layers, text-shadow, fake bold) each spell the target: split them so every
        // copy is rewritten in its own graphics state (colour, alpha, stroke, offset).
        const sorted = glyphs.slice().sort((x, y) => x.seq - y.seq);
        let copies: Placement[][] = [sorted];
        if (knownAll && want && got !== want) {
            copies = [];
            let cur: Placement[] = [];
            let acc = "";
            for (const p of sorted) {
                cur.push(p);
                acc += normText(p.glyph.unicode ?? "");
                if (acc === want) {
                    copies.push(cur);
                    cur = [];
                    acc = "";
                } else if (!want.startsWith(acc)) return { error: "overprinted copies are interleaved" };
            }
            if (cur.length) {
                if (acc !== "" || !copies.length) return { error: "incomplete overprinted copy" };
                copies[copies.length - 1].push(...cur); // trailing whitespace glyphs
            }
        }

        // Geometry validation per copy: our advances must reproduce the run width pdfjs measured.
        const strSpaces = (target.str.match(/\s/g) ?? []).length;
        for (const copy of copies) {
            const us = copy.map((p) => dot([p.origin[0] - e, p.origin[1] - f], ux));
            const span = Math.max(...copy.map((p, i) => us[i] + p.advUser)) - Math.min(...us);
            // pdfjs sometimes attaches a neighbouring space (e.g. from the next Tj at another rise) or inserts
            // pseudo-spaces for letter-spacing: allow for whitespace in item.str that we did not match.
            const matchedSpaces = copy.filter((p) => p.glyph.isSpace || (p.glyph.unicode !== null && /^\s+$/.test(p.glyph.unicode))).length;
            const tol = Math.max(0.03 * W, 0.25 * fs) + Math.max(0, strSpaces - matchedSpaces) * 0.75 * fs;
            if (W > 0 && Math.abs(span - W) > tol) return { error: `width mismatch (${span.toFixed(2)} vs ${W.toFixed(2)})`, invisible };
        }
        return { glyphs: sorted, copies, invisible };
    }

    // ── Replacement ──────────────────────────────────────────────────────────────────────────────

    /** Apply several edits on this page. Edits are processed from the last run to the first (content order) so
     *  earlier runs keep their glyph sequence numbers while later ones are rewritten. */
    async applyAll(edits: EditRequest[], opts: { allowInvisible?: boolean } = {}): Promise<EditResult[]> {
        const results: EditResult[] = new Array(edits.length);
        const original = this.interp;
        const clippedOriginal = this.clippedGlyphs();
        // Order by content position (last first): rewrites only affect glyphs at/after their run, and untouched glyphs
        // never move (verified), so every later edit can be re-located on the current state.
        const order = edits
            .map((ed, i) => {
                const loc = this.locate(ed.target);
                return { i, ed, key: "glyphs" in loc ? loc.glyphs[0].seq : -1 };
            })
            .sort((x, y) => y.key - x.key);
        for (const { i, ed } of order) {
            const loc = this.locate(ed.target);
            if ("error" in loc) {
                results[i] = { ok: false, reason: loc.error, invisible: loc.invisible };
                continue;
            }
            if (loc.invisible && !opts.allowInvisible) {
                results[i] = { ok: false, reason: "invisible text (OCR layer)", invisible: true };
                continue;
            }
            // All copies of one edit succeed or none does.
            const snapshot = { overrides: this.overrides, interp: this.interp, queued: this.alignQueue.length };
            let agg: EditResult = { ok: true, fallbackChars: 0, usedSiblingFont: false, partial: true };
            try {
                for (const copy of loc.copies.slice().sort((x, y) => y[0].seq - x[0].seq)) {
                    const r = await this.replaceSeqs(
                        copy.map((p) => p.seq),
                        ed.newText,
                        ed.style ?? {},
                        ed.target.str,
                        loc.copies.length === 1, // overprinted layers interleave: never reflow their lines
                    );
                    if (!r.ok) {
                        agg = r;
                        break;
                    }
                    agg = {
                        ok: true,
                        fallbackChars: Math.max(agg.ok ? agg.fallbackChars : 0, r.fallbackChars),
                        usedSiblingFont: (agg.ok && agg.usedSiblingFont) || r.usedSiblingFont,
                        partial: agg.ok && !!agg.partial && !!r.partial,
                        copies: loc.copies.length > 1 ? loc.copies.length : undefined,
                        clipped: (agg.ok && agg.clipped) || r.clipped || undefined,
                    };
                }
            } catch (err) {
                agg = { ok: false, reason: err instanceof Error ? err.message : String(err) };
            }
            if (!agg.ok) {
                this.overrides = snapshot.overrides;
                this.interp = snapshot.interp;
                this.alignQueue.length = snapshot.queued;
            }
            results[i] = agg.ok && loc.invisible ? { ...agg, invisible: true } : agg;
        }
        // Alignment moves glyphs before the edits too, so it runs last: every edit above was located on untouched
        // glyphs, and a line edited twice is aligned once with its net change.
        this.alignEditedLines(original);
        if (this.clippedGlyphs() <= clippedOriginal) for (const r of results) if (r?.ok && r.clipped) r.clipped = undefined;
        return results;
    }

    private async replaceSeqs(seqs: number[], newText: string, style: EditStyle, targetStr = "", reflowLine = true): Promise<EditResult> {
        const before = new Map(this.interp.placements.map((p) => [p.seq, p]));
        const run = seqs.map((q) => before.get(q)).filter((p): p is Placement => !!p);
        const clippedBefore = this.clippedGlyphs();
        const preInterp = this.interp;
        const res = await this.replaceSeqsCore(seqs, newText, style, targetStr, reflowLine);
        if (!res.ok) return res;
        if (reflowLine && run.length && !res.partial) this.reflowAfterWholeRun(preInterp, run);
        if (reflowLine && run.length) this.alignQueue.push({ firstSeq: run[0].seq, dn: this.interp.placements.length - preInterp.placements.length });
        this.updateActualText(run, newText);
        return this.clippedGlyphs() > clippedBefore ? { ...res, clipped: true } : res;
    }

    /** A whole-run replacement (style change: bold, size…) puts what follows back where it was; when the new text is
     *  wider or narrower, move the rest of the line by the difference, as the minimal-diff path does. */
    private reflowAfterWholeRun(pre: Interpretation, run: Placement[]) {
        const tail = this.flowTail(run, pre);
        if (!tail.length) return;
        const dn = this.interp.placements.length - pre.placements.length;
        const newLen = run.length + dn;
        const now = this.interp.placements;
        if (newLen <= 0) return;
        const newLast = now[run[0].seq + newLen - 1];
        const oldLast = run[run.length - 1];
        const ax = run[0].xAxis;
        const D = dot(newLast.origin, ax) + newLast.advUser - (dot(oldLast.origin, ax) + oldLast.advUser);
        if (Math.abs(D) < 0.05) return;
        const oldSeg = this.segmentsOf(pre).find((seg) => seg[0].seq <= run[0].seq && seg[seg.length - 1].seq >= run[0].seq);
        if (!oldSeg) return;
        const endSeq = tail[tail.length - 1].seq + dn;
        const line = now.filter((g) => g.seq >= oldSeg[0].seq && g.seq <= endSeq);
        const offsets = new Map<number, number>();
        for (const g of tail) offsets.set(g.seq + dn, D);
        const moved = this.offsetGlyphs(line, offsets);
        this.debug?.(moved ? "styled run: rest of the line reflowed" : "styled run: rest of the line not moved");
    }

    // ── Alignment ───────────────────────────────────────────────────────────────────────────────

    /** Does `g` continue the visual line ending with `prev` (same stream, direction and baseline, word-gap distance)? */
    private continuesLine(prev: Placement, g: Placement, maxGapEm = 1): boolean {
        // Geometry only: glyphs we inserted from fallback fonts have no Unicode in the interpreter.
        if (g.streamKey !== prev.streamKey) return false;
        const hidden = (x: Placement) => x.state.Tr === 3 || x.state.Tr === 7;
        if (hidden(g) !== hidden(prev)) return false;
        const [ax, ay] = prev.xAxis;
        if (Math.abs(g.xAxis[0] - ax) > 1e-3 || Math.abs(g.xAxis[1] - ay) > 1e-3) return false;
        const rel: [number, number] = [g.origin[0] - prev.origin[0], g.origin[1] - prev.origin[1]];
        const size = prev.sizeUser || 1;
        if (!onSameLine(prev, g, ax, ay)) return false;
        const gap = dot(rel, [ax, ay]) - prev.advUser;
        return gap >= -0.25 * size && gap <= maxGapEm * size;
    }

    /** Visual line pieces (glyphs in one flow) of an interpretation, in content order. */
    private segmentsOf(interp: Interpretation): Placement[][] {
        const out: Placement[][] = [];
        const pls = interp.placements;
        let cur: Placement[] = [];
        let gaps: number[] = [];
        for (let k = 0; k < pls.length; k++) {
            const g = pls[k];
            const prev = cur[cur.length - 1];
            let joins = !!prev && this.continuesLine(prev, g);
            if (prev && !joins && g.streamKey === prev.streamKey) {
                // Wide but regular word spacing (CSS word-spacing) keeps the line together.
                const [ax, ay] = prev.xAxis;
                const size = prev.sizeUser || 1;
                const gap = (g.origin[0] - prev.origin[0]) * ax + (g.origin[1] - prev.origin[1]) * ay - prev.advUser;
                joins =
                    Math.abs(g.xAxis[0] - ax) < 1e-3 &&
                    Math.abs(g.xAxis[1] - ay) < 1e-3 &&
                    onSameLine(prev, g, ax, ay) &&
                    gap > 0 &&
                    this.spacedLikeLine(gap, gaps, pls, k, ax, ay, size);
            }
            if (joins) {
                const gap = dot([g.origin[0] - prev.origin[0], g.origin[1] - prev.origin[1]], prev.xAxis) - prev.advUser;
                if (gap > 0.1 * (prev.sizeUser || 1)) gaps.push(gap);
                cur.push(g);
            } else {
                if (cur.length) out.push(cur);
                cur = [g];
                gaps = [];
            }
        }
        if (cur.length) out.push(cur);
        return out.filter((seg) => seg.some((g) => !/^\s*$/.test(g.glyph.unicode ?? "")));
    }

    /** Left / right / centre alignment of a line piece, judged against the lines around it (a column of amounts
     *  shares its right edge, centred headings share their centre), or against the page for a lone centred line. */
    private alignmentOf(line: Placement[], all: Placement[][]): "left" | "right" | "center" | "justify" {
        const [first, last] = inkEnds(line);
        const ax = first.xAxis;
        const perp: [number, number] = [-ax[1], ax[0]];
        const L = dot(first.origin, ax);
        const R = dot(last.origin, ax) + inkAdvance(last);
        const Y = dot(first.origin, perp);
        const H = first.sizeUser || 1;
        let left = 0;
        let right = 0;
        let center = 0;
        let both = 0;
        const seen = new Set<string>();
        for (const seg of all) {
            if (seg === line || seg[0].seq === line[0].seq) continue;
            const [s0, s1] = inkEnds(seg);
            if (Math.abs(s0.xAxis[0] - ax[0]) > 1e-3 || Math.abs(s0.xAxis[1] - ax[1]) > 1e-3) continue;
            const dy = Math.abs(dot(s0.origin, perp) - Y);
            if (dy < 0.5 * H || dy > 4 * H) continue; // same row, or too far to belong to the same block
            const ratio = s0.sizeUser / H;
            if (ratio < 0.6 || ratio > 1.7) continue; // headings and footnotes vote for nothing
            const where = `${Math.round(dot(s0.origin, ax) * 4)}:${Math.round(dot(s0.origin, perp) * 4)}`;
            if (seen.has(where)) continue; // overprinted copies (outline, shadow) are one line
            seen.add(where);
            const l = dot(s0.origin, ax);
            const r = dot(s1.origin, ax) + inkAdvance(s1);
            const lm = Math.abs(l - L) < 0.75;
            const rm = Math.abs(r - R) < 0.75;
            if (lm && rm)
                both++; // justified block, or equal widths: says nothing about alignment alone
            else if (lm) left++;
            else if (rm) right++;
            else if (Math.abs((l + r) / 2 - (L + R) / 2) < 0.75) center++;
        }
        if (right > left && right >= center) return "right";
        if (center > left && center > right) return "center";
        // Justified: both edges shared with two lines, or with one line when the word gaps are visibly stretched.
        if (both >= 2 || (both === 1 && this.gapsStretched(line))) return "justify";
        if (left || both) return "left";
        // Centred in its own box (a text box or table cell clips it).
        const clip = first.clip;
        if (clip && Math.abs(ax[0] - 1) < 1e-3 && Math.abs((L + R) / 2 - (clip[0] + clip[2]) / 2) < 1 && L - clip[0] > 2) return "center";
        // A lone line centred on the page (titles, certificates) — horizontal text only.
        if (Math.abs(ax[0] - 1) < 1e-3) {
            const box = this.pageDict.lookup(N("CropBox")) ?? this.pageDict.lookup(N("MediaBox"));
            if (box instanceof PDFArray && box.size() === 4) {
                const v = [0, 1, 2, 3].map((k) => {
                    const o = box.lookup(k);
                    return o && "asNumber" in o ? (o as unknown as { asNumber(): number }).asNumber() : NaN;
                });
                const mid = (v[0] + v[2]) / 2;
                if (Number.isFinite(mid) && Math.abs((L + R) / 2 - mid) < 1 && L - v[0] > 0.08 * (v[2] - v[0])) return "center";
            }
        }
        return "left";
    }

    /** Word gaps wider than a plain space: the extra after space glyphs, or positioned gaps well above a space. */
    private gapsStretched(line: Placement[]): boolean {
        const ax = line[0].xAxis;
        const size = line[0].sizeUser || 1;
        const isWs = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
        const pseudo = this.pseudoSpaces(line);
        const extras: number[] = [];
        let prevInk: Placement | null = null;
        let wsAdv = 0;
        line.forEach((g, j) => {
            if (isWs(g)) {
                wsAdv += plainAdvance(g);
                return;
            }
            if (prevInk) {
                const gap = dot([g.origin[0] - prevInk.origin[0], g.origin[1] - prevInk.origin[1]], ax) - prevInk.advUser;
                if (wsAdv > 0) extras.push(gap - wsAdv);
                else if (pseudo[j]) extras.push(gap - 0.3 * size);
            }
            prevInk = g;
            wsAdv = 0;
        });
        if (!extras.length) return false;
        extras.sort((a, b) => a - b);
        return extras[Math.floor(extras.length / 2)] > 0.08 * size;
    }

    /** Word spacing of the line around `g`, for typed spaces: justified lines stretch their gaps with numbers after
     *  each space glyph (Word), or draw them by positioning only (pdfTeX). Text space units before scaling. */
    private wordSpacing(g: Placement): { positioned: number | null; extra: number } {
        const seg = this.segmentsOf(this.interp).find((sg) => sg[0].seq <= g.seq && sg[sg.length - 1].seq >= g.seq);
        if (!seg || !g.advPre || !g.advUser) return { positioned: null, extra: 0 };
        const perPre = g.advUser / g.advPre;
        const ax = seg[0].xAxis;
        const isWs = (p: Placement) => p.glyph.isSpace || /^\s+$/.test(p.glyph.unicode ?? "");
        const pseudo = this.pseudoSpaces(seg);
        // The insertion already repeats the line's letter-spacing after every glyph (the space included), so only
        // what word gaps have beyond that is word spacing.
        const letter = this.medianExtraGap(seg) * perPre;
        const withGlyph: number[] = [];
        const positioned: number[] = [];
        let prevInk: Placement | null = null;
        let wsAdv = 0;
        seg.forEach((p, j) => {
            if (isWs(p)) {
                wsAdv += p.advUser;
                return;
            }
            if (prevInk) {
                const gap = dot([p.origin[0] - prevInk.origin[0], p.origin[1] - prevInk.origin[1]], ax) - prevInk.advUser;
                if (wsAdv > 0) withGlyph.push(gap - wsAdv - 2 * letter);
                else if (pseudo[j]) positioned.push(gap - letter);
            }
            prevInk = p;
            wsAdv = 0;
        });
        const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
        if (withGlyph.length) {
            const e = median(withGlyph);
            return { positioned: null, extra: Math.abs(e) > 0.03 * g.sizeUser ? e / perPre : 0 };
        }
        if (positioned.length) return { positioned: median(positioned) / perPre, extra: 0 };
        return { positioned: null, extra: 0 };
    }

    /** After an edit, move a right-aligned or centred line back onto its alignment (an amount keeps its right edge,
     *  a centred heading its centre). Verified like every rewrite; left as is when it can't be done exactly. */
    private alignEditedLines(original: Interpretation) {
        const records = this.alignQueue;
        this.alignQueue = [];
        if (!records.length) return;
        // Records carry original sequence numbers: edits ran last-first, so nothing before a run had moved yet.
        const oldSegs = this.segmentsOf(original);
        const lines = new Map<number, Placement[]>();
        for (const r of records) {
            const seg = oldSegs.find((sg) => sg[0].seq <= r.firstSeq && sg[sg.length - 1].seq >= r.firstSeq);
            if (seg) lines.set(seg[0].seq, seg);
        }
        const shifted = (seq: number, inclusive: boolean) =>
            seq + records.filter((r) => (inclusive ? r.firstSeq <= seq : r.firstSeq < seq)).reduce((a, r) => a + r.dn, 0);
        for (const seg of [...lines.values()].sort((a, b) => b[0].seq - a[0].seq))
            this.keepAlignment(seg, oldSegs, shifted(seg[0].seq, false), shifted(seg[seg.length - 1].seq, true));
    }

    private keepAlignment(oldLine: Placement[], oldSegs: Placement[][], newFirst: number, newLast: number) {
        const align = this.alignmentOf(oldLine, oldSegs);
        const newLine = this.segmentsOf(this.interp).find((seg) => seg[0].seq === newFirst);
        // The new line must span exactly the old one plus the glyphs the edits added or removed.
        if (!newLine || newLine[newLine.length - 1].seq !== newLast) {
            this.debug?.(`alignment (${align}) not kept: the edited line changed shape`);
            return;
        }
        const ax = oldLine[0].xAxis;
        const ol = inkEnds(oldLine)[1];
        const oldR = dot(ol.origin, ax) + inkAdvance(ol);
        const nl = inkEnds(newLine)[1];
        const D = dot(nl.origin, ax) + inkAdvance(nl) - oldR;
        if (Math.abs(D) < 0.05) return;
        if (align === "justify" || align === "left") {
            // Evaluated even without a debug sink. Justified: the line's own gaps first, then the paragraph. Left:
            // only a line that now overflows its paragraph (or a justified paragraph its neighbours didn't reveal).
            const kept =
                align === "justify"
                    ? this.rejustify(newLine, D, true) || this.reflowParagraph(newLine, oldR, D, false) || this.rejustify(newLine, D)
                    : this.reflowParagraph(newLine, oldR, D, true);
            this.debug?.(kept ? `alignment (${align}) kept` : `alignment (${align}): paragraph unchanged`);
            return;
        }
        const shift = align === "right" ? -D : -D / 2;
        const kept = this.shiftLine(newLine, shift);
        this.debug?.(kept ? `alignment (${align}) kept` : `alignment (${align}) not kept: line can't be moved exactly`);
    }

    /** Justified line that grew or shrank by `D`: take it back from the word gaps (each gap loses at most 45% of
     *  the narrowest one, or grows by at most 1.6 times it), so the right edge stays on the margin. */
    private rejustify(line: Placement[], D: number, soft = false): boolean {
        const ax = line[0].xAxis;
        const isWs = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
        const pseudo = this.pseudoSpaces(line);
        const starts: number[] = [];
        let minGap = Infinity;
        let prevInk: Placement | null = null;
        line.forEach((g, j) => {
            if (isWs(g)) return;
            if (prevInk && j > 0 && (isWs(line[j - 1]) || pseudo[j])) {
                starts.push(j);
                minGap = Math.min(minGap, dot([g.origin[0] - prevInk.origin[0], g.origin[1] - prevInk.origin[1]], ax) - prevInk.advUser);
            }
            prevInk = g;
        });
        if (!starts.length || !(minGap > 0)) return false;
        // Like a typesetter: word gaps first (each may lose 45% of the narrowest gap or grow to 2.6 times it), then
        // what they can't take goes into letter-spacing, at most 3% of the type size per letter pair.
        const gapMax = D > 0 ? 0.45 * minGap : 1.6 * minGap;
        const perGap = Math.sign(D) * Math.min(Math.abs(D) / starts.length, gapMax);
        const rest = D - perGap * starts.length;
        const startSet = new Set(starts);
        const pairs = new Set<number>();
        line.forEach((g, j) => {
            if (j > 0 && !isWs(g) && !isWs(line[j - 1]) && !startSet.has(j)) pairs.add(j);
        });
        const perPair = Math.abs(rest) > 1e-6 ? (pairs.size ? rest / pairs.size : Infinity) : 0;
        this.debug?.(
            `rejustify${soft ? " (soft)" : ""}: D=${D.toFixed(2)} gaps=${starts.length} perGap=${perGap.toFixed(2)} minGap=${minGap.toFixed(2)} perPair=${perPair.toFixed(3)}`,
        );
        if (!(Math.abs(perPair) <= 0.03 * (line[0].sizeUser || 1))) return false;
        if (soft && D > 0) {
            // Soft: only while no gap gets narrower than a plain space — otherwise re-flowing the paragraph looks better.
            const spaces = line.filter(isWs).map(plainAdvance);
            const plain = spaces.length ? spaces.sort((a, b) => a - b)[Math.floor(spaces.length / 2)] : 0.3 * (line[0].sizeUser || 1);
            if (perPair !== 0 || minGap - perGap < 0.95 * plain) return false;
        }
        const offsets = new Map<number, number>();
        let acc = 0;
        line.forEach((g, j) => {
            if (startSet.has(j)) acc += perGap;
            if (pairs.has(j)) acc += perPair;
            offsets.set(g.seq, -acc);
        });
        return this.offsetGlyphs(line, offsets);
    }

    /** The edited line no longer fits its paragraph — a justified line that can't absorb the change, or a line that
     *  now runs past the paragraph's right edge: flow the words of this line and of the paragraph's following lines
     *  again, like a word processor (same baselines, same number of lines, justified if the paragraph was). A line
     *  only counts as part of the paragraph if it is wrapped text — the next line's first word didn't fit at its
     *  end — so lists of separate lines are never merged. Words get absolute text matrices; verified glyph by glyph. */
    private reflowParagraph(line: Placement[], oldRight: number, D: number, tryRejustify: boolean): boolean {
        const key = line[0].streamKey;
        const sctx = this.interp.streams.get(key);
        if (!sctx) return this.skipFalse("paragraph: stream");
        const ax = line[0].xAxis;
        const perp: [number, number] = [-ax[1], ax[0]];
        const size = line[0].sizeUser || 1;
        const X = (q: [number, number]) => dot(q, ax);
        const Y = (q: [number, number]) => dot(q, perp);
        const isWs = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
        const leftOf = (seg: Placement[]) => X(inkEnds(seg)[0].origin);
        const rightOf = (seg: Placement[]) => {
            const l = inkEnds(seg)[1];
            return X(l.origin) + inkAdvance(l);
        };
        const sameDir = (seg: Placement[]) => Math.abs(seg[0].xAxis[0] - ax[0]) < 1e-3 && Math.abs(seg[0].xAxis[1] - ax[1]) < 1e-3;
        // One paragraph shares one clip; table cells (Word clips every cell) never merge into a paragraph.
        const clipOf = (seg: Placement[]) => inkEnds(seg)[0].clip;
        const sameClip = (seg: Placement[]) => {
            const a = clipOf(seg);
            const b = clipOf(line);
            return !a && !b ? true : !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) < 0.5);
        };
        const segs = this.segmentsOf(this.interp).filter((sg) => sg[0].streamKey === key && sameDir(sg) && !sg.includes(line[0]) && sameClip(sg));

        // Lines directly below: same left edge (the edited line may be an indented first line), regular leading.
        const below: Placement[][] = [];
        let paraLeft: number | null = null;
        // The paragraph's leading, if the edited line has a line of the same paragraph above it: a wider distance
        // below means the next paragraph (space between paragraphs).
        const yLine = Y(inkEnds(line)[0].origin);
        const above = segs
            .filter((sg) => {
                const d = Y(inkEnds(sg)[0].origin) - yLine;
                return (
                    d > 0.5 * size && d < 2.5 * size && Math.abs(inkEnds(sg)[0].sizeUser - size) < 0.05 * size && Math.abs(leftOf(sg) - leftOf(line)) < 4 * size
                );
            })
            .sort((a, b) => Y(inkEnds(a)[0].origin) - Y(inkEnds(b)[0].origin))[0];
        let lead: number | null = above ? Y(inkEnds(above)[0].origin) - yLine : null;
        for (let cur = line; below.length < 80; ) {
            const y0 = Y(inkEnds(cur)[0].origin);
            const next = segs
                .filter((sg) => {
                    const d = y0 - Y(inkEnds(sg)[0].origin);
                    // Same type size: a heading and the text under it are not one paragraph.
                    return (
                        d > 0.5 * size &&
                        d < 2.5 * size &&
                        (lead === null || Math.abs(d - lead) < 0.5) &&
                        Math.abs(inkEnds(sg)[0].sizeUser - size) < 0.05 * size
                    );
                })
                .filter((sg) =>
                    paraLeft === null ? leftOf(sg) <= leftOf(line) + 0.75 && leftOf(line) - leftOf(sg) < 4 * size : Math.abs(leftOf(sg) - paraLeft) < 0.75,
                )
                .sort((a, b) => Y(inkEnds(b)[0].origin) - Y(inkEnds(a)[0].origin))[0];
            if (!next) break;
            lead = y0 - Y(inkEnds(next)[0].origin);
            paraLeft ??= leftOf(next);
            below.push(next);
            cur = next;
        }
        if (!below.length || paraLeft === null) return this.skipFalse("paragraph: no following line");

        // Wrapped text only: the next line's first word would not have fitted at the end of this one.
        const wsGlyph = [line, ...below].flat().find(isWs);
        const space = wsGlyph ? wsGlyph.advUser : 0.3 * size;
        const firstWordWidth = (seg: Placement[]) => {
            const pseudo = this.pseudoSpaces(seg);
            const a = seg.indexOf(inkEnds(seg)[0]);
            let b = a;
            while (b + 1 < seg.length && !isWs(seg[b + 1]) && !pseudo[b + 1]) b++;
            return X(seg[b].origin) + seg[b].advUser - X(seg[a].origin);
        };
        const rights = [oldRight, ...below.map(rightOf)];
        const lines: Placement[][] = [line];
        const firstInk = (seg: Placement[]) => inkEnds(seg)[0].glyph.unicode ?? "";
        const lastInk = (seg: Placement[]) => inkEnds(seg)[1].glyph.unicode ?? "";
        for (let i = 0; i < below.length; i++) {
            // Measured against the other lines' right edges, so one long line can't make everything look wrapped.
            const others = Math.max(...rights.filter((_, k) => k !== i));
            if (rights[i] + space + firstWordWidth(below[i]) <= others + 0.5) break;
            // A line that isn't full and ends a sentence, followed by one that starts a new one: a new paragraph.
            const prevLine = i === 0 ? line : below[i - 1];
            if (rights[i] < others - 1 && /[.!?:;]$/.test(lastInk(prevLine)) && /^[A-ZÁÉÍÓÚÑÜ¿¡"«(0-9]/.test(firstInk(below[i]))) break;
            lines.push(below[i]);
        }
        if (lines.length < 2) return this.skipFalse("paragraph: the following lines are not wrapped text");
        const R = Math.max(...rights.slice(0, lines.length));
        const wordGaps = (seg: Placement[]) => {
            const pseudo = this.pseudoSpaces(seg);
            const out: number[] = [];
            let prev: Placement | null = null;
            seg.forEach((g, j) => {
                if (isWs(g)) return;
                if (prev && j > 0 && (isWs(seg[j - 1]) || pseudo[j])) out.push(X(g.origin) - (X(prev.origin) + prev.advUser));
                prev = g;
            });
            return out.sort((x, y) => x - y);
        };
        const median = (v: number[]) => (v.length ? v[Math.floor(v.length / 2)] : null);
        const full = rights.slice(0, lines.length - 1);
        let justified = full.every((r) => Math.abs(r - R) < 1);
        if (justified && full.length < 2) {
            // One full line proves nothing by itself: justified text also has wider word gaps than the last line.
            const g0 = median(wordGaps(line));
            justified = g0 !== null && g0 > 1.15 * (median(wordGaps(lines[lines.length - 1])) ?? space);
        }
        // Only justified paragraphs are re-flowed: their shared edges prove they are wrapped text. Ragged lines can't
        // be told apart from a list of short separate lines, so a longer ragged line simply grows.
        if (!justified) return this.skipFalse("paragraph: ragged text is not re-flowed");
        if (justified && tryRejustify && this.rejustify(line, D, true)) return true;
        const giveUp = (why: string) => {
            this.debug?.(`paragraph: ${why}`);
            return justified && tryRejustify ? this.rejustify(line, D) : false;
        };
        if (!justified && rightOf(line) <= R + 0.5) return this.skipFalse("paragraph: the line still fits");
        for (const ln of lines.slice(0, -1)) if (/^[-\u2010\u00ad]$/.test(inkEnds(ln)[1].glyph.unicode ?? "")) return giveUp("hyphenated line");

        // Words (ink glyphs plus the spaces after them) and the natural word gap (last line, or all lines if ragged).
        type Word = { glyphs: Placement[]; first: Placement; last: Placement; width: number };
        const words: Word[] = [];
        const gaps: number[] = [];
        for (const [li, ln] of lines.entries()) {
            const pseudo = this.pseudoSpaces(ln);
            let w: Word | null = null;
            ln.forEach((g, j) => {
                if (isWs(g)) {
                    w?.glyphs.push(g);
                    return;
                }
                if (!w || isWs(ln[j - 1]) || pseudo[j]) {
                    if (w && (li === lines.length - 1 || !justified) && li > 0) gaps.push(X(g.origin) - (X(w.last.origin) + w.last.advUser));
                    w = { glyphs: [g], first: g, last: g, width: 0 };
                    words.push(w);
                } else {
                    w.glyphs.push(g);
                    w.last = g;
                }
            });
        }
        for (const w of words) w.width = X(w.last.origin) + w.last.advUser - X(w.first.origin);
        gaps.sort((a, b) => a - b);
        const natural = gaps.length ? gaps[Math.floor(gaps.length / 2)] : space;
        if (!(natural > 0)) return this.skipFalse("paragraph: no word gap");

        // Greedy fill into the same lines, like a word processor: words go on while they fit with natural spaces;
        // a justified paragraph that would need one more line may squeeze its gaps to 80%, then 60%.
        const lefts = lines.map((_, i) => (i === 0 ? leftOf(line) : paraLeft!));
        const fill = (minGap: number): Word[][] | null => {
            const out: Word[][] = [];
            let row: Word[] = [];
            let rowW = 0;
            for (const w of words) {
                if (row.length && rowW + w.width + minGap * row.length > R - lefts[out.length] + 0.01) {
                    out.push(row);
                    row = [];
                    rowW = 0;
                }
                if (out.length >= lines.length) return null;
                row.push(w);
                rowW += w.width;
            }
            if (row.length) out.push(row);
            return out;
        };
        const layout = (justified ? [1, 0.8, 0.6] : [1]).map((f) => f * natural).reduce<Word[][] | null>((found, g) => found ?? fill(g), null);
        if (!layout) return giveUp("needs another line");
        const targets = new Map<number, [number, number]>();
        for (const [i, r] of layout.entries()) {
            const inkW = r.reduce((a, w) => a + w.width, 0);
            const width = R - lefts[i];
            const last = i === layout.length - 1;
            const gap = r.length < 2 ? 0 : !justified || last ? Math.min(natural, (width - inkW) / (r.length - 1)) : (width - inkW) / (r.length - 1);
            if (r.length > 1 && (gap < 0.55 * natural || gap > 4 * natural)) return giveUp("spacing out of range");
            const base = inkEnds(lines[i])[0].origin;
            let x = lefts[i];
            for (const w of r) {
                const at: [number, number] = [base[0] + ax[0] * (x - X(base)), base[1] + ax[1] * (x - X(base))];
                for (const g of w.glyphs) targets.set(g.seq, [at[0] + g.origin[0] - w.first.origin[0], at[1] + g.origin[1] - w.first.origin[1]]);
                x += w.width + gap;
            }
        }
        if (
            !this.placeGlyphs(
                key,
                words.flatMap((w) => w.glyphs),
                targets,
            )
        )
            return giveUp("glyphs could not be placed");
        this.debug?.(`paragraph reflowed over ${lines.length} lines`);
        return true;
    }

    /** Re-emit the operators that draw `glyphs` so each glyph lands on its target (user space), with an absolute Tm
     *  before every run of glyphs that belong together; the line matrix is restored for what follows. Verified. */
    private placeGlyphs(key: string, glyphs: Placement[], targets: Map<number, [number, number]>): boolean {
        const sctx = this.interp.streams.get(key)!;
        const ops = sctx.ops;
        const inSet = new Set(glyphs.map((g) => g.seq));
        const byOp = this.placementsByOp(key);
        const opIdx = Array.from(new Set(glyphs.map((g) => g.opIndex))).sort((a, b) => a - b);
        for (const i of opIdx) if ((byOp.get(i) ?? []).some((g) => !inSet.has(g.seq))) return this.skipFalse(`place: operator ${i} also draws other text`);
        // Glyphs keep their relative placement inside a run: consecutive glyphs whose targets move by the same amount.
        const delta = (g: Placement) => {
            const t = targets.get(g.seq)!;
            return [t[0] - g.origin[0], t[1] - g.origin[1]];
        };
        const tmFor = (g: Placement) => {
            const [A, B, C, Dd, E, F] = g.ctm;
            const det = A * Dd - B * C;
            if (!det) return null;
            const t = targets.get(g.seq)!;
            const px = ((t[0] - E) * Dd - (t[1] - F) * C) / det;
            const py = ((t[1] - F) * A - (t[0] - E) * B) / det;
            const [a, b, c, d] = g.tm;
            const rise = g.state.Ts;
            return [a, b, c, d, px - c * rise, py - d * rise].map(formatNumber).join(" ") + " Tm";
        };
        const texts = new Map<number, string>();
        for (const i of opIdx) {
            const op = ops[i];
            const out: string[] = [];
            if (op.op === '"') {
                const [aw, ac] = op.args;
                out.push(`${aw?.t === "num" ? formatNumber(aw.v) : "0"} Tw`, `${ac?.t === "num" ? formatNumber(ac.v) : "0"} Tc`);
            }
            const strArg = op.op === '"' ? op.args[2] : op.args[0];
            const items: Operand[] = op.op === "TJ" ? (op.args[0]?.t === "arr" ? op.args[0].items : []) : strArg ? [strArg] : [];
            const byElem = new Map<number, Placement[]>();
            for (const g of byOp.get(i) ?? []) {
                if (!byElem.has(g.elem)) byElem.set(g.elem, []);
                byElem.get(g.elem)!.push(g);
            }
            let cur: string[] = [];
            let kept: number[] = [];
            let pending: number[] = [];
            let prev: Placement | null = null;
            const flushKept = () => {
                if (kept.length) cur.push(hexOf(kept));
                kept = [];
            };
            const flushTJ = () => {
                flushKept();
                if (cur.length) out.push(`[${cur.join(" ")}] TJ`);
                cur = [];
            };
            for (const [k, it] of items.entries()) {
                if (it.t === "num") {
                    pending.push(it.v);
                    continue;
                }
                if (it.t !== "str") continue;
                for (const g of (byElem.get(k) ?? []).slice().sort((x, y) => x.gi - y.gi)) {
                    const dg = delta(g);
                    const dp = prev ? delta(prev) : null;
                    const sameRun = !!prev && prev.seq + 1 === g.seq && Math.hypot(dg[0] - dp![0], dg[1] - dp![1]) < 1e-6;
                    if (!sameRun) {
                        flushTJ();
                        const tm = tmFor(g);
                        if (!tm) return this.skipFalse("place: singular matrix");
                        out.push(tm);
                    } else if (pending.length) {
                        flushKept();
                        cur.push(...pending.map(formatNumber));
                    }
                    pending = [];
                    kept.push(...g.glyph.bytes);
                    prev = g;
                }
            }
            flushTJ();
            texts.set(i, out.join("\n"));
        }
        // What follows the glyphs positions itself from the line matrix: restore the original one.
        const lastG = glyphs.reduce((a, g) => (g.seq > a.seq ? g : a));
        let restoreAt = -1;
        for (let k = opIdx[opIdx.length - 1] + 1; k < ops.length; k++) {
            const o = ops[k].op;
            if (o === "Td" || o === "TD" || o === "T*" || o === "'" || o === '"') restoreAt = k;
            else if ((o === "Tj" || o === "TJ") && !drawsNothing(ops[k])) return this.skipFalse("place: following text continues by advance");
            else if (o === "Tj" || o === "TJ") continue;
            else if (o !== "Tm" && o !== "BT" && o !== "ET") continue;
            break;
        }
        const parts = ops.map((op, i) => {
            let t = texts.get(i) ?? latin1(sctx.bytes.subarray(op.start, op.end));
            if (i === restoreAt) t = `${lastG.tlm.map(formatNumber).join(" ")} Tm\n${t}`;
            return t;
        });
        const staged = new Map(this.overrides);
        staged.set(key, fromLatin1(parts.join("\n") + "\n"));
        const after = this.interpret(staged);
        const before = this.interp.placements;
        if (after.placements.length !== before.length) return this.skipFalse("place: glyph count");
        for (let i = 0; i < before.length; i++) {
            const a = before[i];
            const b = after.placements[i];
            const t = targets.get(a.seq) ?? a.origin;
            if (a.glyph.code !== b.glyph.code || Math.abs(t[0] - b.origin[0]) > 0.01 || Math.abs(t[1] - b.origin[1]) > 0.01)
                return this.skipFalse(`place: glyph ${a.seq} misplaced`);
        }
        this.overrides = staged;
        this.interp = after;
        return true;
    }

    /** Move glyphs of one line piece along its baseline by per-glyph offsets (user space), nothing else: relative
     *  moves get a compensating Td, glyphs inside an operator get TJ numbers. Verified; false if not exact. */
    private offsetGlyphs(line: Placement[], offsets: Map<number, number>): boolean {
        const key = line[0].streamKey;
        const sctx = this.interp.streams.get(key);
        if (!sctx || !line.every((g) => g.streamKey === key)) return this.skipFalse("offset: several streams");
        const firstSeq = line[0].seq;
        const lastSeq = line[line.length - 1].seq;
        const off = (g: Placement) => offsets.get(g.seq) ?? 0;
        const byOp = this.placementsByOp(key);
        const lineOps = Array.from(new Set(line.map((g) => g.opIndex))).sort((a, b) => a - b);
        for (const i of lineOps)
            if ((byOp.get(i) ?? []).some((g) => g.seq < firstSeq || g.seq > lastSeq)) return this.skipFalse(`offset: operator ${i} also draws other text`);
        const ops = sctx.ops;
        const SHOW = new Set(["Tj", "TJ", "'", '"']);
        const startKind = (i: number): "advance" | "reset" | "relative" => {
            if (ops[i].op === "'" || ops[i].op === '"') return "relative"; // they start with T*
            let relative = false;
            for (let k = i - 1; k >= 0; k--) {
                const o = ops[k].op;
                if (o === "Tm" || o === "BT") return "reset";
                if (o === "Td" || o === "TD" || o === "T*") relative = true;
                else if (SHOW.has(o)) return relative ? "relative" : "advance";
            }
            return "reset";
        };
        const eps = 1e-6;
        let tlm = 0; // Td shift inserted since the last absolute positioning
        let cur = 0; // shift of the text position after the last glyph drawn
        const texts = new Map<number, string>();
        for (const i of lineOps) {
            const pls = (byOp.get(i) ?? []).slice().sort((a, b) => a.seq - b.seq);
            const g0 = pls[0];
            if (!g0.advPre || !g0.advUser || !g0.state.Th) return this.skipFalse("offset: zero advance");
            const perTd = g0.advUser / g0.advPre / g0.state.Th;
            const kind = startKind(i);
            let prefix = "";
            let prev = cur;
            if (kind !== "advance") {
                if (kind === "reset") tlm = 0;
                const t = off(g0) - tlm;
                if (Math.abs(t) > eps) prefix = `${formatNumber(t / perTd)} 0 Td\n`;
                tlm = off(g0);
                prev = off(g0);
            }
            const numbers = new Map<number, number>();
            for (const g of pls) {
                const d = off(g) - prev;
                if (Math.abs(d) > eps) {
                    if (!g.advPre || !g.advUser || !g.state.Tfs) return this.skipFalse("offset: zero advance");
                    numbers.set(g.seq, (-(d / (g.advUser / g.advPre)) * 1000) / g.state.Tfs);
                }
                prev = off(g);
            }
            cur = prev;
            if (!prefix && !numbers.size) continue;
            texts.set(i, prefix + (numbers.size ? this.withNumbers(sctx, i, pls, numbers) : latin1(sctx.bytes.subarray(ops[i].start, ops[i].end))));
        }
        // Undo the shifts for whatever follows the line.
        let comp = "";
        let compAt = -1;
        for (let k = lineOps[lineOps.length - 1] + 1; k < ops.length; k++) {
            const o = ops[k].op;
            if (o === "Td" || o === "TD" || o === "T*" || o === "'" || o === '"') {
                if (Math.abs(tlm) > eps) comp = `${formatNumber(-tlm / (line[0].advUser / line[0].advPre / line[0].state.Th))} 0 Td\n`;
                compAt = k;
            } else if (SHOW.has(o) && drawsNothing(ops[k])) continue;
            else if (SHOW.has(o)) {
                if (Math.abs(tlm) > eps) return this.skipFalse("offset: following text continues by advance");
                if (Math.abs(cur) > eps) {
                    const g = line[line.length - 1];
                    comp = `[${formatNumber((-(-cur / (g.advUser / g.advPre)) * 1000) / g.state.Tfs)}] TJ\n`;
                }
                compAt = k;
            } else if (o !== "Tm" && o !== "BT" && o !== "ET") continue;
            break;
        }
        const parts = ops.map((op, i) => {
            let t = texts.get(i) ?? latin1(sctx.bytes.subarray(op.start, op.end));
            if (i === compAt && comp) t = comp + t;
            return t;
        });
        const staged = new Map(this.overrides);
        staged.set(key, fromLatin1(parts.join("\n") + "\n"));
        const after = this.interpret(staged);
        const before = this.interp.placements;
        if (after.placements.length !== before.length) return this.skipFalse("offset: glyph count");
        for (let i = 0; i < before.length; i++) {
            const a = before[i];
            const b = after.placements[i];
            const o = a.seq >= firstSeq && a.seq <= lastSeq ? off(a) : 0;
            if (
                a.glyph.code !== b.glyph.code ||
                Math.abs(a.origin[0] + a.xAxis[0] * o - b.origin[0]) > 0.01 ||
                Math.abs(a.origin[1] + a.xAxis[1] * o - b.origin[1]) > 0.01
            )
                return this.skipFalse(`offset: glyph ${a.seq} misplaced`);
        }
        this.overrides = staged;
        this.interp = after;
        return true;
    }

    /** One text-showing operator re-emitted as TJ with extra displacement numbers before some glyphs. */
    private withNumbers(sctx: StreamCtx, opIndex: number, pls: Placement[], numbers: Map<number, number>): string {
        const op = sctx.ops[opIndex];
        const out: string[] = [];
        if (op.op === "'") out.push("T*");
        if (op.op === '"') {
            const [aw, ac] = op.args;
            out.push(`${aw?.t === "num" ? formatNumber(aw.v) : "0"} Tw`, `${ac?.t === "num" ? formatNumber(ac.v) : "0"} Tc`, "T*");
        }
        const strArg = op.op === '"' ? op.args[2] : op.args[0];
        const items: Operand[] = op.op === "TJ" ? (op.args[0]?.t === "arr" ? op.args[0].items : []) : strArg ? [strArg] : [];
        const byElem = new Map<number, Placement[]>();
        for (const g of pls) {
            if (!byElem.has(g.elem)) byElem.set(g.elem, []);
            byElem.get(g.elem)!.push(g);
        }
        const cur: string[] = [];
        items.forEach((it, k) => {
            if (it.t === "num") {
                cur.push(formatNumber(it.v));
                return;
            }
            if (it.t !== "str") return;
            let kept: number[] = [];
            for (const g of (byElem.get(k) ?? []).slice().sort((x, y) => x.gi - y.gi)) {
                const n = numbers.get(g.seq);
                if (n !== undefined) {
                    if (kept.length) cur.push(hexOf(kept));
                    kept = [];
                    cur.push(formatNumber(n));
                }
                kept.push(...g.glyph.bytes);
            }
            if (kept.length) cur.push(hexOf(kept));
        });
        out.push(`[${cur.join(" ")}] TJ`);
        return out.join("\n");
    }

    /** Move every glyph of one line piece by `shiftUser` along its baseline, nothing else. */
    private shiftLine(line: Placement[], shiftUser: number): boolean {
        const key = line[0].streamKey;
        const sctx = this.interp.streams.get(key);
        if (!sctx || !line.every((g) => g.streamKey === key)) return this.skipFalse("shift: several streams");
        const first = line[0];
        const lastSeq = line[line.length - 1].seq;
        const ref = line.find((g) => g.advPre && g.advUser && g.state.Th);
        if (!ref) return this.skipFalse("shift: no advance");
        const shiftTd = shiftUser / (ref.advUser / ref.advPre / ref.state.Th);
        const byOp = this.placementsByOp(key);
        const lineOps = Array.from(new Set(line.map((g) => g.opIndex))).sort((a, b) => a - b);
        // Every glyph of those operators must belong to the line (we move whole operators).
        for (const i of lineOps)
            if ((byOp.get(i) ?? []).some((g) => g.seq < first.seq || g.seq > lastSeq)) return this.skipFalse(`shift: operator ${i} also draws other text`);
        const ops = sctx.ops;
        const TEXT_OPS = new Set(["Tj", "TJ", "'", '"', "Td", "TD", "Tm", "T*", "BT", "ET"]);
        const prevTextOp = (i: number) => {
            for (let k = i - 1; k >= 0; k--) if (TEXT_OPS.has(ops[k].op)) return ops[k].op;
            return null;
        };
        const at = new Set<number>();
        for (const [k, i] of lineOps.entries()) {
            const prev = prevTextOp(i);
            if (positionReset(ops, i) || (k === 0 && (prev === "Td" || prev === "TD" || prev === "T*"))) at.add(i);
            else if (k === 0) return this.skipFalse(`shift: the line starts by advance (${prev})`); // can't move it alone
        }
        let comp = -1;
        for (let k = lineOps[lineOps.length - 1] + 1; k < ops.length; k++) {
            if (!TEXT_OPS.has(ops[k].op) || drawsNothing(ops[k])) continue;
            if (["Td", "TD", "T*", "'", '"'].includes(ops[k].op)) comp = k;
            else if (ops[k].op === "Tj" || ops[k].op === "TJ") return this.skipFalse("shift: following text continues by advance");
            break;
        }
        const parts = ops.map((op, i) => {
            let t = latin1(sctx.bytes.subarray(op.start, op.end));
            if (at.has(i)) t = `${formatNumber(shiftTd)} 0 Td\n${t}`;
            if (i === comp) t = `${formatNumber(-shiftTd)} 0 Td\n${t}`;
            return t;
        });
        const staged = new Map(this.overrides);
        staged.set(key, fromLatin1(parts.join("\n") + "\n"));
        const after = this.interpret(staged);
        const before = this.interp.placements;
        if (after.placements.length !== before.length) return this.skipFalse("shift: glyph count");
        const [dx, dy] = [first.xAxis[0] * shiftUser, first.xAxis[1] * shiftUser];
        for (let i = 0; i < before.length; i++) {
            const a = before[i];
            const b = after.placements[i];
            const inLine = a.seq >= first.seq && a.seq <= lastSeq;
            const ex = a.origin[0] + (inLine ? dx : 0);
            const ey = a.origin[1] + (inLine ? dy : 0);
            if (a.glyph.code !== b.glyph.code || Math.abs(ex - b.origin[0]) > 0.01 || Math.abs(ey - b.origin[1]) > 0.01)
                return this.skipFalse(`shift: glyph ${a.seq} ${inLine ? "in" : "outside"} the line misplaced`);
        }
        this.overrides = staged;
        this.interp = after;
        return true;
    }

    /** Visible glyphs whose advance leaves their known rectangular clip (0.5 pt tolerance). */
    private clippedGlyphs(): number {
        let n = 0;
        for (const p of this.interp.placements) {
            const c = p.clip;
            if (!c || p.state.Tr === 3 || p.state.Tr === 7 || p.glyph.isSpace) continue;
            const x1 = p.origin[0] + p.xAxis[0] * p.advUser;
            const y1 = p.origin[1] + p.xAxis[1] * p.advUser;
            const out = (x: number, y: number) => x < c[0] - 0.5 || x > c[2] + 0.5 || y < c[1] - 0.5 || y > c[3] + 0.5;
            if (out(p.origin[0], p.origin[1]) || out(x1, y1)) n++;
        }
        return n;
    }

    /** Extractors prefer /ActualText over the glyphs: carry the edit into it, or drop it when it can't be mapped. */
    private updateActualText(run: Placement[], newText: string) {
        const refs = new Map<string, { streamKey: string; opIndex: number }>();
        for (const p of run) if (p.actualText) refs.set(`${p.actualText.streamKey}#${p.actualText.opIndex}`, p.actualText);
        if (!refs.size) return;
        const oldText = run.map((p) => p.glyph.unicode ?? "").join("");
        const norm = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();
        for (const { streamKey, opIndex } of refs.values()) {
            const sctx = this.interp.streams.get(streamKey);
            if (!sctx) continue;
            const op = sctx.ops[opIndex];
            const props = op?.op === "BDC" ? op.args[1] : undefined;
            if (!op || props?.t !== "dict") continue;
            const entry = props.entries.find(([k]) => k === "ActualText");
            const cur = entry?.[1].t === "str" ? decodeTextString(entry[1].bytes) : null;
            let next: string | null = null;
            if (cur !== null) {
                if (norm(cur) === norm(newText)) continue; // already updated (another overprinted copy)
                if (norm(cur) === norm(oldText)) next = newText;
                else if (oldText && cur.includes(oldText)) next = cur.replace(oldText, newText);
            }
            const entries = props.entries
                .map(([k, v]): [string, Operand] | null =>
                    k !== "ActualText" ? [k, v] : next === null ? null : [k, { t: "str", bytes: encodeTextString(next), hex: true }],
                )
                .filter((e): e is [string, Operand] => !!e);
            const text = serializeOp("BDC", [op.args[0], { t: "dict", entries }]);
            const bytes = sctx.bytes;
            const head = latin1(bytes.subarray(0, op.start));
            const tail = latin1(bytes.subarray(op.end));
            this.overrides = new Map(this.overrides);
            this.overrides.set(streamKey, fromLatin1(head + text + tail));
            this.interp = this.interpret();
        }
    }

    private async replaceSeqsCore(seqs: number[], newText: string, style: EditStyle, targetStr = "", reflowLine = true): Promise<EditResult> {
        const bySeq = new Map(this.interp.placements.map((p) => [p.seq, p]));
        const removed = seqs.map((s) => bySeq.get(s)).filter((p): p is Placement => !!p);
        if (removed.length !== seqs.length) return { ok: false, reason: "run moved after a previous edit" };
        removed.sort((x, y) => x.seq - y.seq);
        const anchor = removed[0];
        const st = anchor.state;
        if (!(st.font instanceof FontModel)) return { ok: false, reason: "run uses a font we inserted" };
        if (!st.font.supported) return { ok: false, reason: `unsupported font (${st.font.subtype} ${st.font.baseFont})` };
        if (!st.Tfs) return { ok: false, reason: "zero font size" };
        const ctx = this.interp.streams.get(anchor.streamKey);
        if (!ctx) return { ok: false, reason: "stream not found" };

        // pdfjs inserts pseudo-spaces between letter-spaced glyphs ("P A R Q U E"). When the run has no real space
        // glyph those spaces are layout, not text: drop single ones, keep wider gaps as one real space.
        const letterSpaced = (s: string) => /^\S(\s+\S)+$/.test(s);
        // The new text keeps that look when most of its characters are still spaced out ("S Á B A D O S!").
        const mostlySpaced = (s: string) => {
            const pairs = s.replace(/\s+/g, "").length - 1;
            return pairs > 0 && (s.match(/\S(?=\s+\S)/g) ?? []).length >= 0.6 * pairs;
        };
        const collapse = (s: string) =>
            s
                .trim()
                .replace(/(\S)\s(?=\S)/g, "$1")
                .replace(/\s{2,}/g, " ");
        // Whitespace pdfjs borrowed from a neighbouring run (no glyph of ours draws it, e.g. after a superscript): it
        // must not come back as a space glyph.
        const runText = removed.map((p) => p.glyph.unicode ?? "").join("");
        if (/\s$/.test(targetStr) && !/\s$/.test(runText) && /\s$/.test(newText)) newText = newText.replace(/\s+$/, "");
        if (/^\s/.test(targetStr) && !/^\s/.test(runText) && /^\s/.test(newText)) newText = newText.replace(/^\s+/, "");
        if (letterSpaced(targetStr.trim()) && mostlySpaced(newText.trim())) {
            // Tell pdfjs' letter-spacing spaces from real space glyphs and positioned word gaps by aligning the target
            // with the glyphs; fall back to a plain collapse when the original collapses to exactly the glyphs.
            const mapped = this.dropLetterSpacing(removed, targetStr, newText);
            if (mapped !== null) newText = mapped;
            else {
                const pseudo = this.pseudoSpaces(removed);
                const visual = removed.map((p, i) => (pseudo[i] ? " " : "") + (p.glyph.unicode ?? "")).join("");
                if (collapse(targetStr).normalize("NFKC") === visual.normalize("NFKC")) newText = collapse(newText);
            }
        }

        // Minimal diff first: keep the unchanged prefix/suffix glyphs exactly as authored (kerning, spacing) and
        // rewrite only what changed. Falls through to whole-run replacement when not applicable.
        const noStyle = !style.color && !(style.sizeScale && Math.abs(style.sizeScale - 1) > 1e-6) && !style.forceStyle;
        if (noStyle) {
            // The rest of the line moves with the edited words (like a word processor) unless it is a separate column.
            const tail = reflowLine ? this.flowTail(removed) : [];
            const partial =
                (tail.length ? await this.replacePartial(removed, newText, targetStr, ctx, tail) : null) ??
                (await this.replacePartial(removed, newText, targetStr, ctx));
            if (partial) return partial;
        }

        const ins = await this.buildInsertion(anchor, ctx, newText, style, removed);
        if ("error" in ins) return { ok: false, reason: ins.error };
        const insertion = ins.ops;
        const insAdvPre = ins.advPre;
        const insertedCodes = ins.codes;
        const fallbackChars = ins.fallbackChars;
        const usedSibling = ins.usedSibling;

        // Rewrite every affected text-showing operator.
        const removedSet = new Set(removed.map((p) => p.seq));
        const staged = new Map(this.overrides);
        const streamsTouched = new Set(removed.map((p) => p.streamKey));
        for (const key of streamsTouched) {
            const sctx = this.interp.streams.get(key)!;
            const opsToRewrite = this.placementsByOp(key);
            const affectedOps = new Set(removed.filter((p) => p.streamKey === key).map((p) => p.opIndex));
            const parts: string[] = [];
            sctx.ops.forEach((op, i) => {
                if (!affectedOps.has(i)) {
                    parts.push(latin1(sctx.bytes.subarray(op.start, op.end)));
                    return;
                }
                const pls = opsToRewrite.get(i) ?? [];
                const isAnchorOp = key === anchor.streamKey && i === anchor.opIndex;
                parts.push(
                    this.rewriteShowOp(
                        op,
                        pls,
                        removedSet,
                        isAnchorOp ? { anchorSeq: anchor.seq, ops: insertion, advPre: insAdvPre } : null,
                        this.positionMattersAfter(sctx.ops, i),
                    ),
                );
            });
            staged.set(key, fromLatin1(parts.join("\n") + "\n"));
        }

        // Verify by re-interpretation.
        const after = this.interpret(staged);
        const verdict = this.verify(this.interp.placements, after.placements, removedSet, anchor, insertedCodes);
        if (verdict) return { ok: false, reason: `verification failed: ${verdict}` };
        this.overrides = staged;
        this.interp = after;
        return { ok: true, fallbackChars, usedSiblingFont: usedSibling };
    }

    private placementsByOp(key: string) {
        const m = new Map<number, Placement[]>();
        for (const p of this.interp.placements) {
            if (p.streamKey !== key) continue;
            if (!m.has(p.opIndex)) m.set(p.opIndex, []);
            m.get(p.opIndex)!.push(p);
        }
        return m;
    }

    /** Encode `text` for insertion in `anchor`'s text state and build the operators (style changes, font switches,
     *  TJ strings, restores). `gapRun` provides the letter-spacing rhythm to reproduce. */
    private async buildInsertion(
        anchor: Placement,
        ctx: StreamCtx,
        text: string,
        style: EditStyle,
        gapRun: Placement[],
        opts: { lead?: boolean; trail?: boolean } = {},
    ): Promise<{ ops: string[]; advPre: number; lead: number; codes: number[]; fallbackChars: number; usedSibling: boolean } | { error: string }> {
        const st = anchor.state;
        // Letter-spacing baked into TJ numbers / per-glyph Td (e.g. CSS letter-spacing in Chrome PDFs): reproduce the
        // run's median extra gap between glyphs through Tc so the new text has the same rhythm.
        const extra = this.medianExtraGap(gapRun);
        const tcIns = st.Tc + extra;
        // Appending after a glyph: its own gap is encoded after it (and stays there), so the new text opens with the
        // gap and gives it back after its last glyph instead of adding one more.
        const lead = opts.lead && Math.abs(extra) > 1e-9 ? extra : 0;
        // Before a kept word gap the last new glyph gives its letter gap back too (the gap already follows it).
        const trail = (opts.lead || opts.trail) && Math.abs(extra) > 1e-9 ? extra : 0;
        const segs = await this.encodeText(text, anchor, ctx, style);
        if ("error" in segs) return { error: segs.error };
        const sizeScale = style.sizeScale && style.sizeScale > 0 ? style.sizeScale : 1;
        const TfsIns = st.Tfs * sizeScale;

        const insOps: string[] = [];
        const restore: string[] = [];
        const color = style.color;
        if (color) {
            const c = color.map((v) => formatNumber(Math.max(0, Math.min(1, v)))).join(" ");
            insOps.push(`${c} rg`);
            restore.push(st.fill);
            if (st.Tr === 1 || st.Tr === 2 || st.Tr === 5 || st.Tr === 6) {
                insOps.push(`${c} RG`);
                restore.push(st.stroke);
            }
        }
        if (Math.abs(tcIns - st.Tc) > 1e-9) {
            insOps.push(`${formatNumber(tcIns)} Tc`);
            restore.push(`${formatNumber(st.Tc)} Tc`);
        }
        // Outlined Type3 text (CSS text-stroke): glyphs from other fonts are stroked at the ring's thickness, in the
        // text colour, so they look like the outline glyphs around them.
        const outline = st.font instanceof FontModel ? st.font.outlineWidth() : null;
        const tmScale = st.Tfs ? anchor.sizeUser / st.Tfs / (st.ctmScale || 1) : 0;
        let stroked = false;
        const strokeOn = () => {
            if (stroked || !outline || !tmScale) return;
            insOps.push(fillAsStroke(st.fill), `${formatNumber(outline * TfsIns * tmScale)} w`, "1 Tr");
            stroked = true;
        };
        const strokeOff = () => {
            if (!stroked) return;
            insOps.push(st.stroke, `${formatNumber(st.lineWidth)} w`, `${st.Tr} Tr`);
            stroked = false;
        };
        // Typed spaces take the line's word spacing: a justified line's stretch after each space glyph, or — when the
        // line draws its word gaps by positioning only (pdfTeX) — the same kind of gap without any glyph.
        const spacing = style.forceStyle || style.sizeScale ? { positioned: null, extra: 0 } : this.wordSpacing(anchor);
        let advPre = 0;
        let curFont: string | null = st.fontName;
        let curSize = st.Tfs;
        let fallbackChars = 0;
        let usedSibling = false;
        const codes: number[] = [];
        const tjs: { at: number; body: string; size: number }[] = [];
        let items: string[] = [];
        let hex: number[] = [];
        const flushHex = () => {
            if (hex.length) items.push(hexOf(hex));
            hex = [];
        };
        const flushTJ = () => {
            flushHex();
            if (items.length) {
                tjs.push({ at: insOps.length, body: items.join(" "), size: curSize });
                insOps.push(`[${items.join(" ")}] TJ`);
            }
            items = [];
        };
        const gapNum = (pre: number) => formatNumber((-pre * 1000) / curSize);
        // A font chosen through an ExtGState (/Font entry) has no resource name: re-applying that gs selects it again.
        const fontOp = (name: string, size: number) =>
            !name.startsWith("@gs:")
                ? serializeOp("Tf", [{ t: "name", v: name }, num(size)])
                : Math.abs(size - st.Tfs) < 1e-9
                  ? serializeOp("gs", [{ t: "name", v: name.slice(4) }])
                  : null;
        const isWsCh = (c: string) => /\s/.test(c);
        for (const seg of segs.segs) {
            if (spacing.positioned !== null && seg.chars.every((c) => isWsCh(c.ch))) {
                flushHex();
                for (let k = 0; k < seg.chars.length; k++) {
                    items.push(gapNum(spacing.positioned));
                    advPre += spacing.positioned;
                }
                continue;
            }
            const fname = seg.font === "orig" ? st.fontName : seg.font.name;
            if (seg.font !== "orig") {
                if (seg.font.pdfFont) fallbackChars += seg.chars.length;
                else usedSibling = true;
            }
            const wantStroke = seg.font !== "orig" && !!seg.font.pdfFont && !!outline && !!tmScale;
            if (wantStroke !== stroked || fname !== curFont || Math.abs(TfsIns - curSize) > 1e-9) flushTJ();
            if (wantStroke) strokeOn();
            else strokeOff();
            if (fname !== curFont || Math.abs(TfsIns - curSize) > 1e-9) {
                const op = fontOp(fname, TfsIns);
                if (!op) return { error: "font set through ExtGState at another size" };
                insOps.push(op);
                curFont = fname;
                curSize = TfsIns;
            }
            for (const ch of seg.chars) {
                if (spacing.positioned !== null && isWsCh(ch.ch)) {
                    flushHex();
                    items.push(gapNum(spacing.positioned));
                    advPre += spacing.positioned;
                    continue;
                }
                hex.push(...ch.bytes);
                advPre += ch.w0 * TfsIns + tcIns + (ch.isSpace ? st.Tw : 0);
                codes.push(ch.code);
                if (spacing.extra && isWsCh(ch.ch)) {
                    flushHex();
                    items.push(gapNum(spacing.extra));
                    advPre += spacing.extra;
                }
            }
        }
        flushTJ();
        strokeOff();
        const spacingOk = (lead !== 0 || trail !== 0) && tjs.length > 0 && tjs.every((t) => t.size);
        const leadOk = spacingOk && lead !== 0;
        if (spacingOk) {
            const f = tjs[0];
            const l = tjs[tjs.length - 1];
            const n = (v: number, size: number) => formatNumber((-v * 1000) / size);
            const head = (t: { size: number }) => (leadOk ? `${n(lead, t.size)} ` : "");
            const tailN = (t: { size: number }) => (trail ? ` ${n(-trail, t.size)}` : "");
            if (f === l) insOps[f.at] = `[${head(f)}${f.body}${tailN(f)}] TJ`;
            else {
                insOps[f.at] = `[${head(f)}${f.body}] TJ`;
                insOps[l.at] = `[${l.body}${tailN(l)}] TJ`;
            }
            if (leadOk) advPre += lead;
            if (trail) advPre -= trail;
        }
        if (curFont !== st.fontName || Math.abs(curSize - st.Tfs) > 1e-9) {
            const op = fontOp(st.fontName, st.Tfs);
            if (!op) return { error: "font set through ExtGState at another size" };
            restore.unshift(op);
        }
        return { ops: [...insOps, ...restore], advPre, lead: leadOk ? lead : 0, codes, fallbackChars, usedSibling };
    }

    /** Minimal-diff replacement inside ONE text-showing operator: the unchanged prefix keeps its exact glyphs and
     *  positions, the changed middle is replaced, the unchanged suffix follows the new text with its original
     *  kerning, and whatever comes after the run returns to its original position. Returns null when not applicable
     *  or when its verification fails (the caller then replaces the whole run). */
    private async replacePartial(run: Placement[], newText: string, targetStr: string, ctx: StreamCtx, tail: Placement[] = []): Promise<EditResult | null> {
        const first = run[0];
        const full = run.concat(tail);
        if (!full.every((p) => p.streamKey === first.streamKey)) return this.skip("partial: run spans several streams");
        const singleOp = full.every((p) => p.opIndex === first.opIndex);
        if (run.some((p) => !p.glyph.unicode)) return this.skip("partial: if (run.some((p) => !p.glyph.unicode))");
        const joined = run.map((p) => p.glyph.unicode).join("");
        if (targetStr && normText(joined) !== normText(targetStr)) return this.skip("partial: e.g. overprinted fake bold");
        // Word gaps drawn as positioning (TJ numbers, Td) instead of a space glyph — pdfTeX, Word justification —
        // appear as spaces in the extracted text; the diff consumes them so the gap itself is kept as authored.
        const pseudo = this.pseudoSpaces(run);
        const wsAt = (i: number) => {
            let k = i;
            while (k < newText.length && /\s/.test(newText[k])) k++;
            return k - i;
        };
        const wsBefore = (i: number) => {
            let k = i;
            while (k > 0 && /\s/.test(newText[k - 1])) k--;
            return i - k;
        };
        let p = 0;
        let pc = 0;
        const starts: number[] = [];
        while (p < run.length) {
            let c = pc;
            if (pseudo[p]) {
                const w = wsAt(c);
                if (!w) {
                    // The space was deleted: the gap goes with the glyph before it.
                    if (p > 0) pc = starts[--p];
                    break;
                }
                c += w;
            }
            const u = run[p].glyph.unicode!;
            if (!newText.startsWith(u, c)) {
                pc = c; // the gap before the first changed glyph stays
                break;
            }
            starts[p] = c;
            pc = c + u.length;
            p++;
        }
        let q = run.length - 1;
        let sc = newText.length;
        let wsGiven = 0;
        while (q >= p) {
            const u = run[q].glyph.unicode!;
            if (sc - u.length < pc || newText.slice(sc - u.length, sc) !== u) break;
            sc -= u.length;
            wsGiven = 0;
            q--;
            if (pseudo[q + 1]) {
                const w = wsBefore(sc);
                if (!w || sc - w < pc) break; // space deleted (or owned by the prefix): the gap goes with the middle
                sc -= w;
                wsGiven = w;
            }
        }
        // A positioned word gap (TJ number, Td) before the first kept glyph: when the edit replaced glyphs before it,
        // keep the gap itself (justified width); with nothing replaced it is already used before the insertion, so
        // the new text needs a real space.
        let gapKept = wsGiven > 0 && q >= p;
        if (!gapKept && q >= p && q === run.length - 1 && tail.length) {
            // The whole end of the run changes and the line goes on after a positioned word gap (pdfTeX, justified
            // text): that gap belongs to the rest of the line, not to the replaced glyphs.
            const last = run[run.length - 1];
            const t0 = tail[0];
            const perPre = last.advPre ? last.advUser / last.advPre : 0;
            const between = dot([t0.origin[0] - last.origin[0], t0.origin[1] - last.origin[1]], last.xAxis) - last.advUser;
            const isSp = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
            if (!isSp(last) && !isSp(t0) && between - Math.max(0, this.medianExtraGap(run) * perPre) > 0.1 * last.sizeUser) gapKept = true;
        }
        if (!gapKept) sc += wsGiven;
        // A changed part that needs a fallback font is widened to whole words, so no word mixes two typefaces.
        const isWsGlyph = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
        if (sc > pc && this.needsFallback(run[Math.min(p, run.length - 1)], newText.slice(pc, sc))) {
            const ws = (c: string | undefined) => c === undefined || /\s/.test(c);
            if (!ws(newText[pc]) && !ws(newText[pc - 1])) while (p > 0 && !isWsGlyph(run[p - 1]) && !pseudo[p]) pc = starts[--p];
            if (!ws(newText[sc - 1]) && !ws(newText[sc]))
                while (q + 1 < run.length && !isWsGlyph(run[q + 1]) && !pseudo[q + 1]) {
                    sc += run[q + 1].glyph.unicode!.length;
                    q++;
                }
        }
        const runSuffix = run.slice(q + 1);
        // The rest of the line (tail) follows the new text like the run's own suffix does.
        const suffix = runSuffix.concat(tail);
        const middleOld = run.slice(p, q + 1);
        const middleNew = newText.slice(pc, sc);
        if (!middleOld.length && !middleNew.length) return { ok: true, fallbackChars: 0, usedSiblingFont: false };
        if (p === 0 && !suffix.length) return this.skip("partial: nothing to preserve");
        if (!singleOp) return this.partialTdChain(full, run.slice(0, p), middleOld, middleNew, suffix, ctx, run, gapKept);

        const insertBefore: Placement | null = middleOld[0] ?? runSuffix[0] ?? null;
        const insertAfter: Placement | null = insertBefore ? null : run[run.length - 1];
        const at = (insertBefore ?? insertAfter)!;
        const ins = await this.buildInsertion(at, ctx, middleNew, {}, run, { lead: !insertBefore, trail: gapKept });
        if ("error" in ins) return this.skip(`partial: ${ins.error}`);
        const removedSet = new Set(middleOld.map((g) => g.seq));
        const suffixSet = new Set(suffix.map((g) => g.seq));
        const sctx = this.interp.streams.get(first.streamKey)!;
        const rewritten = this.rewritePartialOp(
            sctx,
            first.opIndex,
            { before: insertBefore?.seq, after: insertAfter?.seq, ops: ins.ops, advPre: ins.advPre, keepGapBefore: gapKept ? suffix[0]?.seq : undefined },
            removedSet,
            suffixSet,
            full[full.length - 1].seq,
            false,
        );
        if (rewritten === null) return this.skip("partial: insertion point not found");
        const parts = sctx.ops.map((o, i) => (i === first.opIndex ? rewritten : latin1(sctx.bytes.subarray(o.start, o.end))));
        const staged = new Map(this.overrides);
        staged.set(first.streamKey, fromLatin1(parts.join("\n") + "\n"));
        const afterInterp = this.interpret(staged);
        const insOrigin = insertBefore ? insertBefore.origin : this.pointAfter(at, ins.lead);
        if (!this.verifyPartial(afterInterp, full, removedSet, suffix, insOrigin, ins.codes)) return this.skip("partial: single-op verification");
        this.overrides = staged;
        this.interp = afterInterp;
        return { ok: true, fallbackChars: ins.fallbackChars, usedSiblingFont: ins.usedSibling, partial: true };
    }

    /** Rewrite ONE text-showing operator for a minimal-diff edit: glyphs before the insertion are kept, the insertion is
     *  emitted, replaced glyphs (and the spacing numbers between them) are dropped, suffix glyphs follow the new text,
     *  and glyphs after the run return to their original position. With `continuesAfter`, the run goes on in later
     *  operators and the end of this one is left shifted (the caller aligns what follows). */
    private rewritePartialOp(
        sctx: StreamCtx,
        opIndex: number,
        insertion: { before?: number; after?: number; ops: string[]; advPre: number; keepGapBefore?: number },
        removedSet: Set<number>,
        suffixSet: Set<number>,
        runLast: number,
        continuesAfter: boolean,
    ): string | null {
        const op = sctx.ops[opIndex];
        const opPls = this.placementsByOp(sctx.key).get(opIndex) ?? [];
        const Tfs = opPls[0]?.state.Tfs || 1;
        const out: string[] = [];
        if (op.op === "'") out.push("T*");
        if (op.op === '"') {
            const [aw, ac] = op.args;
            out.push(`${aw?.t === "num" ? formatNumber(aw.v) : "0"} Tw`, `${ac?.t === "num" ? formatNumber(ac.v) : "0"} Tc`, "T*");
        }
        const strArg = op.op === '"' ? op.args[2] : op.args[0];
        const items: Operand[] = op.op === "TJ" ? (op.args[0]?.t === "arr" ? op.args[0].items : []) : strArg ? [strArg] : [];
        const byElem = new Map<number, Placement[]>();
        for (const g of opPls) {
            if (!byElem.has(g.elem)) byElem.set(g.elem, []);
            byElem.get(g.elem)!.push(g);
        }
        let cur: Operand[] = [];
        let kept: number[] = [];
        let debt = 0;
        let removedAdv = 0;
        let inserted = false;
        let inMiddle = false;
        let afterRun = false;
        const flushKept = () => {
            if (kept.length) cur.push(str(kept));
            kept = [];
        };
        const flushDebt = () => {
            if (Math.abs(debt) > 1e-9) cur.push(num((-debt * 1000) / Tfs));
            debt = 0;
        };
        const closeTJ = () => {
            flushKept();
            if (cur.length) out.push(`[${cur.map((o) => (o.t === "num" ? formatNumber(o.v) : o.t === "str" ? hexOf(o.bytes) : "")).join(" ")}] TJ`);
            cur = [];
        };
        const emitInsertion = () => {
            closeTJ();
            out.push(...insertion.ops);
            inserted = true;
            inMiddle = insertion.before !== undefined; // appending after a glyph removes nothing: its spacing stays
        };
        // Numbers after the last replaced glyph: dropped with it, unless they are the word gap we keep.
        let pendingNums: Operand[] = [];
        const dropPending = () => {
            for (const o of pendingNums) if (o.t === "num") removedAdv += (-o.v / 1000) * Tfs;
            pendingNums = [];
        };
        items.forEach((it, k) => {
            if (it.t === "num") {
                if (inMiddle) {
                    if (insertion.keepGapBefore !== undefined) pendingNums.push(it);
                    else removedAdv += (-it.v / 1000) * Tfs; // spacing that belonged to the replaced glyphs
                    return;
                }
                flushKept();
                cur.push(it);
                return;
            }
            if (it.t !== "str") return;
            for (const g of (byElem.get(k) ?? []).slice().sort((x, y) => x.gi - y.gi)) {
                if (insertion.before !== undefined && g.seq === insertion.before) emitInsertion();
                if (removedSet.has(g.seq)) {
                    dropPending();
                    removedAdv += g.advPre;
                    continue;
                }
                if (g.seq === insertion.keepGapBefore && pendingNums.length) {
                    flushKept();
                    cur.push(...pendingNums);
                    pendingNums = [];
                } else dropPending();
                if (suffixSet.has(g.seq)) inMiddle = false;
                else if (g.seq > runLast && !afterRun) {
                    afterRun = true;
                    inMiddle = false;
                    debt = removedAdv - insertion.advPre;
                }
                if (Math.abs(debt) > 1e-9) {
                    flushKept();
                    flushDebt();
                }
                kept.push(...g.glyph.bytes);
                if (insertion.after !== undefined && g.seq === insertion.after) emitInsertion();
            }
            flushKept();
        });
        dropPending(); // the kept gap's glyph is in a later operator: positions there come from its own moves
        if (!inserted) return null;
        if (!afterRun && !continuesAfter) debt = removedAdv - insertion.advPre;
        flushKept();
        if (!continuesAfter && this.positionMattersAfter(sctx.ops, opIndex)) flushDebt();
        closeTJ();
        return out.join("\n");
    }

    /** Minimal diff for runs spread over several operators (Chrome/Skia and Canva place glyphs one or two per `Tj`
     *  with relative `Td` moves). The operator holding the insertion point is rewritten like a single-operator edit
     *  (its suffix glyphs follow the new text); later operators of the run are shifted by the same amount with one
     *  compensating `Td`, which is undone right after the run so nothing else moves. */
    private async partialTdChain(
        run: Placement[],
        prefix: Placement[],
        middleOld: Placement[],
        middleNew: string,
        suffix: Placement[],
        ctx: StreamCtx,
        gapRun: Placement[] = run,
        gapKept = false,
    ): Promise<EditResult | null> {
        const key = run[0].streamKey;
        const sctx = this.interp.streams.get(key);
        if (!sctx) return this.skip("chain: stream");
        const ops = sctx.ops;
        if (!prefix.length && !middleOld.length && !suffix.length) return this.skip("chain: nothing to keep");
        // Pure prepend: the new text goes in front of the first kept glyph.
        const insertBefore = middleOld[0] ?? (prefix.length ? null : suffix[0]);
        const insertAfter = insertBefore ? null : prefix[prefix.length - 1];
        const at = (insertBefore ?? insertAfter)!;
        const I = at.opIndex;
        const ins = await this.buildInsertion(at, ctx, middleNew, {}, gapRun, { lead: !insertBefore, trail: gapKept });
        if ("error" in ins) return this.skip(`chain: ${ins.error}`);
        if (!at.advPre || !at.advUser || !at.state.Th) return this.skip("chain: zero advance at insertion");
        const userPerPre = at.advUser / at.advPre;
        const userPerTd = userPerPre / at.state.Th; // Td translations are not scaled by Tz
        const xAxis = at.xAxis;
        const insOrigin = insertBefore ? insertBefore.origin : this.pointAfter(at, ins.lead);

        const removedSet = new Set(middleOld.map((g) => g.seq));
        const suffixSet = new Set(suffix.map((g) => g.seq));
        const runOps = Array.from(new Set(run.map((g) => g.opIndex))).sort((a, b) => a - b);
        if (runOps.some((i) => i < I && run.some((g) => g.opIndex === i && (removedSet.has(g.seq) || suffixSet.has(g.seq)))))
            return this.skip("chain: changed glyphs before the insertion operator");
        const laterOps = runOps.filter((i) => i > I);
        const lastRunOp = runOps[runOps.length - 1];

        // Shift that every suffix glyph receives.
        const N = ins.advPre * userPerPre;
        let shiftUser: number;
        const lastOld = middleOld[middleOld.length - 1];
        if (gapKept && insertBefore && lastOld && suffix.length) {
            // The word gap before the first kept glyph stays as it was: it now follows the new text.
            shiftUser = N - (dot([lastOld.origin[0] - insOrigin[0], lastOld.origin[1] - insOrigin[1]], xAxis) + lastOld.advUser);
        } else if (insertBefore && suffix.length) {
            // The first suffix glyph lands right after the new text (whose last gap is already in N), wherever the
            // original put it — this also drops the letter-spacing gap that followed the last removed glyph.
            shiftUser = dot([insOrigin[0] - suffix[0].origin[0], insOrigin[1] - suffix[0].origin[1]], xAxis) + N;
        } else {
            const last = middleOld[middleOld.length - 1];
            const removedSpan = last ? dot([last.origin[0] - insOrigin[0], last.origin[1] - insOrigin[1]], xAxis) + last.advUser : 0;
            shiftUser = N - removedSpan;
        }

        const TEXT_OPS = new Set(["Tj", "TJ", "'", '"', "Td", "TD", "Tm", "T*", "BT", "ET"]);
        const prevTextOp = (i: number) => {
            for (let k = i - 1; k >= 0; k--) if (TEXT_OPS.has(ops[k].op)) return ops[k].op;
            return null;
        };
        const nextTextOp = (i: number) => {
            for (let k = i + 1; k < ops.length; k++) if (TEXT_OPS.has(ops[k].op) && !drawsNothing(ops[k])) return { op: ops[k].op, index: k };
            return null;
        };

        // Later operators: the first one is moved through one Td (if it starts a line segment) or inherits the shift
        // by advance; relative moves after it inherit it too, but every absolute restart (Tm, or a new BT — Word
        // splits lines into several text objects) needs its own Td.
        const shiftTdAt = new Set<number>();
        const shiftTd = shiftUser / userPerTd;
        if (laterOps.length && suffix.some((g) => g.opIndex > I) && Math.abs(shiftUser) > 1e-6) {
            // `lineMoved`: a shift Td was inserted since the last absolute positioning, so relative moves inherit it.
            let lineMoved = false;
            laterOps.forEach((li) => {
                if (positionReset(ops, li)) {
                    shiftTdAt.add(li);
                    lineMoved = true;
                } else if (!lineMoved && startsRelative(ops, li)) {
                    shiftTdAt.add(li);
                    lineMoved = true;
                }
                // otherwise it continues by advance from a shifted glyph, or its line matrix already moved
            });
            const prev0 = prevTextOp(laterOps[0]);
            if (!shiftTdAt.has(laterOps[0]) && prev0 !== "Tj" && prev0 !== "TJ")
                return this.skip(`chain: unexpected operator before the run continuation (${prev0})`);
        }
        // After the run: undo the Td shift before the next line-segment move; an advance continuation can't be fixed.
        let compAt = -1;
        const nxt = nextTextOp(lastRunOp);
        const endShifted = Math.abs(shiftUser) > 1e-6 && (lastRunOp > I || laterOps.length === 0);
        if (shiftTdAt.size && nxt && ["Td", "TD", "T*", "'", '"'].includes(nxt.op)) compAt = nxt.index;
        if (endShifted && lastRunOp > I && nxt && (nxt.op === "Tj" || nxt.op === "TJ")) return this.skip("chain: text continues by advance after the run");

        const byOp = this.placementsByOp(key);
        const parts: string[] = [];
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            let text: string | null;
            if (i === I) {
                text = this.rewritePartialOp(
                    sctx,
                    I,
                    {
                        before: insertBefore?.seq,
                        after: insertAfter?.seq,
                        ops: ins.ops,
                        advPre: ins.advPre,
                        keepGapBefore: gapKept ? suffix[0]?.seq : undefined,
                    },
                    removedSet,
                    suffixSet,
                    run[run.length - 1].seq,
                    laterOps.length > 0,
                );
                if (text === null) return this.skip("chain: insertion point not found");
            } else if (laterOps.includes(i) && (byOp.get(i) ?? []).some((g) => removedSet.has(g.seq))) {
                // Continuing by advance from the insertion, whose width already replaces these glyphs: drop them.
                const byAdvance = !positionReset(ops, i) && !startsRelative(ops, i);
                text = this.rewriteShowOp(op, byOp.get(i) ?? [], removedSet, null, this.positionMattersAfter(ops, i), byAdvance);
            } else text = latin1(sctx.bytes.subarray(op.start, op.end));
            if (shiftTdAt.has(i)) text = `${formatNumber(shiftTd)} 0 Td\n${text}`;
            if (i === compAt) text = `${formatNumber(-shiftTd)} 0 Td\n${text}`;
            parts.push(text);
        }
        const staged = new Map(this.overrides);
        staged.set(key, fromLatin1(parts.join("\n") + "\n"));
        const afterInterp = this.interpret(staged);
        if (!this.verifyPartial(afterInterp, run, removedSet, suffix, insOrigin, ins.codes)) return this.skip("chain: verification");
        this.overrides = staged;
        this.interp = afterInterp;
        return { ok: true, fallbackChars: ins.fallbackChars, usedSiblingFont: ins.usedSibling, partial: true };
    }

    /** Before the change untouched; new glyphs start at `insOrigin`; suffix shifted by one constant vector along the
     *  baseline; everything after the run untouched. */
    private verifyPartial(
        afterInterp: Interpretation,
        run: Placement[],
        removedSet: Set<number>,
        suffix: Placement[],
        insOrigin: [number, number],
        codes: number[],
    ) {
        const before = this.interp.placements;
        const now = afterInterp.placements;
        const firstSeq = run[0].seq;
        const runLast = run[run.length - 1].seq;
        const suffixSet = new Set(suffix.map((g) => g.seq));
        const pre = before.filter((g) => g.seq < firstSeq || (g.seq <= runLast && !removedSet.has(g.seq) && !suffixSet.has(g.seq)));
        const post = before.filter((g) => g.seq > runLast);
        if (now.length !== pre.length + codes.length + suffix.length + post.length)
            return this.skipFalse("verify: if (now.length !== pre.length + codes.length + suffix.length + post.length)");
        const tol = 0.01;
        const same = (x: Placement, y: Placement, dx = 0, dy = 0) =>
            x.glyph.code === y.glyph.code && Math.abs(x.origin[0] + dx - y.origin[0]) < tol && Math.abs(x.origin[1] + dy - y.origin[1]) < tol;
        for (let i = 0; i < pre.length; i++)
            if (!same(pre[i], now[i])) return this.skipFalse("verify: for (let i = 0; i < pre.length; i++) if (!same(pre[i], now[i]))");
        for (let j = 0; j < codes.length; j++)
            if (now[pre.length + j].glyph.code !== codes[j])
                return this.skipFalse("verify: for (let j = 0; j < codes.length; j++) if (now[pre.length + j].glyph.code !== codes[j])");
        if (codes.length && Math.hypot(now[pre.length].origin[0] - insOrigin[0], now[pre.length].origin[1] - insOrigin[1]) > tol)
            return this.skipFalse("verify: if (codes.length && Math.hypot(now[pre.length].origin[0] - insOrigin[0], now[pre.length].o");
        const sBase = pre.length + codes.length;
        if (suffix.length) {
            const dx = now[sBase].origin[0] - suffix[0].origin[0];
            const dy = now[sBase].origin[1] - suffix[0].origin[1];
            if (Math.abs(-dx * run[0].xAxis[1] + dy * run[0].xAxis[0]) > tol)
                return this.skipFalse("verify: if (Math.abs(-dx * run[0].xAxis[1] + dy * run[0].xAxis[0]) > tol)");
            for (let j = 0; j < suffix.length; j++)
                if (!same(suffix[j], now[sBase + j], dx, dy))
                    return this.skipFalse("verify: for (let j = 0; j < suffix.length; j++) if (!same(suffix[j], now[sBase + j], dx, dy))");
        }
        const pBase = sBase + suffix.length;
        for (let j = 0; j < post.length; j++)
            if (!same(post[j], now[pBase + j])) return this.skipFalse("verify: for (let j = 0; j < post.length; j++) if (!same(post[j], now[pBase + j]))");
        return true;
    }

    /** Median extra space between consecutive glyphs of the run, measured from their REAL positions —
     *  works whether letter-spacing was encoded as Tc, TJ numbers or one Td per glyph (Chrome/Canva). */
    private medianExtraGap(run: Placement[]): number {
        const gaps: number[] = [];
        for (let i = 0; i + 1 < run.length; i++) {
            const p = run[i];
            const q = run[i + 1];
            if (!p.advPre || !p.advUser) continue;
            const rel: [number, number] = [q.origin[0] - p.origin[0], q.origin[1] - p.origin[1]];
            if (Math.abs(dot(rel, [-p.xAxis[1], p.xAxis[0]])) > 0.1 * p.sizeUser) continue; // not on the same baseline
            const userPerPre = p.advUser / p.advPre;
            // Remove the Tc already applied by the state so we measure only what Tc must add.
            const du = dot(rel, p.xAxis) - p.advUser;
            gaps.push(du / userPerPre);
        }
        if (run.length === 1) {
            // One glyph: take the rhythm from its neighbour on the same baseline.
            const p = run[0];
            for (const q of [this.interp.placements[p.seq + 1], this.interp.placements[p.seq - 1]]) {
                if (!q || q.streamKey !== p.streamKey || !p.advPre || !p.advUser) continue;
                const [a, b] = q.seq > p.seq ? [p, q] : [q, p];
                if (!a.advPre || !a.advUser) continue;
                const rel: [number, number] = [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]];
                if (Math.abs(dot(rel, [-a.xAxis[1], a.xAxis[0]])) > 0.1 * a.sizeUser) continue;
                gaps.push((dot(rel, a.xAxis) - a.advUser) / (a.advUser / a.advPre));
                break;
            }
        }
        if (gaps.length < 1) return 0;
        gaps.sort((x, y) => x - y);
        const med = gaps[Math.floor(gaps.length / 2)];
        return Math.abs(med) > 0.01 * run[0].state.Tfs ? med : 0;
    }

    /** True when `text` has a character the run's own font (after learning the whole document) can't draw. */
    private needsFallback(g: Placement, text: string): boolean {
        const font = g.state.font;
        if (!(font instanceof FontModel)) return false;
        const missing = () => Array.from(text).some((ch) => !/\s/.test(ch) && !font.encodeChar(ch));
        if (!missing()) return false;
        return !(font.isEmbedded && this.scanDocument()) || missing();
    }

    /** Letter-spaced run: classify every whitespace of `targetStr` (pdfjs text) as a real space (a space glyph, or a
     *  positioned word gap) or as letter-spacing, by walking it along the glyphs; carry that to `newText` where it is
     *  unchanged, and treat single spaces between letters in the changed part as letter-spacing. Null when the target
     *  doesn't align with the glyphs. */
    private dropLetterSpacing(run: Placement[], targetStr: string, newText: string): string | null {
        const t = Array.from(targetStr.normalize("NFKC"));
        const n = Array.from(newText.normalize("NFKC"));
        const keep: (boolean | null)[] = t.map(() => null);
        const pseudo = this.pseudoSpaces(run);
        const ws = (c: string | undefined) => c !== undefined && /\s/.test(c);
        let ti = 0;
        for (let gi = 0; gi < run.length; gi++) {
            const u = (run[gi].glyph.unicode ?? "").normalize("NFKC");
            if (!u) return null;
            if (/^\s+$/.test(u)) {
                // A space glyph: the whitespace around it in the text is ONE real space.
                let first = true;
                while (ws(t[ti])) {
                    keep[ti++] = first;
                    first = false;
                }
                continue;
            }
            let first = true;
            while (ws(t[ti])) {
                keep[ti++] = first && pseudo[gi]; // a positioned word gap counts once, letter gaps not at all
                first = false;
            }
            for (const ch of Array.from(u)) if (t[ti++] !== ch) return null;
        }
        while (ws(t[ti])) keep[ti++] = false;
        if (ti !== t.length) return null;
        let a = 0;
        while (a < n.length && a < t.length && n[a] === t[a]) a++;
        let b = 0;
        while (b < n.length - a && b < t.length - a && n[n.length - 1 - b] === t[t.length - 1 - b]) b++;
        const out: string[] = [];
        for (let i = 0; i < n.length; i++) {
            if (!ws(n[i])) {
                out.push(n[i]);
                continue;
            }
            let k: boolean;
            if (i < a) k = !!keep[i];
            else if (i >= n.length - b) k = !!keep[t.length - (n.length - i)];
            else k = !(i > 0 && i + 1 < n.length && !ws(n[i - 1]) && !ws(n[i + 1])); // single space between letters
            if (k && out.length && out[out.length - 1] !== " ") out.push(" ");
        }
        return out.join("").trim();
    }

    /** `out[i]` is true when a word gap is drawn by positioning (no space glyph) between glyphs i-1 and i: wider than
     *  the run's usual letter gap by more than ~0.1 em, the threshold at which extractors print a space. */
    private pseudoSpaces(run: Placement[]): boolean[] {
        const out = run.map(() => false);
        const gaps: (number | null)[] = run.map(() => null);
        for (let i = 1; i < run.length; i++) {
            const a = run[i - 1];
            const rel: [number, number] = [run[i].origin[0] - a.origin[0], run[i].origin[1] - a.origin[1]];
            if (Math.abs(dot(rel, [-a.xAxis[1], a.xAxis[0]])) > 0.1 * a.sizeUser) continue;
            gaps[i] = dot(rel, a.xAxis) - a.advUser;
        }
        const vals = gaps.filter((g): g is number => g !== null).sort((x, y) => x - y);
        const base = Math.max(0, vals.length ? vals[Math.floor(vals.length / 2)] : 0);
        const isSpace = (g: Placement) => g.glyph.isSpace || /^\s+$/.test(g.glyph.unicode ?? "");
        for (let i = 1; i < run.length; i++) {
            const g = gaps[i];
            if (g !== null && !isSpace(run[i - 1]) && !isSpace(run[i]) && g - base > 0.1 * run[i].sizeUser) out[i] = true;
        }
        return out;
    }

    /** Point right after glyph `g`, plus `extraPre` unscaled text-space units along its baseline. */
    private pointAfter(g: Placement, extraPre = 0): [number, number] {
        const perPre = g.advPre ? g.advUser / g.advPre : 0;
        const d = g.advUser + extraPre * perPre;
        return [g.origin[0] + g.xAxis[0] * d, g.origin[1] + g.xAxis[1] * d];
    }

    /** Glyphs that continue the run's line in the same flow: same stream, baseline and direction, each within a
     *  word gap of the previous one. A wider gap (a table column, a tab stop) ends the flow. */
    private flowTail(run: Placement[], interp: Interpretation = this.interp): Placement[] {
        const last = run[run.length - 1];
        const pls = interp.placements;
        const hidden = (g: Placement) => g.state.Tr === 3 || g.state.Tr === 7;
        const size = last.sizeUser || 1;
        const perPre = last.advPre ? last.advUser / last.advPre : 0;
        const maxGap = 0.8 * size + 2 * Math.max(0, this.medianExtraGap(run) * perPre);
        const [ax, ay] = last.xAxis;
        const out: Placement[] = [];
        let prev = last;
        const seenGaps = this.wordGapsOf(run);
        for (let s = last.seq + 1; s < pls.length && out.length < 400; s++) {
            const g = pls[s];
            // Geometry only: glyphs a previous edit inserted from a fallback font have no Unicode here.
            if (!g || g.seq !== s || g.streamKey !== last.streamKey || hidden(g) !== hidden(last)) break;
            if (Math.abs(g.xAxis[0] - ax) > 1e-3 || Math.abs(g.xAxis[1] - ay) > 1e-3) break;
            const rel: [number, number] = [g.origin[0] - prev.origin[0], g.origin[1] - prev.origin[1]];
            if (!onSameLine(prev, g, ax, ay)) break;
            const gap = dot(rel, [ax, ay]) - prev.advUser;
            if (gap < -0.25 * size) break;
            if (gap > maxGap && !this.spacedLikeLine(gap, seenGaps, pls, s, ax, ay, size)) break;
            if (gap > 0.1 * size) seenGaps.push(gap);
            out.push(g);
            prev = g;
        }
        return out;
    }

    /** Word gaps (wider than 0.1 em) between consecutive glyphs of a run. */
    private wordGapsOf(run: Placement[]): number[] {
        const out: number[] = [];
        for (let k = 1; k < run.length; k++) {
            const a = run[k - 1];
            const gap = dot([run[k].origin[0] - a.origin[0], run[k].origin[1] - a.origin[1]], a.xAxis) - a.advUser;
            if (gap > 0.1 * (a.sizeUser || 1)) out.push(gap);
        }
        return out;
    }

    /** A gap wider than a normal word gap is still one when the line is set with wide word spacing (CSS
     *  word-spacing): the line's other word gaps — before it, and after it up to a column-sized gap — are about as
     *  wide. The gap before a table column is not (columns differ, and the words inside a cell sit close). */
    private spacedLikeLine(gap: number, before: number[], pls: Placement[], at: number, ax: number, ay: number, size: number): boolean {
        if (gap > 2 * size) return false;
        const gaps = [...before];
        for (let k = at + 1; k < pls.length && k < at + 200; k++) {
            const a = pls[k - 1];
            const b = pls[k];
            if (!b || b.streamKey !== a.streamKey || !onSameLine(a, b, ax, ay)) break;
            const g = (b.origin[0] - a.origin[0]) * ax + (b.origin[1] - a.origin[1]) * ay - a.advUser;
            if (g > 2 * size || g < -0.25 * size) break;
            if (g > 0.1 * size) gaps.push(g);
        }
        if (!gaps.length) return false;
        gaps.sort((x, y) => x - y);
        const med = gaps[Math.floor(gaps.length / 2)];
        return med >= gap / 1.25 && med <= gap * 1.25;
    }

    // True when the text position after op `i` still matters, i.e. the next text operator shows glyphs
    // from the current position instead of repositioning the line (Td, TD, Tm, T-star, quote ops, BT, ET).
    private positionMattersAfter(ops: ContentOp[], i: number): boolean {
        for (let k = i + 1; k < ops.length; k++) {
            switch (ops[k].op) {
                case "Tj":
                case "TJ":
                    if (drawsNothing(ops[k])) continue; // only moves the position: look further
                    return true;
                case "Td":
                case "TD":
                case "Tm":
                case "T*":
                case "'":
                case '"':
                case "BT":
                case "ET":
                    return false;
            }
        }
        return false;
    }

    /** Encode new text word by word. Each word uses ONE font — the original, a same-family sibling on the page, the
     *  same typeface from the font pack, or a Standard 14 face — so words never mix designs and pdfjs keeps them as
     *  whole items on re-edit. A glyph that no candidate really contains fails the edit instead of drawing .notdef. */
    private async encodeText(text: string, anchor: Placement, ctx: StreamCtx, style: EditStyle): Promise<{ segs: Seg[] } | { error: string }> {
        const orig = anchor.state.font as FontModel;
        const info = orig.styleInfo();
        const origBold = info.weight >= 600;
        const styleChanged = !!style.forceStyle && (style.forceStyle.bold !== origBold || style.forceStyle.italic !== info.italic);
        const wantItalic = styleChanged ? style.forceStyle!.italic : info.italic;
        // When the user toggles bold we target the regular/bold weight; otherwise keep the exact weight.
        const wantWeight = styleChanged ? (style.forceStyle!.bold ? (origBold ? info.weight : 700) : 400) : info.weight;

        type Encoder = { seg: Seg["font"]; encode: (ch: string) => EncodedChar | null };
        const encoders: Encoder[] = [];
        if (!styleChanged) {
            let scanned = false;
            encoders.push({
                seg: "orig",
                encode: (ch) => {
                    let e = orig.encodeChar(ch);
                    // A subset font may contain the glyph because another page uses it: learn from the document once.
                    if (!e && !scanned && orig.isEmbedded) {
                        scanned = true;
                        if (this.scanDocument()) e = orig.encodeChar(ch);
                    }
                    return e;
                },
            });
        }
        for (const s of this.siblingFonts(ctx, orig, info.family, wantWeight, wantItalic))
            encoders.push({ seg: s.seg, encode: (ch) => s.model.encodeChar(ch) });

        // Fallback faces, created lazily: same typeface from the pack, then Standard 14.
        const request: FallbackRequest = {
            baseFont: info.name,
            family: info.family,
            weight: wantWeight,
            bold: wantWeight >= 600,
            italic: wantItalic,
            serif: info.serif,
            mono: info.mono,
        };
        const tiers: (() => Promise<Encoder | null>)[] = [{ standardOnly: false }, { standardOnly: true }, { universal: true }].map((tier) => {
            let cached: Encoder | null | undefined;
            return async () => {
                if (cached !== undefined) return cached;
                const pdfFont = await this.fallback({ ...request, ...tier });
                cached = pdfFont ? this.fallbackEncoder(ctx, pdfFont) : null;
                return cached;
            };
        });
        // Whole words: same typeface, then Standard 14. The wide-coverage face only fills single characters.
        const fallbackEncoders = tiers.slice(0, 2);

        const segs: Seg[] = [];
        const push = (font: Seg["font"], chars: EncodedChar[]) => {
            if (!chars.length) return;
            const last = segs[segs.length - 1];
            if (last && last.font === font) last.chars.push(...chars);
            else segs.push({ font, chars: [...chars] });
        };
        const encodeAll = (enc: Encoder, chars: string[]) => {
            const out: EncodedChar[] = [];
            for (const ch of chars) {
                const e = enc.encode(ch);
                if (!e) return null;
                out.push(e);
            }
            return out;
        };
        const tokens = text.match(/\s+|\S+/g) ?? [];
        let lastEncoder: Encoder | null = null;
        for (const token of tokens) {
            const chars = Array.from(token);
            const isSpace = /^\s+$/.test(token);
            // Whitespace follows the previous word's font when possible (keeps the line in few items).
            const order: Encoder[] = isSpace && lastEncoder ? [lastEncoder, ...encoders] : encoders;
            let done = false;
            for (const enc of order) {
                const out = encodeAll(enc, chars);
                if (out) {
                    push(enc.seg, out);
                    lastEncoder = enc;
                    done = true;
                    break;
                }
            }
            if (done) continue;
            for (const getFb of fallbackEncoders) {
                const enc = await getFb();
                const out = enc && encodeAll(enc, chars);
                if (enc && out) {
                    push(enc.seg, out);
                    lastEncoder = enc;
                    done = true;
                    break;
                }
            }
            if (done) continue;
            // Last resort: character by character across every candidate.
            for (const ch of chars) {
                let e: EncodedChar | null = null;
                let seg: Seg["font"] | null = null;
                for (const enc of encoders) {
                    e = enc.encode(ch);
                    if (e) {
                        seg = enc.seg;
                        break;
                    }
                }
                if (!e) {
                    for (const getFb of tiers) {
                        const enc = await getFb();
                        e = enc?.encode(ch) ?? null;
                        if (e && enc) {
                            seg = enc.seg;
                            break;
                        }
                    }
                }
                if (!e || !seg) return { error: `character "${ch}" is not available in any font` };
                push(seg, [e]);
            }
        }
        return { segs };
    }

    /** Encoder for a pdf-lib font we embed: verifies the glyph really exists (pdf-lib maps unknown characters to
     *  glyph 0 for custom fonts instead of throwing). The font resource is registered on first use. */
    private fallbackEncoder(ctx: StreamCtx, pdfFont: PDFFont) {
        const model = this.virtualFor(pdfFont);
        const fk = (pdfFont as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font;
        const seg = { name: "", model, pdfFont };
        return {
            seg: seg as Seg["font"],
            encode: (ch: string): EncodedChar | null => {
                const cp = ch.codePointAt(0);
                if (cp === undefined) return null;
                if (fk?.hasGlyphForCodePoint) {
                    try {
                        if (!fk.hasGlyphForCodePoint(cp) && !/\s/.test(ch)) return null;
                    } catch {
                        return null;
                    }
                }
                let bytes: Uint8Array;
                try {
                    bytes = pdfFont.encodeText(ch).asBytes();
                } catch {
                    return null; // Standard 14: outside WinAnsi
                }
                if (bytes.length !== model.byteLen) return null;
                let code = 0;
                for (const x of bytes) code = code * 256 + x;
                if (model.byteLen === 2 && code === 0) return null; // .notdef
                if (!seg.name) seg.name = this.registerFallback(ctx, pdfFont);
                const w0 = pdfFont.widthOfTextAtSize(ch, 1);
                model.widths.set(code, w0);
                model.unicode.set(code, ch);
                return { ch, code, bytes, w0, isSpace: bytes.length === 1 && code === 32 };
            },
        };
    }

    private siblingFonts(ctx: StreamCtx, orig: FontModel, family: string, weight: number, italic: boolean) {
        const out: { model: FontModel; seg: Seg["font"] }[] = [];
        const fontDict = ctx.resources?.lookup(N("Font"));
        if (!(fontDict instanceof PDFDict) || !family) return out;
        for (const [k, v] of fontDict.entries()) {
            const m = this.registry.get(v);
            if (!(m instanceof FontModel) || m === orig || !m.supported) continue;
            const d = m.styleInfo();
            if (d.family !== family || d.weight !== weight || d.italic !== italic) continue;
            out.push({ model: m, seg: { name: k.decodeText(), model: m } });
        }
        return out;
    }

    private virtualFor(font: PDFFont): VirtualFont {
        let v = this.virtualFonts.get(font);
        if (!v) {
            // Standard 14 fonts are single-byte WinAnsi; embedded custom fonts use 2-byte Identity-H.
            let len = 2;
            try {
                len = font.encodeText("a").asBytes().length || 2;
            } catch {
                /* keep 2 */
            }
            v = new VirtualFont(len);
            this.virtualFonts.set(font, v);
            this.registry.setVirtual(font.ref, v);
        }
        return v;
    }

    private registerFallback(ctx: StreamCtx, font: PDFFont): string {
        const res = ctx.resources ?? this.pageResources();
        if (!res) throw new Error("page has no resources");
        const key = ctx.key;
        let names = this.fallbackNames.get(key);
        if (!names) {
            names = new Map();
            this.fallbackNames.set(key, names);
        }
        const existing = names.get(font);
        if (existing) return existing;
        let fonts = res.lookup(N("Font"));
        if (!(fonts instanceof PDFDict)) {
            fonts = this.context.obj({});
            res.set(N("Font"), fonts as PDFDict);
        }
        const fd = fonts as PDFDict;
        const nm = fd.uniqueKey("LPEd");
        fd.set(nm, font.ref);
        names.set(font, nm.decodeText());
        return nm.decodeText();
    }

    private rewriteShowOp(
        op: ContentOp,
        placements: Placement[],
        removed: Set<number>,
        /** Insert before the (removed) glyph `anchorSeq`, or right after the kept glyph `afterSeq`. */
        insertion: { anchorSeq?: number; afterSeq?: number; ops: string[]; advPre: number } | null,
        trailingPositionMatters: boolean,
        /** Drop removed glyphs and the spacing numbers next to them instead of keeping their displacement. */
        dropRemoved = false,
    ): string {
        const Tfs = placements[0]?.state.Tfs ?? 1;
        const out: string[] = [];
        if (op.op === "'") out.push("T*");
        if (op.op === '"') {
            const [aw, ac] = op.args;
            out.push(`${aw?.t === "num" ? formatNumber(aw.v) : "0"} Tw`, `${ac?.t === "num" ? formatNumber(ac.v) : "0"} Tc`, "T*");
        }
        const strArg = op.op === '"' ? op.args[2] : op.args[0];
        const items: Operand[] = op.op === "TJ" ? (op.args[0]?.t === "arr" ? op.args[0].items : []) : strArg ? [strArg] : [];
        const byElem = new Map<number, Placement[]>();
        for (const p of placements) {
            if (!byElem.has(p.elem)) byElem.set(p.elem, []);
            byElem.get(p.elem)!.push(p);
        }
        let cur: Operand[] = [];
        let kept: number[] = [];
        let debt = 0;
        const flushKept = () => {
            if (kept.length) cur.push(str(kept));
            kept = [];
        };
        const flushDebt = () => {
            if (Math.abs(debt) > 1e-9) cur.push(num((-debt * 1000) / Tfs));
            debt = 0;
        };
        const closeTJ = () => {
            flushKept();
            if (cur.length) out.push(`[${cur.map((o) => (o.t === "num" ? formatNumber(o.v) : o.t === "str" ? hexOf(o.bytes) : "")).join(" ")}] TJ`);
            cur = [];
        };
        let pendingNums: Operand[] = [];
        let prevRemoved = false;
        items.forEach((it, k) => {
            if (it.t === "num") {
                if (dropRemoved) {
                    pendingNums.push(it);
                    return;
                }
                flushKept();
                cur.push(it);
                return;
            }
            if (it.t !== "str") return;
            const pls = (byElem.get(k) ?? []).sort((x, y) => x.gi - y.gi);
            for (const p of pls) {
                if (dropRemoved) {
                    const isRemoved = removed.has(p.seq);
                    // Spacing next to a dropped glyph goes with it; spacing between kept glyphs stays.
                    if (pendingNums.length && !isRemoved && !prevRemoved) {
                        flushKept();
                        cur.push(...pendingNums);
                    }
                    pendingNums = [];
                    prevRemoved = isRemoved;
                    if (isRemoved) continue;
                }
                if (insertion && p.seq === insertion.anchorSeq) {
                    flushKept();
                    flushDebt();
                    closeTJ();
                    out.push(...insertion.ops);
                    debt = -insertion.advPre;
                }
                if (removed.has(p.seq)) {
                    flushKept();
                    debt += p.advPre;
                } else {
                    if (Math.abs(debt) > 1e-9) {
                        flushKept();
                        flushDebt();
                    }
                    kept.push(...p.glyph.bytes);
                    if (insertion && p.seq === insertion.afterSeq) {
                        closeTJ();
                        out.push(...insertion.ops);
                        debt = -insertion.advPre;
                    }
                }
            }
            flushKept();
        });
        if (dropRemoved && pendingNums.length && !prevRemoved) cur.push(...pendingNums);
        flushKept();
        // A pending displacement at the end only matters if the next text operator continues from here.
        if (trailingPositionMatters) flushDebt();
        closeTJ();
        return out.join("\n");
    }

    private verify(before: Placement[], after: Placement[], removed: Set<number>, anchor: Placement, insertedCodes: number[]): string | null {
        const kept = before.filter((p) => !removed.has(p.seq));
        const pre = kept.filter((p) => p.seq < anchor.seq);
        const post = kept.filter((p) => p.seq > anchor.seq);
        if (after.length !== pre.length + insertedCodes.length + post.length)
            return `glyph count ${after.length} ≠ ${pre.length + insertedCodes.length + post.length}`;
        const tol = 0.01;
        const same = (x: Placement, y: Placement) =>
            x.glyph.code === y.glyph.code && Math.abs(x.origin[0] - y.origin[0]) < tol && Math.abs(x.origin[1] - y.origin[1]) < tol;
        for (let i = 0; i < pre.length; i++) if (!same(pre[i], after[i])) return `glyph ${i} moved before the edit`;
        for (let j = 0; j < insertedCodes.length; j++) {
            const g = after[pre.length + j];
            if (g.glyph.code !== insertedCodes[j]) return `inserted glyph ${j} has wrong code`;
        }
        if (insertedCodes.length) {
            const first = after[pre.length];
            if (Math.hypot(first.origin[0] - anchor.origin[0], first.origin[1] - anchor.origin[1]) > tol)
                return "new text does not start at the original origin";
        }
        for (let j = 0; j < post.length; j++) if (!same(post[j], after[pre.length + insertedCodes.length + j])) return `glyph after the edit moved (${j})`;
        return null;
    }

    // ── Commit ───────────────────────────────────────────────────────────────────────────────────

    get hasChanges() {
        return this.overrides.size > 0;
    }

    /** Write accepted rewrites into the document (copy-on-write for Form XObjects). A changed form painting gets
     *  its own copy; when its parent paints the same resource name more than once, that one `Do` is renamed so the
     *  other paintings keep the original. Streams are written last, once every rename is known. */
    commit() {
        if (!this.overrides.size) return;
        const streams = this.interp.streams;
        const pending = new Map(this.overrides);
        const newRefs = new Map<string, PDFRef>();
        const clonedRes = new Map<string, PDFDict>();

        const writableResources = (key: string): PDFDict => {
            const hit = clonedRes.get(key);
            if (hit) return hit;
            const sctx = streams.get(key)!;
            const base = sctx.resources ?? this.context.obj({});
            const copy = base.clone(this.context);
            const xo = copy.lookup(N("XObject"));
            if (xo instanceof PDFDict) copy.set(N("XObject"), xo.clone(this.context));
            clonedRes.set(key, copy);
            if (key === "page") this.pageDict.set(N("Resources"), copy);
            else ensureForm(key);
            return copy;
        };

        const renameDo = (parentKey: string, opIndex: number, name: string) => {
            const pctx = streams.get(parentKey)!;
            const bytes = pending.get(parentKey) ?? pctx.bytes;
            const op = parseContentStream(bytes)[opIndex];
            if (!op || op.op !== "Do") throw new Error("form painting operator not found");
            const head = bytes.subarray(0, op.start);
            const tail = bytes.subarray(op.end);
            const mid = fromLatin1(serializeOp("Do", [{ t: "name", v: name }]));
            const out = new Uint8Array(head.length + mid.length + tail.length);
            out.set(head, 0);
            out.set(mid, head.length);
            out.set(tail, head.length + mid.length);
            pending.set(parentKey, out);
            if (parentKey !== "page") ensureForm(parentKey);
        };

        const ensureForm = (key: string): PDFRef => {
            const hit = newRefs.get(key);
            if (hit) return hit;
            const sctx = streams.get(key)!;
            // Placeholder now (the parent's resources point at it), final bytes at the end.
            const ref = this.context.register(this.context.obj({}));
            newRefs.set(key, ref);
            const parentRes = writableResources(sctx.parentKey!);
            let xo = parentRes.lookup(N("XObject"));
            if (!(xo instanceof PDFDict)) {
                xo = this.context.obj({});
                parentRes.set(N("XObject"), xo);
            }
            const xd = xo as PDFDict;
            const shared = [...streams.values()].some((o) => o.key !== key && o.parentKey === sctx.parentKey && o.nameInParent === sctx.nameInParent);
            if (!shared || sctx.doOpIndex === undefined) xd.set(N(sctx.nameInParent!), ref);
            else {
                let n = 1;
                while (xd.get(N(`${sctx.nameInParent}_e${n}`))) n++;
                const name = `${sctx.nameInParent}_e${n}`;
                xd.set(N(name), ref);
                renameDo(sctx.parentKey!, sctx.doOpIndex, name);
            }
            return ref;
        };

        for (const key of [...pending.keys()]) if (key !== "page") ensureForm(key);

        for (const [key, ref] of newRefs) {
            const sctx = streams.get(key)!;
            const s = this.context.flateStream(pending.get(key) ?? sctx.bytes);
            for (const [k, v] of sctx.form!.dict.entries()) {
                const kn = k.decodeText();
                if (kn === "Length" || kn === "Filter" || kn === "DecodeParms") continue;
                s.dict.set(k, v);
            }
            const res = clonedRes.get(key) ?? (sctx.form!.dict.get(N("Resources")) ? undefined : sctx.resources);
            if (res) s.dict.set(N("Resources"), res);
            this.context.assign(ref, s);
        }
        const page = pending.get("page");
        if (page) this.pageDict.set(N("Contents"), this.context.register(this.context.flateStream(page)));
        this.overrides = new Map();
        this.interp = this.interpret();
        void PDFArray;
    }
}
