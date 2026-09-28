// Tagged PDF structure. Word, Chrome, LibreOffice and InDesign exports mark every piece of page content with the
// logical element it belongs to (paragraph, heading level, list item, table cell) and page furniture as artifacts:
// the headings and paragraph boundaries the author made, instead of guesses from font sizes.
//
// Marked content (BDC … /MCID n … EMC) in the page's streams → the page's ParentTree entry → structure element →
// its standard type (through the RoleMap) and the nearest block-level element around it.
import { PDFArray, type PDFContext, PDFDict, PDFName, PDFNumber, type PDFObject, type PDFPage, PDFRef } from "pdf-lib";
import type { Interpretation } from "../pdf-text-engine/text-interpreter";
import type { TextLine } from "./types";

export type StructTag = {
    /** Identity of the element the text belongs to (the same number for all of its content, across pages). */
    id: number;
    /** Standard structure type after the role map: "P", "H1"…"H6", "H", "Title", "LI", "TD", "TH", "Caption", "Span"… */
    role: string;
    /** The element is block-level (a paragraph, heading, list item, cell…), not an inline or grouping one. */
    block: boolean;
    /** Inside a table / a list. */
    table: boolean;
    list: boolean;
};

/** Structure of a line: the element that holds most of its text, or page furniture (headers, footers, numbers). */
export type LineStructure = { tag?: StructTag; artifact?: boolean };

/** Set by the line builder for lines of tagged pages. */
export const lineStructure = new WeakMap<TextLine, LineStructure>();

const N = (s: string) => PDFName.of(s);

const BLOCK = new Set([
    "P",
    "H",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "Title",
    "LI",
    "Lbl",
    "LBody",
    "TD",
    "TH",
    "Caption",
    "BlockQuote",
    "TOCI",
    "Note",
    "BibEntry",
    "Index",
    "Figure",
    "Formula",
    "Code",
]);

/** Heading level of a structure type ("H1" → 1 … "H6" → 6; "H" and "Title" → 1), or 0. */
export const headingLevelOfRole = (role: string): number => {
    const m = /^H([1-6])$/.exec(role);
    if (m) return +m[1];
    return role === "H" || role === "Title" ? 1 : 0;
};

type TreeCache = { roleMap: Map<string, string>; tags: Map<PDFDict, StructTag>; ids: Map<PDFDict, number> };
const treeCaches = new WeakMap<PDFDict, TreeCache>();

const deref = (o: PDFObject | undefined, context: PDFContext): PDFObject | undefined => (o instanceof PDFRef ? context.lookup(o) : o);

/** Value of a number tree (ParentTree) for `key`. */
const numberTreeGet = (node: PDFDict, key: number, context: PDFContext, depth = 0): PDFObject | undefined => {
    if (depth > 24) return undefined;
    const nums = deref(node.get(N("Nums")), context);
    if (nums instanceof PDFArray) {
        for (let i = 0; i + 1 < nums.size(); i += 2) {
            const k = deref(nums.get(i), context);
            if (k instanceof PDFNumber && k.asNumber() === key) return deref(nums.get(i + 1), context);
        }
    }
    const kids = deref(node.get(N("Kids")), context);
    if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
            const kid = deref(kids.get(i), context);
            if (!(kid instanceof PDFDict)) continue;
            const lim = deref(kid.get(N("Limits")), context);
            if (lim instanceof PDFArray && lim.size() === 2) {
                const lo = deref(lim.get(0), context);
                const hi = deref(lim.get(1), context);
                if (lo instanceof PDFNumber && hi instanceof PDFNumber && (key < lo.asNumber() || key > hi.asNumber())) continue;
            }
            const v = numberTreeGet(kid, key, context, depth + 1);
            if (v !== undefined) return v;
        }
    }
    return undefined;
};

const cacheOf = (root: PDFDict, context: PDFContext): TreeCache => {
    let c = treeCaches.get(root);
    if (c) return c;
    const roleMap = new Map<string, string>();
    const rm = deref(root.get(N("RoleMap")), context);
    if (rm instanceof PDFDict)
        for (const [k, v] of rm.entries()) {
            const target = deref(v, context);
            if (target instanceof PDFName) roleMap.set(k.decodeText(), target.decodeText());
        }
    c = { roleMap, tags: new Map(), ids: new Map() };
    treeCaches.set(root, c);
    return c;
};

const mapRole = (raw: string, roleMap: Map<string, string>) => {
    let role = raw;
    for (let i = 0; i < 8 && roleMap.has(role) && !BLOCK.has(role); i++) {
        const next = roleMap.get(role)!;
        if (next === role) break;
        role = next;
    }
    return role;
};

