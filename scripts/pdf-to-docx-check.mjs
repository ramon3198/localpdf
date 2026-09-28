// Quality check for the PDF → Word converter (src/lib/pdf-to-docx). Converts PDFs to .docx in Node, renders every
// .docx with Microsoft Word and scores it against the original PDF, against ground-truth .docx files and against
// Word's own PDF → DOCX conversion. Metrics come from scripts/pdf-to-docx-metrics.py (PyMuPDF, python-docx).
//
//   node scripts/pdf-to-docx-check.mjs [options] <input...>
//
// Inputs: PDF files, folders (every *.pdf; a .docx with the same name beside a PDF is its ground truth), manifest
// .json files ({ "documents": [{ "id", "pdf", "gt"?, "set"?, "features"? }], paths relative to the manifest), or the
// shortcuts `corpus` and `samples` (<home>/corpus/manifest.json and <home>/corpus/samples.json).
//
// Options:
//   --home <dir>          workspace with corpus/, runs/ and word-export.ps1 (default: $P2D_HOME)
//   --name <run>          run folder name (default: run-<date>-<time>)
//   --runs <dir>          parent folder of the runs (default: <home>/runs, else node_modules/.cache/p2d-check-runs)
//   --converter <file>    use this module's convertPdfToDocx(pdf, env, options) instead of src/lib/pdf-to-docx
//   --build <dir>         use a converter already compiled with tsc (<dir>/pdf-to-docx/index.js)
//   --no-compile          reuse the last build (node_modules/.cache/p2d-check/latest) instead of running tsc
//   --word                export each .docx to PDF with Word: rendered metrics and side-by-side sheets
//   --baseline            also score Word's own PDF → DOCX conversion, converting what is not cached yet (see
//                         --baseline-dir); implies --word. With --word alone, cached conversions are still scored.
//   --word-export <ps1>   Word gateway script, -In <file> -Out <file> (default: <home>/word-export.ps1, else
//                         $P2D_WORD_EXPORT, else scripts/pdf-to-docx-word-export.ps1)
//   --baseline-dir <dir>  cache of Word's own conversions (default: <home>/corpus/word-baseline)
//   --refresh-baseline    redo Word's own conversions even when cached
//   --ocr                 OCR image-only pages with tesseract.js; --ocr-lang-path <dir> for local traineddata
//   --mode <m>            converter mode: auto (default), flow or layout
//   --render <fmt>        png (default) or jpeg for env.renderPage
//   --only <regex>        only documents whose id matches
//   --sheets <n>          side-by-side sheets for the first n pages of each document (default 8; 0 = none)
//   --sheet-dpi <n>       resolution of the sheets (default 70)
//   --overlay             add an overlay panel (original red, ours blue) to the sheets
//   --compare <run>       show deltas against an earlier run (a name under the runs folder, or a folder)
//   --report <run>        only rebuild that run's summary.md / summary.html from its results.json (with --compare)
//   --rescore <run>       recompute that run's metrics from its files (after changing the metrics), then the report
//   --jobs <n>            parallel metric workers (default 3)
//   --timeout <s>         conversion timeout per document (default 300)
//   --word-timeout <s>    per Word job, including the wait for Word's lock (default 900)
//   --python <exe>        Python with PyMuPDF, python-docx, numpy and Pillow (default: python)
//
// Output in <runs>/<name>/: results.json, summary.md, summary.html and docs/<id>/ (ours.docx, ours.pdf,
// convert.json, convert.log, metrics.json, sheets/p<N>.png). A failing document is recorded and the run goes on;
// the exit code is 1 when any conversion failed.
//
// Examples:
//   node scripts/pdf-to-docx-check.mjs --home <p2d> --name quick corpus                  (docx-level metrics only)
//   node scripts/pdf-to-docx-check.mjs --home <p2d> --name r1 --word --baseline corpus samples
//   node scripts/pdf-to-docx-check.mjs --home <p2d> --name r2 --word --no-compile --compare r1 --only "c0[1-3]" corpus
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const BUILD_DIR = path.join(ROOT, "node_modules/.cache/p2d-check");
const METRICS_PY = path.join(ROOT, "scripts/pdf-to-docx-metrics.py");

// ── Worker mode: convert one PDF in a child process (a crash or hang only loses that document) ──────────────────

const convertOne = async (jobPath) => {
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const started = Date.now();
    const result = { ok: false };
    let env = null;
    try {
        const mod = job.converter.endsWith(".mjs") ? await import(pathToFileURL(job.converter).href) : require(job.converter);
        const convert = mod.convertPdfToDocx ?? mod.default?.convertPdfToDocx;
        if (typeof convert !== "function") throw new Error(`${job.converter} does not export convertPdfToDocx`);
        env = await nodeEnvironment(job);
        const pdf = new Uint8Array(fs.readFileSync(job.pdf));
        const stages = {};
        const out = await convert(pdf, env.env, {
            mode: job.mode,
            ocr: job.ocr,
            ocrLanguages: job.ocrLanguages,
            onProgress: (p) => {
                stages[p.stage] ??= Date.now() - started;
            },
        });
        fs.writeFileSync(job.outDocx, out.docx);
        Object.assign(result, { ok: true, stats: out.stats, bytes: out.docx.length, stages, renders: env.renders });
    } catch (err) {
        result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        result.stack = err instanceof Error ? err.stack : undefined;
    } finally {
        await env?.close().catch(() => undefined);
    }
    result.ms = Date.now() - started;
    fs.writeFileSync(job.outJson, JSON.stringify(result, null, 1));
    process.exit(0);
};

