// Text runs of the page model → docx runs (fonts, sizes, colours, scripts, spacing, links, tabs).
import { BuilderElement, ExternalHyperlink, type IRunOptions, OnOffElement, type ParagraphChild, Tab, TextRun, type XmlComponent } from "docx";
import { SCRIPT_SCALE } from "./docx-metrics";
import { halfPoints, hexColor, twip } from "./docx-units";
import type { TextRun as ModelRun, TextStyle } from "./types";

/** Document-wide run defaults (docDefaults): runs only spell out what differs from them. */
export type RunDefaults = { fontFamily: string; fontSize: number; color: string };

// XML 1.0 cannot carry these (Word reports the file as corrupt): C0 controls except tab/LF/CR, U+FFFE/U+FFFF and
// unpaired surrogates (matched without lookbehind, which older Safari can't parse).
const INVALID_XML = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]", "g");
const SURROGATES = new RegExp("[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDFFF]", "g");

export const cleanText = (text: string): string => text.replace(INVALID_XML, "").replace(SURROGATES, (m) => (m.length === 2 ? m : ""));

/** Word font size of a run: super/subscripts are printed at 2/3 of w:sz, so the model's (already small) size is scaled up. */
export const wordFontSize = (style: TextStyle): number => (style.verticalAlign ? style.fontSize / SCRIPT_SCALE : style.fontSize);

const fontOf = (family: string) => ({ ascii: family, hAnsi: family, cs: family, eastAsia: family });

/**
 * Run properties for a style, omitting what the document defaults already say. `rise` raises (or lowers) the run
 * off the line's baseline without shrinking it (w:position), for text the PDF moved with a text rise.
 */
export const runStyleOptions = (style: TextStyle, defaults: RunDefaults, rise = 0): IRunOptions => {
    const family = style.fontFamily?.trim() || defaults.fontFamily;
    const size = halfPoints(wordFontSize(style));
    const color = hexColor(style.color) ?? "000000";
    const spacing = style.characterSpacing ? twip(style.characterSpacing) : 0;
    const position = Math.round(rise * 2) / 2;
    // Glyphs stretched or squeezed horizontally (PDF Tz): Word's character scale, 1–600 %.
    const hs = style.horizontalScale;
    const scale = hs !== undefined && Number.isFinite(hs) && Math.abs(hs - 100) >= 1 ? Math.max(1, Math.min(600, Math.round(hs))) : undefined;
    return {
        ...(position !== 0 && !style.verticalAlign ? { position: `${position}pt` as const } : {}),
        ...(family !== defaults.fontFamily ? { font: fontOf(family) } : {}),
        ...(size !== halfPoints(defaults.fontSize) ? { size, sizeComplexScript: size } : {}),
        ...(style.bold ? { bold: true, boldComplexScript: true } : {}),
        ...(style.italic ? { italics: true, italicsComplexScript: true } : {}),
        ...(color !== defaults.color ? { color } : {}),
        ...(style.underline ? { underline: { type: "single" as const } } : {}),
        ...(style.strike ? { strike: true } : {}),
        ...(style.verticalAlign === "superscript" ? { superScript: true } : {}),
        ...(style.verticalAlign === "subscript" ? { subScript: true } : {}),
        ...(spacing !== 0 ? { characterSpacing: spacing } : {}),
        ...(scale !== undefined ? { scale } : {}),
    };
};

// Run properties that come before w:outline in the schema's sequence (Word wants them in order). docx has no option
// for w:outline, so it is inserted into the run's properties.
const BEFORE_OUTLINE = new Set(["w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike", "w:dstrike"]);

const element = (name: string, attributes?: Record<string, string | number>, children?: XmlComponent[]) =>
    new BuilderElement({
        name,
        ...(attributes ? { attributes: Object.fromEntries(Object.entries(attributes).map(([k, value]) => [k, { key: `w14:${k}`, value }])) } : {}),
        ...(children ? { children } : {}),
    });

