// Fonts of the .docx. The non-Office families the document uses (Inter, Poppins, Crimson Text…) are embedded, only
// the variants used, when the host can provide them (ConvertEnvironment.loadFont: the app's font pack), so Word shows
// them on machines that don't have them; every non-Office family also gets a font-table entry naming the substitute
// Word should use when it has neither (w:altName, "Inter" → Arial: Word honours it; without it Word picks Calibri or
// Cambria). Word loads an embedded face under the family in the font's own name table, so a face is embedded only
// when that name is the family the runs ask for and its style fits the slot (regular, bold, italic, bold italic).
import type { ConvertEnvironment, PageModel, Paragraph, TextRun } from "./types";

/** Total font data a document may embed; faces that don't fit are left out (the pack's faces are 20–70 KB each). */
const MAX_EMBEDDED_BYTES = 6 * 1024 * 1024;

/** 0 regular, 1 bold, 2 italic, 3 bold italic: Word's four embedding slots. */
type Variant = 0 | 1 | 2 | 3;
const SLOTS = ["w:embedRegular", "w:embedBold", "w:embedItalic", "w:embedBoldItalic"] as const;
const variantOf = (bold: boolean, italic: boolean): Variant => ((bold ? 1 : 0) + (italic ? 2 : 0)) as Variant;

export type EmbeddedFace = { family: string; variant: Variant; data: Uint8Array };

export type FontPlan = {
    /** Families Word will show as in the PDF wherever the .docx is opened (embedded here; Office's own are always there). */
    embedded: Set<string>;
    /** Embedded faces, in the order they are given to docx (font1.odttf, font2.odttf…). */
    faces: EmbeddedFace[];
    /** Font-table entries of the non-Office families: the substitute Word should use when it lacks the family. */
    families: { family: string; fallback?: string }[];
    /** Advance widths of the embedded faces, by family (lower case) and variant: what Word will set. */
    advances: Map<string, Advances>;
};

const advancesKey = (family: string, variant: Variant) => `${family.trim().toLowerCase()}|${variant}`;

/** Advance widths Word will use for this family and style: only when the document embeds that very face. */
export const embeddedAdvances = (plan: Pick<FontPlan, "advances">, family: string, bold: boolean, italic: boolean): Advances | undefined =>
    plan.advances.get(advancesKey(family, variantOf(bold, italic)));

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

// ── What the font file says about itself ──────────────────────────────────────────────────────────────────────────

/** Horizontal advance of a character in the face, in ems (undefined when the face has no glyph for it). */
export type Advances = (codePoint: number) => number | undefined;

type FaceInfo = { family: string; variant: Variant; advances?: Advances };

type Tables = Map<string, { offset: number; length: number }>;

/** Glyph of a code point from the Unicode cmap subtable (format 4 or 12). */
const glyphLookup = (view: DataView, tables: Tables): ((cp: number) => number) | undefined => {
    const cmap = tables.get("cmap");
    if (!cmap) return undefined;
    const count = view.getUint16(cmap.offset + 2);
    let best: { at: number; format: number; rank: number } | undefined;
    for (let i = 0; i < count; i++) {
        const rec = cmap.offset + 4 + 8 * i;
        const platform = view.getUint16(rec);
        const encoding = view.getUint16(rec + 2);
        const at = cmap.offset + view.getUint32(rec + 4);
        if (at + 4 > cmap.offset + cmap.length) continue;
        const format = view.getUint16(at);
        const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
        if (!unicode || (format !== 4 && format !== 12)) continue;
        const rank = format === 12 ? 2 : 1;
        if (!best || rank > best.rank) best = { at, format, rank };
    }
    if (!best) return undefined;
    const { at } = best;
    if (best.format === 12) {
        const groups = view.getUint32(at + 12);
        return (cp) => {
            let lo = 0;
            let hi = groups - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const g = at + 16 + 12 * mid;
                const start = view.getUint32(g);
                const end = view.getUint32(g + 4);
                if (cp < start) hi = mid - 1;
                else if (cp > end) lo = mid + 1;
                else return view.getUint32(g + 8) + (cp - start);
            }
            return 0;
        };
    }
    const segments = view.getUint16(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + 2 * segments + 2;
    const deltas = starts + 2 * segments;
    const ranges = deltas + 2 * segments;
    return (cp) => {
        if (cp > 0xffff) return 0;
        let lo = 0;
        let hi = segments - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (view.getUint16(ends + 2 * mid) < cp) lo = mid + 1;
            else hi = mid;
        }
        const start = view.getUint16(starts + 2 * lo);
        if (cp < start || cp > view.getUint16(ends + 2 * lo)) return 0;
        const delta = view.getInt16(deltas + 2 * lo);
        const range = view.getUint16(ranges + 2 * lo);
        if (!range) return (cp + delta) & 0xffff;
        const glyph = view.getUint16(ranges + 2 * lo + range + 2 * (cp - start));
        return glyph ? (glyph + delta) & 0xffff : 0;
    };
};

