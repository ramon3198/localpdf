/**
 * Resolution of the fallback font pack (public/fonts/pack, built by scripts/build-font-pack.py).
 *
 * Given the PostScript name of a PDF font (e.g. "BAAAAA+Montserrat-ExtraBold", "Arial-BoldMT",
 * "Calibri,Bold"), pick the best face in the pack: the same family at the nearest weight/slant, or a
 * metric-compatible clone for common system fonts. Returns null when nothing close enough exists.
 */
import { describeFont, slugFamily } from "./font-style";

export type FontPackManifest = {
    version: number;
    families: Record<string, { name: string; category: "sans" | "serif" | "mono"; faces: Record<string, string> }>;
    aliases: Record<string, string>;
    /** Wide-coverage last-resort faces per class ("sans" | "serif" | "mono") keyed like family faces ("400", "700i"). */
    universal?: Record<string, Record<string, string>>;
};

const STYLE_SUFFIX =
    /\s*(extralight|ultralight|extrabold|ultrabold|semibold|demibold|hairline|condensed|regular|oblique|italic|medium|narrow|normal|light|black|heavy|thin|book|bold|demi|psmt|mt|ps)$/;

const stripStyles = (s: string) => {
    for (let i = 0; i < 5; i++) {
        const next = s.replace(STYLE_SUFFIX, "").trim();
        if (next === s) break;
        s = next;
    }
    return s;
};

/** Candidate family slugs from a PostScript/Font name, most specific first. */
export const familyCandidates = (baseFont: string): string[] => {
    const raw = baseFont.replace(/^[A-Z]{6}\+/, "");
    const out: string[] = [];
    const push = (s: string) => {
        const v = s.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (v && !out.includes(v)) out.push(v);
    };
    const head = raw.split(/[-,]/)[0];
    push(stripStyles(head.toLowerCase())); // "Montserrat-ExtraBold", "ArialMT", "MontserratExtraBold"
    push(stripStyles(raw.replace(/[-,_]/g, " ").toLowerCase().trim())); // "Open Sans Bold"
    push(head);
    push(stripStyles(head.toLowerCase()).replace(/\d+$/, "")); // TeX sizes: "CMR10", "LMRoman12"
    return out;
};

export const resolvePackFace = (
    manifest: FontPackManifest,
    baseFont: string,
    want: { weight: number; italic: boolean; family?: string },
): { file: string; family: string; exactFamily: boolean } | null => {
    const cands = [...(want.family ? [slugFamily(want.family)] : []), ...familyCandidates(baseFont)];
    for (const cand of cands) {
        const direct = manifest.families[cand];
        const aliasKey = manifest.aliases[cand];
        const fam = direct ?? (aliasKey ? manifest.families[aliasKey] : undefined);
        if (!fam) continue;
        const faces = Object.entries(fam.faces).map(([k, file]) => ({ w: parseInt(k, 10), i: k.endsWith("i"), file }));
        const score = (f: { w: number; i: boolean }) => Math.abs(f.w - want.weight) + (f.i === want.italic ? 0 : 1000);
        faces.sort((a, b) => score(a) - score(b));
        const best = faces[0];
        if (!best) continue;
        return { file: best.file, family: fam.name, exactFamily: !!direct };
    }
    return null;
};

/** Wide-coverage face for characters the typeface match lacks (→ ✓ Ω α ≥ …), in the same class and style. */
export const resolveUniversalFace = (manifest: FontPackManifest, want: { weight: number; italic: boolean; serif: boolean; mono: boolean }): string | null => {
    const u = manifest.universal;
    if (!u) return null;
    const faces = u[want.mono ? "mono" : want.serif ? "serif" : "sans"] ?? u.sans;
    if (!faces) return null;
    const w = want.weight >= 600 ? "700" : "400";
    return faces[w + (want.italic ? "i" : "")] ?? faces[w] ?? faces["400"] ?? null;
};

/** Weight/slant the fallback should have for a given original font (and optional user style change). */
export const wantedStyle = (baseFont: string, force?: { bold: boolean; italic: boolean } | null) => {
    const d = describeFont(baseFont);
    if (!force) return { weight: d.weight, italic: d.italic };
    return { weight: force.bold ? (d.bold ? d.weight : 700) : d.bold ? 400 : d.weight, italic: force.italic };
};
