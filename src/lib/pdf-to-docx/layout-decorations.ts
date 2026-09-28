// Underline and strikethrough. PDFs draw them as thin rules or filled bars under / through the text (Word, browsers,
// LibreOffice); here they become run formatting again, split at the exact characters they cover, and the graphics
// they came from are marked so that nothing draws them a second time.
import { runCharX } from "./text-lines";
import type { FilledRect, PageContent, RuleSegment, TextRun, TextStyle } from "./types";

/** Rules and fills that became underline / strikethrough (the layout doesn't draw them as shapes). */
export const decorationGraphics = new WeakSet<object>();

type Mark = { x0: number; x1: number; y: number; thickness: number; src: RuleSegment | FilledRect };

const marksOf = (content: PageContent): Mark[] => {
    const out: Mark[] = [];
    for (const r of content.graphics.rules) {
        if (Math.abs(r.y1 - r.y2) > 0.3 || r.width > 3) continue;
        out.push({ x0: Math.min(r.x1, r.x2), x1: Math.max(r.x1, r.x2), y: (r.y1 + r.y2) / 2, thickness: r.width, src: r });
    }
    for (const f of content.graphics.fills) {
        if (f.height > 2.5 || f.width < 2 || f.opacity < 0.5) continue;
        out.push({ x0: f.x, x1: f.x + f.width, y: f.y + f.height / 2, thickness: f.height, src: f });
    }
    return out;
};

/**
 * Finds underlines and strikethroughs of the page's horizontal lines and sets them on the runs (splitting runs where a
 * mark starts or ends inside them). Mutates `content.lines`; call once per page, before tables and paragraphs.
 */
export const applyDecorations = (content: PageContent) => {
    const marks = marksOf(content);
    if (!marks.length) return;
    marks.sort((a, b) => a.y - b.y);
    for (const line of content.lines) {
        if (line.rotation || line.invisible) continue;
        const size = line.fontSize || 10;
        const x0 = line.box.x;
        const x1 = line.box.x + line.box.width;
        const maxThick = Math.max(1.6, 0.14 * size);
        // Marks that lie within the line's text (a separator running past the text is not an underline).
        const near = marks.filter(
            (m) => m.thickness <= maxThick && m.y >= line.baseline - 0.5 * size && m.y <= line.baseline + 0.32 * size && m.x0 >= x0 - 1.5 && m.x1 <= x1 + 1.5,
        );
        if (!near.length) continue;
        const runs: TextRun[] = [];
        let changed = false;
        for (const run of line.runs) {
            const xs = runCharX.get(run);
            const under = near.filter((m) => m.y >= run.baseline + 0.02 * size && m.y <= run.baseline + 0.32 * size);
            const strike = near.filter((m) => m.y >= run.baseline - 0.5 * size && m.y <= run.baseline - 0.12 * size);
            if (!xs || (!under.length && !strike.length) || xs.length !== run.text.length + 1) {
                runs.push(run);
                continue;
            }
            const n = run.text.length;
            const covered = (list: Mark[], i: number) => {
                const c = (xs[i] + xs[i + 1]) / 2;
                const hit = list.find((m) => c >= m.x0 - 0.5 && c <= m.x1 + 0.5);
                if (hit) decorationGraphics.add(hit.src);
                return !!hit;
            };
            const flags = Array.from({ length: n }, (_, i) => [covered(under, i), covered(strike, i)] as const);
            // A mark that only grazes the run's spaces decorates nothing.
            if (!flags.some(([u, s], i) => (u || s) && run.text[i].trim())) {
                runs.push(run);
                continue;
            }
            changed = true;
            let start = 0;
            for (let i = 1; i <= n; i++) {
                if (i < n && flags[i][0] === flags[start][0] && flags[i][1] === flags[start][1]) continue;
                const style: TextStyle = { ...run.style };
                if (flags[start][0]) style.underline = true;
                if (flags[start][1]) style.strike = true;
                const piece: TextRun = {
                    text: run.text.slice(start, i),
                    style,
                    box: { x: xs[start], y: run.box.y, width: xs[i] - xs[start], height: run.box.height },
                    baseline: run.baseline,
                };
                runCharX.set(piece, xs.slice(start, i + 1));
                runs.push(piece);
                start = i;
            }
        }
        if (changed) line.runs = runs;
    }
};