/** Advance widths (hmtx) by character, in ems. */
const advancesOf = (view: DataView, tables: Tables): Advances | undefined => {
    const head = tables.get("head");
    const hhea = tables.get("hhea");
    const hmtx = tables.get("hmtx");
    const glyph = glyphLookup(view, tables);
    if (!head || !hhea || !hmtx || !glyph) return undefined;
    const unitsPerEm = view.getUint16(head.offset + 18);
    const metrics = view.getUint16(hhea.offset + 34);
    if (!unitsPerEm || !metrics || 4 * metrics > hmtx.length) return undefined;
    return (cp) => {
        const g = glyph(cp);
        if (!g) return undefined;
        return view.getUint16(hmtx.offset + 4 * Math.min(g, metrics - 1)) / unitsPerEm;
    };
};

/**
 * Family (name ID 1, the name Windows matches), style and advance widths of a TrueType font, or undefined when Word
 * can't embed it: PostScript outlines (Word embeds TrueType only), collections, damaged files, licences that forbid
 * editable embedding.
 */
export const faceInfo = (data: Uint8Array): FaceInfo | undefined => {
    try {
        if (data.length < 12) return undefined;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const version = view.getUint32(0);
        if (version !== 0x00010000 && version !== 0x74727565) return undefined;
        const tables = new Map<string, { offset: number; length: number }>();
        const count = view.getUint16(4);
        for (let i = 0; i < count; i++) {
            const at = 12 + 16 * i;
            if (at + 16 > data.length) return undefined;
            const tag = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
            const offset = view.getUint32(at + 8);
            const length = view.getUint32(at + 12);
            if (offset + length > data.length) return undefined;
            tables.set(tag, { offset, length });
        }
        if (!tables.has("glyf")) return undefined;
        const os2 = tables.get("OS/2");
        let bold: boolean | undefined;
        let italic: boolean | undefined;
        if (os2 && os2.length >= 64) {
            const fsType = view.getUint16(os2.offset + 8);
            const usage = fsType & 0x000f;
            // Restricted (2) or preview & print (4) only, or bitmap-only embedding: not for an editable document.
            if ((usage !== 0 && !(usage & 0x0008)) || fsType & 0x0200) return undefined;
            const selection = view.getUint16(os2.offset + 62);
            italic = (selection & 0x0001) !== 0;
            bold = (selection & 0x0020) !== 0;
        }
        const head = tables.get("head");
        if ((bold === undefined || italic === undefined) && head && head.length >= 46) {
            const macStyle = view.getUint16(head.offset + 44);
            bold = (macStyle & 1) !== 0;
            italic = (macStyle & 2) !== 0;
        }
        const family = nameRecord(view, data, tables.get("name"), 1);
        if (!family) return undefined;
        let advances: Advances | undefined;
        try {
            advances = advancesOf(view, tables);
        } catch {
            advances = undefined;
        }
        return { family, variant: variantOf(!!bold, !!italic), advances };
    } catch {
        return undefined;
    }
};

/** A name-table string: Windows Unicode (US English first), else Mac Roman. */
const nameRecord = (view: DataView, data: Uint8Array, table: { offset: number; length: number } | undefined, id: number): string | undefined => {
    if (!table || table.length < 6) return undefined;
    const count = view.getUint16(table.offset + 2);
    const strings = table.offset + view.getUint16(table.offset + 4);
    let best: { score: number; text: string } | undefined;
    for (let i = 0; i < count; i++) {
        const at = table.offset + 6 + 12 * i;
        if (at + 12 > table.offset + table.length) break;
        const platform = view.getUint16(at);
        const encoding = view.getUint16(at + 2);
        const language = view.getUint16(at + 4);
        if (view.getUint16(at + 6) !== id) continue;
        const length = view.getUint16(at + 8);
        const start = strings + view.getUint16(at + 10);
        if (start + length > data.length) continue;
        let text = "";
        let score = 0;
        if (platform === 3 && (encoding === 1 || encoding === 0 || encoding === 10)) {
            for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(start + k));
            score = language === 0x409 ? 3 : 2;
        } else if (platform === 1 && encoding === 0) {
            for (let k = 0; k < length; k++) text += String.fromCharCode(data[start + k]);
            score = 1;
        } else continue;
        if (text.trim() && (!best || score > best.score)) best = { score, text: text.trim() };
    }
    return best?.text;
};

// ── What the document uses ──────────────────────────────────────────────────────────────────────────────────────

type Usage = { family: string; chars: number; variants: Map<Variant, number>; fallbacks: Map<string, number> };

const paragraphsOf = (pages: PageModel[]): Paragraph[] =>
    pages.flatMap((page) =>
        page.blocks.flatMap((b) => (b.kind === "paragraph" ? [b] : b.kind === "table" ? b.rows.flatMap((r) => r.cells.flatMap((c) => c.paragraphs)) : [])),
    );

