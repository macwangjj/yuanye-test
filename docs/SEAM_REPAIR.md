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

## 0.7.27 Layout Balance Gate

- The quality gate now measures motif activity across a 5x5 grid and compares center activity against the outer ring.
- Outputs with one dominant centered motif and very quiet edges are rejected as `花型分布过于集中，不可修复`, because they tile into a visible grid rather than a wearable all-over repeat.
- This issue is routed to regeneration instead of seam repair; local seam tools cannot rebalance the motif layout.
- Certification metadata stores `layoutBalanceScore` and `edgeMotifActivity`, and history downloads require the current layout gate.
- Tests cover all-over printable texture that must pass and a centered motif with quiet edges that must fail.

## 0.7.28 Mirror Axis Gate

- The quality gate now scans the center horizontal and vertical axes for mechanical mirror symmetry.
- This catches AI or local seam repairs that make both sides of a seam numerically smooth but visibly mirrored, which creates an artificial axis after tiling.
- `镜像轴痕明显，可修复` is routed to AI Offset repair instead of simple edge blending, because the fix needs fresh local variation rather than averaged pixels.
- Certification metadata stores `mirrorAxisScore` and `mirrorAxisWorstScore`; history downloads require the current mirror-axis gate.
- Tests cover normal all-over texture that must pass and a synthetic mirrored center-axis artifact that must fail.

## 0.7.29 Pre-Tiled Preview Gate

- The quality gate now compares the four quadrants of the generated image to detect accidental 2x2 preview output.
- If multiple quadrant pairs are too similar, the image is rejected as `疑似平铺预览输出，不可修复`; this means the model produced a preview/montage instead of one printable repeat unit.
- This issue is routed to regeneration rather than seam repair, because the scale and composition are wrong even if the edges are technically continuous.
- Certification metadata stores `preTiledPreviewScore` and `preTiledDuplicatePairs`; history downloads require the current pre-tiled preview gate.
- Tests cover a normal all-over tile that must pass and a synthetic 2x2 repeated output that must fail.

## 0.7.30 Print Texture Density Gate

- The quality gate now measures printable fine-detail density separately from broad contrast and blur.
- Low-detail wash outputs are rejected as `印花细节密度不足，可增强`, even when they are not empty enough for the low-information gate.
- This issue is routed through the clarity-enhancement path first, then regeneration if the enhanced result still cannot pass certification.
- Certification metadata stores `textureDensityScore` and `fineDetailRatio`; history downloads require the current texture-density gate.
- Tests cover sharp printable texture that must pass and a soft low-detail output that must fail.

## 0.7.31 Outer Frame Gate

- The quality gate now scans wide outer bands on all four sides and compares them with nearby interior regions.
- Outputs with broad white/black/tinted margins, picture-frame borders, or quiet edge gutters are rejected as `画框留白边界，不可修复`.
- This issue is routed to regeneration instead of seam repair, because a framed composition is not one full-bleed printable repeat unit.
- Certification metadata stores `outerFrameScore` and `outerFrameRiskSides`; history downloads require the current outer-frame gate.
- Tests cover all-over texture that must pass and a synthetic wide-margin frame that must fail.

## 0.7.33 Aspect-Warp Gate

- The JPG exporter now records the source image dimensions before fitting the image to the `4961 x 7559 px` print canvas.
- If horizontal and vertical scale differ by more than 8%, the output is rejected as `输出比例拉伸过大，不可修复`.
- This catches square or landscape model outputs being forced into the portrait textile layout; those files may tile mathematically, but the motifs become visibly distorted and are not commercial-print ready.
- This issue is routed to regeneration rather than seam repair, because local seam blending cannot recover the correct motif proportion.
- Certification metadata stores `aspectWarpRatio` and `aspectStretchPercent`; current and history downloads require the aspect-warp gate.
- Tests originally covered near-target portrait outputs that must pass and mismatched outputs that must not be hard-stretched; 0.7.34 adds a safe square-tile rectification path before final rejection.

## 0.7.34 Periodic Aspect Rectification

- When the upstream image API returns a square tile despite the portrait size request, the exporter now searches for a low-distortion periodic grid before rejecting it.
- A square seamless source can be exported as a `2 x 3` periodic grid on the `4961 x 7559 px` canvas, keeping motif proportions within the same 8% stretch limit instead of pulling the whole image tall.
- The existing seam and internal-line gates still run after export. If the square source was not genuinely seamless, the repeated cell boundaries remain visible and the candidate fails certification.
- Certification metadata stores `exportMode`, `tileColumns`, and `tileRows`, so history records show whether a file came from direct portrait export or periodic rectification.
- Tests cover direct portrait export, square-to-`2 x 3` periodic rectification, and landscape outputs that remain too distorted to certify.