/**
 * Hollow letters. Word 2010+ draws w14:textOutline (a stroke of the given width in the run's colour, no fill); the
 * legacy w:outline, a hairline, is there for older readers (Word uses the w14 effect when both are present). The PDF's
 * stroke width isn't in the model: about 3 % of the size, what outlined display type usually has.
 */
const withOutline = (run: TextRun, style: TextStyle): TextRun => {
    const root = (run as unknown as { properties?: { root?: { rootKey?: string }[] } }).properties?.root;
    if (!Array.isArray(root)) return run;
    let at = 0;
    root.forEach((child, i) => {
        if (child?.rootKey && BEFORE_OUTLINE.has(child.rootKey)) at = i + 1;
    });
    root.splice(at, 0, new OnOffElement("w:outline", true) as unknown as { rootKey?: string });
    const color = hexColor(style.color) ?? "000000";
    const width = Math.round(Math.max(0.25, Math.min(3, 0.03 * wordFontSize(style))) * 12700);
    root.push(
        element("w14:textOutline", { w: width, cap: "flat", cmpd: "sng", algn: "ctr" }, [
            element("w14:solidFill", undefined, [element("w14:srgbClr", { val: color })]),
            element("w14:prstDash", { val: "solid" }),
            element("w14:round"),
        ]) as unknown as { rootKey?: string },
        element("w14:textFill", undefined, [element("w14:noFill")]) as unknown as { rootKey?: string },
    );
    return run;
};

/** One docx run for a piece of text (no line breaks inside); tabs become <w:tab/>. */
const makeRun = (text: string, options: IRunOptions, outline?: TextStyle): TextRun => {
    const clean = cleanText(text).replace(/\r/g, "");
    let run: TextRun;
    if (!clean.includes("\t")) run = new TextRun({ ...options, text: clean });
    else {
        const children: (string | Tab)[] = [];
        clean.split("\t").forEach((part, i) => {
            if (i > 0) children.push(new Tab());
            if (part) children.push(part);
        });
        run = new TextRun({ ...options, children });
    }
    return outline ? withOutline(run, outline) : run;
};

const safeLink = (link: string): string | undefined => {
    const trimmed = link.trim();
    if (!trimmed) return undefined;
    try {
        return encodeURI(decodeURI(trimmed));
    } catch {
        return encodeURI(trimmed);
    }
};

/** A piece of paragraph text (`rise`: points above the line's baseline, for text moved without being a script). */
export type RunPiece = { text: string; style: TextStyle; rise?: number } | { lineBreak: true; style: TextStyle };

/** Paragraph children for a sequence of text pieces: runs, line breaks, and hyperlinks grouping linked runs. */
export const buildRunChildren = (pieces: RunPiece[], defaults: RunDefaults): ParagraphChild[] => {
    const out: ParagraphChild[] = [];
    let linkRuns: TextRun[] = [];
    let link: string | undefined;
    const flushLink = () => {
        if (link && linkRuns.length) out.push(new ExternalHyperlink({ link, children: linkRuns }));
        link = undefined;
        linkRuns = [];
    };
    for (const piece of pieces) {
        const options = runStyleOptions(piece.style, defaults, "rise" in piece ? piece.rise : 0);
        if ("lineBreak" in piece) {
            flushLink();
            out.push(new TextRun({ ...options, break: 1 }));
            continue;
        }
        if (!piece.text) continue;
        const target = piece.style.link ? safeLink(piece.style.link) : undefined;
        // "\n" inside a run is a line kept from the PDF (keepLineBreaks paragraphs): a <w:br/>.
        piece.text.split("\n").forEach((part, i) => {
            if (i > 0) {
                flushLink();
                out.push(new TextRun({ ...options, break: 1 }));
            }
            if (!part) return;
            const run = makeRun(part, options, piece.style.outline ? piece.style : undefined);
            if (target) {
                if (target !== link) flushLink();
                link = target;
                linkRuns.push(run);
            } else {
                flushLink();
                out.push(run);
            }
        });
    }
    flushLink();
    return out;
};