/** Non-Office families (the model names a substitute for them) with the characters set in each variant. */
const familyUsage = (pages: PageModel[]): Usage[] => {
    const byFamily = new Map<string, Usage>();
    const add = (r: TextRun) => {
        const family = r.style.fontFamily?.trim();
        const n = r.text.replace(/\s/g, "").length;
        if (!family || !n) return;
        let u = byFamily.get(family.toLowerCase());
        if (!u) byFamily.set(family.toLowerCase(), (u = { family, chars: 0, variants: new Map(), fallbacks: new Map() }));
        u.chars += n;
        const v = variantOf(!!r.style.bold, !!r.style.italic);
        u.variants.set(v, (u.variants.get(v) ?? 0) + n);
        const fallback = r.style.fallbackFamily?.trim();
        if (fallback) u.fallbacks.set(fallback, (u.fallbacks.get(fallback) ?? 0) + n);
    };
    for (const p of paragraphsOf(pages)) {
        p.runs.forEach(add);
        // The lines carry the same text; count their styles only where the runs don't (paragraphs built from lines).
        if (!p.runs.length) p.lines.forEach((l) => l.runs.forEach(add));
    }
    // Office's own families come without a substitute: never requested.
    return [...byFamily.values()].filter((u) => u.fallbacks.size > 0).sort((a, b) => b.chars - a.chars);
};

const mostUsed = (counts: Map<string, number>): string | undefined => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which faces to embed (asking the host for the variants the document uses) and the font-table entries. */
export const planFonts = async (pages: PageModel[], loadFont?: ConvertEnvironment["loadFont"]): Promise<FontPlan> => {
    const usage = familyUsage(pages);
    const plan: FontPlan = {
        embedded: new Set(),
        faces: [],
        families: usage.map((u) => ({ family: u.family, fallback: mostUsed(u.fallbacks) })),
        advances: new Map(),
    };
    if (!loadFont) return plan;
    // Every variant asked for at once (the host may fetch them), then taken in order of use until the budget is spent.
    const requests = usage.map((u) => ({
        u,
        faces: [...u.variants.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([v]) => ({
                v,
                data: Promise.resolve()
                    .then(() => loadFont(u.family, (v & 1) !== 0, (v & 2) !== 0))
                    .catch(() => null),
            })),
    }));
    let total = 0;
    for (const { u, faces } of requests) {
        const slots = new Map<Variant, Uint8Array>();
        for (const { v, data: pending } of faces) {
            const data = await pending;
            if (slots.has(v)) continue;
            const info = data && faceInfo(data);
            // A face of another family (an alias) would not be found by Word under this name.
            if (!data || !info || !sameName(info.family, u.family) || slots.has(info.variant)) continue;
            if (total + data.length > MAX_EMBEDDED_BYTES) continue;
            // The face goes in the slot of its own style: a family without a bold face gets its regular one, which
            // Word emboldens (as it would for the installed font).
            slots.set(info.variant, data);
            if (info.advances) plan.advances.set(advancesKey(u.family, info.variant), info.advances);
            total += data.length;
        }
        for (const [variant, data] of [...slots.entries()].sort((a, b) => a[0] - b[0])) plan.faces.push({ family: u.family, variant, data });
        if (slots.size) plan.embedded.add(u.family);
    }
    return plan;
};

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Word's generic class of a substitute ("swiss", "roman", "modern"), which it also uses to choose one. */
const classOf = (fallback: string | undefined): { family: string; pitch: string } => {
    const f = (fallback ?? "").toLowerCase();
    if (/courier|consolas|mono|lucida console/.test(f)) return { family: "modern", pitch: "fixed" };
    if (/times|georgia|cambria|garamond|palatino|book antiqua|bookman|century(?! gothic)|serif/.test(f)) return { family: "roman", pitch: "variable" };
    if (/symbol|wingdings|webdings/.test(f)) return { family: "decorative", pitch: "variable" };
    return { family: "swiss", pitch: "variable" };
};

/**
 * word/fontTable.xml: one entry per non-Office family, with its substitute and its embedded faces. `keys` are the
 * obfuscation keys docx gave the faces (in `plan.faces` order; relationship rId<n+1> is face n).
 */
export const fontTableXml = (plan: FontPlan, keys: string[]): string => {
    const entries = plan.families.map(({ family, fallback }) => {
        const cls = classOf(fallback);
        const embeds = plan.faces
            .map((face, i) => ({ face, i }))
            .filter(({ face, i }) => sameName(face.family, family) && keys[i])
            .sort((a, b) => a.face.variant - b.face.variant)
            .map(({ face, i }) => `<${SLOTS[face.variant]} r:id="rId${i + 1}" w:fontKey="{${keys[i]}}"/>`)
            .join("");
        return (
            `<w:font w:name="${escapeXml(family)}">` +
            (fallback && !sameName(fallback, family) ? `<w:altName w:val="${escapeXml(fallback)}"/>` : "") +
            `<w:charset w:val="00"/><w:family w:val="${cls.family}"/><w:pitch w:val="${cls.pitch}"/>${embeds}</w:font>`
        );
    });
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        entries.join("") +
        `</w:fonts>`
    );
};
