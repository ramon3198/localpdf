// Lists: real Word numbering (abstractNum per list) whose markers print like the PDF's ("•", "1.", "a)", "(iv)"…);
// markers Word can't reproduce with its counters (e.g. "1.2.", irregular sequences) stay as literal text + tab.
import { AlignmentType, type ILevelsOptions, LevelFormat, LevelSuffix } from "docx";
import { type RunPiece, piecesText, runStyleOptions } from "./docx-text";
import { twip } from "./docx-units";
import type { Paragraph, TextStyle } from "./types";

type Format = "decimal" | "decimalZero" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman";

export type ParsedMarker =
    | { kind: "bullet"; text: string }
    | { kind: "number"; candidates: { format: Format; value: number }[]; prefix: string; suffix: string; digits: number };

// Private-use bullets of Symbol / Wingdings fonts (by code point), as their Unicode look-alikes.
const PUA_BULLETS = new Map<number, string>([
    [0xf0b7, "•"],
    [0xf0a7, "▪"],
    [0xf0a8, "□"],
    [0xf06e, "■"],
    [0xf06c, "●"],
    [0xf071, "❑"],
    [0xf076, "❖"],
    [0xf0d8, "➢"],
    [0xf0e0, "➔"],
    [0xf0fc, "✓"],
    [0xf02d, "–"],
]);

const isPrivateUse = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;

const ROMAN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

const romanValue = (s: string): number | undefined => {
    if (!s || !ROMAN.test(s)) return undefined;
    const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    const chars = s.toLowerCase().split("");
    let total = 0;
    chars.forEach((c, i) => {
        const cur = v[c];
        const next = v[chars[i + 1]] ?? 0;
        total += cur < next ? -cur : cur;
    });
    return total > 0 ? total : undefined;
};

export const parseMarker = (raw: string): ParsedMarker | undefined => {
    const m = raw.trim();
    if (!m) return undefined;
    const num = /^([([]?)([0-9]{1,4}|[A-Za-z]{1,7})([.)\]:]?)$/.exec(m);
    if (num) {
        const [, prefix, core, suffix] = num;
        const candidates: { format: Format; value: number }[] = [];
        if (/^[0-9]+$/.test(core)) {
            const value = parseInt(core, 10);
            if (core.length === 2 && core[0] === "0") candidates.push({ format: "decimalZero", value });
            else if (core[0] !== "0" || core === "0") candidates.push({ format: "decimal", value });
        } else {
            // A bare word is text, not a marker: letters need a prefix or suffix.
            if (!prefix && !suffix) return undefined;
            if (core.length === 1) {
                const lower = core === core.toLowerCase();
                candidates.push({ format: lower ? "lowerLetter" : "upperLetter", value: core.toLowerCase().charCodeAt(0) - 96 });
            }
            const r = core === core.toLowerCase() || core === core.toUpperCase() ? romanValue(core) : undefined;
            if (r !== undefined) candidates.push({ format: core === core.toLowerCase() ? "lowerRoman" : "upperRoman", value: r });
        }
        if (!candidates.length || candidates.every((c) => c.value < 0)) return undefined;
        candidates.sort((a, b) => a.value - b.value);
        return { kind: "number", candidates, prefix, suffix, digits: core.length };
    }
    if (/[\p{L}\p{N}]/u.test(m) || [...m].length > 2) return undefined;
    const first = [...m][0];
    const cp = first.codePointAt(0) ?? 0;
    return { kind: "bullet", text: PUA_BULLETS.get(cp) ?? (isPrivateUse(cp) ? "•" : m) };
};

type LevelDef = {
    kind: "bullet" | "number";
    format: Format | "bullet";
    text: string;
    start: number;
    prefix: string;
    suffix: string;
    style: TextStyle;
    left: number;
    hanging: number;
};

type ListDef = { reference: string; levels: Map<number, LevelDef>; counters: (number | undefined)[] };

/** How a list paragraph is written. */
export type ListUse = { type: "numbering"; reference: string; level: number; pieces: RunPiece[] } | { type: "literal"; pieces: RunPiece[] };