/** ConvertEnvironment for Node: pdf.js (legacy build) + @napi-rs/canvas for renderPage, tesseract.js for OCR. */
const nodeEnvironment = async (job) => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = require("@napi-rs/canvas");
    const fontkit = require("@pdf-lib/fontkit");
    const dir = path.dirname(require.resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");
    const docs = new Map();
    const opened = [];
    const stats = { renders: 0 };
    const open = (bytes) => {
        let task = docs.get(bytes);
        if (!task) {
            // pdf.js takes ownership of the buffer it is given: always pass a copy.
            task = pdfjs.getDocument({
                data: bytes.slice(),
                verbosity: 0,
                isEvalSupported: false,
                standardFontDataUrl: `${dir}/standard_fonts/`,
                cMapUrl: `${dir}/cmaps/`,
                cMapPacked: true,
                wasmUrl: `${dir}/wasm/`,
                iccUrl: `${dir}/iccs/`,
            }).promise;
            docs.set(bytes, task);
            opened.push(task);
        }
        return task;
    };
    const renderPage = async (pdf, pageIndex, dpi) => {
        const doc = await open(pdf);
        const page = await doc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        page.cleanup();
        stats.renders++;
        const jpeg = job.render === "jpeg";
        const data = jpeg ? canvas.toBuffer("image/jpeg", 88) : canvas.toBuffer("image/png");
        return { data: new Uint8Array(data), mime: jpeg ? "image/jpeg" : "image/png", pixelWidth: canvas.width, pixelHeight: canvas.height };
    };
    let worker = null;
    let workerLangs = "";
    const ocr = async (image, languages) => {
        const { createWorker } = require("tesseract.js");
        const langs = (languages?.length ? languages : ["spa", "eng"]).join("+");
        if (!worker || workerLangs !== langs) {
            await worker?.terminate();
            const options = { logger: () => undefined, cachePath: path.join(ROOT, "node_modules/.cache/p2d-tessdata") };
            if (job.ocrLangPath) Object.assign(options, { langPath: job.ocrLangPath, gzip: false });
            worker = await createWorker(langs, 1, options);
            workerLangs = langs;
        }
        const { data } = await worker.recognize(Buffer.from(image.data), {}, { blocks: true });
        const words = [];
        let line = 0;
        let paragraph = 0;
        for (const block of data.blocks ?? [])
            for (const para of block.paragraphs ?? []) {
                paragraph++;
                for (const l of para.lines ?? []) {
                    line++;
                    for (const w of l.words ?? [])
                        words.push({
                            text: w.text,
                            box: { x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 },
                            confidence: w.confidence,
                            line,
                            paragraph,
                        });
                }
            }
        return words;
    };
    // ConvertEnvironment.loadFont from the app's font pack (public/fonts/pack), resolved like the browser does
    // (src/lib/pdf-to-docx/browser.ts with the engine's resolvePackFace): a face of the family itself, never an alias,
    // nearest to the family's own weight (bold: at least 700) and slant ("Inter SemiBold" → Inter's 600 face).
    const packDir = path.join(ROOT, "public/fonts/pack");
    let manifest;
    const faces = new Map();
    const STYLE_WORDS =
        /\s*(extralight|ultralight|extrabold|ultrabold|semibold|demibold|hairline|condensed|regular|oblique|italic|medium|narrow|normal|light|black|heavy|thin|book|bold|demi)$/;
    const weightOf = (s) => {
        const n = s.toLowerCase().replace(/[\s_-]/g, "");
        for (const [re, w] of [
            [/(thin|hairline)/, 100],
            [/(extralight|ultralight)/, 200],
            [/(semibold|demibold|demi)/, 600],
            [/(extrabold|ultrabold)/, 800],
            [/(black|heavy)/, 900],
            [/bold/, 700],
            [/medium/, 500],
            [/light/, 300],
        ])
            if (re.test(n)) return w;
        return 400;
    };
    const loadFont = async (family, bold, italic) => {
        try {
            manifest ??= JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
        } catch {
            manifest = { families: {} };
        }
        let name = String(family).toLowerCase().trim();
        for (let i = 0; i < 5 && !manifest.families?.[name.replace(/[^a-z0-9]/g, "")]; i++) {
            const next = name.replace(STYLE_WORDS, "").trim();
            if (next === name) break;
            name = next;
        }
        const fam = manifest.families?.[name.replace(/[^a-z0-9]/g, "")];
        if (!fam) return null;
        const own = weightOf(family);
        const weight = bold ? Math.max(own, 700) : own;
        const score = (key) => Math.abs(parseInt(key, 10) - weight) + (key.endsWith("i") === !!italic ? 0 : 1000);
        const key = Object.keys(fam.faces ?? {}).sort((a, b) => score(a) - score(b))[0];
        if (!key) return null;
        const file = path.join(packDir, fam.faces[key]);
        if (!faces.has(file)) faces.set(file, fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null);
        return faces.get(file);
    };
    return {
        env: { renderPage, ocr: job.ocr ? ocr : undefined, fontkit: (bytes) => fontkit.create(bytes), loadFont },
        get renders() {
            return stats.renders;
        },
        close: async () => {
            await worker?.terminate();
            for (const task of opened) (await task.catch(() => null))?.destroy();
        },
    };
};

if (process.argv[2] === "--convert-one") {
    await convertOne(process.argv[3]);
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
    const opts = { inputs: [], word: false, baseline: false, compile: true, sheets: 8, sheetDpi: 70, jobs: 3, timeout: 300, wordTimeout: 900 };
    Object.assign(opts, { python: "python", mode: "auto", render: "png" });
    const takes = {
        "--home": "home",
        "--name": "name",
        "--runs": "runs",
        "--converter": "converter",
        "--build": "build",
        "--word-export": "wordExport",
        "--baseline-dir": "baselineDir",
        "--ocr-lang-path": "ocrLangPath",
        "--mode": "mode",
        "--render": "render",
        "--only": "only",
        "--sheets": "sheets",
        "--sheet-dpi": "sheetDpi",
        "--compare": "compare",
        "--jobs": "jobs",
        "--timeout": "timeout",
        "--word-timeout": "wordTimeout",
        "--python": "python",
        "--report": "report",
        "--rescore": "rescore",
    };
    const flags = { "--word": "word", "--baseline": "baseline", "--ocr": "ocr", "--overlay": "overlay", "--refresh-baseline": "refreshBaseline" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            const head = fs.readFileSync(SCRIPT, "utf8").split("\n");
            console.log(
                head
                    .slice(
                        0,
                        head.findIndex((l) => l.startsWith("import ")),
                    )
                    .map((l) => l.replace(/^\/\/ ?/, ""))
                    .join("\n"),
            );
            process.exit(0);
        } else if (a === "--no-compile") opts.compile = false;
        else if (takes[a]) opts[takes[a]] = argv[++i];
        else if (flags[a]) opts[flags[a]] = true;
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else opts.inputs.push(a);
    }
    for (const k of ["sheets", "sheetDpi", "jobs", "timeout", "wordTimeout"]) opts[k] = Number(opts[k]);
    if (opts.baseline) opts.word = true;
    opts.home ??= process.env.P2D_HOME;
    const home = opts.home ? path.resolve(opts.home) : null;
    opts.runs = path.resolve(opts.runs ?? (home ? path.join(home, "runs") : path.join(ROOT, "node_modules/.cache/p2d-check-runs")));
    opts.baselineDir = path.resolve(opts.baselineDir ?? (home ? path.join(home, "corpus/word-baseline") : path.join(opts.runs, "_word-baseline")));
    const homeExport = home && path.join(home, "word-export.ps1");
    opts.wordExport = path.resolve(
        opts.wordExport ??
            (homeExport && fs.existsSync(homeExport) ? homeExport : (process.env.P2D_WORD_EXPORT ?? path.join(ROOT, "scripts/pdf-to-docx-word-export.ps1"))),
    );
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    opts.name ??= `run-${stamp}`;
    opts.homeDir = home;
    return opts;
};

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────────────────

