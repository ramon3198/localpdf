// Headless harness for src/lib/pdf-text-engine (compiled to node_modules/.cache/pte by tsc).
// Usage: node scripts/engine-test.mjs <in.pdf> <out.pdf> <page> "<find>" "<replace>" ["<find>" "<replace>" ...]
// Edits use the same inputs the browser has: pdfjs TextItem.transform/width/str.
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const engine = require(process.env.ENGINE_DIR ? `${process.env.ENGINE_DIR}/index.js` : "../node_modules/.cache/pte/index.js");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const [, , inPath, outPath, pageArg, ...pairs] = process.argv;
const pageNo = Number(pageArg || 1);
const bytes = fs.readFileSync(inPath);

const jsDoc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 }).promise;
const page = await jsDoc.getPage(pageNo);
const tc = await page.getTextContent();
const items = tc.items.filter((i) => i.str && i.str.trim());

const edits = [];
const wanted = [];
for (let i = 0; i + 1 < pairs.length; i += 2) {
    const find = pairs[i];
    const repl = pairs[i + 1];
    const it = items.find((x) => x.str === find) ?? items.find((x) => x.str.includes(find));
    if (!it) {
        console.log(JSON.stringify({ find, error: "item not found", sample: items.slice(0, 12).map((x) => x.str) }));
        continue;
    }
    edits.push({
        pageIndex: pageNo - 1,
        target: { transform: it.transform, width: it.width, str: it.str },
        newText: it.str === find ? repl : it.str.replace(find, repl),
    });
    wanted.push({ find, item: it.str });
}

const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
doc.registerFontkit(fontkit);
const stdFor = (r) => {
    if (r.mono)
        return r.bold
            ? r.italic
                ? StandardFonts.CourierBoldOblique
                : StandardFonts.CourierBold
            : r.italic
              ? StandardFonts.CourierOblique
              : StandardFonts.Courier;
    if (r.serif)
        return r.bold
            ? r.italic
                ? StandardFonts.TimesRomanBoldItalic
                : StandardFonts.TimesRomanBold
            : r.italic
              ? StandardFonts.TimesRomanItalic
              : StandardFonts.TimesRoman;
    return r.bold
        ? r.italic
            ? StandardFonts.HelveticaBoldOblique
            : StandardFonts.HelveticaBold
        : r.italic
          ? StandardFonts.HelveticaOblique
          : StandardFonts.Helvetica;
};
const cache = new Map();
const packDir = new URL("../public/fonts/pack/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", packDir), "utf8"));
const fallbackLog = [];
const t0 = Date.now();
const results = await engine.applyTextEdits(doc, edits, {
    fallback: async (r) => {
        if (r.universal) {
            const file = process.env.NO_PACK ? null : engine.resolveUniversalFace(manifest, r);
            if (!file) return null;
            if (!cache.has(file)) cache.set(file, await doc.embedFont(fs.readFileSync(new URL(file, packDir)), { subset: false }));
            fallbackLog.push({ for: r.baseFont, weight: r.weight, using: file });
            return cache.get(file);
        }
        // Same typeface from the font pack first, then a Standard 14 font of the same style.
        const face =
            process.env.NO_PACK || r.standardOnly
                ? null
                : engine.resolvePackFace(manifest, r.baseFont, { weight: r.weight, italic: r.italic, family: r.family });
        const k = face ? face.file : stdFor(r);
        if (!cache.has(k)) cache.set(k, face ? await doc.embedFont(fs.readFileSync(new URL(face.file, packDir)), { subset: true }) : await doc.embedFont(k));
        fallbackLog.push({ for: r.baseFont, weight: r.weight, using: face ? `${face.family} (${face.file})` : k });
        return cache.get(k);
    },
    fontkitFactory: (b) => fontkit.create(b),
    debug: process.env.ENGINE_DEBUG ? (m) => console.error("[engine]", m) : undefined,
});
if (fallbackLog.length) console.error("fallback fonts:", JSON.stringify(fallbackLog));
const out = await doc.save();
fs.writeFileSync(outPath, out);
console.log(JSON.stringify({ ms: Date.now() - t0, edits: wanted.map((w, i) => ({ ...w, newText: edits[i].newText, result: results[i] })) }, null, 1));
