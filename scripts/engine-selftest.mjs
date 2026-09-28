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

/** One-page PDF: `fonts` maps resource names to standard fonts, `content` is the raw page content. */
const makePdf = async (content, { fonts = { F1: HELV }, forms = {}, width = 612, height = 792 } = {}) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([width, height]);
    const fontDict = {};
    for (const [name, std] of Object.entries(fonts)) fontDict[name] = (await doc.embedFont(std)).ref;
    const xobjects = {};
    for (const [name, body] of Object.entries(forms)) {
        const form = doc.context.flateStream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, width, 200], Resources: { Font: fontDict } });
        xobjects[name] = doc.context.register(form);
    }
    page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fontDict, XObject: xobjects }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
    return doc.save();
};

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
