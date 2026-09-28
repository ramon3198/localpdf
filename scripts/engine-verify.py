"""Independent verification of an edited PDF with MuPDF (a different renderer/extractor than pdfjs).

Usage: python scripts/engine-verify.py <orig.pdf> <edited.pdf> <page> <outdir> "<old1>" "<new1>" ["<old2>" "<new2>" ...]
Reports: text presence/absence (ghost check), pixel diff outside the edited lines (collateral damage),
and writes side-by-side crops of each edited line.
"""
import sys, os, json
import fitz

orig_path, edit_path, page_no, outdir, *pairs = sys.argv[1:]
page_no = int(page_no) - 1
os.makedirs(outdir, exist_ok=True)
o = fitz.open(orig_path)[page_no]
e = fitz.open(edit_path)[page_no]
ZOOM = 3
mat = fitz.Matrix(ZOOM, ZOOM)
po = o.get_pixmap(matrix=mat, alpha=False)
pe = e.get_pixmap(matrix=mat, alpha=False)
text_e = e.get_text()
report = {"edits": [], "size_ok": (po.width, po.height) == (pe.width, pe.height)}

allowed = []  # rects (in pixel space) where differences are expected
for i in range(0, len(pairs), 2):
    old, new = pairs[i], pairs[i + 1]
    rects_o = o.search_for(old)
    rects_n = e.search_for(new)
    r = {"old": old, "new": new, "old_still_extractable": old in text_e and old not in new, "new_extractable": new in text_e,
         "found_old_rect": bool(rects_o), "found_new_rect": bool(rects_n)}
    if rects_o:
        ro = rects_o[0]
        # The new text may come back as several rects (font switches inside the run): union them all
        # on the same line as the original.
        u = fitz.Rect(ro)
        for rn in rects_n:
            if abs(rn.y1 - ro.y1) < (ro.y1 - ro.y0):
                u |= rn
        # The edited line may reflow as a whole: the rest of the line follows the edit, and right-aligned, centred
        # or justified lines move/re-space to keep their alignment. Anything outside that line band is damage.
        allowed.append(fitz.Rect(o.rect.x0, u.y0, o.rect.x1, u.y1))
        crop = fitz.Rect(u.x0 - 40, u.y0 - 18, u.x1 + 160, u.y1 + 18) & o.rect
        for tag, pg in (("orig", o), ("edit", e)):
            pg.get_pixmap(matrix=fitz.Matrix(4, 4), clip=crop, alpha=False).save(os.path.join(outdir, f"crop{i//2}_{tag}.png"))
    report["edits"].append(r)

# Pixel diff outside the allowed rects (with a 1pt margin).
n = po.n
so, se = po.samples, pe.samples
W, H = po.width, po.height
def inside(x, y):
    px, py = x / ZOOM, y / ZOOM
    return any(a.x0 - 1 <= px <= a.x1 + 1 and a.y0 - 1 <= py <= a.y1 + 1 for a in allowed)
diff_out = 0
max_out = 0
if report["size_ok"]:
    for y in range(0, H):
        row = y * W * n
        for x in range(0, W):
            k = row + x * n
            d = abs(so[k] - se[k]) + abs(so[k + 1] - se[k + 1]) + abs(so[k + 2] - se[k + 2])
            if d > 0 and not inside(x, y):
                diff_out += 1
                max_out = max(max_out, d)
report["pixels_changed_outside_edited_lines"] = diff_out
report["max_delta_outside"] = max_out
print(json.dumps(report, indent=1, ensure_ascii=False))
