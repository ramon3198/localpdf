// Self-test for src/lib/pdf-text-engine: builds small PDFs in memory (no external files), applies edits the way the
// app does (targets from pdf.js text items) and checks the results with pdf.js as an independent reader.
//
//   node scripts/engine-selftest.mjs            compiles the engine to node_modules/.cache/pte-selftest first
//   ENGINE_DIR=<compiled dir> node scripts/engine-selftest.mjs
//
// Exit code 1 when any check fails.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PDFDocument, PDFName, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

let engineDir = process.env.ENGINE_DIR;
if (!engineDir) {
    engineDir = path.join(ROOT, "node_modules/.cache/pte-selftest");
    const tsc = spawnSync(
        "npx",
        [
            "tsc",
            "src/lib/pdf-text-engine/index.ts",
            "--outDir",
            engineDir,
            "--module",
            "commonjs",
            "--target",
            "es2020",
            "--esModuleInterop",
            "--skipLibCheck",
            "--strict",
            "--downlevelIteration",
            "--moduleResolution",
            "node",
        ],
        { cwd: ROOT, shell: true, encoding: "utf8" },
    );
    if (tsc.status !== 0) {
        console.error(tsc.stdout, tsc.stderr);
        process.exit(1);
    }
}
const engine = require(path.join(engineDir, "index.js"));

const packDir = path.join(ROOT, "public/fonts/pack");
const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────

const HELV = StandardFonts.Helvetica;
const helvWidth = (() => {
    let font = null;
    return async (text, size) => {
        if (!font) font = await (await PDFDocument.create()).embedFont(HELV);
        return font.widthOfTextAtSize(text, size);
    };
})();

/**
 * One-page PDF: `fonts` maps resource names to standard fonts (or to a function that registers a font dictionary and
 * returns its reference), `content` is the raw page content, `prepare` can change the page before it is saved.
 */
const makePdf = async (content, { fonts = { F1: HELV }, forms = {}, width = 612, height = 792, prepare = null } = {}) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([width, height]);
    const fontDict = {};
    for (const [name, std] of Object.entries(fonts)) fontDict[name] = typeof std === "function" ? await std(doc) : (await doc.embedFont(std)).ref;
    const xobjects = {};
    for (const [name, body] of Object.entries(forms)) {
        const form = doc.context.flateStream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, width, 200], Resources: { Font: fontDict } });
        xobjects[name] = doc.context.register(form);
    }
    page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fontDict, XObject: xobjects }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
    prepare?.(doc, page);
    return doc.save();
};

/**
 * A subset font as LibreOffice writes them: a simple TrueType font with no /Encoding whose codes are numbered in order
 * of use, so only its ToUnicode CMap says what each code means. `codes` maps characters to codes; every glyph is
 * 500 units wide.
 */
const subsetFont = (codes) => (doc) => {
    const ctx = doc.context;
    const hex = (n, digits) => n.toString(16).padStart(digits, "0");
    const cmap = [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def",
        "1 begincodespacerange <00> <FF> endcodespacerange",
        `${codes.size} beginbfchar`,
        ...[...codes].map(([ch, code]) => `<${hex(code, 2)}> <${hex(ch.charCodeAt(0), 4)}>`),
        "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
    ].join("\n");
    const ttf = fs.readFileSync(path.join(packDir, "inter-400.ttf"));
    const last = Math.max(...codes.values());
    const descriptor = ctx.register(
        ctx.obj({
            Type: "FontDescriptor",
            FontName: "BAAAAA+LiberationSans",
            Flags: 4,
            FontBBox: [-500, -300, 1300, 1000],
            ItalicAngle: 0,
            Ascent: 900,
            Descent: -200,
            CapHeight: 700,
            StemV: 80,
            FontFile2: ctx.register(ctx.flateStream(ttf, { Length1: ttf.length })),
        }),
    );
    return ctx.register(
        ctx.obj({
            Type: "Font",
            Subtype: "TrueType",
            BaseFont: "BAAAAA+LiberationSans",
            FirstChar: 0,
            LastChar: last,
            Widths: Array.from({ length: last + 1 }, () => 500),
            FontDescriptor: descriptor,
            ToUnicode: ctx.register(ctx.flateStream(cmap)),
        }),
    );
};
/** `text` as a hex string in the codes of a `subsetFont`. */
const inCodes = (codes, text) => `<${[...text].map((ch) => codes.get(ch).toString(16).padStart(2, "0")).join("")}>`;