const STYLE_KEYS: (keyof TextStyle)[] = [
    "fontFamily",
    "fontSize",
    "bold",
    "italic",
    "underline",
    "strike",
    "color",
    "verticalAlign",
    "characterSpacing",
    "link",
    "outline",
    "horizontalScale",
];

export const sameStyle = (a: TextStyle, b: TextStyle): boolean => STYLE_KEYS.every((k) => (a[k] ?? false) === (b[k] ?? false));

/**
 * Points a run sits above the baseline of its line (one of `baselines`): text the PDF raised or lowered without
 * making it a super/subscript. Tiny shifts (rounding, mixed fonts) count as none.
 */
const riseOf = (r: ModelRun, baselines: number[]): number => {
    if (r.style.verticalAlign || !Number.isFinite(r.baseline) || !baselines.length || !r.text.trim()) return 0;
    const line = baselines.reduce((a, b) => (Math.abs(b - r.baseline) < Math.abs(a - r.baseline) ? b : a));
    const rise = line - r.baseline;
    return Math.abs(rise) >= 1 && Math.abs(rise) <= 0.8 * r.style.fontSize ? rise : 0;
};

/** Runs as pieces, neighbours with the same style (and rise) merged: one Word run per style change, not per PDF line. */
const merged = (runs: ModelRun[], baselines: number[] = []): RunPiece[] => {
    const out: { text: string; style: TextStyle; rise: number }[] = [];
    for (const r of runs) {
        const last = out[out.length - 1];
        const rise = riseOf(r, baselines);
        if (last && sameStyle(last.style, r.style) && (last.rise === rise || !r.text.trim())) last.text += r.text;
        else out.push({ text: r.text, style: r.style, rise });
    }
    return out;
};

/** Pieces of a flowing paragraph: its runs, the trailing whitespace of the last one removed. `baselines`: its lines'. */
export const piecesFromRuns = (runs: ModelRun[], baselines: number[] = []): RunPiece[] => {
    const pieces = merged(runs, baselines);
    trimEnd(pieces);
    return pieces;
};

type RowSource = { baseline: number; pieces: { runs: ModelRun[]; box: { x: number; width: number }; fontSize: number }[] };

/**
 * Pieces of a paragraph whose visual lines are kept: each row's source lines left to right (a wide gap between two
 * of them is a tab, a narrow one a space), a line break between rows — or, when `breaks` lists the rows that end in a
 * break, a space after the others (Word wraps there by itself).
 */
export const piecesFromRows = (rows: RowSource[], breaks?: ReadonlySet<number>): RunPiece[] => {
    const pieces: RunPiece[] = [];
    rows.forEach((row, i) => {
        const runs: ModelRun[] = [];
        row.pieces.forEach((piece, k) => {
            const prev = row.pieces[k - 1];
            const last = runs[runs.length - 1];
            if (prev && last) {
                const gap = piece.box.x - (prev.box.x + prev.box.width);
                const sep = gap > 1.2 * Math.max(prev.fontSize, piece.fontSize) ? "\t" : " ";
                runs[runs.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") + sep };
            }
            runs.push(...piece.runs);
        });
        const part = merged(runs, [row.baseline]);
        trimEnd(part);
        if (i > 0 && (!breaks || breaks.has(i - 1))) {
            const style = part.find((p) => "text" in p)?.style ?? runs[0]?.style;
            if (style) pieces.push({ lineBreak: true, style });
        } else if (i > 0) {
            const last = pieces[pieces.length - 1];
            if (last && "text" in last) pieces[pieces.length - 1] = { ...last, text: last.text + " " };
        }
        pieces.push(...part);
    });
    return pieces;
};

const trimEnd = (pieces: RunPiece[]) => {
    for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        if ("lineBreak" in p) break;
        const trimmed = p.text.replace(/\s+$/, "");
        if (trimmed) {
            pieces[i] = { ...p, text: trimmed };
            break;
        }
        pieces.splice(i, 1);
    }
};

/** Plain text of pieces (marker detection, statistics). */
export const piecesText = (pieces: RunPiece[]): string => pieces.map((p) => ("text" in p ? p.text : "\n")).join("");