const LEVEL_FORMAT: Record<LevelDef["format"], (typeof LevelFormat)[keyof typeof LevelFormat]> = {
    bullet: LevelFormat.BULLET,
    decimal: LevelFormat.DECIMAL,
    decimalZero: LevelFormat.DECIMAL_ZERO,
    lowerLetter: LevelFormat.LOWER_LETTER,
    upperLetter: LevelFormat.UPPER_LETTER,
    lowerRoman: LevelFormat.LOWER_ROMAN,
    upperRoman: LevelFormat.UPPER_ROMAN,
};

const DEFAULT_BULLETS = ["•", "◦", "▪"];

/** Removes the marker from the start of a list paragraph's text, when the runs include it. */
export const stripMarker = (pieces: RunPiece[], marker: string): { pieces: RunPiece[]; markerStyle?: TextStyle } => {
    const target = marker.trim();
    if (!target) return { pieces };
    const text = piecesText(pieces);
    const lead = text.length - text.trimStart().length;
    if (!text.slice(lead).startsWith(target)) return { pieces };
    const after = text.slice(lead + target.length);
    // "1.5 kg" is text, not "1." + "5 kg": the marker must be followed by white space or end the paragraph.
    if (after && !/^[\s  -​]/.test(after)) return { pieces };
    let remove = lead + target.length + (after.length - after.replace(/^[\s  -​]+/, "").length);
    let markerStyle: TextStyle | undefined;
    const out: RunPiece[] = [];
    for (const p of pieces) {
        if (remove <= 0 || !("text" in p)) {
            out.push(p);
            continue;
        }
        if (!markerStyle && p.text.trim()) markerStyle = p.style;
        if (p.text.length <= remove) {
            remove -= p.text.length;
            continue;
        }
        out.push({ ...p, text: p.text.slice(remove) });
        remove = 0;
    }
    return { pieces: out, markerStyle };
};

/**
 * Assigns Word numbering to the list paragraphs of one container (a page's flow, a table cell…), in reading order.
 * Consecutive items share one numbering (so Word keeps counting when the user adds items) as long as Word's counters
 * print exactly the PDF's markers; otherwise a new numbering starts, or the marker stays literal.
 */
export class ListPlanner {
    private readonly lists: ListDef[] = [];
    private current: ListDef | undefined;
    private counter = 0;

    constructor(private readonly prefix: string) {}

    /** Call for every paragraph of the container in order (non-list paragraphs keep the list open). */
    use(p: Paragraph, pieces: RunPiece[], geometry: { left: number; hanging: number }): ListUse | undefined {
        if (!p.list) return undefined;
        // The runs may spell the marker differently (a Symbol-font bullet decoded as "•", say): what leads the text wins.
        const text = piecesText(pieces).trim();
        const lead = text.split(/\s/)[0] ?? "";
        const declared = (p.list.marker ?? "").trim();
        const leadParsed = parseMarker(lead);
        const declaredParsed = parseMarker(declared);
        const marker =
            declared && text.startsWith(declared) ? declared : leadParsed && (!declaredParsed || declaredParsed.kind === leadParsed.kind) ? lead : declared;
        const { pieces: body, markerStyle } = stripMarker(pieces, marker);
        const style = markerStyle ?? neutralMarkerStyle(firstStyle(pieces) ?? p.runs[0]?.style);
        // A letter the layout already judged to be a bullet (Word's "o" in Courier New) is one.
        const parsed =
            parseMarker(marker) ?? (p.list.kind === "bullet" && marker && [...marker].length <= 2 ? { kind: "bullet" as const, text: marker } : undefined);
        const level = Math.max(0, Math.min(8, Math.round(p.list.level || 0)));
        if (!parsed || !style) return { type: "literal", pieces: literal(marker, style, body) };
        const tryAccept = (list: ListDef) => accept(list, parsed, level, style, geometry);
        if (!this.current || !tryAccept(this.current)) {
            this.current = { reference: `${this.prefix}-${this.counter++}`, levels: new Map(), counters: [] };
            this.lists.push(this.current);
            if (!tryAccept(this.current)) return { type: "literal", pieces: literal(marker, style, body) };
        }
        return { type: "numbering", reference: this.current.reference, level, pieces: body };
    }

    /** Ends the current list (a heading or a table in between, say). */
    close() {
        this.current = undefined;
    }