## 0.7.35 Portrait-First API Attempts

- The Maimai-compatible image gateway now exhausts requested-size `1024x1536` attempts, including high-quality multipart and curl variants, before falling back to `auto`.
- This reduces avoidable square outputs from gateways that support portrait generation but need a different transport or quality option.
- `auto` remains as a final fallback so generation can still proceed when the provider rejects explicit size parameters.
- Tests cover the attempt order so requested portrait size cannot accidentally move behind `auto` again.

## 0.7.36 Strict Export-Mode Certification

- History downloads now require the saved certification to include `actual.exportMode`, `actual.tileColumns`, and `actual.tileRows`.
- Only `direct-stretch` with a `1 x 1` grid or `periodic-grid` with more than one tile can pass the history certification gate.
- This prevents records certified before the 0.7.34 periodic export logic from remaining downloadable without proof of the exact export geometry.
- History rows disclose either `竖版直出` or `周期转竖版 2×3`, so visual review can connect each JPG to the export path that produced it.
- Tests cover direct exports, periodic-grid exports, missing export metadata, and mismatched export-mode/grid combinations.

## 0.7.37 Live Export-Geometry Gate

- Current-task JPG downloads now use the same export-geometry gate as history records.
- A task can pass only when the seam check includes a valid `aspectWarp.mode`, `aspectWarp.columns`, and `aspectWarp.rows`.
- This prevents an in-memory task from becoming downloadable if it has a stale or partial aspect-warp result without proof that the final JPG was exported as either direct portrait or a valid periodic grid.
- Tests cover current direct exports, current periodic-grid exports, missing geometry, and mode/grid mismatches.

## 0.7.38 Low-Resolution Upscale Gate

- The quality gate now checks for low-resolution enlargement artifacts: long flat pixel plateaus, sudden luminance jumps, and stair-step transitions that appear after a small source tile is scaled up.
- This catches outputs that can look artificially sharp after sharpening but still print like a low-resolution enlarged image.
- The issue is reported as `低清放大痕迹，可增强`, so the pipeline first tries print-clarity enhancement and then rechecks before allowing download.
- Certification metadata stores `upscaleArtifactScore` and `upscaleFlatPairRatio`; history downloads require the current upscale-artifact gate.
- Tests cover a clean printable texture that must pass and a pixel-replicated low-resolution output that must fail.

## 0.7.39 Posterization / Tone-Banding Gate

- The quality gate now checks whether shadows and gradients have collapsed into visible hard tone steps instead of smooth printable transitions.
- The detector combines long flat tonal plateaus, moderate jump edges, available luminance-bin count, contrast, and local detail so limited-palette line art is not rejected merely for using fewer colors.
- The issue is reported as `色阶断层，可增强`. The enhancement path applies a very light deterministic print-tone dither before rechecking, which can break up hard bands without changing the pattern layout.
- Certification metadata stores `posterizationScore` and `posterizationToneBinRatio`; history downloads require the current posterization gate.
- Tests cover smooth tonal shading that must pass and posterized 12-level shading that must fail.

## 0.7.40 Compression Block Artifact Gate

- The quality gate now checks for repeated square compression blocks that can look acceptable in a single preview but print as dirty tiled patches.
- The detector scans multiple candidate periods and requires both a repeated vertical/horizontal block grid and block-level evidence: unusually flat block interiors, color jumps between neighboring blocks, or very low intra-block texture.
- The issue is reported as `压缩块噪点，不可修复` and routed to regeneration rather than blur/deblock repair, because smoothing compression blocks can destroy textile line detail and create a softer but still unprintable file.
- Certification metadata stores `compressionArtifactScore` and `compressionArtifactPeriod`; history downloads require the current compression-artifact gate.
- Tests cover clean printable texture that must pass and synthetic macro-block compression artifacts that must fail.

## 0.7.41 Sharpen Halo Gate

- The quality gate now checks for over-sharpening halos: bright rims around dark strokes or dark rims around light strokes that make a pattern look artificially crisp on screen but dirty on fabric.
- The detector scans horizontal and vertical luminance profiles for repeated ring-core-ring overshoot, while allowing normal high-contrast textile line work when the artifacts are sparse.
- The issue is reported as `锐化光晕明显，不可修复` so the candidate is regenerated instead of being further sharpened or smoothed into a lower-quality handoff.
- Certification metadata stores `sharpenHaloScore` and `sharpenHaloRatio`; history downloads require the current sharpen-halo gate.
- Tests cover clean printable texture that must pass and synthetic bright-edge/dark-edge ringing that must fail.

## 0.7.42 Final-Size Edge Gate