const slug = (s) =>
    s
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "doc";

const collectDocuments = (opts) => {
    const docs = [];
    const addPdf = (pdf, extra = {}) => {
        const gt = pdf.replace(/\.pdf$/i, ".docx");
        docs.push({ id: slug(path.basename(pdf, path.extname(pdf))), pdf, gt: fs.existsSync(gt) ? gt : null, set: "files", features: [], ...extra });
    };
    const addManifest = (file) => {
        const dir = path.dirname(file);
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const d of manifest.documents ?? []) {
            const pdf = path.resolve(dir, d.pdf);
            docs.push({
                id: slug(d.id ?? path.basename(pdf, ".pdf")),
                pdf,
                gt: d.gt ? path.resolve(dir, d.gt) : null,
                set: d.set ?? "manifest",
                features: d.features ?? [],
            });
        }
    };
    for (const input of opts.inputs) {
        if ((input === "corpus" || input === "samples") && !fs.existsSync(input)) {
            if (!opts.homeDir) throw new Error(`"${input}" needs --home (or P2D_HOME)`);
            addManifest(path.join(opts.homeDir, "corpus", input === "corpus" ? "manifest.json" : "samples.json"));
            continue;
        }
        const abs = path.resolve(input);
        if (!fs.existsSync(abs)) throw new Error(`input not found: ${input}`);
        if (fs.statSync(abs).isDirectory()) {
            for (const f of fs.readdirSync(abs).sort()) if (f.toLowerCase().endsWith(".pdf")) addPdf(path.join(abs, f));
        } else if (abs.toLowerCase().endsWith(".json")) addManifest(abs);
        else addPdf(abs);
    }
    const seen = new Map();
    for (const d of docs) {
        const n = seen.get(d.id) ?? 0;
        seen.set(d.id, n + 1);
        if (n) d.id = `${d.id}-${n + 1}`;
        if (d.gt && !fs.existsSync(d.gt)) d.gt = null;
    }
    const only = opts.only ? new RegExp(opts.only) : null;
    return docs.filter((d) => (!only || only.test(d.id)) && fs.existsSync(d.pdf));
};

// ── Child processes ──────────────────────────────────────────────────────────────────────────────────────────────