    /** docx numbering config for every list planned so far. */
    config(): { reference: string; levels: ILevelsOptions[] }[] {
        return this.lists.map((list) => ({ reference: list.reference, levels: levelsOf(list) }));
    }
}

const firstStyle = (pieces: RunPiece[]) => pieces.find((p) => "text" in p && p.text.trim())?.style;

/** Marker style when the runs don't carry the marker: the text's font, size and colour, without emphasis. */
const neutralMarkerStyle = (style: TextStyle | undefined): TextStyle | undefined =>
    style && { ...style, bold: false, italic: false, underline: false, strike: false, link: undefined, verticalAlign: undefined, characterSpacing: undefined };

const literal = (marker: string, style: TextStyle | undefined, body: RunPiece[]): RunPiece[] =>
    style && marker.trim() ? [{ text: `${marker.trim()}\t`, style: { ...style, link: undefined } }, ...body] : body;

const accept = (list: ListDef, parsed: ParsedMarker, level: number, style: TextStyle, geometry: { left: number; hanging: number }): boolean => {
    const def = list.levels.get(level);
    if (parsed.kind === "bullet") {
        if (def && (def.kind !== "bullet" || def.text !== parsed.text)) return false;
        if (!def) list.levels.set(level, { kind: "bullet", format: "bullet", text: parsed.text, start: 1, prefix: "", suffix: "", style, ...geometry });
        list.counters.length = level;
        return true;
    }
    if (def) {
        if (def.kind !== "number" || def.prefix !== parsed.prefix || def.suffix !== parsed.suffix) return false;
        const expected = list.counters[level] === undefined ? def.start : (list.counters[level] as number) + 1;
        if (!parsed.candidates.some((c) => c.format === def.format && c.value === expected)) return false;
        list.counters[level] = expected;
    } else {
        const choice = parsed.candidates[0];
        if (choice.value < 0) return false;
        list.levels.set(level, {
            kind: "number",
            format: choice.format,
            text: "",
            start: choice.value,
            prefix: parsed.prefix,
            suffix: parsed.suffix,
            style,
            ...geometry,
        });
        list.counters[level] = choice.value;
    }
    list.counters.length = level + 1;
    return true;
};

const levelsOf = (list: ListDef): ILevelsOptions[] => {
    const levels: ILevelsOptions[] = [];
    let last: LevelDef | undefined;
    let lastLevel = 0;
    const firstKind = [...list.levels.values()][0]?.kind ?? "bullet";
    for (let level = 0; level < 9; level++) {
        const def = list.levels.get(level);
        if (def) {
            last = def;
            lastLevel = level;
        }
        const left = def ? def.left : (last?.left ?? 0) + 18 * (level - lastLevel + (last ? 0 : 1));
        const hanging = def ? def.hanging : 18;
        const markerStyle = def?.style ?? last?.style;
        const run = markerStyle ? runStyleOptions({ ...markerStyle, link: undefined }, { fontFamily: "", fontSize: -1, color: "" }) : undefined;
        const kind = def?.kind ?? firstKind;
        const format = def ? def.format : kind === "bullet" ? "bullet" : "decimal";
        const text = def
            ? def.kind === "bullet"
                ? def.text
                : `${def.prefix}%${level + 1}${def.suffix}`
            : kind === "bullet"
              ? DEFAULT_BULLETS[level % 3]
              : `%${level + 1}.`;
        levels.push({
            level,
            format: LEVEL_FORMAT[format],
            text,
            alignment: AlignmentType.LEFT,
            start: def?.start ?? 1,
            suffix: hanging > 0 ? LevelSuffix.TAB : LevelSuffix.SPACE,
            style: {
                ...(run ? { run: stripRunOnlyOptions(run) } : {}),
                paragraph: { indent: { left: twip(Math.max(0, left)), hanging: twip(Math.max(0, hanging)) } },
            },
        });
    }
    return levels;
};

// Numbering levels take run *style* properties only (no text/children/break).
const stripRunOnlyOptions = <T extends object>(options: T) => {
    const rest = { ...options } as Record<string, unknown>;
    delete rest.text;
    delete rest.children;
    delete rest.break;
    return rest as T;
};