- The seam checker now samples narrow strips from the original final JPG before it creates the smaller analysis canvas.
- This catches one-pixel hard edge seams, final-encoder border lines, and matching but visible outer-edge strokes that can be blurred away by downscaled preview analysis.
- The issue is reported as `最终JPG边缘硬线，不可修复`, because the exported handoff file itself contains the defect and must be regenerated or re-exported cleanly.
- Certification metadata stores `fullSizeEdgeScore` and `fullSizeEdgePeakRatio`; history downloads require the current final-size edge gate.
- Tests cover a clean periodic final edge, mismatched one-pixel edge colors, and a matching one-pixel hard border that would draw a line in tiled output.

## 0.7.43 Issue-Specific Regeneration Guidance

- Automatic regeneration now translates quality failures into targeted prompt constraints instead of only echoing the previous issue list.
- Seam failures, final JPG hard edges, pre-tiled preview output, outer frames, aspect distortion, low information density, center-heavy layouts, mirror-axis artifacts, low-resolution upscales, posterization, compression blocks, sharpen halos, edge drift, pasted overlaps, and blurred seam bands each get a different correction.
- The retry prompt now explicitly says to regenerate one true repeat tile and internally preview a 3x3 tiling before output, so the next attempt is less likely to repeat the same visible seam.
- Tests cover hard-edge retry guidance, pre-tiled preview correction, high-detail regeneration constraints, deduplication, instruction capping, and both normal/fission prompt wiring.

## 0.7.44 Strict Certified Fallback Candidate

- Before automatic regeneration, structural edge-closure failures such as horizontal seams, vertical seams, corner return failures, and final-edge hard lines now get one deterministic strict-seamless candidate.
- The candidate is discardable: it replaces the task image only when the full commercial seam check passes after re-export; otherwise the original failed image remains in place and the pipeline continues to regeneration.
- Non-structural failures such as low information density, center-heavy layouts, pre-tiled previews, frames, aspect distortion, low-resolution upscales, compression blocks, sharpen halos, and pasted motif overlaps still go straight to enhancement or regeneration.
- Tests cover structural allow-listing, non-structural rejection, extreme-score rejection, and the generation-loop order before auto-regeneration.

## 0.7.45 Attempt-Specific Regeneration Strategies

- Automatic regeneration now changes composition strategy by attempt instead of repeating the same broad prompt with a longer failure list.
- The second attempt uses an edge-first closure strategy for structural seam failures: design the four borders and corners first, then fill the interior.
- The third attempt switches to a small/medium all-over repeat structure to reduce large motif edge risk, quiet borders, center-heavy layouts, and pasted overlaps.
- The final retry uses a strict production-tile strategy: lower compositional ambition, output one portrait repeat unit, close all edges and corners first, and preserve native print detail.
- Normal generation and fission generation both receive these attempt strategies, while the same commercial seam and print certification gates remain unchanged.
- Tests cover attempt guidance, normal/fission prompt wiring, and the generation loop passing the attempt number into prompt construction.

## 0.7.46 Four-Corner Stabilization

- Forced periodic repair now applies a dedicated corner-stabilization pass after opposite bands are locked and micro-texture is restored.
- The pass blends the four corresponding corner patches toward one shared periodic corner while borrowing interior detail, reducing hard dots, corner knots, and 2x2 junction spots without accepting the candidate blindly.
- The discardable strict-seamless candidate still replaces the task image only after the full commercial seam, clarity, print-spec, and download-certification gates pass.
- Tests cover synthetic hard corner spots, verify the corner score drops after stabilization, and confirm the production force-periodic path calls the corner pass.

## 0.7.47 Best Failed Candidate Retention

- Automatic regeneration now remembers the best failed candidate across all attempts instead of leaving the last attempt on screen by default.
- If no candidate passes certification, the task restores the lowest-risk candidate before review, history save, manual repair availability, and download-gate updates run.
- The comparison uses both the overall seam score and the worst visible seam score, so a candidate with fewer hard seam artifacts is preferred even when the total score is close.
- The restored candidate remains non-downloadable until it passes the full commercial certification gate, but human review and any follow-up repair now start from the best available base image.
- Tests cover candidate cloning, later-worse rejection, later-better replacement, and generation-loop placement before auto-regeneration and final review.

## 0.7.48 Discarded Fallback Candidate Retention

- Rejected strict-seamless fallback candidates are no longer thrown away blindly.
- If the strict fallback fails certification but scores better than other failed attempts, it can become the restored review candidate while still remaining non-downloadable.
- This lets human review, fission, or follow-up repair start from a locally improved seam base without weakening the commercial gate.
- Tests confirm rejected fallback branches expose a candidate, and the generation loop considers that candidate before automatic regeneration overwrites the current task image.