/** Runs a command; resolves { code, stdout, stderr, ms, timedOut } (never rejects). */
const run = (cmd, args, { timeout = 0, cwd = ROOT, log = null } = {}) =>
    new Promise((resolve) => {
        const started = Date.now();
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let child;
        try {
            child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        } catch (err) {
            resolve({ code: -1, stdout, stderr: String(err), ms: 0, timedOut });
            return;
        }
        const timer = timeout
            ? setTimeout(() => {
                  timedOut = true;
                  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
                  else child.kill("SIGKILL");
              }, timeout)
            : null;
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.on("error", (err) => (stderr += String(err)));
        child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            if (log) fs.writeFileSync(log, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`);
            resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut });
        });
    });

/** A FIFO limiter: at most `n` tasks at a time. */
const limiter = (n) => {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n || !queue.length) return;
        active++;
        const { task, resolve, reject } = queue.shift();
        task()
            .then(resolve, reject)
            .finally(() => {
                active--;
                next();
            });
    };
    return (task) =>
        new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            next();
        });
};

// ── Build ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * tsc into a fresh node_modules/.cache/p2d-check/build-<time>-<pid> (so runs started at the same time never delete
 * each other's build), recorded in p2d-check/latest for --no-compile; only the newest builds are kept.
 */
const compileConverter = () => {
    const dir = path.join(BUILD_DIR, `build-${Date.now().toString(36)}-${process.pid}`);
    const args = ["tsc", "src/lib/pdf-to-docx/index.ts", "--outDir", dir, "--module", "commonjs", "--target", "es2020", "--esModuleInterop"];
    args.push("--skipLibCheck", "--strict", "--downlevelIteration", "--moduleResolution", "node");
    const r = spawnSync("npx", args, { cwd: ROOT, shell: true, encoding: "utf8" });
    const entry = path.join(dir, "pdf-to-docx/index.js");
    const diagnostics = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (!fs.existsSync(entry)) throw new Error(`tsc produced no ${entry}\n${diagnostics}`);
    fs.writeFileSync(path.join(BUILD_DIR, "latest"), path.basename(dir));
    const builds = fs
        .readdirSync(BUILD_DIR)
        .filter((f) => f.startsWith("build-"))
        .map((f) => ({ f, t: fs.statSync(path.join(BUILD_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    for (const { f } of builds.slice(6)) fs.rmSync(path.join(BUILD_DIR, f), { recursive: true, force: true });
    return { entry, diagnostics };
};

const latestBuild = () => {
    const latest = path.join(BUILD_DIR, "latest");
    return fs.existsSync(latest)
        ? path.join(BUILD_DIR, fs.readFileSync(latest, "utf8").trim(), "pdf-to-docx/index.js")
        : path.join(BUILD_DIR, "pdf-to-docx/index.js");
};

// ── Word ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const wordQueue = limiter(1);
const WORD_JOB = path.join(ROOT, "scripts/pdf-to-docx-word-job.ps1");

/**
 * One Word job (DOCX → PDF, or Word's own PDF → DOCX) through the gateway, wrapped by pdf-to-docx-word-job.ps1, which
 * answers Word's PDF-conversion notice and ends the Word processes the job leaves behind. Word remembers files whose
 * last opening failed and asks before opening them again, so it always gets a fresh copy of the input.
 */
const wordExport = (opts, input, output, tmpDir) =>
    wordQueue(async () => {
        fs.rmSync(output, { force: true });
        fs.mkdirSync(tmpDir, { recursive: true });
        const ext = path.extname(input);
        const fresh = path.join(tmpDir, `${slug(path.basename(input, ext))}-${Date.now().toString(36)}${ext}`);
        fs.copyFileSync(input, fresh);
        const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WORD_JOB, "-Gateway", opts.wordExport, "-In", fresh, "-Out", output];
        args.push("-TimeoutSec", String(opts.wordTimeout));
        const r = await run("powershell", args, { timeout: (opts.wordTimeout + 120) * 1000 });
        fs.rmSync(fresh, { force: true });
        const text = `${r.stdout}\n${r.stderr}`;
        const notes = text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^(notice|cleanup|dialog|timeout|gateway error):/.test(l));
        const pages = Number(/ok pages=(\d+)/.exec(text)?.[1] ?? NaN);
        if (r.code !== 0 || !fs.existsSync(output)) {
            const why = r.timedOut || r.code === 124 ? "timed out" : `exit ${r.code}`;
            const detail = notes.filter((l) => !l.startsWith("cleanup")).join(" ") || text.trim().split("\n").slice(-3).join(" ");
            // Only a failure Word itself reported is worth remembering (not a timeout, a busy lock or a killed job).
            const deterministic = /gateway error:/.test(text) && !/busy|lock|timed out/i.test(text) && !r.timedOut;
            return { ok: false, ms: r.ms, error: `Word ${why}: ${detail.slice(0, 600)}`, notes, deterministic };
        }
        return { ok: true, ms: r.ms, pages: Number.isFinite(pages) ? pages : null, notes };
    });

const sha = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);

/** Word's own PDF → DOCX conversion of the original, and that .docx rendered back to PDF (cached by content hash). */
/** Word's own conversion when it is already in the cache (no Word job): used by --word without --baseline. */
const cachedBaseline = (opts, doc) => {
    const base = path.join(opts.baselineDir, `${doc.id}-${sha(doc.pdf)}`);
    const docx = `${base}.word.docx`;
    const pdf = `${base}.word.pdf`;
    return fs.existsSync(docx) && fs.existsSync(pdf) ? { ok: true, docx, pdf, ms: 0, cached: true } : undefined;
};

const wordBaseline = async (opts, doc) => {
    fs.mkdirSync(opts.baselineDir, { recursive: true });
    const base = path.join(opts.baselineDir, `${doc.id}-${sha(doc.pdf)}`);
    const docx = `${base}.word.docx`;
    const pdf = `${base}.word.pdf`;
    const fail = `${base}.fail.txt`;
    if (opts.refreshBaseline) for (const f of [docx, pdf, fail]) fs.rmSync(f, { force: true });
    if (fs.existsSync(fail)) return { ok: false, cached: true, error: fs.readFileSync(fail, "utf8") };
    const steps = [];
    const notes = [];
    for (const [input, output] of [
        [doc.pdf, docx],
        [docx, pdf],
    ]) {
        if (fs.existsSync(output)) continue;
        const r = await wordExport(opts, input, output, path.join(opts.baselineDir, "_in"));
        steps.push(r.ms);
        notes.push(...(r.notes ?? []));
        if (!r.ok) {
            if (r.deterministic) fs.writeFileSync(fail, r.error);
            return { ok: false, error: r.error, notes };
        }
    }
    return { ok: true, docx, pdf, ms: steps.reduce((a, b) => a + b, 0), cached: !steps.length, notes };
};

// ── One document ─────────────────────────────────────────────────────────────────────────────────────────────────

const convertQueue = limiter(1);

const processDocument = async (opts, ctx, doc) => {
    const dir = path.join(ctx.runDir, "docs", doc.id);
    fs.mkdirSync(dir, { recursive: true });
    const record = { id: doc.id, set: doc.set, features: doc.features, pdf: doc.pdf, gt: doc.gt };
    const oursDocx = path.join(dir, "ours.docx");
    const oursPdf = path.join(dir, "ours.pdf");

    // 1. Convert (child process, one at a time: conversions are CPU-bound).
    record.convert = await convertQueue(async () => {
        const job = {
            pdf: doc.pdf,
            outDocx: oursDocx,
            outJson: path.join(dir, "convert.json"),
            converter: ctx.converter,
            mode: opts.mode,
            ocr: !!opts.ocr,
            ocrLangPath: opts.ocrLangPath,
            render: opts.render,
        };
        const jobPath = path.join(dir, "convert-job.json");
        fs.writeFileSync(jobPath, JSON.stringify(job, null, 1));
        fs.rmSync(job.outJson, { force: true });
        fs.rmSync(oursDocx, { force: true });
        const r = await run(process.execPath, [SCRIPT, "--convert-one", jobPath], { timeout: opts.timeout * 1000, log: path.join(dir, "convert.log") });
        if (fs.existsSync(job.outJson)) return JSON.parse(fs.readFileSync(job.outJson, "utf8"));
        return {
            ok: false,
            ms: r.ms,
            error: r.timedOut ? `timed out after ${opts.timeout} s` : `worker exit ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`,
        };
    });
    ctx.progress(doc, "converted", record.convert.ok ? `${(record.convert.ms / 1000).toFixed(1)} s` : `FAILED ${record.convert.error}`);

    // 2. Word: our .docx rendered to PDF, and Word's own conversion of the original.
    if (opts.word && record.convert.ok) record.export = await wordExport(opts, oursDocx, oursPdf, path.join(ctx.runDir, "_word-in"));
    if (opts.baseline) record.baseline = await wordBaseline(opts, doc);
    else if (opts.word) record.baseline = cachedBaseline(opts, doc);

    // 3. Metrics.
    const candidates = {};
    if (record.convert.ok) candidates.ours = { docx: oursDocx, pdf: record.export?.ok ? oursPdf : null };
    if (record.baseline?.ok) candidates.word = { docx: record.baseline.docx, pdf: record.baseline.pdf };
    const job = {
        id: doc.id,
        orig: doc.pdf,
        gt: doc.gt,
        candidates,
        outDir: dir,
        visualDpi: 60,
        sheets: opts.word && opts.sheets > 0 ? { dpi: opts.sheetDpi, maxPages: opts.sheets, overlay: !!opts.overlay } : null,
    };
    const jobPath = path.join(dir, "metrics-job.json");
    fs.writeFileSync(jobPath, JSON.stringify(job, null, 1));
    const m = await ctx.metricsQueue(() => run(opts.python, [METRICS_PY, jobPath], { timeout: 15 * 60 * 1000, log: path.join(dir, "metrics.log") }));
    const metricsFile = path.join(dir, "metrics.json");
    if (m.code === 0 && fs.existsSync(metricsFile)) record.metrics = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    else
        record.metrics = {
            error: `metrics failed (${m.timedOut ? "timeout" : `exit ${m.code}`}): ${m.stderr.trim().split("\n").slice(-4).join(" ").slice(0, 500)}`,
        };
    ctx.progress(doc, "done", summaryLine(record));
    return record;
};

// ── Report ───────────────────────────────────────────────────────────────────────────────────────────────────────

const get = (obj, keys) => keys.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const METRICS = [
    { key: "text.sim", label: "Text", help: "1 − normalised edit distance to the original's text (whitespace-normalised)" },
    { key: "text.words", label: "Words", help: "order-insensitive word completeness (F1 of the word multisets)" },
    { key: "order.score", label: "Order", help: "share of unique n-gram anchors in the original's reading order" },
    {
        key: "styleRendered.all",
        label: "Style",
        help: "words whose family, size, bold, italic and colour match the original PDF, as Word renders our .docx (fonts missing on this machine count as wrong family)",
    },
    {
        key: "styleDocx.all",
        label: "Style docx",
        help: "same, but what our .docx asks for (python-docx, resolved styles) against the original PDF: independent of installed fonts",
    },
    { key: "style.all", label: "Style GT", help: "our .docx against the ground-truth .docx (python-docx, resolved styles)" },
    { key: "paragraphs.breakF1", label: "¶ F1", help: "paragraph breaks vs ground truth (line breaks count as breaks)" },
    { key: "paragraphs.alignment", label: "Align", help: "ground-truth paragraphs whose alignment matches" },
    { key: "paragraphs.heading", label: "Head", help: "ground-truth paragraphs whose heading level (none, 1, 2, 3…) matches" },
    { key: "paragraphs.list", label: "List", help: "ground-truth or our list items with the same list kind (bullet/number) and level" },
    { key: "tables.cellsPos", label: "Cells", help: "ground-truth table cells with the same text at the same row/column" },
    {
        key: "visual.inkF1",
        label: "Ink F1",
        help: "rendered pages, after the best global shift (≤ 18 pt, see shiftPt): ink found within ~2.4 pt in both directions (60 dpi); inkF1Raw in metrics.json is without the shift",
    },
    { key: "visual.diff", label: "Diff", help: "rendered pages, after the same shift: mean absolute grey difference (lower is better)", lower: true },
    {
        key: "score",
        label: "Score",
        help: "mean of the metrics available for the document among Text, Order, Style docx, Style GT, Ink F1, ¶ F1 and Cells",
    },
];

const fmt = (v, digits = 3) => (v == null || Number.isNaN(v) ? "–" : typeof v === "number" ? v.toFixed(digits) : String(v));

const summaryLine = (r) => {
    const o = r.metrics?.ours;
    const w = r.metrics?.word;
    const bits = [];
    if (!r.convert?.ok) bits.push("conversion failed");
    if (r.export && !r.export.ok) bits.push(`word export failed`);
    if (o) bits.push(`score ${fmt(o.score)}`, `text ${fmt(o.text?.sim)}`, `order ${fmt(o.order?.score)}`);
    if (o?.visual?.inkF1 != null) bits.push(`ink ${fmt(o.visual.inkF1)}`);
    if (w) bits.push(`(Word ${fmt(w.score)})`);
    if (r.metrics?.error) bits.push(r.metrics.error.slice(0, 120));
    return bits.join("  ");
};

const mean = (values) => {
    const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const aggregate = (records) => {
    const out = {};
    for (const cand of ["ours", "word"]) {
        const rows = records.map((r) => r.metrics?.[cand]).filter(Boolean);
        out[cand] = { documents: rows.length };
        for (const m of METRICS) out[cand][m.key] = mean(rows.map((row) => get(row, m.key)));
    }
    out.failedConversions = records.filter((r) => !r.convert?.ok).map((r) => r.id);
    out.failedExports = records.filter((r) => r.export && !r.export.ok).map((r) => r.id);
    return out;
};

const loadCompare = (opts) => {
    if (!opts.compare) return null;
    const dir = fs.existsSync(path.join(opts.compare, "results.json")) ? opts.compare : path.join(opts.runs, opts.compare);
    const file = path.join(dir, "results.json");
    if (!fs.existsSync(file)) {
        console.warn(`--compare: ${file} not found`);
        return null;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { name: data.run?.name ?? path.basename(dir), docs: new Map(data.documents.map((d) => [d.id, d])), aggregate: data.aggregate };
};

/** Change of a metric's mean against the compared run, over the documents that have it in both runs. */
const avgDelta = (records, compare, cand, m) => {
    if (!compare) return "";
    const now = [];
    const before = [];
    for (const r of records) {
        const a = get(r.metrics?.[cand], m.key);
        const b = get(compare.docs.get(r.id)?.metrics?.[cand], m.key);
        if (typeof a === "number" && typeof b === "number") {
            now.push(a);
            before.push(b);
        }
    }
    return delta(mean(now), mean(before), m.lower);
};

const delta = (now, before, lower) => {
    if (now == null || before == null) return "";
    const d = now - before;
    if (Math.abs(d) < 0.0005) return "";
    const better = lower ? d < 0 : d > 0;
    return `${better ? "▲" : "▼"}${d > 0 ? "+" : ""}${d.toFixed(3)}`;
};

const pagesCell = (r) => {
    const m = r.metrics ?? {};
    return [m.orig?.pages, m.ours?.pages ?? r.export?.pages, m.word?.pages].map((v) => (v == null ? "–" : v)).join("/");
};

const imagesCell = (r) => {
    const m = r.metrics ?? {};
    const ref = m.gt ? m.gt.images : m.orig?.images;
    return `${ref ?? "–"}/${m.ours?.structure?.images ?? "–"}${m.word?.structure ? `/${m.word.structure.images}` : ""}`;
};

const markdown = (opts, ctx, records, agg, compare) => {
    const lines = [];
    lines.push(`# PDF → Word check: ${opts.name}`, "");
    lines.push(
        `- Date: ${new Date().toISOString()}  ·  converter: \`${ctx.converterLabel}\`  ·  mode: ${opts.mode}${opts.word ? "  ·  rendered by Word" : "  ·  docx-level only (no --word)"}`,
    );
    if (compare) lines.push(`- Deltas (▲ better / ▼ worse) against run \`${compare.name}\` (averages: over the documents scored in both runs)`);
    lines.push(
        `- Documents: ${records.length}  ·  failed conversions: ${agg.failedConversions.length}  ·  failed Word exports: ${agg.failedExports.length}`,
        "",
    );
    lines.push("## Averages", "", `| | ${METRICS.map((m) => m.label).join(" | ")} |`, `|---|${METRICS.map(() => "---:").join("|")}|`);
    for (const cand of ["ours", "word"]) {
        if (!agg[cand].documents) continue;
        lines.push(
            `| ${cand === "ours" ? "**LocalPDF**" : "Word (own conversion)"} (${agg[cand].documents}) | ${METRICS.map((m) => `${fmt(agg[cand][m.key])} ${avgDelta(records, compare, cand, m)}`.trim()).join(" | ")} |`,
        );
    }
    lines.push("", "## Documents", "", `| Document | Pages o/ours/word | ${METRICS.map((m) => m.label).join(" | ")} | Word score | Images ref/ours |`);
    lines.push(`|---|---|${METRICS.map(() => "---:").join("|")}|---:|---|`);
    for (const r of records) {
        const o = r.metrics?.ours;
        const before = compare?.docs.get(r.id)?.metrics?.ours;
        const cells = METRICS.map((m) => (o ? `${fmt(get(o, m.key))}${before ? ` ${delta(get(o, m.key), get(before, m.key), m.lower)}` : ""}` : "–"));
        const name = r.convert?.ok ? r.id : `${r.id} ⚠`;
        lines.push(`| ${name} | ${pagesCell(r)} | ${cells.join(" | ")} | ${fmt(r.metrics?.word?.score)} | ${imagesCell(r)} |`);
    }
    lines.push("", "## Structure (ours; ground truth or Word in brackets)", "");
    lines.push("| Document | Paragraphs | Tables | Text boxes | Frames | Flow ratio | Headings | List items | Links | Line breaks | Sections/cols |");
    lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const r of records) {
        const s = r.metrics?.ours?.structure;
        const ref = r.metrics?.gt ?? r.metrics?.word?.structure;
        if (!s) continue;
        const b = (k) => (ref ? ` (${Array.isArray(ref[k]) ? ref[k].join(" ") || "0" : (ref[k] ?? "–")})` : "");
        lines.push(
            `| ${r.id} | ${s.paragraphs}${b("paragraphs")} | ${s.tableDims.join(" ") || "0"}${b("tableDims")} | ${s.textboxes}${b("textboxes")} | ${s.frames} | ${fmt(s.flowRatio, 2)} | ${s.headings}${b("headings")} | ${s.listItems}${b("listItems")} | ${s.hyperlinks}${b("hyperlinks")} | ${s.lineBreaks} | ${s.sections}/${s.maxColumns} |`,
        );
    }
    // Per attribute: family, size, bold, italic, colour (f/s/b/i/c), for each comparison.
    const attrs = ["family", "size", "bold", "italic", "color"];
    const groups = [
        ["styleRendered", "rendered vs PDF", attrs],
        ["styleDocx", ".docx vs PDF", attrs],
        ["style", ".docx vs GT", [...attrs, "underline", "script"]],
    ];
    const styleRows = records.filter((r) => groups.some(([k]) => r.metrics?.ours?.[k]));
    if (styleRows.length) {
        lines.push("", "## Style agreement by attribute (ours; f s b i c = family, size, bold, italic, colour; u = underline, x = super/subscript)", "");
        const heads = groups.flatMap(([, label, keys]) => keys.map((k, n) => `${n ? "" : `${label}: `}${k === "script" ? "x" : k[0]}`));
        lines.push(`| Document | ${heads.join(" | ")} | coverage |`, `|---|${heads.map(() => "---:").join("|")}|---:|`);
        for (const r of styleRows) {
            const o = r.metrics.ours;
            const cells = groups.flatMap(([key, , keys]) => keys.map((k) => fmt(o[key]?.[k], 2)));
            lines.push(`| ${r.id} | ${cells.join(" | ")} | ${fmt(o.styleDocx?.coverage ?? o.styleRendered?.coverage, 2)} |`);
        }
    }
    const notes = [];
    for (const r of records) {
        const items = [];
        if (!r.convert?.ok) items.push(`conversion failed: ${r.convert?.error}`);
        if (r.export && !r.export.ok) items.push(`Word export failed: ${r.export.error}`);
        if (r.baseline && !r.baseline.ok) items.push(`Word's own conversion unavailable: ${r.baseline.error}`);
        if (r.metrics?.error) items.push(r.metrics.error);
        if (r.metrics?.ours?.error) items.push(`metrics: ${r.metrics.ours.error}`);
        for (const w of r.convert?.stats?.warnings ?? []) items.push(`converter: ${w}`);
        const o = r.metrics?.ours;
        if (o?.pages != null && r.metrics?.orig?.pages != null && o.pages !== r.metrics.orig.pages)
            items.push(`Word lays our .docx out on ${o.pages} page(s), the original has ${r.metrics.orig.pages}`);
        if (o?.structure?.rulePictures)
            items.push(`${o.structure.rulePictures} line(s) drawn as thin pictures (underlines, rules or borders that will not follow the text)`);
        const mm = o?.styleDocx?.topMismatches ?? o?.styleRendered?.topMismatches ?? [];
        if (mm.length) items.push(`style mismatches (.docx vs PDF): ${mm.slice(0, 4).join("; ")}`);
        if (items.length) notes.push(`- **${r.id}**: ${items.join(" · ")}`);
    }
    const wordNotes = records.flatMap((r) => [...(r.export?.notes ?? []), ...(r.baseline?.notes ?? [])]);
    const skipped = wordNotes.filter((n) => n.startsWith("cleanup: skipped")).length;
    if (skipped)
        notes.push(
            `- **Word**: ${skipped} job(s) overlapped with other Word users, so their Word processes were not ended (the gateway leaves one running per job).`,
        );
    if (notes.length) lines.push("", "## Notes", "", ...notes);
    lines.push("", "## Metric definitions", "", ...METRICS.map((m) => `- **${m.label}**: ${m.help}`));
    lines.push("- **Pages o/ours/word**: original PDF / our .docx rendered by Word / Word's own conversion rendered by Word");
    lines.push("- **Images ref/ours**: ground-truth .docx pictures (or images drawn in the PDF) / pictures in our .docx (page backgrounds excluded)");
    lines.push("- **Flow ratio**: share of the .docx text in flowing paragraphs and tables (not in text boxes or framed, positioned paragraphs)");
    lines.push("- **Tables**: rows x columns; `*` marks an invisible layout table (no borders, no shading), which Cells does not score");
    return lines.join("\n") + "\n";
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const cellColor = (v, lower) => {
    if (typeof v !== "number") return "";
    const good = lower ? 1 - Math.min(1, v * 8) : v;
    const hue = Math.round(Math.max(0, Math.min(1, (good - 0.5) / 0.5)) * 120);
    return ` style="background:hsl(${hue} 70% 88%)"`;
};

const html = (opts, ctx, records, agg, compare, md) => {
    const head = METRICS.map((m) => `<th title="${esc(m.help)}">${esc(m.label)}</th>`).join("");
    const avg = ["ours", "word"]
        .filter((c) => agg[c].documents)
        .map(
            (c) =>
                `<tr><th>${c === "ours" ? "LocalPDF" : "Word (own conversion)"} (${agg[c].documents})</th>${METRICS.map((m) => `<td${cellColor(agg[c][m.key], m.lower)}>${fmt(agg[c][m.key])} <small>${esc(avgDelta(records, compare, c, m))}</small></td>`).join("")}</tr>`,
        )
        .join("");
    const rows = records
        .map((r) => {
            const o = r.metrics?.ours;
            const before = compare?.docs.get(r.id)?.metrics?.ours;
            const cells = METRICS.map((m) => {
                const v = o ? get(o, m.key) : undefined;
                return `<td${cellColor(v, m.lower)}>${fmt(v)} <small>${esc(before ? delta(v, get(before, m.key), m.lower) : "")}</small></td>`;
            }).join("");
            return `<tr><th><a href="#${esc(r.id)}">${esc(r.id)}</a>${r.convert?.ok ? "" : " ⚠"}</th><td>${pagesCell(r)}</td>${cells}<td>${fmt(r.metrics?.word?.score)}</td><td>${imagesCell(r)}</td></tr>`;
        })
        .join("\n");
    const details = records
        .map((r) => {
            const dir = `docs/${r.id}`;
            const sheets = (r.metrics?.sheets ?? []).map((s) => `<a href="${dir}/${s}"><img loading="lazy" src="${dir}/${s}" alt="${esc(s)}"></a>`).join("");
            const files = [
                ["ours.docx", r.convert?.ok],
                ["ours.pdf", r.export?.ok],
                ["convert.log", true],
                ["metrics.json", !!r.metrics],
            ]
                .filter(([, ok]) => ok)
                .map(([f]) => `<a href="${dir}/${f}">${f}</a>`)
                .join(" · ");
            const info = {
                features: r.features,
                convert: r.convert && { ok: r.convert.ok, ms: r.convert.ms, stats: r.convert.stats, error: r.convert.error },
                orig: r.metrics?.orig,
                ours: r.metrics?.ours && { ...r.metrics.ours, visual: r.metrics.ours.visual && { ...r.metrics.ours.visual, pages: undefined } },
                word: r.metrics?.word && {
                    score: r.metrics.word.score,
                    text: r.metrics.word.text,
                    order: r.metrics.word.order,
                    structure: r.metrics.word.structure,
                },
            };
            return `<section id="${esc(r.id)}"><h3>${esc(r.id)} <small>${esc(r.set)} · ${esc((r.features ?? []).join(", "))}</small></h3><p>${files}</p><div class="sheets">${sheets || "<em>no sheets (run with --word)</em>"}</div><details><summary>metrics</summary><pre>${esc(JSON.stringify(info, null, 1))}</pre></details></section>`;
        })
        .join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PDF → Word check ${esc(opts.name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#1b1f24;background:#fff}
table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #d0d4da;padding:4px 8px;text-align:right;white-space:nowrap}
th:first-child{text-align:left}thead th{background:#f1f3f5;position:sticky;top:0}small{color:#5a6270}
.sheets img{max-width:100%;border:1px solid #ccc;margin:6px 0;display:block}section{border-top:2px solid #e3e6ea;margin-top:28px}
pre{background:#f6f8fa;padding:8px;overflow:auto;max-height:420px}details pre{white-space:pre-wrap}
</style></head><body>
<h1>PDF → Word check: ${esc(opts.name)}</h1>
<p>Converter <code>${esc(ctx.converterLabel)}</code> · mode ${esc(opts.mode)} · ${opts.word ? "rendered by Word" : "docx-level metrics only"}${compare ? ` · deltas vs <code>${esc(compare.name)}</code>` : ""} · ${records.length} documents · failed conversions: ${agg.failedConversions.length} · failed exports: ${agg.failedExports.length}</p>
<h2>Averages</h2><table><thead><tr><th></th>${head}</tr></thead><tbody>${avg}</tbody></table>
<h2>Documents</h2><table><thead><tr><th>Document</th><th>Pages o/ours/word</th>${head}<th>Word score</th><th>Images ref/ours</th></tr></thead><tbody>${rows}</tbody></table>
<details><summary>Markdown summary</summary><pre>${esc(md)}</pre></details>
<h2>Sheets</h2><p>Each sheet: original PDF | our .docx rendered by Word | Word's own conversion rendered by Word.</p>
${details}
</body></html>
`;
};

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** --report <run>: rebuilds summary.md / summary.html from a run's results.json (e.g. to add --compare later). */
const rebuildReport = async (opts) => {
    const which = opts.rescore ?? opts.report;
    const runDir = fs.existsSync(path.join(which, "results.json")) ? path.resolve(which) : path.join(opts.runs, which);
    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    const ropts = { ...(results.run.options ?? {}), name: results.run.name, compare: opts.compare, runs: opts.runs };
    const ctx = { converterLabel: results.run.converter };
    const records = results.documents;
    if (opts.rescore) {
        // --rescore: the metrics again on the run's files (after a change to pdf-to-docx-metrics.py), no conversion or Word.
        const queue = limiter(Math.max(1, opts.jobs));
        let done = 0;
        await Promise.all(
            records.map((r) =>
                queue(async () => {
                    const dir = path.join(runDir, "docs", r.id);
                    const job = path.join(dir, "metrics-job.json");
                    if (!fs.existsSync(job)) return;
                    const m = await run(opts.python, [METRICS_PY, job], { timeout: 15 * 60 * 1000, log: path.join(dir, "metrics.log") });
                    const file = path.join(dir, "metrics.json");
                    r.metrics =
                        m.code === 0 && fs.existsSync(file)
                            ? JSON.parse(fs.readFileSync(file, "utf8"))
                            : { error: `metrics failed (exit ${m.code}): ${m.stderr.trim().split("\n").slice(-4).join(" ").slice(0, 500)}` };
                    console.log(`[${++done}/${records.length}] ${r.id.padEnd(28)} ${summaryLine(r)}`);
                }),
            ),
        );
    }
    const agg = aggregate(records);
    const compare = loadCompare(ropts);
    const md = markdown(ropts, ctx, records, agg, compare);
    results.aggregate = agg;
    fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(runDir, "summary.md"), md);
    fs.writeFileSync(path.join(runDir, "summary.html"), html(ropts, ctx, records, agg, compare, md));
    console.log(md);
    console.log(`Results: ${path.join(runDir, "summary.html")}`);
};

const main = async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.report || opts.rescore) return rebuildReport(opts);
    const docs = collectDocuments(opts);
    if (!docs.length) throw new Error("no input documents (see --help)");
    if (opts.word && !fs.existsSync(opts.wordExport)) throw new Error(`Word gateway not found: ${opts.wordExport} (use --word-export)`);
    const runDir = path.join(opts.runs, opts.name);
    fs.rmSync(path.join(runDir, "docs"), { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });

    let converter;
    let converterLabel;
    let diagnostics = "";
    if (opts.converter) {
        converter = path.resolve(opts.converter);
        converterLabel = converter;
    } else if (opts.build) {
        converter = path.join(path.resolve(opts.build), "pdf-to-docx/index.js");
        converterLabel = `build ${opts.build}`;
    } else if (opts.compile) {
        process.stdout.write("Compiling src/lib/pdf-to-docx … ");
        const t = Date.now();
        const built = compileConverter();
        converter = built.entry;
        diagnostics = built.diagnostics;
        converterLabel = "src/lib/pdf-to-docx";
        console.log(
            `${((Date.now() - t) / 1000).toFixed(1)} s${diagnostics ? ` (tsc reported ${diagnostics.split("\n").filter((l) => /error TS/.test(l)).length} type errors, see results.json)` : ""}`,
        );
    } else {
        converter = latestBuild();
        converterLabel = "src/lib/pdf-to-docx (previous build)";
    }
    if (!fs.existsSync(converter)) throw new Error(`converter not found: ${converter}`);

    const started = Date.now();
    let done = 0;
    const ctx = {
        runDir,
        converter,
        converterLabel,
        metricsQueue: limiter(Math.max(1, opts.jobs)),
        progress: (doc, stage, text) => {
            if (stage === "done") done++;
            const tag = stage === "done" ? `[${done}/${docs.length}]` : "       ";
            console.log(`${tag} ${doc.id.padEnd(28)} ${stage.padEnd(9)} ${text}`);
        },
    };
    console.log(`${docs.length} documents → ${runDir}${opts.word ? `  (Word: ${opts.wordExport})` : ""}`);
    const records = await Promise.all(
        docs.map((doc) =>
            processDocument(opts, ctx, doc).catch((err) => ({
                id: doc.id,
                set: doc.set,
                features: doc.features,
                pdf: doc.pdf,
                gt: doc.gt,
                convert: { ok: false, error: `harness: ${err.stack ?? err}` },
            })),
        ),
    );
    const agg = aggregate(records);
    const compare = loadCompare(opts);
    const md = markdown(opts, ctx, records, agg, compare);
    const results = {
        run: {
            name: opts.name,
            date: new Date().toISOString(),
            seconds: Math.round((Date.now() - started) / 1000),
            converter: converterLabel,
            options: { ...opts, inputs: opts.inputs },
            tsc: diagnostics || undefined,
            host: `${os.hostname()} node ${process.version}`,
        },
        aggregate: agg,
        documents: records,
    };
    fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(runDir, "summary.md"), md);
    fs.writeFileSync(path.join(runDir, "summary.html"), html(opts, ctx, records, agg, compare, md));
    console.log(`\n${md}`);
    console.log(`Results: ${path.join(runDir, "summary.html")}  (${results.run.seconds} s)`);
    process.exitCode = agg.failedConversions.length ? 1 : 0;
};

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
});
