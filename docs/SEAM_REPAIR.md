# Seam Repair Pipeline

This test build treats four-way repeat quality as a production requirement, not a cosmetic afterthought.

## Strategy

1. Generate one repeat tile from the reference image.
2. Export to the print target size: `4961 x 7559 px`, 300 dpi.
3. Run seam scoring on the raw print export first. The checker looks at opposite borders, corners, local break windows, internal guide lines, one-sided border-object risk, edge-band artifacts, edge drift, the center cross, and the four-corner junction that appears in a real 2x2 tiled preview.
4. Use `repairSeams` as the primary local repair path:
   - feathered weights instead of a hard border average;
   - opposite-edge matching;
   - interior texture guidance so the edge borrows from nearby printable texture;
   - local detail reinjection from neighboring interior pixels, so repaired edges keep visible texture instead of becoming flat bands;
   - transition feathering so the repaired band blends back into the original image.
5. Use forced periodic repair only when the seam score remains repairable.
6. Use AI Offset repair as an assistant when structural content needs to be redrawn:
   - offset the tile so edge seams move to the center;
   - send a cross-shaped mask so AI redraws only the center seam band;
   - offset the result back and score again;
   - allow a second AI refinement only when the first repair clearly improves the score;
   - keep the best scored version and roll back if AI makes the seam worse.

## Edge-Band Quality Gate

A tile can look numerically seamless while still failing in a 2x2 preview: the border may have been averaged into a flat or blurry strip. The current checker rejects that case by comparing the outer repair band with nearby interior texture. A pass now requires:

- the opposite edges to match;
- no corner jump;
- no internal seam line;
- no one-sided border object;
- no visible flat, blurry, or shifted edge band after tiling.
- no hard center cross, halo, or fake border stripe in a simulated 2x2 tile preview.
- no edge drift where the opposite borders only line up after sliding a few pixels.
- no hard spot, star joint, dark/light knot, or fake patch where all four tile corners meet.

## Why `repairSeams` Changed

The previous local repair averaged opposite pixels. That made scores improve, but could create a visibly smoothed strip.

The current repair blends three signals:

- the current edge pixel;
- the opposite edge pixel;
- nearby interior texture from both sides.
- local high-frequency detail from neighboring interior pixels.

This keeps edge continuity while preserving enough local texture for fabric printing.

## 0.7.16 Success-Rate Changes

- The quality gate now simulates a 2x2 tiled preview and measures the horizontal/vertical center seams directly.
- A candidate can fail even when the opposite borders numerically match if the tiled preview would show a hard line, halo, flat stripe, or blurry transition band.
- The task summary now includes a `平铺` score so visible preview risk is not hidden inside the edge score.
- AI offset repair, local edge blending, and forced periodic repair now consider this tiled-preview score when deciding whether a result is repairable.
- Tests include both a genuinely periodic texture that must pass and a matching-edge hard line that must fail.

## 0.7.17 Print-Clarity Changes

- Final JPG export now applies a conservative print-finishing clarity pass by default, especially when a 1024/1536 generation is enlarged to the `4961 x 7559 px` print canvas.
- The quality gate now reports a `清晰` score and can reject high-contrast but blurred output as `成品清晰度不足，可增强`.
- If clarity is the first failing issue, the generation pipeline runs a print-clarity enhancement and rechecks seams before allowing download.
- AI Offset repair now uses the native generated image when available and sends PNG offset/mask assets, reducing repeated JPEG compression before the final print export.
- Local edge repair and forced periodic repair add a small detail-restoration pass after seam blending so repaired seams do not look overly soft.

## 0.7.18 Commercial Download Gate

- Download buttons now open only for records that pass the current four-way repeat and print-clarity gate.
- Review/fail records remain visible for preview, recheck, and fission, but they are not selectable for batch download and are not included in task ZIP exports.
- Each saved record can carry a `certification` object with target pixels, DPI, format, version, seam scores, tiled-preview score, edge-band score, clarity score, and issue list.
- History records show `商用下载认证` or `未认证下载`, making it harder to confuse test failures with printable handoff files.

## 0.7.19 Edge-Drift Diagnostic

- The quality gate now scans small windows along the top/bottom and left/right borders for pixel drift.
- If an edge pair matches much better after a small slide than at the true zero-offset seam, the result is marked as `边缘错位漂移，可修复`.
- Strong drift is routed to AI Offset repair first, because local edge averaging can make this failure look blurrier instead of truly seamless.
- The task summary now includes a `错位` score, and certification metadata stores a `driftScore`.
- Tests include both aligned periodic edge texture that must pass and shifted edge texture that must fail.