/** The page's content stream as written (latin1). */
const rawContent = async (bytes) => {
    const doc = await PDFDocument.load(bytes);
    const content = doc.getPage(0).node.lookup(PDFName.of("Contents"));
    return Buffer.from(require("pdf-lib").decodePDFRawStream(content).decode()).toString("latin1");
};

/** A paragraph set like Word does: one TJ per line, space glyphs plus a number after each to justify to `right`. */
const justifiedLines = (text, { size, left, right, indent = 0, widthOf, show }) => {
    const rows = [];
    let row = [];
    for (const word of text.split(" ")) {
        const trial = [...row, word];
        if (row.length && widthOf(trial.join(" ")) > right - left - (rows.length ? 0 : indent)) {
            rows.push(row);
            row = [word];
        } else row = trial;
    }
    rows.push(row);
    return rows
        .map((words, i) => {
            const x = left + (i ? 0 : indent);
            const extra = i === rows.length - 1 ? 0 : (right - x - widthOf(words.join(" "))) / (words.length - 1);
            const parts = words.map((word, k) => (k < words.length - 1 ? `${show(word + " ")} ${((-extra * 1000) / size).toFixed(3)}` : show(word)));
            return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${700 - i * 14} Tm [${parts.join(" ")}] TJ ET`;
        })
        .join("\n");
};
const PARAGRAPH =
    "El comite ha decidido aprobar la ampliacion del contrato de mantenimiento por un periodo adicional de doce meses a partir de la fecha de " +
    "firma de este documento y en las mismas condiciones que el anterior sin cambios de ningun tipo para nadie y con la garantia de que los " +
    "plazos pactados se respetan en cada una de las fases del proyecto hasta su entrega final al cliente";

const itemsOf = async (bytes) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items.filter((i) => i.str && i.str.trim());
    await doc.destroy();
    return items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, transform: i.transform }));
};

/** Apply edits given as [find, replace] pairs on page 1, targeting pdf.js items like the app does. */
const edit = async (bytes, pairs, { nth = {} } = {}) => {
    const items = await itemsOf(bytes);
    const edits = pairs.map(([find, repl, style]) => {
        const matches = items.filter((x) => x.str === find || x.str.includes(find));
        const it = matches[nth[find] ?? 0];
        if (!it) throw new Error(`item "${find}" not found in ${JSON.stringify(items.map((i) => i.str))}`);
        return {
            pageIndex: 0,
            target: { transform: it.transform, width: it.w, str: it.str },
            newText: it.str === find ? repl : it.str.replace(find, repl),
            style,
        };
    });
    const doc = await PDFDocument.load(bytes);
    doc.registerFontkit(fontkit);
    const cache = new Map();
    const embed = async (key, make) => {
        if (!cache.has(key)) cache.set(key, await make());
        return cache.get(key);
    };
    const results = await engine.applyTextEdits(doc, edits, {
        fallback: async (r) => {
            if (r.universal) {
                const file = engine.resolveUniversalFace(manifest, r);
                return file ? embed(file, () => doc.embedFont(fs.readFileSync(path.join(packDir, file)), { subset: false })) : null;
            }
            const face = r.standardOnly ? null : engine.resolvePackFace(manifest, r.baseFont, { weight: r.weight, italic: r.italic, family: r.family });
            if (face) return embed(face.file, () => doc.embedFont(fs.readFileSync(path.join(packDir, face.file)), { subset: true }));
            const std = r.serif ? StandardFonts.TimesRoman : r.mono ? StandardFonts.Courier : r.bold ? StandardFonts.HelveticaBold : HELV;
            return embed(std, () => doc.embedFont(std));
        },
        fontkitFactory: (b) => fontkit.create(b),
        // SELFTEST_DEBUG=1 prints the engine's own account of each decision.
        debug: process.env.SELFTEST_DEBUG ? (message) => console.log(`  debug: ${message}`) : undefined,
    });
    const out = await doc.save();
    if (process.env.SELFTEST_DUMP) fs.writeFileSync(process.env.SELFTEST_DUMP, out);
    return { results, bytes: out };
};

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────

let failures = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
    if (!cond) failures++;
};
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const find = (items, s) => items.find((i) => i.str.includes(s));
/** The whole visual line containing an item with `s` (pdf.js splits lines at wide gaps). */
const lineOf = (items, s) => {
    const hit = find(items, s);
    if (!hit) return null;
    const parts = items.filter((i) => Math.abs(i.y - hit.y) < 0.5).sort((a, b) => a.x - b.x);
    return { text: parts.map((i) => i.str).join(" "), left: parts[0].x, right: Math.max(...parts.map((i) => i.x + i.w)), y: hit.y };
};
const allOk = (results) => results.every((r) => r && r.ok);
const esc = (s) => s.replace(/[()\\]/g, (c) => "\\" + c);

const cases = {
    // The rest of the line moves with a longer word; text before it stays.
    async reflow() {
        const src = await makePdf("BT /F1 12 Tf 72 700 Td (Total: ) Tj /F2 12 Tf (100 EUR) Tj /F1 12 Tf ( IVA incluido) Tj ET", {
            fonts: { F1: HELV, F2: StandardFonts.HelveticaBold },
        });
        const before = await itemsOf(src);
        const { results, bytes } = await edit(src, [["100 EUR", "1.250,00 EUR"]]);
        const after = await itemsOf(bytes);
        const grow = find(after, "1.250,00 EUR").w - find(before, "100 EUR").w;
        check("reflow: edit applied", allOk(results), JSON.stringify(results));
        check("reflow: text before the edit unchanged", near(find(after, "Total:").x, find(before, "Total:").x));
        check(
            "reflow: rest of the line follows",
            near(find(after, "IVA incluido").x, find(before, "IVA incluido").x + grow),
            `${find(after, "IVA incluido").x} vs ${find(before, "IVA incluido").x + grow}`,
        );
    },

    // A style change (bold) makes the word wider: the rest of the line moves instead of being overlapped.
    async styleChange() {
        const src = await makePdf("BT /F1 12 Tf 72 700 Td (Total: ) Tj /F2 12 Tf (importe final) Tj /F1 12 Tf ( IVA incluido) Tj ET", {
            fonts: { F1: HELV, F2: StandardFonts.TimesRoman },
        });
        const before = await itemsOf(src);
        const { results, bytes } = await edit(src, [["importe final", "importe final", { forceStyle: { bold: true, italic: false } }]]);
        const after = await itemsOf(bytes);
        const word = after.find((i) => i.str.includes("importe"));
        const grow = word.w - find(before, "importe final").w;
        check("style: applied", allOk(results), JSON.stringify(results));
        check("style: bold is wider", grow > 1, `${grow}`);
        check(
            "style: rest of the line follows",
            near(find(after, "IVA incluido").x, find(before, "IVA incluido").x + grow, 0.1),
            `${find(after, "IVA incluido").x} vs ${find(before, "IVA incluido").x + grow}`,
        );
    },

    // Right-aligned amounts keep their right edge.
    async rightAligned() {
        const rows = ["90,00", "1.250,00", "15,50"];
        let content = "";
        for (const [i, t] of rows.entries()) content += `BT /F1 11 Tf ${500 - (await helvWidth(t, 11))} ${700 - i * 20} Td (${t}) Tj ET\n`;
        const src = await makePdf(content);
        const { results, bytes } = await edit(src, [["90,00", "12.090,00"]]);
        const it = find(await itemsOf(bytes), "12.090,00");
        check("right-aligned: edit applied", allOk(results), JSON.stringify(results));
        check("right-aligned: right edge kept", it && near(it.x + it.w, 500, 0.1), it ? `${it.x + it.w}` : "missing");
    },

    // A lone centred title keeps its centre.
    async centred() {
        const t = "Informe anual";
        const src = await makePdf(
            `BT /F1 24 Tf ${306 - (await helvWidth(t, 24)) / 2} 720 Td (${t}) Tj ET BT /F1 11 Tf 72 680 Td (Texto normal a la izquierda) Tj ET`,
        );
        const b = lineOf(await itemsOf(src), "Informe");
        const { results, bytes } = await edit(src, [[t, "Informe anual consolidado"]]);
        const a = lineOf(await itemsOf(bytes), "Informe");
        check("centred: edit applied", allOk(results), JSON.stringify(results));
        check(
            "centred: centre kept",
            a && near((a.left + a.right) / 2, (b.left + b.right) / 2, 0.1),
            a ? `${(a.left + a.right) / 2} vs ${(b.left + b.right) / 2}` : "missing",
        );
    },

    // TJ-justified paragraph (pdfTeX style, no space glyphs): the edited line keeps both edges.
    async justified() {
        const lines = [
            ["Este", "texto", "esta", "justificado", "con", "huecos"],
            ["de", "posicionamiento", "como", "los", "documentos", "LaTeX"],
            ["y", "termina", "aqui."],
        ];
        let content = "BT /F1 11 Tf 72 700 Td 14 TL\n";
        for (const [k, words] of lines.entries()) {
            const inkW = (await Promise.all(words.map((w) => helvWidth(w, 11)))).reduce((a, b) => a + b, 0);
            const last = k === lines.length - 1;
            const gap = last ? 3 : (468 - inkW) / (words.length - 1);
            const n = (-gap * 1000) / 11;
            content += `[${words.map((w) => `(${esc(w)})`).join(` ${n.toFixed(3)} `)}] TJ T*\n`;
        }
        content += "ET";
        const src = await makePdf(content);
        const before = await itemsOf(src);
        const b1 = lineOf(before, "Este");
        const { results, bytes } = await edit(src, [["esta", "estaba"]]);
        const after = await itemsOf(bytes);
        const a1 = lineOf(after, "Este");
        const b2 = lineOf(before, "posicionamiento");
        const a2 = lineOf(after, "posicionamiento");
        check("justified: edit applied", allOk(results), JSON.stringify(results));
        check("justified: text changed", a1 && a1.text.includes("estaba"), a1?.text);
        check("justified: left edge kept", a1 && near(a1.left, b1.left));
        check("justified: right edge kept", a1 && near(a1.right, b1.right, 0.15), a1 ? `${a1.right} vs ${b1.right}` : "");
        check("justified: next line untouched", a2 && near(a2.left, b2.left) && near(a2.right, b2.right));
    },

    // A justified paragraph (Word style: one TJ per line, space glyphs plus justification numbers) whose edited line
    // can't absorb a longer phrase: words flow into the next lines, which stay justified; the last stays ragged.
    async paragraphReflow() {
        const text =
            "El comite ha decidido aprobar la ampliacion del contrato de mantenimiento por un periodo adicional de doce meses a partir de la fecha de firma de este documento y en las mismas condiciones";
        const words = text.split(" ");
        const size = 11;
        const space = await helvWidth(" ", size);
        const rows = [];
        let row = [];
        for (const w of words) {
            const trial = [...row, w];
            const width = (await Promise.all(trial.map((x) => helvWidth(x, size)))).reduce((a, b) => a + b, 0) + space * (trial.length - 1);
            if (row.length && width > 468) {
                rows.push(row);
                row = [w];
            } else row = trial;
        }
        rows.push(row);
        let content = "";
        for (const [i, r] of rows.entries()) {
            const inkW = (await Promise.all(r.map((x) => helvWidth(x, size)))).reduce((a, b) => a + b, 0);
            const extra = i === rows.length - 1 ? 0 : (468 - inkW - space * (r.length - 1)) / (r.length - 1);
            const parts = r.map((w, k) => (k < r.length - 1 ? `(${w} ) ${((-extra * 1000) / size).toFixed(3)}` : `(${w})`));
            content += `BT /F1 ${size} Tf 1 0 0 1 72 ${700 - i * 14} Tm [${parts.join(" ")}] TJ ET\n`;
        }
        const src = await makePdf(content);
        const { results, bytes } = await edit(src, [["ha decidido", "directivo de la empresa ha decidido"]]);
        const after = await itemsOf(bytes);
        const lines = [...new Set(after.map((i) => Math.round(i.y)))]
            .sort((a, b) => b - a)
            .map((y) => lineOf(after, after.find((i) => Math.round(i.y) === y).str));
        const joined = lines
            .map((l) => l.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        check("paragraph: applied", allOk(results), JSON.stringify(results));
        check("paragraph: same number of lines", lines.length === rows.length, `${lines.length} vs ${rows.length}`);
        check("paragraph: text in order", joined === text.replace("ha decidido", "directivo de la empresa ha decidido"), joined);
        check(
            "paragraph: justified lines keep both edges",
            lines.slice(0, -1).every((l) => near(l.left, 72, 0.1) && near(l.right, 540, 0.2)),
            JSON.stringify(lines.map((l) => [l.left.toFixed(2), l.right.toFixed(2)])),
        );
        check("paragraph: last line ragged, inside the margin", near(lines[lines.length - 1].left, 72, 0.1) && lines[lines.length - 1].right < 540);
    },

    // Letter-spaced text (Tc) with real spaces: pdf.js' extra spaces must not become glyphs.
    async letterSpaced() {
        const src = await makePdf("BT /F1 12 Tf 2 Tc 72 700 Td (Hola mundo) Tj ET");
        const before = lineOf(await itemsOf(src), "H");
        const { results, bytes } = await edit(src, [["m u n d o", "m u n d o s"]]);
        const after = lineOf(await itemsOf(bytes), "H");
        const expected = before.right + (await helvWidth("s", 12)) + 2;
        check("letter-spaced: edit applied", allOk(results), JSON.stringify(results));
        check("letter-spaced: spacing kept", after && near(after.right, expected, 0.2), after ? `${after.right} vs ${expected}` : "missing");
        check("letter-spaced: text", after && after.text.replace(/\s+/g, "") === "Holamundos", after?.text);
    },

    // Several edits on one line in a single call all reflow.
    async twoEditsOneLine() {
        const src = await makePdf("BT /F2 10 Tf 72 700 Td (Fecha:) Tj /F1 10 Tf ( 23/03/2026 ) Tj /F2 10 Tf (Hora:) Tj /F1 10 Tf ( 09:34) Tj ET", {
            fonts: { F1: HELV, F2: StandardFonts.HelveticaBold },
        });
        const before = await itemsOf(src);
        const { results, bytes } = await edit(src, [
            ["Fecha:", "Fecha de emision:"],
            ["23/03/2026", "1 de abril de 2026"],
        ]);
        const after = await itemsOf(bytes);
        const grow = find(after, "Fecha de emision:").w - find(before, "Fecha:").w + (find(after, "1 de abril").w - find(before, "23/03/2026").w);
        check("two edits: applied", allOk(results), JSON.stringify(results));
        check(
            "two edits: rest of the line follows both",
            near(find(after, "Hora:").x, find(before, "Hora:").x + grow, 0.1),
            `${find(after, "Hora:").x} vs ${find(before, "Hora:").x + grow}`,
        );
    },

    // A form painted twice under the same name: only the edited painting changes.
    async formTwice() {
        const src = await makePdf("q 1 0 0 1 0 500 cm /Fm0 Do Q q 1 0 0 1 0 250 cm /Fm0 Do Q", {
            forms: { Fm0: "BT /F1 14 Tf 72 100 Td (Etiqueta: Sevilla) Tj ET" },
        });
        const { results, bytes } = await edit(src, [["Etiqueta: Sevilla", "Etiqueta: Cordoba"]]);
        const strs = (await itemsOf(bytes)).map((i) => i.str);
        check("form twice: applied", allOk(results), JSON.stringify(results));
        check(
            "form twice: one copy edited, the other kept",
            strs.filter((s) => s.includes("Cordoba")).length === 1 && strs.filter((s) => s.includes("Sevilla")).length === 1,
            JSON.stringify(strs),
        );
    },

    // /ActualText around the run follows the edit.
    async actualText() {
        const src = await makePdf("/Span <</ActualText (Precio antiguo)>> BDC BT /F1 12 Tf 72 700 Td (Precio antiguo) Tj ET EMC");
        const { results, bytes } = await edit(src, [["Precio antiguo", "Precio nuevo"]]);
        const doc = await PDFDocument.load(bytes);
        const content = doc.getPage(0).node.lookup(PDFName.of("Contents"));
        const raw = Buffer.from(require("pdf-lib").decodePDFRawStream(content).decode()).toString("latin1");
        const hex = raw.match(/ActualText\s*<([0-9a-fA-F]+)>/)?.[1] ?? "";
        const text = Buffer.from(hex.slice(4), "hex").swap16().toString("utf16le");
        check("actualtext: applied", allOk(results), JSON.stringify(results));
        check("actualtext: updated", text === "Precio nuevo", text || raw.slice(0, 120));
    },

    // A symbol the font lacks comes from the wide-coverage face; the text stays native.
    async symbol() {
        const src = await makePdf("BT /F1 12 Tf 72 700 Td (Pago mensual) Tj ET");
        const { results, bytes } = await edit(src, [["Pago mensual", "Pago mensual → anual"]]);
        const it = find(await itemsOf(bytes), "Pago");
        check("symbol: applied", allOk(results), JSON.stringify(results));
        check(
            "symbol: extractable",
            it &&
                (await itemsOf(bytes))
                    .map((i) => i.str)
                    .join(" ")
                    .includes("→"),
            (await itemsOf(bytes)).map((i) => i.str).join("|"),
        );
    },

    // Glyphs placed one per Tj with relative Td (Chrome/Skia): minimal diff and reflow still work.
    async tdChain() {
        const word = "Noche de estrellas";
        let content = "BT /F1 16 Tf 1 0 0 1 72 700 Tm\n";
        for (const [i, ch] of [...word].entries()) content += `${i ? `${(await helvWidth(word[i - 1], 16)).toFixed(4)} 0 Td ` : ""}(${esc(ch)}) Tj\n`;
        content += "ET BT /F1 16 Tf 1 0 0 1 72 660 Tm (Linea siguiente) Tj ET";
        const src = await makePdf(content);
        const before = await itemsOf(src);
        const { results, bytes } = await edit(src, [["estrellas", "galaxias"]]);
        const after = await itemsOf(bytes);
        const it = find(after, "galaxias");
        check("td chain: applied", allOk(results) && results[0].partial, JSON.stringify(results));
        check("td chain: width follows the new word", it && near(it.w, await helvWidth("Noche de galaxias", 16), 0.1), it ? `${it.w}` : "missing");
        check("td chain: other line untouched", near(find(after, "Linea").x, find(before, "Linea").x));
    },

    // Subset font numbered in order of use: code 0x23 is a letter here, so a typed "#" must not be written with it.
    async toUnicodeWins() {
        const text = "Total de la factura numero 12345 con IVA incluido y descuento aplicado: BCDEFGHJKMNOPQRSUVWXYZ";
        const codes = new Map();
        for (const ch of text) if (!codes.has(ch)) codes.set(ch, codes.size + 1);
        const src = await makePdf(
            `BT /F1 12 Tf 72 700 Td ${inCodes(codes, text.slice(0, 32))} Tj ET\nBT /F1 12 Tf 72 680 Td ${inCodes(codes, text.slice(33))} Tj ET`,
            { fonts: { F1: subsetFont(codes) } },
        );
        const { results, bytes } = await edit(src, [["12345", "12345 #"]]);
        const line = lineOf(await itemsOf(bytes), "12345");
        check("tounicode: applied", allOk(results), JSON.stringify(results));
        check("tounicode: the typed character is the one drawn", !!line && line.text.includes("#"), line ? line.text : "missing");
    },

    // Two codes mean "a" (the letter and an alternate glyph): typed text uses the letter's own code.
    async alternateGlyph() {
        const alternate = (doc) => {
            const cmap =
                "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def\n" +
                "1 begincodespacerange <00> <FF> endcodespacerange\n2 beginbfchar\n<80> <0061>\n<61> <0061>\nendbfchar\n" +
                "endcmap CMapName currentdict /CMap defineresource pop end end";
            return doc.context.register(
                doc.context.obj({
                    Type: "Font",
                    Subtype: "Type1",
                    BaseFont: "Helvetica",
                    Encoding: "WinAnsiEncoding",
                    ToUnicode: doc.context.register(doc.context.flateStream(cmap)),
                }),
            );
        };
        const src = await makePdf("BT /F1 12 Tf 72 700 Td (pan con \\200ceite) Tj ET", { fonts: { F1: alternate } });
        const { results, bytes } = await edit(src, [["pan", "panaderia"]]);
        const raw = await rawContent(bytes);
        const hexBytes = [...raw.matchAll(/<([0-9a-fA-F\s]+)>/g)].flatMap((m) => m[1].replace(/\s/g, "").match(/../g) ?? []);
        const alternates = hexBytes.filter((b) => b.toLowerCase() === "80").length + raw.split("\\200").length - 1 + raw.split("\x80").length - 1;
        check("alternate glyph: applied", allOk(results), JSON.stringify(results));
        check("alternate glyph: new letters use the plain code", alternates === 1, `${alternates} alternate glyphs in ${raw.slice(0, 160)}`);
    },

    // The indented first line of a justified paragraph shares only its right edge with the others: it is not a
    // right-aligned line, and must keep its indent.
    async indentedJustified() {
        const size = 11;
        const font = await (await PDFDocument.create()).embedFont(HELV);
        const content = justifiedLines(PARAGRAPH, {
            size,
            left: 72,
            right: 540,
            indent: 20,
            // Glyph by glyph: a plain Tj applies no kerning, and the lines must end exactly on the margin.
            widthOf: (t) => [...t].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size), 0),
            show: (t) => `(${esc(t)})`,
        });
        const src = await makePdf(content);
        const { results, bytes } = await edit(src, [["decidido", "decidido finalmente"]]);
        const line = lineOf(await itemsOf(bytes), "comite");
        check("indented: applied", allOk(results), JSON.stringify(results));
        check("indented: first line keeps its indent", !!line && near(line.left, 92, 0.1), line ? `${line.left}` : "missing");
        check("indented: first line stays inside the margin", !!line && line.right <= 540.5, line ? `${line.right}` : "missing");
    },

    // A subset font whose code 32 is the letter "a": word spacing rules for code 32 must not make it a word gap.
    async letterAtCode32() {
        const size = 11;
        const codes = new Map([["a", 0x20]]);
        for (const ch of PARAGRAPH) if (!codes.has(ch)) codes.set(ch, codes.size);
        const content = justifiedLines(PARAGRAPH, {
            size,
            left: 72,
            right: 540,
            widthOf: (t) => t.length * 0.5 * size,
            show: (t) => inCodes(codes, t),
        });
        const src = await makePdf(content, { fonts: { F1: subsetFont(codes) } });
        const { results, bytes } = await edit(src, [["doce", "doce o trece"]]);
        const doc = await PDFDocument.load(bytes);
        const registry = new engine.FontRegistry(doc.context, (b) => fontkit.create(b));
        const placed = new engine.PageTextEditor(doc, 0, registry, async () => null).placements;
        const torn = [];
        for (let i = 1; i < placed.length; i++) {
            const a = placed[i - 1];
            const b = placed[i];
            if (Math.abs(a.origin[1] - b.origin[1]) > 0.5 || a.glyph.unicode === " " || b.glyph.unicode === " ") continue;
            const gap = b.origin[0] - a.origin[0] - a.advUser;
            // Overlapping letters, or a sliver between them. A reflowed line may draw whole word gaps by position.
            if (gap < -0.05 || (gap > 0.05 && gap < 2)) torn.push(`${a.glyph.unicode}|${b.glyph.unicode}:${gap.toFixed(2)}`);
        }
        check("code 32 letter: applied", allOk(results), JSON.stringify(results));
        check("code 32 letter: no gap moved inside a word", torn.length === 0, torn.slice(0, 8).join(" "));
    },

    // Readers normalise some characters (µ becomes the Greek mu): an untouched glyph must still be kept as it is.
    async normalisedGlyph() {
        const src = await makePdf("BT /F1 12 Tf 72 700 Td [(Dosis: 50 \\265g) -20 ( al dia, diarios)] TJ ET");
        const { results, bytes } = await edit(src, [["diarios", "semanales"]]);
        const raw = await rawContent(bytes);
        check("normalised glyph: applied", allOk(results), JSON.stringify(results));
        check(
            "normalised glyph: untouched text not redrawn",
            !results[0].fallbackChars && raw.includes("-20"),
            `${JSON.stringify(results[0])} ${raw.slice(0, 160)}`,
        );
    },

    // /ActualText kept in the page's /Properties (a named property list) follows the edit too.
    async actualTextNamed() {
        const { PDFString, PDFHexString, PDFDict } = require("pdf-lib");
        const src = await makePdf("/Span /MC0 BDC BT /F1 12 Tf 72 700 Td (Precio antiguo) Tj ET EMC", {
            prepare: (doc, page) =>
                page.node
                    .lookup(PDFName.of("Resources"))
                    .set(PDFName.of("Properties"), doc.context.obj({ MC0: { ActualText: PDFString.of("Precio antiguo") } })),
        });
        const { results, bytes } = await edit(src, [["Precio antiguo", "Precio nuevo"]]);
        const name = (await rawContent(bytes)).match(/\/Span\s*\/(\S+)\s+BDC/)?.[1];
        const lists = (await PDFDocument.load(bytes)).getPage(0).node.Resources()?.lookup(PDFName.of("Properties"));
        const list = name && lists instanceof PDFDict ? lists.lookup(PDFName.of(name)) : undefined;
        const value = list instanceof PDFDict ? list.lookup(PDFName.of("ActualText")) : undefined;
        const text = value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
        check("actualtext (named): applied", allOk(results), JSON.stringify(results));
        check("actualtext (named): updated", text === "Precio nuevo", `${name}: ${text}`);
        // Another page or sequence may use the same list.
        const original = lists instanceof PDFDict ? lists.lookup(PDFName.of("MC0")) : undefined;
        const kept = original instanceof PDFDict ? original.lookup(PDFName.of("ActualText")) : undefined;
        check("actualtext (named): the shared list is left as it was", kept instanceof PDFString && kept.decodeText() === "Precio antiguo", `${kept}`);
    },

    // A span of its own inside the line (a soft hyphen at the line's end) keeps its /ActualText when other words change.
    async actualTextOtherSpan() {
        const src = await makePdf("BT /F1 12 Tf 72 700 Td (Texto de ejem) Tj /Span <</ActualText <FEFF00AD>>> BDC (-) Tj EMC ET");
        const { results, bytes } = await edit(src, [["Texto", "Parrafo"]]);
        const raw = await rawContent(bytes);
        check("actualtext (other span): applied", allOk(results), JSON.stringify(results));
        check("actualtext (other span): kept", /ActualText\s*<FEFF00AD>/i.test(raw), raw.slice(0, 200));
    },

    // A Type3 font whose glyph space is not the usual 1/1000 (FontMatrix 1, drawn at size 1): readers report the height
    // of its glyphs, not the nominal size, and the run must still be found.
    async type3GlyphSpace() {
        const unit = 12;
        const type3 = (doc) => {
            const ctx = doc.context;
            const box = (w) => ctx.register(ctx.flateStream(`${w} 0 d0 0 0 ${w * 0.8} ${unit * 0.7} re f`));
            const widths = { 32: 0.3, 65: 0.6, 66: 0.5, 67: 0.7 };
            return ctx.register(
                ctx.obj({
                    Type: "Font",
                    Subtype: "Type3",
                    FontBBox: [0, 0, unit, unit],
                    FontMatrix: [1, 0, 0, 1, 0, 0],
                    CharProcs: { A: box(unit * 0.6), B: box(unit * 0.5), C: box(unit * 0.7), space: box(unit * 0.3) },
                    Encoding: { Type: "Encoding", Differences: [32, "space", 65, "A", "B", "C"] },
                    FirstChar: 32,
                    LastChar: 67,
                    Widths: Array.from({ length: 36 }, (_, i) => unit * (widths[i + 32] ?? 0)),
                    Resources: {},
                }),
            );
        };
        const src = await makePdf("BT /F1 1 Tf 72 700 Td (ABCAB) Tj ( CAB) Tj ET", { fonts: { F1: type3 } });
        const { results, bytes } = await edit(src, [["ABCAB", "ABCABBA"]]);
        const text = (await itemsOf(bytes)).map((i) => i.str).join(" ");
        check("type3 glyph space: applied", allOk(results), JSON.stringify(results));
        check("type3 glyph space: text changed", text.includes("ABCABBA"), text);
    },

    // A lone centred title keeps its centre when the page takes its MediaBox from the page tree.
    async inheritedPageBox() {
        const t = "Informe anual";
        const src = await makePdf(
            `BT /F1 24 Tf ${306 - (await helvWidth(t, 24)) / 2} 720 Td (${t}) Tj ET BT /F1 11 Tf 72 680 Td (Texto normal a la izquierda) Tj ET`,
            {
                prepare: (doc, page) => {
                    const box = PDFName.of("MediaBox");
                    page.node.lookup(PDFName.of("Parent")).set(box, page.node.get(box));
                    page.node.delete(box);
                },
            },
        );
        const b = lineOf(await itemsOf(src), "Informe");
        const { results, bytes } = await edit(src, [[t, "Informe anual consolidado"]]);
        const a = lineOf(await itemsOf(bytes), "Informe");
        check("inherited box: applied", allOk(results), JSON.stringify(results));
        check("inherited box: centre kept", !!a && near((a.left + a.right) / 2, (b.left + b.right) / 2, 0.1), a ? `${(a.left + a.right) / 2}` : "missing");
    },
};

for (const [name, fn] of Object.entries(cases)) {
    if (process.env.SELFTEST_ONLY && process.env.SELFTEST_ONLY !== name) continue;
    try {
        await fn();
    } catch (err) {
        check(name, false, err instanceof Error ? err.stack : String(err));
    }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
