# Seam Repair Pipeline

This test build treats four-way repeat quality as a production requirement, not a cosmetic afterthought.

## Strategy

1. Generate one repeat tile from the reference image.
2. Export to the print target size: `4961 x 7559 px`, 300 dpi.
3. Run seam scoring on the raw print export first. The checker looks at opposite borders, corners, local break windows, internal guide lines, one-sided border-object risk, and edge-band artifacts.
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

## Why `repairSeams` Changed

The previous local repair averaged opposite pixels. That made scores improve, but could create a visibly smoothed strip.

The current repair blends three signals:

- the current edge pixel;
- the opposite edge pixel;
- nearby interior texture from both sides.
- local high-frequency detail from neighboring interior pixels.

This keeps edge continuity while preserving enough local texture for fabric printing.

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