## 0.7.49 Manual AI Seam Repair Routing

- The manual repair button now uses the same repair availability gate as the automatic pipeline.
- If a failed candidate is suitable for AI Offset repair and still has AI repair budget, the button stays available and routes to AI-generated seam transition repair first.
- Mirror-axis marks, bounded drift, corner junctions, and other nontrivial seam-transition failures no longer fall through into simple local edge blending.
- If AI repair budget is exhausted, the button can still fall back to strict periodic repair or local edge blending when those paths are appropriate.
- Failed manual AI repair remains non-downloadable until the full commercial certification gate passes.

## 0.7.50 Internal Guide-Line AI Repair

- AI Offset repair masks now include the center cross plus narrow editable guide bands at 1/4, 1/3, 2/3, and 3/4 positions.
- Candidates whose outer edges are already numerically closed but still show internal guide lines or 2x2 corner junction marks are reclassified as repairable instead of terminal seam failures.
- The prompt explicitly asks the image model to redraw internal guide-line bands naturally, removing grid seams without changing the whole textile style.
- Hard failures such as motif overlap, low information, frames, wrong output form, low-resolution artifacts, compression blocks, and final-edge hard lines are not reclassified.
- The commercial download gate is unchanged: these candidates still need to pass the full seam, print, metadata, and certification checks before download.

## 0.7.51 Local Motif-Overlap AI Repair

- Motif overlap is now split into localized and severe cases.
- Localized seam-area motif overlap can route to AI Offset repair when edge scores, local windows, internal lines, drift, and border-object risk are still bounded.
- Severe motif overlap, low information, center-heavy layout, frames, wrong output form, low-resolution artifacts, compression, posterization, sharpen halos, and final-edge hard lines still require regeneration.
- The local overlap path is never sent to simple edge blending; it routes through AI redraw so stacked flowers, leaves, or texture patches can be rebuilt into natural spacing and continuous motif flow.
- Tests cover localized-overlap reclassification, severe-overlap rejection, AI repair routing, and the unchanged commercial download gate.

## 0.7.52 Deploy Health Check

- `/api/health` is public even when the test site password is enabled, so deployment platforms and external checks can verify that the service is alive.
- The health response exposes only operational status, version, model configuration, base URL, and whether auth is enabled; protected image generation, history, repair, and downloads still require a valid session.
- Tests start the server with password protection enabled and assert that `/api/health` returns 200 while `/api/history` still returns 401 without login.

## 0.7.53 Maimai Masked AI Seam Repair

- The maimai-compatible image attempt plan now honors the AI seam-repair mask.
- When AI Offset repair prepares an offset tile plus seam mask, the server first sends masked edit requests so the image model redraws only the center seam cross and internal guide bands before any unmasked fallback runs.
- If the gateway rejects masked edits, the existing unmasked maimai attempts still run afterward, preserving compatibility while giving true inpaint-style seam repair the first chance.
- Tests cover maimai masked-attempt ordering and ensure masked auto fallback happens before unmasked edits.

## 0.7.54 QA Seam Recheck Tools

- Opening the workbench with `?qa=1` exposes `window.YUANYE_QA` for internal verification only; normal user sessions do not receive the QA object.
- QA can run the same browser seam checker as the production UI and can also run a structure-only recheck that records print-spec metadata without allowing old low-spec history images through the commercial gate.
- The standard generation, history, and download certification paths still call the full print-spec gate, so this tooling cannot certify undersized or non-300dpi artwork.
- Bounded final JPG edge-hard-line failures are now marked as AI-repairable, so they route to Offset inpainting instead of being presented as terminal failures; extreme edge hard lines still remain unrepairable.

## 0.7.57 Near-Miss Structural Seam Repair

- QA rechecks on 24 historical seam failures showed a remaining cluster of low-score structural seams that were still labeled terminal even though their scores were within the AI Offset repair envelope.
- Bounded structural failures now classify as `结构接缝轻度失配，可修复` when the seam score, edge dominance, border mismatch, local windows, tiled preview, corner, band/detail, and drift measurements are all within conservative limits.
- Low-intensity border-object hits can enter AI Offset repair when border mismatch and drift stay low, preventing ornamental edge motifs from being treated as terminal failures.
- Drift-risk seams, high-mismatch object-risk border seams, severe motif overlap, low-information layouts, frames, aspect failures, low-resolution/clarity artifacts, posterization, compression blocks, and sharpen halos remain regeneration-only.
- This changes repair routing and human review language only; the commercial download gate still requires a fresh passing seam check, target pixel dimensions, 300dpi metadata, and complete certification.

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