## 0.7.20 Four-Corner Junction Gate

- The quality gate now samples the exact 2x2 preview point where the four original tile corners meet.
- It rejects matching corner patches that would create a visible dot, star joint, hard knot, or dark/light square at every repeat intersection.
- Strong corner-junction risk is routed to AI Offset repair first, since the center cross mask is the right place to redraw that junction naturally.
- The task summary now includes a `交汇` score, and certification metadata stores `cornerJunctionScore`.
- Tests include aligned periodic corners that must pass and a matching hard corner spot that must fail.

## 0.7.21 Print DPI Metadata Guarantee

- Final JPG exports now guarantee a JFIF APP0 density segment set to 300 pixels per inch.
- If the browser encoder already emits JFIF metadata, the density is patched in place.
- If the browser encoder omits JFIF metadata, the exporter inserts a valid JFIF segment immediately after the JPEG SOI marker.
- Certification metadata records the DPI contract as `JFIF inch density`.
- Tests cover both existing-JFIF and missing-JFIF JPEG outputs.

## 0.7.22 Print-Spec Certification Gate

- Every seam check now also verifies the actual exported JPG dimensions and DPI metadata.
- A file can only be certified for commercial download when the actual image is `4961 x 7559 px`, is JPG, and reads as 300 dpi through JFIF inch density.
- Task downloads and history downloads now require `printSpecPassed: true`, so older or partially verified records are not treated as printable handoff files.
- Certification metadata stores the actual width, height, DPI values, DPI unit, and `printSpecPassed` result.
- Tests cover the print-spec helper and the stricter certification gate.

## 0.7.23 Seam Detail-Loss Gate

- The quality gate now compares high-frequency detail in the seam band against nearby interior texture.
- It rejects candidates where local or AI repair makes the seam band visibly soft, misty, or over-smoothed while the surrounding textile detail remains sharp.
- The task summary now includes a `细节` score, and certification metadata stores `seamDetailLossScore`.
- `接缝细节发虚，可修复` is routed through the repair chain instead of being treated as a certified handoff.
- Tests cover sharp seam bands that must pass and blurred seam bands that must fail.

## 0.7.24 Strict History Certification

- History downloads now require the saved certification object to carry `certified: true`, `fourWayRepeat: true`, `qualityPassed: true`, `printSpecPassed: true`, and a numeric `seamDetailLossScore`.
- Older records that lack the current seam-detail gate are treated as `未认证下载` instead of being included in commercial ZIP exports.
- This keeps new safety gates from being bypassed through stale history metadata.
- Tests cover the stricter history certification contract.

## 0.7.25 Strict Batch Certification

- Current-task batch selection now uses `taskHasCertifiedDownload`, the same gate used by single JPG downloads.
- Batch ZIP creation only includes items with `certified === true`; missing or stale certification is rejected instead of treated as acceptable.
- The batch button count now reflects only explicitly certified items.
- Tests cover current-task selection, batch counts, and ZIP filtering.

## 0.7.26 Print Richness Gate

- The quality gate now measures global contrast, local detail, color spread, and active texture ratio.
- Nearly empty, flat, or low-information outputs are rejected as `花型信息量不足，不可修复`, so a blank seamless tile cannot pass commercial certification.
- This issue is routed to regeneration rather than seam repair, because local repair cannot create a printable motif system.
- Certification metadata stores `richnessScore` and `activeTextureRatio`, and history downloads require the current `richnessScore` gate.
- Tests cover sharp printable patterns that must pass and near-empty outputs that must fail.

## 0.7.13 Success-Rate Changes

- Automatic regeneration was raised to four tries total.
- AI Offset repair can now run twice on one candidate, but only when the first pass improves the visual seam score.
- Local edge blending uses a wider, softer band with stronger interior texture guidance.
- Forced periodic repair is less aggressive and restores micro-texture after opposite bands are matched.
- Prompts now explicitly reject fake seamless tricks: blur bands, faded borders, mirror smears, plain color strips, and averaged edges.

## Test

Run:

```bash
npm test
```

The synthetic test creates severe mismatched top/bottom and left/right borders, repairs them, and asserts:

- horizontal seam mismatch drops sharply;
- vertical seam mismatch drops sharply;
- the interior texture variation remains printable;
- the repaired edge is not reduced to a flat strip;
- a synthetic flat border band is rejected even when opposite edges match.