/** The element's tag: the nearest block-level element around it (list labels and bodies count as their list item). */
const tagOf = (elem: PDFDict, context: PDFContext, cache: TreeCache): StructTag | null => {
    const hit = cache.tags.get(elem);
    if (hit) return hit;
    const idOf = (d: PDFDict) => {
        let id = cache.ids.get(d);
        if (id === undefined) cache.ids.set(d, (id = cache.ids.size + 1));
        return id;
    };
    let block: { dict: PDFDict; role: string } | null = null;
    let first: { dict: PDFDict; role: string } | null = null;
    let table = false;
    let list = false;
    let passedList = false;
    let el: PDFDict | null = elem;
    for (let depth = 0; el && depth < 64; depth++) {
        const type = deref(el.get(N("Type")), context);
        if (type instanceof PDFName && type.decodeText() === "StructTreeRoot") break;
        const s = deref(el.get(N("S")), context);
        const role = s instanceof PDFName ? mapRole(s.decodeText(), cache.roleMap) : "";
        if (!first && role) first = { dict: el, role };
        // A list item's label and body (and the paragraphs in its body) are one item: the nearest item around the text,
        // unless a list or a table lies between them (the text is then in a nested list's item, or in a cell).
        if (!block && BLOCK.has(role)) block = { dict: el, role };
        else if (block && block.role !== "LI" && role === "LI" && !passedList) block = { dict: el, role };
        if (block && (role === "L" || role === "Table" || role === "TD" || role === "TH")) passedList = true;
        if (role === "Table" || role === "TR" || role === "TD" || role === "TH" || role === "THead" || role === "TBody" || role === "TFoot") table = true;
        if (role === "L" || role === "LI") list = true;
        const parent = deref(el.get(N("P")), context);
        el = parent instanceof PDFDict ? parent : null;
    }
    const chosen = block ?? first;
    if (!chosen) return null;
    const tag: StructTag = { id: idOf(chosen.dict), role: chosen.role, block: !!block, table, list };
    cache.tags.set(elem, tag);
    return tag;
};

const ARTIFACT = -2;
const NONE = -1;

/**
 * Structure of the text each operator of the page shows: its tag, "artifact" (page furniture) or null (untagged).
 * Null when the document or page is not tagged.
 */
export const pageStructure = (
    context: PDFContext,
    page: PDFPage,
    interp: Interpretation,
): ((streamKey: string, opIndex: number) => StructTag | "artifact" | null) | null => {
    const catalog = deref(context.trailerInfo.Root, context);
    if (!(catalog instanceof PDFDict)) return null;
    const root = deref(catalog.get(N("StructTreeRoot")), context);
    if (!(root instanceof PDFDict)) return null;
    const parentTree = deref(root.get(N("ParentTree")), context);
    const cache = cacheOf(root, context);
    const tags: StructTag[] = [];
    const parentsOf = (holder: PDFDict | undefined): PDFArray | null => {
        const sp = holder ? deref(holder.get(N("StructParents")), context) : undefined;
        if (!(sp instanceof PDFNumber) || !(parentTree instanceof PDFDict)) return null;
        const arr = numberTreeGet(parentTree, sp.asNumber(), context);
        return arr instanceof PDFArray ? arr : null;
    };
    const pageParents = parentsOf(page.node);
    const perStream = new Map<string, Int32Array>();
    let any = false;
    for (const [key, ctx] of interp.streams) {
        const n = ctx.ops.length;
        const out = new Int32Array(n).fill(NONE);
        let base = NONE;
        if (ctx.kind === "form" && ctx.parentKey) {
            const parent = perStream.get(ctx.parentKey);
            if (parent && ctx.doOpIndex !== undefined && ctx.doOpIndex < parent.length) base = parent[ctx.doOpIndex];
        }
        // A form with its own marked content refers to its own ParentTree entry.
        const parents = ctx.kind === "form" ? (parentsOf(ctx.form?.dict) ?? null) : pageParents;
        const stack: number[] = [];
        let artifacts = 0;
        for (let i = 0; i < n; i++) {
            const op = ctx.ops[i];
            if (op.op === "BMC") {
                const artifact = op.args[0]?.t === "name" && op.args[0].v === "Artifact";
                stack.push(artifact ? ARTIFACT : NONE);
                if (artifact) artifacts++;
            } else if (op.op === "BDC") {
                const name = op.args[0]?.t === "name" ? op.args[0].v : "";
                if (name === "Artifact") {
                    stack.push(ARTIFACT);
                    artifacts++;
                } else {
                    let mcid: number | undefined;
                    const props = op.args[1];
                    if (props?.t === "dict") {
                        const e = props.entries.find(([k]) => k === "MCID");
                        if (e && e[1].t === "num") mcid = e[1].v;
                    } else if (props?.t === "name" && ctx.resources) {
                        const res = deref(ctx.resources.get(N("Properties")), context);
                        const d = res instanceof PDFDict ? deref(res.get(N(props.v)), context) : undefined;
                        const m = d instanceof PDFDict ? deref(d.get(N("MCID")), context) : undefined;
                        if (m instanceof PDFNumber) mcid = m.asNumber();
                    }
                    let v = NONE;
                    if (mcid !== undefined && parents && mcid >= 0 && mcid < parents.size()) {
                        const elem = deref(parents.get(mcid), context);
                        const tag = elem instanceof PDFDict ? tagOf(elem, context, cache) : null;
                        if (tag) {
                            tags.push(tag);
                            v = tags.length - 1;
                            any = true;
                        }
                    }
                    stack.push(v);
                }
            } else if (op.op === "EMC") {
                const top = stack.pop();
                if (top === ARTIFACT) artifacts--;
            }
            let v = base;
            if (artifacts > 0) v = ARTIFACT;
            else
                for (let k = stack.length - 1; k >= 0; k--)
                    if (stack[k] !== NONE) {
                        v = stack[k];
                        break;
                    }
            out[i] = v;
            if (v === ARTIFACT) any = true;
        }
        perStream.set(key, out);
    }
    if (!any) return null;
    return (streamKey, opIndex) => {
        const v = perStream.get(streamKey)?.[opIndex] ?? NONE;
        return v === ARTIFACT ? "artifact" : v >= 0 ? tags[v] : null;
    };
};
