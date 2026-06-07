import assert from "node:assert/strict";
import { test } from "node:test";

test("repairSeams reduces opposite-edge seam mismatch while preserving interior variation", () => {
  const width = 96;
  const height = 128;
  const before = makeSyntheticPattern(width, height);
  const originalInterior = interiorVariation(before, width, height);
  const beforeScore = seamScore(before, width, height);

  const repaired = new Uint8ClampedArray(before);
  repairSeamsCore(repaired, width, height, {
    bandRatio: 0.08,
    minBand: 10,
    maxBand: 18,
    strength: 0.96,
    maxDiff: Infinity,
    textureMix: 0.72,
  });

  const afterScore = seamScore(repaired, width, height);
  const repairedInterior = interiorVariation(repaired, width, height);

  assert.ok(beforeScore.horizontal > 70, `expected strong horizontal seam, got ${beforeScore.horizontal}`);
  assert.ok(beforeScore.vertical > 55, `expected strong vertical seam, got ${beforeScore.vertical}`);
  assert.ok(afterScore.horizontal < beforeScore.horizontal * 0.16, `${afterScore.horizontal} should be much lower than ${beforeScore.horizontal}`);
  assert.ok(afterScore.vertical < beforeScore.vertical * 0.18, `${afterScore.vertical} should be much lower than ${beforeScore.vertical}`);
  assert.ok(repairedInterior > originalInterior * 0.72, "repair should keep enough printable interior texture variation");
});

test("repairSeams uses a feathered band rather than a flat border fill", () => {
  const width = 80;
  const height = 80;
  const data = makeSyntheticPattern(width, height);
  repairSeamsCore(data, width, height, {
    bandRatio: 0.1,
    minBand: 12,
    maxBand: 12,
    strength: 0.98,
    maxDiff: Infinity,
    textureMix: 0.76,
  });

  const edgeVariation = rowVariation(data, width, 0);
  const innerVariation = rowVariation(data, width, 18);

  assert.ok(edgeVariation > 8, `edge should retain visible texture variation after repair; got ${edgeVariation}`);
  assert.ok(Math.abs(edgeVariation - innerVariation) < 70, `edge should blend toward the interior instead of becoming a flat strip; edge=${edgeVariation} inner=${innerVariation}`);
});

test("edge band artifact check rejects a flat border even when opposite edges match", () => {
  const width = 128;
  const height = 128;
  const data = makeSyntheticPattern(width, height);
  paintMatchingFlatBand(data, width, height, "horizontal", 12, [118, 92, 76]);

  const oppositeEdgeScore = seamScore(data, width, height).horizontal;
  const bandCheck = measureEdgeBandArtifactCore(data, width, height, "horizontal");

  assert.ok(oppositeEdgeScore < 1, `opposite edges should numerically match; got ${oppositeEdgeScore}`);
  assert.ok(bandCheck.bandRisk, `flat edge band should be rejected; got ${JSON.stringify(bandCheck)}`);
  assert.ok(bandCheck.worstScore > 18, `expected a visible band score; got ${bandCheck.worstScore}`);
});

test("outer frame check rejects wide print margins", () => {
  const width = 160;
  const height = 160;
  const allover = makeSharpPrintPattern(width, height);
  const framed = makeFramedPrintPattern(width, height, 18, [238, 232, 216]);
  const alloverFrame = measureOuterFrameArtifactCore(allover, width, height);
  const framedCheck = measureOuterFrameArtifactCore(framed, width, height);

  assert.equal(alloverFrame.frameRisk, false, `all-over textile should not be rejected as a frame; got ${JSON.stringify(alloverFrame)}`);
  assert.equal(framedCheck.frameRisk, true, `wide print margin should be rejected; got ${JSON.stringify(framedCheck)}`);
  assert.ok(framedCheck.riskSides >= 3, `wide frame should affect most sides; got ${framedCheck.riskSides}`);
});

test("tiled preview seam check allows genuinely periodic textured edges", () => {
  const width = 128;
  const height = 128;
  const data = makePeriodicPattern(width, height);
  const horizontal = measureTiledPreviewSeamCore(data, width, height, "horizontal");
  const vertical = measureTiledPreviewSeamCore(data, width, height, "vertical");

  assert.equal(horizontal.lineRisk, false, `periodic horizontal edge should pass; got ${JSON.stringify(horizontal)}`);
  assert.equal(vertical.lineRisk, false, `periodic vertical edge should pass; got ${JSON.stringify(vertical)}`);
  assert.ok(horizontal.worstScore < 14, `periodic horizontal seam should stay quiet; got ${horizontal.worstScore}`);
  assert.ok(vertical.worstScore < 14, `periodic vertical seam should stay quiet; got ${vertical.worstScore}`);
});

test("tiled preview seam check rejects a matching hard line that appears only after tiling", () => {
  const width = 128;
  const height = 128;
  const data = makePeriodicPattern(width, height);
  paintMatchingLine(data, width, height, "horizontal", 2, [28, 24, 22]);

  const oppositeEdgeScore = seamScore(data, width, height).horizontal;
  const tiled = measureTiledPreviewSeamCore(data, width, height, "horizontal");

  assert.ok(oppositeEdgeScore < 1, `opposite edges numerically match; got ${oppositeEdgeScore}`);
  assert.equal(tiled.lineRisk, true, `matching hard line should be rejected in tiled preview; got ${JSON.stringify(tiled)}`);
  assert.ok(tiled.worstScore > 16, `expected a visible tiled seam score; got ${tiled.worstScore}`);
});

test("edge drift check allows aligned periodic edge texture", () => {
  const width = 144;
  const height = 144;
  const data = makePeriodicPattern(width, height);
  const horizontal = measureEdgeDriftCore(data, width, height, "horizontal");
  const vertical = measureEdgeDriftCore(data, width, height, "vertical");

  assert.equal(horizontal.driftRisk, false, `aligned horizontal edge should pass; got ${JSON.stringify(horizontal)}`);
  assert.equal(vertical.driftRisk, false, `aligned vertical edge should pass; got ${JSON.stringify(vertical)}`);
  assert.ok(horizontal.worstScore < 10, `aligned horizontal drift score should stay quiet; got ${horizontal.worstScore}`);
  assert.ok(vertical.worstScore < 10, `aligned vertical drift score should stay quiet; got ${vertical.worstScore}`);
});

test("edge drift check rejects shifted seam texture", () => {
  const width = 144;
  const height = 144;
  const data = makeSharpPrintPattern(width, height);
  paintShiftedMatchingEdge(data, width, height, "horizontal", 14, 7);

  const drift = measureEdgeDriftCore(data, width, height, "horizontal");

  assert.equal(drift.driftRisk, true, `shifted edge should be rejected; got ${JSON.stringify(drift)}`);
  assert.ok(drift.averageShift >= 4, `expected a meaningful detected shift; got ${drift.averageShift}`);
  assert.ok(drift.worstScore > 13, `expected a visible drift score; got ${drift.worstScore}`);
});

test("final-size edge check rejects one-pixel JPG edge seams", () => {
  const width = 180;
  const height = 220;
  const clean = makePeriodicPattern(width, height);
  const mismatched = makePeriodicPattern(width, height);
  const hardLine = makePeriodicPattern(width, height);
  paintFinalEdgePixels(mismatched, width, height, "horizontal", [246, 238, 224], [28, 24, 21]);
  paintFinalEdgePixels(hardLine, width, height, "horizontal", [24, 21, 18], [24, 21, 18]);
  const cleanCheck = measureFullSizeEdgeArtifactCore(clean, width, height);
  const mismatchCheck = measureFullSizeEdgeArtifactCore(mismatched, width, height);
  const hardLineCheck = measureFullSizeEdgeArtifactCore(hardLine, width, height);

  assert.equal(cleanCheck.edgeRisk, false, `periodic final JPG edge should pass; got ${JSON.stringify(cleanCheck)}`);
  assert.equal(mismatchCheck.edgeRisk, true, `mismatched final JPG edge pixels should fail; got ${JSON.stringify(mismatchCheck)}`);
  assert.equal(hardLineCheck.edgeRisk, true, `matching one-pixel hard border should fail; got ${JSON.stringify(hardLineCheck)}`);
  assert.ok(mismatchCheck.score > cleanCheck.score + 20, `mismatched final edge score should be much higher; clean=${cleanCheck.score} mismatch=${mismatchCheck.score}`);
});

test("tiled corner junction check allows aligned periodic corners", () => {
  const width = 144;
  const height = 144;
  const data = makePeriodicPattern(width, height);
  const corner = measureTiledCornerJunctionCore(data, width, height);

  assert.equal(corner.junctionRisk, false, `aligned periodic corners should pass; got ${JSON.stringify(corner)}`);
  assert.ok(corner.worstScore < 15, `periodic corner junction should stay quiet; got ${corner.worstScore}`);
});

test("tiled corner junction check rejects matching hard corner spot", () => {
  const width = 144;
  const height = 144;
  const data = makePeriodicPattern(width, height);
  paintMatchingCornerSpot(data, width, height, 14, [24, 21, 18]);

  const corner = measureTiledCornerJunctionCore(data, width, height);

  assert.equal(corner.junctionRisk, true, `matching corner spot should be rejected; got ${JSON.stringify(corner)}`);
  assert.ok(corner.worstScore > 18, `expected a visible corner-junction score; got ${corner.worstScore}`);
});

test("print clarity check allows sharp printable texture and rejects blurred output", () => {
  const width = 160;
  const height = 160;
  const sharp = makeSharpPrintPattern(width, height);
  const blurred = boxBlur(sharp, width, height, 3);
  const sharpClarity = measurePrintClarityCore(sharp, width, height);
  const blurredClarity = measurePrintClarityCore(blurred, width, height);

  assert.equal(sharpClarity.blurRisk, false, `sharp texture should pass; got ${JSON.stringify(sharpClarity)}`);
  assert.equal(blurredClarity.blurRisk, true, `blurred texture should be rejected; got ${JSON.stringify(blurredClarity)}`);
  assert.ok(sharpClarity.detailScore > blurredClarity.detailScore * 1.8, `sharp detail should be much higher; sharp=${sharpClarity.detailScore} blurred=${blurredClarity.detailScore}`);
});

test("print upscale artifact check rejects low-resolution pixel-replicated output", () => {
  const width = 180;
  const height = 180;
  const clean = makeSmoothPrintPattern(width, height);
  const low = downsampleNearest(clean, width, height, 36, 36);
  const replicated = upscaleNearest(low, 36, 36, width, height);
  const cleanCheck = measureUpscaleArtifactCore(clean, width, height);
  const replicatedCheck = measureUpscaleArtifactCore(replicated, width, height);

  assert.equal(cleanCheck.upscaleArtifactRisk, false, `clean printable texture should not look like a low-resolution upscale; got ${JSON.stringify(cleanCheck)}`);
  assert.equal(replicatedCheck.upscaleArtifactRisk, true, `pixel-replicated low-resolution output should be rejected; got ${JSON.stringify(replicatedCheck)}`);
  assert.ok(replicatedCheck.artifactScore > cleanCheck.artifactScore * 2, `upscaled artifact score should be much higher; clean=${cleanCheck.artifactScore} upscaled=${replicatedCheck.artifactScore}`);
});

test("print posterization check rejects visible tonal banding", () => {
  const width = 180;
  const height = 180;
  const smooth = makeSmoothGradientPattern(width, height);
  const posterized = posterizePrintPattern(smooth, 12);
  const smoothCheck = measurePosterizationArtifactCore(smooth, width, height);
  const posterizedCheck = measurePosterizationArtifactCore(posterized, width, height);

  assert.equal(smoothCheck.posterizationRisk, false, `smooth tonal shading should pass; got ${JSON.stringify(smoothCheck)}`);
  assert.equal(posterizedCheck.posterizationRisk, true, `visible tonal banding should be rejected; got ${JSON.stringify(posterizedCheck)}`);
  assert.ok(posterizedCheck.toneBinRatio < smoothCheck.toneBinRatio * 0.5, `posterized output should have far fewer tone bins; smooth=${smoothCheck.toneBinRatio} posterized=${posterizedCheck.toneBinRatio}`);
});

test("print compression artifact check rejects blocky macro artifacts", () => {
  const width = 180;
  const height = 180;
  const clean = makeSmoothPrintPattern(width, height);
  const blocky = makeBlockyCompressionPattern(width, height, 8);
  const cleanCheck = measureCompressionArtifactCore(clean, width, height);
  const blockyCheck = measureCompressionArtifactCore(blocky, width, height);

  assert.equal(cleanCheck.compressionRisk, false, `clean printable texture should not look block-compressed; got ${JSON.stringify(cleanCheck)}`);
  assert.equal(blockyCheck.compressionRisk, true, `blocky compression artifacts should be rejected; got ${JSON.stringify(blockyCheck)}`);
  assert.ok(blockyCheck.blockScore > cleanCheck.blockScore * 4, `block artifact score should be much higher; clean=${cleanCheck.blockScore} blocky=${blockyCheck.blockScore}`);
});

test("print sharpen halo check rejects bright or dark edge ringing", () => {
  const width = 180;
  const height = 180;
  const clean = makeSmoothPrintPattern(width, height);
  const haloed = makeSharpenHaloPattern(width, height);
  const cleanCheck = measureSharpenHaloArtifactCore(clean, width, height);
  const haloCheck = measureSharpenHaloArtifactCore(haloed, width, height);

  assert.equal(cleanCheck.haloRisk, false, `clean printable texture should not be rejected for edge halos; got ${JSON.stringify(cleanCheck)}`);
  assert.equal(haloCheck.haloRisk, true, `visible sharpen halos should be rejected; got ${JSON.stringify(haloCheck)}`);
  assert.ok(haloCheck.haloRatio > cleanCheck.haloRatio + 0.03, `halo artifact ratio should be much higher; clean=${cleanCheck.haloRatio} halo=${haloCheck.haloRatio}`);
});

test("print richness check rejects nearly empty low-information output", () => {
  const width = 160;
  const height = 160;
  const sharp = makeSharpPrintPattern(width, height);
  const flat = makeFlatPrint(width, height, [184, 178, 165]);
  const sharpRichness = measurePrintRichnessCore(sharp, width, height);
  const flatRichness = measurePrintRichnessCore(flat, width, height);

  assert.equal(sharpRichness.lowInformationRisk, false, `sharp textile pattern should pass richness gate; got ${JSON.stringify(sharpRichness)}`);
  assert.equal(flatRichness.lowInformationRisk, true, `near-empty output should be rejected; got ${JSON.stringify(flatRichness)}`);
  assert.ok(sharpRichness.richnessScore > flatRichness.richnessScore * 3, `pattern richness should be much higher; sharp=${sharpRichness.richnessScore} flat=${flatRichness.richnessScore}`);
});

test("print texture density check rejects soft low-detail output", () => {
  const width = 180;
  const height = 180;
  const sharp = makeSharpPrintPattern(width, height);
  const soft = makeSoftLowDetailPattern(width, height);
  const sharpDensity = measurePrintTextureDensityCore(sharp, width, height);
  const softDensity = measurePrintTextureDensityCore(soft, width, height);

  assert.equal(sharpDensity.lowTextureDensityRisk, false, `sharp printable texture should pass density gate; got ${JSON.stringify(sharpDensity)}`);
  assert.equal(softDensity.lowTextureDensityRisk, true, `soft low-detail texture should be rejected; got ${JSON.stringify(softDensity)}`);
  assert.ok(sharpDensity.fineDetailRatio > softDensity.fineDetailRatio * 3, `sharp output should have much more fine detail; sharp=${sharpDensity.fineDetailRatio} soft=${softDensity.fineDetailRatio}`);
});

test("pattern balance check rejects a single centered motif with quiet edges", () => {
  const width = 180;
  const height = 180;
  const allover = makeSharpPrintPattern(width, height);
  const centered = makeCenteredMotifPattern(width, height);
  const alloverBalance = measurePatternBalanceCore(allover, width, height);
  const centeredBalance = measurePatternBalanceCore(centered, width, height);

  assert.equal(alloverBalance.centerDominanceRisk, false, `all-over textile layout should pass balance gate; got ${JSON.stringify(alloverBalance)}`);
  assert.equal(centeredBalance.centerDominanceRisk, true, `centered motif layout should be rejected; got ${JSON.stringify(centeredBalance)}`);
  assert.ok(centeredBalance.centerToEdgeRatio > alloverBalance.centerToEdgeRatio * 2, `centered motif should be much more center-heavy; allover=${alloverBalance.centerToEdgeRatio} centered=${centeredBalance.centerToEdgeRatio}`);
});

test("mirror axis check rejects mechanical center-axis symmetry", () => {
  const width = 180;
  const height = 180;
  const allover = makeSharpPrintPattern(width, height);
  const mirrored = makeMirroredAxisPattern(width, height, "vertical");
  const alloverMirror = measureMirrorAxisArtifactCore(allover, width, height, "vertical");
  const mirroredAxis = measureMirrorAxisArtifactCore(mirrored, width, height, "vertical");

  assert.equal(alloverMirror.mirrorRisk, false, `all-over textile texture should not look mechanically mirrored; got ${JSON.stringify(alloverMirror)}`);
  assert.equal(mirroredAxis.mirrorRisk, true, `mechanical mirrored axis should be rejected; got ${JSON.stringify(mirroredAxis)}`);
  assert.ok(mirroredAxis.worstScore > alloverMirror.worstScore * 2, `mirrored axis should score much worse; allover=${alloverMirror.worstScore} mirrored=${mirroredAxis.worstScore}`);
});

test("pre-tiled preview check rejects 2x2 repeated outputs", () => {
  const width = 180;
  const height = 180;
  const allover = makeSharpPrintPattern(width, height);
  const preTiled = makePreTiledPreviewPattern(width, height);
  const alloverCheck = measurePreTiledPreviewArtifactCore(allover, width, height);
  const preTiledCheck = measurePreTiledPreviewArtifactCore(preTiled, width, height);

  assert.equal(alloverCheck.duplicateRisk, false, `single all-over tile should pass pre-tiled gate; got ${JSON.stringify(alloverCheck)}`);
  assert.equal(preTiledCheck.duplicateRisk, true, `2x2 repeated preview should be rejected; got ${JSON.stringify(preTiledCheck)}`);
  assert.ok(preTiledCheck.duplicatePairs >= 2, `pre-tiled output should have multiple duplicate quadrant pairs; got ${preTiledCheck.duplicatePairs}`);
});

test("seam detail loss check rejects a soft blurred seam band", () => {
  const width = 160;
  const height = 160;
  const sharp = makeSharpPrintPattern(width, height);
  const sharpDetail = measureSeamDetailLossCore(sharp, width, height, "horizontal");
  const softened = new Uint8ClampedArray(sharp);
  softenSeamBand(softened, width, height, "horizontal", 16, 3);
  const softenedDetail = measureSeamDetailLossCore(softened, width, height, "horizontal");

  assert.equal(sharpDetail.detailLossRisk, false, `sharp seam detail should pass; got ${JSON.stringify(sharpDetail)}`);
  assert.equal(softenedDetail.detailLossRisk, true, `soft seam band should be rejected; got ${JSON.stringify(softenedDetail)}`);
  assert.ok(softenedDetail.worstScore > sharpDetail.worstScore * 2, `soft seam should score much worse; sharp=${sharpDetail.worstScore} soft=${softenedDetail.worstScore}`);
});

function makeSyntheticPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const wave = Math.sin(x * 0.18) * 28 + Math.cos(y * 0.11) * 22;
      const diagonal = ((x + y) % 17) * 3;
      data[i] = clamp(112 + wave + diagonal);
      data[i + 1] = clamp(96 + Math.cos(x * 0.13) * 24 + y * 0.15);
      data[i + 2] = clamp(132 + Math.sin((x + y) * 0.08) * 30);
      data[i + 3] = 255;
    }
  }

  paintBand(data, width, height, "top", [235, 46, 42]);
  paintBand(data, width, height, "bottom", [26, 149, 228]);
  paintBand(data, width, height, "left", [238, 214, 42]);
  paintBand(data, width, height, "right", [56, 42, 190]);
  return data;
}

function makeSharpPrintPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const woven = ((x % 8) < 4 ? 36 : -36) + ((y % 10) < 5 ? 28 : -28);
      const line = ((x + y) % 19 === 0 || (x * 2 - y) % 23 === 0) ? 96 : 0;
      data[i] = clamp(128 + woven + line + Math.sin(y * 0.17) * 12);
      data[i + 1] = clamp(112 + woven * 0.85 + line * 0.74 + Math.cos(x * 0.11) * 10);
      data[i + 2] = clamp(94 + woven * 0.62 + line * 0.52);
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeFlatPrint(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeFramedPrintPattern(width, height, frame, color) {
  const data = makeSharpPrintPattern(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= frame && x < width - frame && y >= frame && y < height - frame) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeSoftLowDetailPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const wash = Math.sin(x * 0.028) * 30 + Math.cos(y * 0.024) * 24 + Math.sin((x + y) * 0.018) * 18;
      data[i] = clamp(142 + wash);
      data[i + 1] = clamp(126 + wash * 0.82);
      data[i + 2] = clamp(104 + wash * 0.6);
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeSmoothPrintPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const wash = Math.sin(x * 0.23 + y * 0.11) * 24 +
        Math.cos(x * 0.05) * 18 +
        Math.sin((x * x + y * y) * 0.0009) * 20;
      const line = ((x + y) % 17 === 0 || Math.abs(Math.sin(x * 0.17) + Math.cos(y * 0.13)) > 1.88) ? 70 : 0;
      data[i] = clamp(132 + wash + line);
      data[i + 1] = clamp(118 + wash * 0.8 + line * 0.75);
      data[i + 2] = clamp(92 + wash * 0.55 + line * 0.52);
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeSmoothGradientPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const value = 82 +
        (90 * x) / Math.max(1, width - 1) +
        Math.sin(y * 0.04) * 34 +
        Math.sin((x + y) * 0.025) * 20;
      data[i] = clamp(value + 24);
      data[i + 1] = clamp(value * 0.88 + 18);
      data[i + 2] = clamp(value * 0.62 + 12);
      data[i + 3] = 255;
    }
  }
  return data;
}

function posterizePrintPattern(source, levels) {
  const output = new Uint8ClampedArray(source.length);
  const step = 255 / Math.max(1, levels - 1);
  for (let index = 0; index < source.length; index += 4) {
    output[index] = clamp(Math.round(source[index] / step) * step);
    output[index + 1] = clamp(Math.round(source[index + 1] / step) * step);
    output[index + 2] = clamp(Math.round(source[index + 2] / step) * step);
    output[index + 3] = 255;
  }
  return output;
}

function makeBlockyCompressionPattern(width, height, block) {
  const base = makeSmoothPrintPattern(width, height);
  const output = new Uint8ClampedArray(base);

  for (let y = 0; y < height; y += block) {
    for (let x = 0; x < width; x += block) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let yy = y; yy < Math.min(height, y + block); yy += 1) {
        for (let xx = x; xx < Math.min(width, x + block); xx += 1) {
          const index = (yy * width + xx) * 4;
          r += base[index];
          g += base[index + 1];
          b += base[index + 2];
          count += 1;
        }
      }

      const bias = Math.round(Math.sin(x * 0.37 + y * 0.23) * 10 + (((x / block + y / block) % 2) ? 7 : -7));
      r = r / Math.max(1, count) + bias;
      g = g / Math.max(1, count) + bias * 0.85;
      b = b / Math.max(1, count) + bias * 0.6;

      for (let yy = y; yy < Math.min(height, y + block); yy += 1) {
        for (let xx = x; xx < Math.min(width, x + block); xx += 1) {
          const index = (yy * width + xx) * 4;
          const grain = ((xx + yy) % 5) - 2;
          output[index] = clamp(r + grain);
          output[index + 1] = clamp(g + grain);
          output[index + 2] = clamp(b + grain);
          output[index + 3] = 255;
        }
      }
    }
  }

  return output;
}

function makeSharpenHaloPattern(width, height) {
  const data = makeSmoothPrintPattern(width, height);

  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const diagonal = (x + y) % 28;
      const secondDiagonal = (x * 2 - y + width) % 37;
      const distance = Math.min(diagonal, 28 - diagonal, secondDiagonal, 37 - secondDiagonal);
      const index = (y * width + x) * 4;

      if (distance === 0) {
        data[index] = 34;
        data[index + 1] = 28;
        data[index + 2] = 22;
      } else if (distance <= 1) {
        data[index] = 238;
        data[index + 1] = 228;
        data[index + 2] = 204;
      }
    }
  }

  return data;
}

function downsampleNearest(source, width, height, targetWidth, targetHeight) {
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.floor((x * width) / targetWidth);
      const sy = Math.floor((y * height) / targetHeight);
      const sourceIndex = (sy * width + sx) * 4;
      const outputIndex = (y * targetWidth + x) * 4;
      output[outputIndex] = source[sourceIndex];
      output[outputIndex + 1] = source[sourceIndex + 1];
      output[outputIndex + 2] = source[sourceIndex + 2];
      output[outputIndex + 3] = 255;
    }
  }
  return output;
}

function upscaleNearest(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.floor((x * sourceWidth) / targetWidth);
      const sy = Math.floor((y * sourceHeight) / targetHeight);
      const sourceIndex = (sy * sourceWidth + sx) * 4;
      const outputIndex = (y * targetWidth + x) * 4;
      output[outputIndex] = source[sourceIndex];
      output[outputIndex + 1] = source[sourceIndex + 1];
      output[outputIndex + 2] = source[sourceIndex + 2];
      output[outputIndex + 3] = 255;
    }
  }
  return output;
}

function makeCenteredMotifPattern(width, height) {
  const data = makeFlatPrint(width, height, [176, 168, 152]);
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.24;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const i = (y * width + x) * 4;
      const petal = Math.sin(Math.atan2(dy, dx) * 8) * 36;
      const rings = Math.sin(distance * 0.52) * 42;
      const vein = ((x + y) % 13 === 0 || (x * 2 - y) % 17 === 0) ? 88 : 0;
      const fade = 1 - distance / radius;
      data[i] = clamp(120 + (petal + rings + vein) * fade);
      data[i + 1] = clamp(94 + (petal * 0.7 + rings * 0.6 + vein * 0.5) * fade);
      data[i + 2] = clamp(82 + (petal * 0.45 + rings * 0.4 + vein * 0.35) * fade);
    }
  }

  return data;
}

function makeMirroredAxisPattern(width, height, direction) {
  const data = makeSharpPrintPattern(width, height);
  const horizontal = direction === "horizontal";
  const cross = horizontal ? height : width;
  const length = horizontal ? width : height;
  const center = Math.floor(cross / 2);
  const band = Math.max(14, Math.round(cross * 0.16));

  for (let along = 0; along < length; along += 1) {
    for (let offset = 0; offset < band; offset += 1) {
      const sourceCross = Math.max(0, center - 1 - offset);
      const targetCross = Math.min(cross - 1, center + offset);
      const sx = horizontal ? along : sourceCross;
      const sy = horizontal ? sourceCross : along;
      const tx = horizontal ? along : targetCross;
      const ty = horizontal ? targetCross : along;
      const source = (sy * width + sx) * 4;
      const target = (ty * width + tx) * 4;
      data[target] = data[source];
      data[target + 1] = data[source + 1];
      data[target + 2] = data[source + 2];
      data[target + 3] = 255;
    }
  }

  return data;
}

function makePreTiledPreviewPattern(width, height) {
  const tileW = Math.floor(width / 2);
  const tileH = Math.floor(height / 2);
  const tile = makeSharpPrintPattern(tileW, tileH);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x % tileW;
      const sy = y % tileH;
      const source = (sy * tileW + sx) * 4;
      const target = (y * width + x) * 4;
      data[target] = tile[source];
      data[target + 1] = tile[source + 1];
      data[target + 2] = tile[source + 2];
      data[target + 3] = 255;
    }
  }

  return data;
}

function boxBlur(source, width, height, radius) {
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let count = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          const sy = Math.max(0, Math.min(height - 1, y + dy));
          const i = (sy * width + sx) * 4;
          r += source[i];
          g += source[i + 1];
          b += source[i + 2];
          count += 1;
        }
      }
      output[out] = Math.round(r / count);
      output[out + 1] = Math.round(g / count);
      output[out + 2] = Math.round(b / count);
      output[out + 3] = 255;
    }
  }
  return output;
}

function softenSeamBand(data, width, height, direction, band, radius) {
  const blurred = boxBlur(data, width, height, radius);
  const horizontal = direction === "horizontal";

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const active = horizontal ? y < band || y >= height - band : x < band || x >= width - band;
      if (!active) continue;
      const i = (y * width + x) * 4;
      data[i] = blurred[i];
      data[i + 1] = blurred[i + 1];
      data[i + 2] = blurred[i + 2];
      data[i + 3] = 255;
    }
  }
}

function makePeriodicPattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const px = (Math.PI * 2 * x) / Math.max(1, width - 1);
      const py = (Math.PI * 2 * y) / Math.max(1, height - 1);
      data[i] = clamp(124 + Math.sin(px) * 26 + Math.cos(py * 2) * 14);
      data[i + 1] = clamp(112 + Math.cos(py) * 24 + Math.sin(px * 3) * 10);
      data[i + 2] = clamp(138 + Math.sin(px + py) * 18 + Math.cos(py * 2) * 9);
      data[i + 3] = 255;
    }
  }
  return data;
}

function paintMatchingFlatBand(data, width, height, direction, band, color) {
  const horizontal = direction === "horizontal";
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const active = horizontal ? y < band || y >= height - band : x < band || x >= width - band;
      if (!active) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
    }
  }
}

function paintMatchingLine(data, width, height, direction, band, color) {
  const horizontal = direction === "horizontal";
  for (let d = 0; d < band; d += 1) {
    for (let position = 0; position < (horizontal ? width : height); position += 1) {
      const points = horizontal
        ? [[position, d], [position, height - 1 - d]]
        : [[d, position], [width - 1 - d, position]];
      for (const [x, y] of points) {
        const i = (y * width + x) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
      }
    }
  }
}

function paintShiftedMatchingEdge(data, width, height, direction, depth, shift) {
  const source = new Uint8ClampedArray(data);
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  for (let offset = 0; offset < depth; offset += 1) {
    for (let along = 0; along < length; along += 1) {
      const shiftedAlong = wrapIndex(along - shift, length);
      const sourceX = horizontal ? along : offset;
      const sourceY = horizontal ? offset : along;
      const targetX = horizontal ? shiftedAlong : width - 1 - offset;
      const targetY = horizontal ? height - 1 - offset : shiftedAlong;
      const sourceIndex = (sourceY * width + sourceX) * 4;
      const targetIndex = (targetY * width + targetX) * 4;
      data[targetIndex] = source[sourceIndex];
      data[targetIndex + 1] = source[sourceIndex + 1];
      data[targetIndex + 2] = source[sourceIndex + 2];
      data[targetIndex + 3] = 255;
    }
  }
}

function paintFinalEdgePixels(data, width, height, direction, firstColor, secondColor) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  for (let position = 0; position < length; position += 1) {
    const firstX = horizontal ? position : 0;
    const firstY = horizontal ? 0 : position;
    const secondX = horizontal ? position : width - 1;
    const secondY = horizontal ? height - 1 : position;
    const first = (firstY * width + firstX) * 4;
    const second = (secondY * width + secondX) * 4;
    data[first] = firstColor[0];
    data[first + 1] = firstColor[1];
    data[first + 2] = firstColor[2];
    data[second] = secondColor[0];
    data[second + 1] = secondColor[1];
    data[second + 2] = secondColor[2];
  }
}

function paintMatchingCornerSpot(data, width, height, radius, color) {
  const corners = [
    [0, 0, 1, 1],
    [width - 1, 0, -1, 1],
    [0, height - 1, 1, -1],
    [width - 1, height - 1, -1, -1],
  ];

  for (const [originX, originY, sx, sy] of corners) {
    for (let dy = 0; dy < radius; dy += 1) {
      for (let dx = 0; dx < radius; dx += 1) {
        if (Math.hypot(dx, dy) > radius) continue;
        const x = originX + dx * sx;
        const y = originY + dy * sy;
        const i = (y * width + x) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = 255;
      }
    }
  }
}

function paintBand(data, width, height, side, color) {
  const band = 6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const active =
        (side === "top" && y < band) ||
        (side === "bottom" && y >= height - band) ||
        (side === "left" && x < band) ||
        (side === "right" && x >= width - band);
      if (!active) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
    }
  }
}

function measureEdgeBandArtifactCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(6, Math.min(34, Math.round(cross * 0.014)));
  const innerGap = Math.max(depth * 3, Math.round(cross * 0.04));
  const windowSize = Math.max(24, Math.min(96, Math.round(length / 24)));
  const windowStep = Math.max(10, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(Math.min(windowSize, depth) / 10));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let flatWindows = 0;
  let shiftWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let seamShiftTotal = 0;
    let bandShiftTotal = 0;
    let edgeActivityTotal = 0;
    let innerActivityTotal = 0;
    let sampleCount = 0;

    for (let position = start; position < end; position += sampleStep) {
      for (let offset = 0; offset < depth; offset += sampleStep) {
        const aCross = offset;
        const bCross = cross - 1 - offset;
        const innerA = Math.min(cross - 1, offset + innerGap);
        const innerB = Math.max(0, cross - 1 - offset - innerGap);
        const nextA = Math.min(cross - 1, aCross + sampleStep);
        const nextB = Math.max(0, bCross - sampleStep);
        const nextInnerA = Math.min(cross - 1, innerA + sampleStep);
        const nextInnerB = Math.max(0, innerB - sampleStep);
        const ax = horizontal ? position : aCross;
        const ay = horizontal ? aCross : position;
        const bx = horizontal ? position : bCross;
        const by = horizontal ? bCross : position;
        const iax = horizontal ? position : innerA;
        const iay = horizontal ? innerA : position;
        const ibx = horizontal ? position : innerB;
        const iby = horizontal ? innerB : position;
        const nax = horizontal ? position : nextA;
        const nay = horizontal ? nextA : position;
        const nbx = horizontal ? position : nextB;
        const nby = horizontal ? nextB : position;
        const niax = horizontal ? position : nextInnerA;
        const niay = horizontal ? nextInnerA : position;
        const nibx = horizontal ? position : nextInnerB;
        const niby = horizontal ? nextInnerB : position;

        seamShiftTotal += pixelDistance(data, width, ax, ay, bx, by);
        bandShiftTotal += (
          pixelDistance(data, width, ax, ay, iax, iay) +
          pixelDistance(data, width, bx, by, ibx, iby)
        ) / 2;
        edgeActivityTotal += (
          pixelDistance(data, width, ax, ay, nax, nay) +
          pixelDistance(data, width, bx, by, nbx, nby)
        ) / 2;
        innerActivityTotal += (
          pixelDistance(data, width, iax, iay, niax, niay) +
          pixelDistance(data, width, ibx, iby, nibx, niby)
        ) / 2;
        sampleCount += 1;
      }
    }

    const seamShift = seamShiftTotal / Math.max(1, sampleCount);
    const bandShift = bandShiftTotal / Math.max(1, sampleCount);
    const edgeActivity = edgeActivityTotal / Math.max(1, sampleCount);
    const innerActivity = innerActivityTotal / Math.max(1, sampleCount);
    const activityDrop = Math.max(0, innerActivity - edgeActivity);
    const stripScore = Math.max(0, bandShift - innerActivity * 0.2) * 0.52 + activityDrop * 0.95 + Math.max(0, seamShift - edgeActivity * 0.45) * 0.18;

    total += stripScore;
    count += 1;
    worstScore = Math.max(worstScore, stripScore);
    if (activityDrop > 7.5 && bandShift > 9) flatWindows += 1;
    if (bandShift > 14 || stripScore > 14) shiftWindows += 1;
  }

  const score = total / Math.max(1, count);
  const flatRatio = flatWindows / Math.max(1, count);
  const shiftRatio = shiftWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    flatWindows,
    shiftWindows,
    flatRatio,
    shiftRatio,
    bandRisk: worstScore > 20 || score > 12 || (flatWindows >= 2 && flatRatio > 0.06) || (shiftWindows >= 2 && shiftRatio > 0.08),
  };
}

function measureOuterFrameArtifactCore(data, width, height) {
  const size = Math.min(width, height);
  const frameDepth = Math.max(8, Math.min(72, Math.round(size * 0.055)));
  const innerOffset = Math.max(frameDepth * 2, Math.round(size * 0.14));
  const sideStats = [
    measureFrameSideCore(data, width, height, 0, 0, width, frameDepth, 0, innerOffset, width, Math.min(height, innerOffset + frameDepth)),
    measureFrameSideCore(data, width, height, 0, height - frameDepth, width, height, 0, Math.max(0, height - innerOffset - frameDepth), width, Math.max(0, height - innerOffset)),
    measureFrameSideCore(data, width, height, 0, 0, frameDepth, height, innerOffset, 0, Math.min(width, innerOffset + frameDepth), height),
    measureFrameSideCore(data, width, height, width - frameDepth, 0, width, height, Math.max(0, width - innerOffset - frameDepth), 0, Math.max(0, width - innerOffset), height),
  ];
  const riskSides = sideStats.filter((side) => side.risk).length;
  const score = sideStats.reduce((sum, side) => sum + side.score, 0) / Math.max(1, sideStats.length);
  const worstScore = Math.max(...sideStats.map((side) => side.score));
  const averageEdgeActivity = sideStats.reduce((sum, side) => sum + side.edge.activity, 0) / Math.max(1, sideStats.length);
  const averageInnerActivity = sideStats.reduce((sum, side) => sum + side.inner.activity, 0) / Math.max(1, sideStats.length);

  return {
    score,
    worstScore,
    riskSides,
    averageEdgeActivity,
    averageInnerActivity,
    sides: sideStats,
    frameRisk: riskSides >= 3 || (riskSides >= 2 && score > 9.5 && worstScore > 14),
  };
}

function measureFrameSideCore(data, width, height, ex0, ey0, ex1, ey1, ix0, iy0, ix1, iy1) {
  const edge = measureFrameRegionCore(data, width, height, ex0, ey0, ex1, ey1);
  const inner = measureFrameRegionCore(data, width, height, ix0, iy0, ix1, iy1);
  const activityDrop = Math.max(0, inner.activity - edge.activity);
  const flatDrop = Math.max(0, inner.lumStd - edge.lumStd);
  const lumShift = Math.abs(edge.lumMean - inner.lumMean);
  const extremeFlatEdge = edge.lumStd < 4.5 && (edge.lumMean > 226 || edge.lumMean < 28);
  const frameLike = (
    inner.activity > 4.6 &&
    edge.activity < Math.max(2.8, inner.activity * 0.46) &&
    edge.lumStd < Math.max(8, inner.lumStd * 0.72) &&
    (lumShift > 10 || activityDrop > 4.8 || extremeFlatEdge)
  );
  const score = activityDrop * 0.86 + flatDrop * 0.32 + Math.max(0, lumShift - 8) * 0.38 + (extremeFlatEdge ? 8 : 0);

  return {
    edge,
    inner,
    activityDrop,
    flatDrop,
    lumShift,
    score,
    risk: frameLike && score > 6.8,
  };
}

function measureFrameRegionCore(data, width, height, x0, y0, x1, y1) {
  const left = Math.max(1, Math.min(width - 2, Math.round(x0)));
  const top = Math.max(1, Math.min(height - 2, Math.round(y0)));
  const right = Math.max(left + 1, Math.min(width - 1, Math.round(x1)));
  const bottom = Math.max(top + 1, Math.min(height - 1, Math.round(y1)));
  const step = Math.max(1, Math.round(Math.max(right - left, bottom - top) / 96));
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let activityTotal = 0;
  let count = 0;

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const luminance = pixelLuminance(data, width, x, y);
      const detail = pixelDetailAt(data, width, height, x, y);
      lumTotal += luminance;
      lumSquareTotal += luminance * luminance;
      activityTotal += detail.gradient * 0.48 + detail.detail * 0.88;
      count += 1;
    }
  }

  const lumMean = lumTotal / Math.max(1, count);
  const lumStd = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - lumMean * lumMean));
  const activity = activityTotal / Math.max(1, count);
  return {
    lumMean,
    lumStd,
    activity,
  };
}

function measureSeamDetailLossCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const band = Math.max(5, Math.min(28, Math.round(cross * 0.012)));
  const innerGap = Math.max(band * 4, Math.round(cross * 0.055));
  const windowSize = Math.max(28, Math.min(128, Math.round(length / 24)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(band / 7));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let softWindows = 0;
  let activeWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let edgeDetailTotal = 0;
    let innerDetailTotal = 0;
    let edgeGradientTotal = 0;
    let innerGradientTotal = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 2, Math.max(1, along));

      for (let depth = 1; depth <= band; depth += depthStep) {
        const aCross = Math.min(cross - 2, Math.max(1, depth));
        const bCross = Math.max(1, cross - 1 - depth);
        const innerA = Math.min(cross - 2, depth + innerGap);
        const innerB = Math.max(1, cross - 1 - depth - innerGap);
        const ax = horizontal ? safeAlong : aCross;
        const ay = horizontal ? aCross : safeAlong;
        const bx = horizontal ? safeAlong : bCross;
        const by = horizontal ? bCross : safeAlong;
        const iax = horizontal ? safeAlong : innerA;
        const iay = horizontal ? innerA : safeAlong;
        const ibx = horizontal ? safeAlong : innerB;
        const iby = horizontal ? innerB : safeAlong;
        const edgeA = pixelDetailAt(data, width, height, ax, ay);
        const edgeB = pixelDetailAt(data, width, height, bx, by);
        const innerDetailA = pixelDetailAt(data, width, height, iax, iay);
        const innerDetailB = pixelDetailAt(data, width, height, ibx, iby);

        edgeDetailTotal += (edgeA.detail + edgeB.detail) / 2;
        innerDetailTotal += (innerDetailA.detail + innerDetailB.detail) / 2;
        edgeGradientTotal += (edgeA.gradient + edgeB.gradient) / 2;
        innerGradientTotal += (innerDetailA.gradient + innerDetailB.gradient) / 2;
        sampleCount += 1;
      }
    }

    const edgeDetail = edgeDetailTotal / Math.max(1, sampleCount);
    const innerDetail = innerDetailTotal / Math.max(1, sampleCount);
    const edgeGradient = edgeGradientTotal / Math.max(1, sampleCount);
    const innerGradient = innerGradientTotal / Math.max(1, sampleCount);
    const detailLoss = Math.max(0, innerDetail - edgeDetail);
    const gradientLoss = Math.max(0, innerGradient - edgeGradient);
    const lossRatio = detailLoss / Math.max(1, innerDetail);
    const activeInterior = innerDetail > 3.8 || innerGradient > 7.5;
    const windowScore = activeInterior
      ? detailLoss * 1.18 + Math.max(0, lossRatio - 0.32) * 16 + gradientLoss * 0.18
      : 0;

    total += windowScore;
    count += 1;
    worstScore = Math.max(worstScore, windowScore);
    if (activeInterior) activeWindows += 1;
    if (
      activeInterior &&
      (windowScore > 10.5 || (lossRatio > 0.48 && detailLoss > 2.6 && gradientLoss > 2.5))
    ) {
      softWindows += 1;
    }
  }

  const score = total / Math.max(1, count);
  const softRatio = softWindows / Math.max(1, count);
  const activeRatio = activeWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    softWindows,
    activeWindows,
    softRatio,
    activeRatio,
    detailLossRisk: worstScore > 17 || score > 9.2 || (softWindows >= 2 && softRatio > 0.08 && activeRatio > 0.18),
  };
}

function measureEdgeDriftCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(4, Math.min(18, Math.round(cross * 0.012)));
  const maxShift = Math.max(4, Math.min(24, Math.round(length * 0.05)));
  const windowSize = Math.max(28, Math.min(132, Math.round(length / 22)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.48));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(depth / 6));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let shiftedWindows = 0;
  let totalShift = 0;
  let worstShift = 0;
  let dominantShift = 0;
  let bestConfidence = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let activityTotal = 0;
    let activityCount = 0;

    for (let position = start; position < end; position += sampleStep) {
      const along = Math.min(length - 1, position);
      const nextAlong = wrapIndex(along + sampleStep, length);
      for (let offset = 0; offset < depth; offset += depthStep) {
        const aCross = offset;
        const bCross = cross - 1 - offset;
        const innerA = Math.min(cross - 1, offset + depthStep);
        const innerB = Math.max(0, cross - 1 - offset - depthStep);
        const ax = horizontal ? along : aCross;
        const ay = horizontal ? aCross : along;
        const bx = horizontal ? along : bCross;
        const by = horizontal ? bCross : along;
        const anx = horizontal ? nextAlong : innerA;
        const any = horizontal ? innerA : nextAlong;
        const bnx = horizontal ? nextAlong : innerB;
        const bny = horizontal ? innerB : nextAlong;

        activityTotal += (
          pixelDistance(data, width, ax, ay, anx, any) +
          pixelDistance(data, width, bx, by, bnx, bny)
        ) / 2;
        activityCount += 1;
      }
    }

    const edgeActivity = activityTotal / Math.max(1, activityCount);
    let zeroDiff = Infinity;
    let bestDiff = Infinity;
    let bestShift = 0;

    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
      let diffTotal = 0;
      let sampleCount = 0;

      for (let position = start; position < end; position += sampleStep) {
        const alongA = Math.min(length - 1, position);
        const alongB = wrapIndex(alongA + shift, length);
        for (let offset = 0; offset < depth; offset += depthStep) {
          const ax = horizontal ? alongA : offset;
          const ay = horizontal ? offset : alongA;
          const bx = horizontal ? alongB : width - 1 - offset;
          const by = horizontal ? height - 1 - offset : alongB;
          diffTotal += pixelDistance(data, width, ax, ay, bx, by);
          sampleCount += 1;
        }
      }

      const diff = diffTotal / Math.max(1, sampleCount);
      if (shift === 0) zeroDiff = diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestShift = shift;
      }
    }

    const improvement = Math.max(0, zeroDiff - bestDiff);
    const shiftAbs = Math.abs(bestShift);
    const confidence = improvement / Math.max(1, zeroDiff);
    const explainableShift = (
      shiftAbs >= 2 &&
      zeroDiff > 8 &&
      edgeActivity > 3.5 &&
      bestDiff < zeroDiff * 0.78 &&
      improvement > Math.max(3.2, edgeActivity * 0.16)
    );
    const driftScore = explainableShift
      ? improvement * Math.min(1, shiftAbs / 6) * (0.65 + Math.min(0.55, confidence)) + Math.max(0, zeroDiff - bestDiff * 1.32) * 0.35
      : 0;

    total += driftScore;
    count += 1;
    if (driftScore > worstScore) {
      worstScore = driftScore;
      worstShift = shiftAbs;
      dominantShift = bestShift;
      bestConfidence = confidence;
    }
    if (driftScore > 8 && shiftAbs >= 2) {
      shiftedWindows += 1;
      totalShift += shiftAbs;
    }
  }

  const score = total / Math.max(1, count);
  const shiftedRatio = shiftedWindows / Math.max(1, count);
  const averageShift = totalShift / Math.max(1, shiftedWindows);
  return {
    score,
    worstScore,
    shiftedWindows,
    shiftedRatio,
    averageShift,
    worstShift,
    dominantShift,
    confidence: bestConfidence,
    driftRisk: worstScore > 13.5 || score > 8.5 || (shiftedWindows >= 2 && shiftedRatio > 0.08 && averageShift >= 2.4 && worstScore > 9.5),
  };
}

function measureFullSizeEdgeArtifactCore(data, width, height) {
  const horizontal = measureFullSizeEdgeStripCore(data, width, height, "horizontal");
  const vertical = measureFullSizeEdgeStripCore(data, width, height, "vertical");
  return {
    score: Math.max(horizontal.score, vertical.score),
    peakRatio: Math.max(horizontal.peakRatio, vertical.peakRatio),
    horizontal,
    vertical,
    edgeRisk: horizontal.edgeRisk || vertical.edgeRisk,
  };
}

function measureFullSizeEdgeStripCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  let seamTotal = 0;
  let seamWorst = 0;
  let seamPeaks = 0;
  let lineTotal = 0;
  let lineWorst = 0;
  let linePeaks = 0;
  let count = 0;

  for (let position = 0; position < length; position += 1) {
    const topOuter = fullSizeEdgePointCore(position, 0, width, height, horizontal);
    const bottomOuter = fullSizeEdgePointCore(position, 0, width, height, horizontal, true);
    const topInner = fullSizeEdgePointCore(position, 1, width, height, horizontal);
    const bottomInner = fullSizeEdgePointCore(position, 1, width, height, horizontal, true);
    const topInner2 = fullSizeEdgePointCore(position, 2, width, height, horizontal);
    const bottomInner2 = fullSizeEdgePointCore(position, 2, width, height, horizontal, true);
    const seam = pixelDistance(data, width, topOuter.x, topOuter.y, bottomOuter.x, bottomOuter.y);
    const topJump = pixelDistance(data, width, topOuter.x, topOuter.y, topInner.x, topInner.y);
    const bottomJump = pixelDistance(data, width, bottomOuter.x, bottomOuter.y, bottomInner.x, bottomInner.y);
    const innerActivity = (
      pixelDistance(data, width, topInner.x, topInner.y, topInner2.x, topInner2.y) +
      pixelDistance(data, width, bottomInner.x, bottomInner.y, bottomInner2.x, bottomInner2.y)
    ) / 2;
    const edgeJump = (topJump + bottomJump) / 2;
    const lineScore = Math.max(0, edgeJump - innerActivity * 1.8 - 7);

    seamTotal += seam;
    seamWorst = Math.max(seamWorst, seam);
    lineTotal += lineScore;
    lineWorst = Math.max(lineWorst, lineScore);
    if (seam > Math.max(18, innerActivity * 2 + 6)) seamPeaks += 1;
    if (lineScore > 8 && edgeJump > 22) linePeaks += 1;
    count += 1;
  }

  const seamAverage = seamTotal / Math.max(1, count);
  const seamPeakRatio = seamPeaks / Math.max(1, count);
  const lineAverage = lineTotal / Math.max(1, count);
  const linePeakRatio = linePeaks / Math.max(1, count);
  const score = seamAverage * 0.55 + seamPeakRatio * 95 + lineAverage * 0.7 + linePeakRatio * 70;
  const edgeRisk = (
    (seamAverage > 9.5 && seamPeakRatio > 0.025) ||
    (seamWorst > 48 && seamPeakRatio > 0.012) ||
    (lineAverage > 7.5 && linePeakRatio > 0.08 && lineWorst > 18) ||
    score > 22
  );

  return {
    score,
    peakRatio: Math.max(seamPeakRatio, linePeakRatio),
    seamAverage,
    seamWorst,
    seamPeakRatio,
    lineAverage,
    lineWorst,
    linePeakRatio,
    edgeRisk,
  };
}

function fullSizeEdgePointCore(position, offset, width, height, horizontal, secondSide = false) {
  if (horizontal) {
    return {
      x: position,
      y: secondSide ? height - 1 - offset : offset,
    };
  }
  return {
    x: secondSide ? width - 1 - offset : offset,
    y: position,
  };
}

function measureTiledCornerJunctionCore(data, width, height) {
  const size = Math.min(width, height);
  const radius = Math.max(8, Math.min(48, Math.round(size * 0.018)));
  const innerGap = Math.max(radius * 3, Math.round(size * 0.055));
  const sampleStep = Math.max(1, Math.round(radius / 8));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let spotSamples = 0;
  let seamSamples = 0;
  let haloSamples = 0;
  let centerJumpTotal = 0;
  let haloShiftTotal = 0;
  let activityTotal = 0;

  for (let dy = 0; dy < radius; dy += sampleStep) {
    for (let dx = 0; dx < radius; dx += sampleStep) {
      const br = { x: width - 1 - dx, y: height - 1 - dy };
      const bl = { x: dx, y: height - 1 - dy };
      const tr = { x: width - 1 - dx, y: dy };
      const tl = { x: dx, y: dy };
      const ibr = { x: Math.max(0, br.x - innerGap), y: Math.max(0, br.y - innerGap) };
      const ibl = { x: Math.min(width - 1, bl.x + innerGap), y: Math.max(0, bl.y - innerGap) };
      const itr = { x: Math.max(0, tr.x - innerGap), y: Math.min(height - 1, tr.y + innerGap) };
      const itl = { x: Math.min(width - 1, tl.x + innerGap), y: Math.min(height - 1, tl.y + innerGap) };
      const nbr = { x: Math.max(0, br.x - sampleStep), y: Math.max(0, br.y - sampleStep) };
      const nbl = { x: Math.min(width - 1, bl.x + sampleStep), y: Math.max(0, bl.y - sampleStep) };
      const ntr = { x: Math.max(0, tr.x - sampleStep), y: Math.min(height - 1, tr.y + sampleStep) };
      const ntl = { x: Math.min(width - 1, tl.x + sampleStep), y: Math.min(height - 1, tl.y + sampleStep) };

      const verticalJump = (
        pixelDistance(data, width, br.x, br.y, bl.x, bl.y) +
        pixelDistance(data, width, tr.x, tr.y, tl.x, tl.y)
      ) / 2;
      const horizontalJump = (
        pixelDistance(data, width, br.x, br.y, tr.x, tr.y) +
        pixelDistance(data, width, bl.x, bl.y, tl.x, tl.y)
      ) / 2;
      const diagonalJump = (
        pixelDistance(data, width, br.x, br.y, tl.x, tl.y) +
        pixelDistance(data, width, bl.x, bl.y, tr.x, tr.y)
      ) / 2;
      const cornerToInner = (
        pixelDistance(data, width, br.x, br.y, ibr.x, ibr.y) +
        pixelDistance(data, width, bl.x, bl.y, ibl.x, ibl.y) +
        pixelDistance(data, width, tr.x, tr.y, itr.x, itr.y) +
        pixelDistance(data, width, tl.x, tl.y, itl.x, itl.y)
      ) / 4;
      const localActivity = (
        pixelDistance(data, width, br.x, br.y, nbr.x, nbr.y) +
        pixelDistance(data, width, bl.x, bl.y, nbl.x, nbl.y) +
        pixelDistance(data, width, tr.x, tr.y, ntr.x, ntr.y) +
        pixelDistance(data, width, tl.x, tl.y, ntl.x, ntl.y)
      ) / 4;
      const innerActivity = (
        pixelDistance(data, width, ibr.x, ibr.y, Math.max(0, ibr.x - sampleStep), Math.max(0, ibr.y - sampleStep)) +
        pixelDistance(data, width, ibl.x, ibl.y, Math.min(width - 1, ibl.x + sampleStep), Math.max(0, ibl.y - sampleStep)) +
        pixelDistance(data, width, itr.x, itr.y, Math.max(0, itr.x - sampleStep), Math.min(height - 1, itr.y + sampleStep)) +
        pixelDistance(data, width, itl.x, itl.y, Math.min(width - 1, itl.x + sampleStep), Math.min(height - 1, itl.y + sampleStep))
      ) / 4;
      const centerJump = Math.max(verticalJump, horizontalJump);
      const gradientBudget = Math.max(
        5.5,
        innerActivity * 0.34,
        localActivity * Math.min(18, innerGap / Math.max(1, sampleStep)) * 0.74,
      );
      const haloShift = Math.max(0, cornerToInner - gradientBudget);
      const activityDrop = Math.max(0, innerActivity - localActivity);
      const seamSpike = Math.max(0, centerJump - Math.max(9, localActivity * 0.72));
      const diagonalSpike = Math.max(0, diagonalJump - Math.max(10, localActivity * 0.8));
      const sampleScore = seamSpike * 0.52 + haloShift * 0.46 + activityDrop * 0.82 + diagonalSpike * 0.22;

      total += sampleScore;
      count += 1;
      centerJumpTotal += centerJump;
      haloShiftTotal += haloShift;
      activityTotal += localActivity;
      worstScore = Math.max(worstScore, sampleScore);
      if (sampleScore > 13) spotSamples += 1;
      if (seamSpike > 9) seamSamples += 1;
      if (haloShift > 13 || activityDrop > 8.5) haloSamples += 1;
    }
  }

  const score = total / Math.max(1, count);
  const spotRatio = spotSamples / Math.max(1, count);
  const seamRatio = seamSamples / Math.max(1, count);
  const haloRatio = haloSamples / Math.max(1, count);
  return {
    score,
    worstScore,
    centerJump: centerJumpTotal / Math.max(1, count),
    haloShift: haloShiftTotal / Math.max(1, count),
    localActivity: activityTotal / Math.max(1, count),
    spotSamples,
    seamSamples,
    haloSamples,
    spotRatio,
    seamRatio,
    haloRatio,
    junctionRisk: worstScore > 18 || score > 9.5 || (spotSamples >= 3 && spotRatio > 0.08) || (haloSamples >= 3 && haloRatio > 0.12) || (seamSamples >= 2 && seamRatio > 0.08),
  };
}

function measureTiledPreviewSeamCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const radius = Math.max(8, Math.min(42, Math.round(cross * 0.016)));
  const innerGap = Math.max(radius * 2, Math.round(cross * 0.045));
  const windowSize = Math.max(24, Math.min(112, Math.round(length / 24)));
  const windowStep = Math.max(10, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(radius / 9));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let peakWindows = 0;
  let haloWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let centerJumpTotal = 0;
    let nearJumpTotal = 0;
    let haloShiftTotal = 0;
    let edgeActivityTotal = 0;
    let innerActivityTotal = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 1, along);
      centerJumpTotal += previewPixelDistance(data, width, safeAlong, -1, safeAlong, 0, horizontal, cross);
      nearJumpTotal += (
        previewPixelDistance(data, width, safeAlong, -2, safeAlong, -1, horizontal, cross) +
        previewPixelDistance(data, width, safeAlong, 0, safeAlong, 1, horizontal, cross)
      ) / 2;

      for (let depth = 0; depth < radius; depth += depthStep) {
        const edgeA = -1 - depth;
        const edgeB = depth;
        const innerA = -1 - depth - innerGap;
        const innerB = depth + innerGap;
        const nextEdgeA = edgeA - depthStep;
        const nextEdgeB = edgeB + depthStep;
        const nextInnerA = innerA - depthStep;
        const nextInnerB = innerB + depthStep;

        haloShiftTotal += (
          previewPixelDistance(data, width, safeAlong, edgeA, safeAlong, innerA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, edgeB, safeAlong, innerB, horizontal, cross)
        ) / 2;
        edgeActivityTotal += (
          previewPixelDistance(data, width, safeAlong, edgeA, safeAlong, nextEdgeA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, edgeB, safeAlong, nextEdgeB, horizontal, cross)
        ) / 2;
        innerActivityTotal += (
          previewPixelDistance(data, width, safeAlong, innerA, safeAlong, nextInnerA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, innerB, safeAlong, nextInnerB, horizontal, cross)
        ) / 2;
        sampleCount += 1;
      }
    }

    const edgeSamples = Math.max(1, Math.ceil((end - start) / sampleStep));
    const centerJump = centerJumpTotal / edgeSamples;
    const nearJump = nearJumpTotal / edgeSamples;
    const haloShift = haloShiftTotal / Math.max(1, sampleCount);
    const edgeActivity = edgeActivityTotal / Math.max(1, sampleCount);
    const innerActivity = innerActivityTotal / Math.max(1, sampleCount);
    const activityDrop = Math.max(0, innerActivity - edgeActivity);
    const lineSpike = Math.max(0, centerJump - nearJump * 1.35 - innerActivity * 0.18);
    const haloScore = Math.max(0, haloShift - innerActivity * 0.24) * 0.5 + activityDrop * 0.82;
    const score = lineSpike * 0.9 + haloScore + Math.max(0, centerJump - edgeActivity * 0.7) * 0.18;

    total += score;
    count += 1;
    worstScore = Math.max(worstScore, score);
    if (lineSpike > 5.5 || centerJump > Math.max(11, nearJump * 2.2)) peakWindows += 1;
    if (haloScore > 11 || activityDrop > 8) haloWindows += 1;
  }

  const score = total / Math.max(1, count);
  const peakRatio = peakWindows / Math.max(1, count);
  const haloRatio = haloWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    peakWindows,
    haloWindows,
    peakRatio,
    haloRatio,
    lineRisk: (
      worstScore > 18 ||
      score > 10.5 ||
      (peakWindows >= 2 && peakRatio > 0.07) ||
      (haloWindows >= 2 && haloRatio > 0.08)
    ),
  };
}

function previewPixelDistance(data, width, alongA, crossA, alongB, crossB, horizontal, crossSize) {
  const normalizedA = wrapIndex(Math.round(crossA), crossSize);
  const normalizedB = wrapIndex(Math.round(crossB), crossSize);
  const x1 = horizontal ? alongA : normalizedA;
  const y1 = horizontal ? normalizedA : alongA;
  const x2 = horizontal ? alongB : normalizedB;
  const y2 = horizontal ? normalizedB : alongB;
  return pixelDistance(data, width, x1, y1, x2, y2);
}

function measurePrintClarityCore(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 260));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const center = pixelLuminance(data, width, x, y);
      const left = pixelLuminance(data, width, x - step, y);
      const right = pixelLuminance(data, width, x + step, y);
      const top = pixelLuminance(data, width, x, y - step);
      const bottom = pixelLuminance(data, width, x, y + step);
      const gradient = (Math.abs(right - left) + Math.abs(bottom - top)) / 2;
      const detail = Math.abs(center * 4 - left - right - top - bottom) / 4;

      gradientTotal += gradient;
      detailTotal += detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const detailRatio = detailScore / Math.max(1, gradientScore);
  const riskScore = Math.max(0, 3.2 - detailScore) + Math.max(0, 0.18 - detailRatio) * 18 + Math.max(0, gradientScore - detailScore * 2.6) * 0.18;
  const softBlurRisk = contrastScore > 10 && gradientScore > 6 && detailScore < 2.2 && detailRatio < 0.26;
  const blurRisk = (contrastScore > 13 && gradientScore > 4.2 && riskScore > 2.6) || softBlurRisk;

  return {
    detailScore,
    gradientScore,
    contrastScore,
    detailRatio,
    riskScore,
    softBlurRisk,
    blurRisk,
  };
}

function measureUpscaleArtifactCore(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 360));
  const rowStep = Math.max(sampleStep * 4, Math.round(height / 84));
  const colStep = Math.max(sampleStep * 4, Math.round(width / 84));
  let flatPairs = 0;
  let strongJumps = 0;
  let stairPairs = 0;
  let runSegments = 0;
  let runLengthTotal = 0;
  let diffTotal = 0;
  let diffSquareTotal = 0;
  let count = 0;

  function scanLine(length, luminanceAt) {
    let previousDiff = null;
    let flatRun = 0;
    for (let position = sampleStep; position < length; position += sampleStep) {
      const diff = Math.abs(luminanceAt(position) - luminanceAt(position - sampleStep));
      diffTotal += diff;
      diffSquareTotal += diff * diff;
      count += 1;

      if (diff < 0.55) {
        flatPairs += 1;
        flatRun += 1;
      } else {
        if (flatRun >= 3) {
          runSegments += 1;
          runLengthTotal += flatRun;
        }
        flatRun = 0;
      }

      if (diff > 11) strongJumps += 1;
      if (
        previousDiff !== null &&
        ((previousDiff < 0.65 && diff > 11) || (previousDiff > 11 && diff < 0.65))
      ) {
        stairPairs += 1;
      }
      previousDiff = diff;
    }

    if (flatRun >= 3) {
      runSegments += 1;
      runLengthTotal += flatRun;
    }
  }

  for (let y = 0; y < height; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = 0; x < width; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const flatPairRatio = flatPairs / Math.max(1, count);
  const strongJumpRatio = strongJumps / Math.max(1, count);
  const stairPairRatio = stairPairs / Math.max(1, count);
  const runRatio = runSegments / Math.max(1, count);
  const averageRun = runLengthTotal / Math.max(1, runSegments);
  const meanDiff = diffTotal / Math.max(1, count);
  const diffVariance = Math.max(0, diffSquareTotal / Math.max(1, count) - meanDiff * meanDiff);
  const diffBurstScore = Math.sqrt(diffVariance) / Math.max(1, meanDiff);
  const artifactScore = flatPairRatio * 22 +
    strongJumpRatio * 18 +
    stairPairRatio * 36 +
    Math.min(8, averageRun) * 0.8 +
    diffBurstScore * 3;
  const upscaleArtifactRisk = (
    flatPairRatio > 0.68 &&
    strongJumpRatio > 0.06 &&
    stairPairRatio > 0.14 &&
    averageRun > 3.4 &&
    artifactScore > 32
  );

  return {
    artifactScore,
    flatPairRatio,
    strongJumpRatio,
    stairPairRatio,
    runRatio,
    averageRun,
    diffBurstScore,
    upscaleArtifactRisk,
  };
}

function measurePosterizationArtifactCore(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 360));
  const rowStep = Math.max(sampleStep * 4, Math.round(height / 90));
  const colStep = Math.max(sampleStep * 4, Math.round(width / 90));
  const toneBins = new Set();
  let flatPairs = 0;
  let bandEdges = 0;
  let moderateJumps = 0;
  let diffCount = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let detailTotal = 0;
  let gradientTotal = 0;
  let sampleCount = 0;

  function scanLine(length, luminanceAt) {
    const values = [];
    for (let position = 0; position < length; position += sampleStep) {
      values.push(luminanceAt(position));
    }
    const diffs = [];
    for (let index = 1; index < values.length; index += 1) {
      diffs.push(Math.abs(values[index] - values[index - 1]));
    }
    for (let index = 0; index < diffs.length; index += 1) {
      const diff = diffs[index];
      const before = index > 0 ? diffs[index - 1] : diff;
      const after = index < diffs.length - 1 ? diffs[index + 1] : diff;
      diffCount += 1;
      if (diff < 0.9) flatPairs += 1;
      if (diff >= 2.6 && diff <= 16) {
        moderateJumps += 1;
        if (before < 1.1 || after < 1.1) {
          bandEdges += 1;
        }
      }
    }
  }

  for (let y = 0; y < height; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = 0; x < width; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const textureStep = Math.max(1, Math.round(Math.max(width, height) / 180));
  for (let y = textureStep; y < height - textureStep; y += textureStep) {
    for (let x = textureStep; x < width - textureStep; x += textureStep) {
      const luminance = pixelLuminance(data, width, x, y);
      const detail = pixelDetailAt(data, width, height, x, y);
      toneBins.add(Math.round(luminance / 3));
      lumTotal += luminance;
      lumSquareTotal += luminance * luminance;
      detailTotal += detail.detail;
      gradientTotal += detail.gradient;
      sampleCount += 1;
    }
  }

  const flatPairRatio = flatPairs / Math.max(1, diffCount);
  const bandEdgeRatio = bandEdges / Math.max(1, diffCount);
  const moderateJumpRatio = moderateJumps / Math.max(1, diffCount);
  const toneBinRatio = toneBins.size / 86;
  const mean = lumTotal / Math.max(1, sampleCount);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, sampleCount) - mean * mean));
  const detailScore = detailTotal / Math.max(1, sampleCount);
  const gradientScore = gradientTotal / Math.max(1, sampleCount);
  const posterizationScore = flatPairRatio * 14 +
    bandEdgeRatio * 38 +
    moderateJumpRatio * 8 +
    Math.max(0, 0.36 - toneBinRatio) * 42 +
    Math.max(0, 2.4 - detailScore) * 2.4;
  const posterizationRisk = (
    contrastScore > 10 &&
    toneBinRatio < 0.29 &&
    flatPairRatio > 0.68 &&
    (bandEdgeRatio > 0.018 || detailScore < 1.6) &&
    posterizationScore > 21.5
  );

  return {
    posterizationScore,
    flatPairRatio,
    bandEdgeRatio,
    moderateJumpRatio,
    toneBinRatio,
    toneBins: toneBins.size,
    contrastScore,
    detailScore,
    gradientScore,
    posterizationRisk,
  };
}

function measureCompressionArtifactCore(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 420));
  const periods = [4, 6, 8, 10, 12, 16, 20, 24].filter((period) => period < Math.min(width, height) / 3);
  let best = {
    period: 0,
    blockScore: 0,
    gridScore: 0,
    boundaryRatio: 0,
    boundaryAvg: 0,
    interiorAvg: 0,
    peakRatio: 0,
    axisBalance: 0,
    flatBlockRatio: 0,
    blockMeanJump: 0,
    blockStd: 0,
    localTexture: 0,
  };
  let detailTotal = 0;
  let gradientTotal = 0;
  let textureCount = 0;
  const textureStep = Math.max(1, Math.round(Math.max(width, height) / 180));

  for (let y = textureStep; y < height - textureStep; y += textureStep) {
    for (let x = textureStep; x < width - textureStep; x += textureStep) {
      const detail = pixelDetailAt(data, width, height, x, y);
      detailTotal += detail.detail;
      gradientTotal += detail.gradient;
      textureCount += 1;
    }
  }

  const localTexture = (detailTotal * 0.68 + gradientTotal * 0.32) / Math.max(1, textureCount);

  for (const period of periods) {
    const vertical = measureCompressionGridAxisCore(data, width, height, period, false, sampleStep);
    const horizontal = measureCompressionGridAxisCore(data, width, height, period, true, sampleStep);
    const blocks = measureCompressionBlocksCore(data, width, height, period, localTexture);
    const boundaryRatio = (vertical.boundaryRatio + horizontal.boundaryRatio) / 2;
    const peakRatio = (vertical.peakRatio + horizontal.peakRatio) / 2;
    const boundaryAvg = (vertical.boundaryAvg + horizontal.boundaryAvg) / 2;
    const interiorAvg = (vertical.interiorAvg + horizontal.interiorAvg) / 2;
    const axisBalance = Math.min(vertical.peakRatio, horizontal.peakRatio) / Math.max(0.001, Math.max(vertical.peakRatio, horizontal.peakRatio));
    const gridScore = Math.max(0, boundaryRatio - 1.24) * 12 +
      peakRatio * 44 +
      Math.max(0, boundaryAvg - interiorAvg - 1.8) * 0.55 +
      blocks.flatBlockRatio * 5 +
      Math.max(0, blocks.blockMeanJump - localTexture * 0.72) * 0.22 +
      axisBalance * 2;
    const compressionEvidence = Math.max(0, blocks.flatBlockRatio - 0.24) * 2.4 +
      Math.max(0, blocks.blockMeanJump / Math.max(1, localTexture) - 0.88) * 0.62 +
      Math.max(0, 5.5 - interiorAvg) * 0.18;
    const blockScore = gridScore * Math.min(1.25, compressionEvidence);

    if (blockScore > best.blockScore) {
      best = {
        period,
        blockScore,
        gridScore,
        boundaryRatio,
        boundaryAvg,
        interiorAvg,
        peakRatio,
        axisBalance,
        flatBlockRatio: blocks.flatBlockRatio,
        blockMeanJump: blocks.blockMeanJump,
        blockStd: blocks.blockStd,
        localTexture,
      };
    }
  }

  const compressionRisk = best.blockScore > 18 &&
    best.peakRatio > 0.1 &&
    best.boundaryRatio > 1.42 &&
    best.axisBalance > 0.28 &&
    (
      best.flatBlockRatio > 0.28 ||
      best.blockMeanJump > best.localTexture * 0.9 ||
      best.interiorAvg < 4.8
    );

  return {
    ...best,
    compressionRisk,
  };
}

function measureSharpenHaloArtifactCore(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 420));
  const rowStep = Math.max(sampleStep * 3, Math.round(height / 120));
  const colStep = Math.max(sampleStep * 3, Math.round(width / 120));
  let haloSamples = 0;
  let severeSamples = 0;
  let count = 0;
  let scoreTotal = 0;
  let contrastTotal = 0;

  function scanLine(length, luminanceAt) {
    for (let position = sampleStep * 2; position < length - sampleStep * 2; position += sampleStep) {
      const a = luminanceAt(position - sampleStep * 2);
      const b = luminanceAt(position - sampleStep);
      const c = luminanceAt(position);
      const d = luminanceAt(position + sampleStep);
      const e = luminanceAt(position + sampleStep * 2);
      const outer = (a + e) / 2;
      const ring = (b + d) / 2;
      const darkCore = c < outer - 18 && b > Math.max(a, c) + 8 && d > Math.max(e, c) + 8;
      const lightCore = c > outer + 18 && b < Math.min(a, c) - 8 && d < Math.min(e, c) - 8;
      let localHalo = 0;

      if (darkCore) {
        localHalo = Math.min(b - Math.max(a, c), d - Math.max(e, c), outer - c) +
          Math.max(0, ring - outer) * 0.7;
      }
      if (lightCore) {
        localHalo = Math.min(Math.min(a, c) - b, Math.min(e, c) - d, c - outer) +
          Math.max(0, outer - ring) * 0.7;
      }

      const edgeContrast = Math.max(Math.abs(b - c), Math.abs(d - c), Math.abs(a - b), Math.abs(e - d));
      if (localHalo > 6 && edgeContrast > 24) {
        haloSamples += 1;
        scoreTotal += localHalo;
        contrastTotal += edgeContrast;
        if (localHalo > 13 && edgeContrast > 40) severeSamples += 1;
      }
      count += 1;
    }
  }

  for (let y = sampleStep * 2; y < height - sampleStep * 2; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = sampleStep * 2; x < width - sampleStep * 2; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const haloRatio = haloSamples / Math.max(1, count);
  const severeRatio = severeSamples / Math.max(1, count);
  const averageHalo = scoreTotal / Math.max(1, haloSamples);
  const averageContrast = contrastTotal / Math.max(1, haloSamples);
  const densityWeight = Math.min(1, haloRatio / 0.02);
  const haloScore = haloRatio * 120 +
    severeRatio * 180 +
    Math.max(0, averageHalo - 8) * 0.18 * densityWeight +
    Math.max(0, averageContrast - 36) * 0.035 * densityWeight;
  const haloRisk = haloScore > 5.2 &&
    haloRatio > 0.018 &&
    averageHalo > 8.2 &&
    averageContrast > 30;

  return {
    haloScore,
    haloRatio,
    severeRatio,
    averageHalo,
    averageContrast,
    haloSamples,
    severeSamples,
    sampleCount: count,
    haloRisk,
  };
}

function measureCompressionGridAxisCore(data, width, height, period, horizontal, sampleStep) {
  const cross = horizontal ? height : width;
  const length = horizontal ? width : height;
  const crossStep = Math.max(sampleStep, Math.round(cross / 150));
  let boundaryTotal = 0;
  let interiorTotal = 0;
  let peaks = 0;
  let count = 0;

  for (let line = period; line < length - period; line += period) {
    for (let crossPos = 1; crossPos < cross - 1; crossPos += crossStep) {
      const ax = horizontal ? line : crossPos;
      const ay = horizontal ? crossPos : line;
      const bx = horizontal ? line - 1 : crossPos;
      const by = horizontal ? crossPos : line - 1;
      const in1x = horizontal ? Math.min(width - 1, line + 1) : crossPos;
      const in1y = horizontal ? crossPos : Math.min(height - 1, line + 1);
      const in2x = horizontal ? Math.min(width - 1, line + 2) : crossPos;
      const in2y = horizontal ? crossPos : Math.min(height - 1, line + 2);
      const in3x = horizontal ? Math.max(0, line - 2) : crossPos;
      const in3y = horizontal ? crossPos : Math.max(0, line - 2);
      const in4x = horizontal ? Math.max(0, line - 3) : crossPos;
      const in4y = horizontal ? crossPos : Math.max(0, line - 3);
      const boundary = Math.abs(pixelLuminance(data, width, ax, ay) - pixelLuminance(data, width, bx, by));
      const interior = (
        Math.abs(pixelLuminance(data, width, in2x, in2y) - pixelLuminance(data, width, in1x, in1y)) +
        Math.abs(pixelLuminance(data, width, in3x, in3y) - pixelLuminance(data, width, in4x, in4y))
      ) / 2;

      boundaryTotal += boundary;
      interiorTotal += interior;
      count += 1;
      if (boundary > Math.max(4.8, interior * 1.8 + 1.8)) peaks += 1;
    }
  }

  const boundaryAvg = boundaryTotal / Math.max(1, count);
  const interiorAvg = interiorTotal / Math.max(1, count);
  return {
    boundaryAvg,
    interiorAvg,
    boundaryRatio: boundaryAvg / Math.max(1, interiorAvg),
    peakRatio: peaks / Math.max(1, count),
  };
}

function measureCompressionBlocksCore(data, width, height, period, localTexture) {
  const blockStep = Math.max(1, Math.round(period / 4));
  let flatBlocks = 0;
  let blocks = 0;
  let jumpTotal = 0;
  let jumpCount = 0;
  let stdTotal = 0;

  for (let y = 0; y < height - period; y += period) {
    for (let x = 0; x < width - period; x += period) {
      const block = compressionBlockMeanCore(data, width, x, y, period, blockStep);
      stdTotal += block.std;
      blocks += 1;
      if (block.std < Math.max(3.2, localTexture * 0.58)) flatBlocks += 1;

      if (x + period < width - period) {
        const right = compressionBlockMeanCore(data, width, x + period, y, period, blockStep);
        jumpTotal += Math.abs(block.mean - right.mean);
        jumpCount += 1;
      }
      if (y + period < height - period) {
        const bottom = compressionBlockMeanCore(data, width, x, y + period, period, blockStep);
        jumpTotal += Math.abs(block.mean - bottom.mean);
        jumpCount += 1;
      }
    }
  }

  return {
    flatBlockRatio: flatBlocks / Math.max(1, blocks),
    blockMeanJump: jumpTotal / Math.max(1, jumpCount),
    blockStd: stdTotal / Math.max(1, blocks),
  };
}

function compressionBlockMeanCore(data, width, x, y, period, blockStep) {
  let total = 0;
  let totalSquare = 0;
  let count = 0;
  const start = Math.max(1, Math.round(period * 0.22));
  const end = Math.max(start + 1, Math.round(period * 0.78));

  for (let by = start; by < end; by += blockStep) {
    for (let bx = start; bx < end; bx += blockStep) {
      const luminance = pixelLuminance(data, width, x + bx, y + by);
      total += luminance;
      totalSquare += luminance * luminance;
      count += 1;
    }
  }

  const mean = total / Math.max(1, count);
  const variance = Math.max(0, totalSquare / Math.max(1, count) - mean * mean);
  return {
    mean,
    std: Math.sqrt(variance),
  };
}

function measurePrintRichnessCore(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 260));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let colorSpreadTotal = 0;
  let activeSamples = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const index = (Math.round(y) * width + Math.round(x)) * 4;
      const center = pixelLuminanceAt(data, index);
      const left = pixelLuminance(data, width, x - step, y);
      const right = pixelLuminance(data, width, x + step, y);
      const top = pixelLuminance(data, width, x, y - step);
      const bottom = pixelLuminance(data, width, x, y + step);
      const gradient = (Math.abs(right - left) + Math.abs(bottom - top)) / 2;
      const detail = Math.abs(center * 4 - left - right - top - bottom) / 4;
      const channelMax = Math.max(data[index], data[index + 1], data[index + 2]);
      const channelMin = Math.min(data[index], data[index + 1], data[index + 2]);

      gradientTotal += gradient;
      detailTotal += detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      colorSpreadTotal += channelMax - channelMin;
      if (gradient > 3.2 || detail > 1.25) {
        activeSamples += 1;
      }
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const colorSpreadScore = colorSpreadTotal / Math.max(1, count);
  const activeRatio = activeSamples / Math.max(1, count);
  const richnessScore = contrastScore * 0.34 + gradientScore * 0.32 + detailScore * 0.88 + activeRatio * 18;
  const lowInformationRisk = (
    contrastScore < 4.6 &&
    gradientScore < 2.7 &&
    detailScore < 1.05 &&
    activeRatio < 0.055 &&
    richnessScore < 5.2
  );

  return {
    richnessScore,
    activeRatio,
    detailScore,
    gradientScore,
    contrastScore,
    colorSpreadScore,
    lowInformationRisk,
  };
}

function measurePrintTextureDensityCore(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 280));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let activeSamples = 0;
  let fineDetailSamples = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const detail = pixelDetailAt(data, width, height, x, y);
      const center = pixelLuminance(data, width, x, y);
      const detailRatio = detail.detail / Math.max(1, detail.gradient);

      gradientTotal += detail.gradient;
      detailTotal += detail.detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      if (detail.gradient > 4.6 || detail.detail > 1.35) activeSamples += 1;
      if (detail.detail > 2.2 || (detail.gradient > 7 && detailRatio > 0.22)) fineDetailSamples += 1;
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const activeRatio = activeSamples / Math.max(1, count);
  const fineDetailRatio = fineDetailSamples / Math.max(1, count);
  const textureDensityScore = detailScore * 1.25 + gradientScore * 0.28 + fineDetailRatio * 26 + activeRatio * 8;
  const lowTextureDensityRisk = (
    contrastScore > 5.8 &&
    activeRatio < 0.22 &&
    fineDetailRatio < 0.09 &&
    detailScore < 1.85 &&
    gradientScore < 5.6 &&
    textureDensityScore < 6.2
  );

  return {
    textureDensityScore,
    activeRatio,
    fineDetailRatio,
    detailScore,
    gradientScore,
    contrastScore,
    lowTextureDensityRisk,
  };
}

function measurePatternBalanceCore(data, width, height) {
  const columns = 5;
  const rows = 5;
  const cellScores = [];
  let total = 0;
  let activeCells = 0;
  let centerTotal = 0;
  let centerCount = 0;
  let edgeTotal = 0;
  let edgeCount = 0;
  let maxCell = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor((column / columns) * width);
      const x1 = Math.floor(((column + 1) / columns) * width);
      const y0 = Math.floor((row / rows) * height);
      const y1 = Math.floor(((row + 1) / rows) * height);
      const activity = measureCellActivityCore(data, width, height, x0, y0, x1, y1);
      const centerCell = column >= 1 && column <= 3 && row >= 1 && row <= 3;
      const edgeCell = column === 0 || column === columns - 1 || row === 0 || row === rows - 1;

      cellScores.push(activity);
      total += activity;
      maxCell = Math.max(maxCell, activity);
      if (activity > 4.4) activeCells += 1;
      if (centerCell) {
        centerTotal += activity;
        centerCount += 1;
      }
      if (edgeCell) {
        edgeTotal += activity;
        edgeCount += 1;
      }
    }
  }

  const average = total / Math.max(1, cellScores.length);
  const centerActivity = centerTotal / Math.max(1, centerCount);
  const edgeActivity = edgeTotal / Math.max(1, edgeCount);
  const activeCellRatio = activeCells / Math.max(1, cellScores.length);
  const centerToEdgeRatio = centerActivity / Math.max(0.8, edgeActivity);
  const dominanceRatio = maxCell / Math.max(1, average);
  const balanceScore = Math.max(0, centerToEdgeRatio - 1.7) * 2.4 + Math.max(0, dominanceRatio - 3.2) * 1.2 + Math.max(0, 0.38 - activeCellRatio) * 8;
  const centerDominanceRisk = (
    centerActivity > 4.8 &&
    edgeActivity < 2.9 &&
    activeCellRatio < 0.34 &&
    centerToEdgeRatio > 3.4 &&
    dominanceRatio > 4.2 &&
    balanceScore > 6.2
  );

  return {
    balanceScore,
    centerActivity,
    edgeActivity,
    activeCellRatio,
    centerToEdgeRatio,
    dominanceRatio,
    centerDominanceRisk,
  };
}

function measureCellActivityCore(data, width, height, x0, y0, x1, y1) {
  const cellWidth = Math.max(1, x1 - x0);
  const cellHeight = Math.max(1, y1 - y0);
  const step = Math.max(1, Math.round(Math.max(cellWidth, cellHeight) / 18));
  let total = 0;
  let count = 0;

  for (let y = Math.max(1, y0 + step); y < Math.min(height - 1, y1 - step); y += step) {
    for (let x = Math.max(1, x0 + step); x < Math.min(width - 1, x1 - step); x += step) {
      const detail = pixelDetailAt(data, width, height, x, y);
      total += detail.gradient * 0.42 + detail.detail * 0.92;
      count += 1;
    }
  }

  return total / Math.max(1, count);
}

function measureMirrorAxisArtifactCore(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const axisIndex = Math.floor(cross / 2);
  const radius = Math.max(8, Math.min(64, Math.round(cross * 0.038)));
  const depthStep = Math.max(1, Math.round(radius / 10));
  const sampleStep = Math.max(1, Math.round(length / 260));
  const windowSize = Math.max(30, Math.min(132, Math.round(length / 22)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.5));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let mirrorWindows = 0;
  let activeWindows = 0;
  let mirrorSampleRatioTotal = 0;
  let bestMirrorRatio = 1;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let mirrorTotal = 0;
    let crossActivityTotal = 0;
    let alongActivityTotal = 0;
    let suspiciousSamples = 0;
    let activeSamples = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 2, Math.max(1, along));
      const nextAlong = Math.min(length - 1, safeAlong + sampleStep);

      for (let depth = 0; depth < radius; depth += depthStep) {
        const leftCross = Math.max(1, Math.min(cross - 2, axisIndex - 1 - depth));
        const rightCross = Math.max(1, Math.min(cross - 2, axisIndex + depth));
        const leftOuter = Math.max(1, Math.min(cross - 2, leftCross - depthStep));
        const rightOuter = Math.max(1, Math.min(cross - 2, rightCross + depthStep));
        const left = horizontal ? { x: safeAlong, y: leftCross } : { x: leftCross, y: safeAlong };
        const right = horizontal ? { x: safeAlong, y: rightCross } : { x: rightCross, y: safeAlong };
        const leftFar = horizontal ? { x: safeAlong, y: leftOuter } : { x: leftOuter, y: safeAlong };
        const rightFar = horizontal ? { x: safeAlong, y: rightOuter } : { x: rightOuter, y: safeAlong };
        const leftNext = horizontal ? { x: nextAlong, y: leftCross } : { x: leftCross, y: nextAlong };
        const rightNext = horizontal ? { x: nextAlong, y: rightCross } : { x: rightCross, y: nextAlong };
        const mirrorDiff = pixelDistance(data, width, left.x, left.y, right.x, right.y);
        const crossActivity = (
          pixelDistance(data, width, left.x, left.y, leftFar.x, leftFar.y) +
          pixelDistance(data, width, right.x, right.y, rightFar.x, rightFar.y)
        ) / 2;
        const alongActivity = (
          pixelDistance(data, width, left.x, left.y, leftNext.x, leftNext.y) +
          pixelDistance(data, width, right.x, right.y, rightNext.x, rightNext.y)
        ) / 2;
        const activity = crossActivity * 0.75 + alongActivity * 0.25;

        mirrorTotal += mirrorDiff;
        crossActivityTotal += crossActivity;
        alongActivityTotal += alongActivity;
        sampleCount += 1;
        if (activity > 6.5) activeSamples += 1;
        if (activity > 7.2 && mirrorDiff < Math.max(5.2, activity * 0.42)) suspiciousSamples += 1;
      }
    }

    const mirrorDiff = mirrorTotal / Math.max(1, sampleCount);
    const crossActivity = crossActivityTotal / Math.max(1, sampleCount);
    const alongActivity = alongActivityTotal / Math.max(1, sampleCount);
    const activity = crossActivity * 0.75 + alongActivity * 0.25;
    const mirrorRatio = mirrorDiff / Math.max(1, activity);
    const suspiciousRatio = suspiciousSamples / Math.max(1, sampleCount);
    const activeRatio = activeSamples / Math.max(1, sampleCount);
    const mirrorExcess = Math.max(0, activity * 0.72 - mirrorDiff);
    const windowScore = activeRatio > 0.22
      ? mirrorExcess * (0.55 + Math.min(0.85, suspiciousRatio * 3.2)) + Math.max(0, 0.45 - mirrorRatio) * 8
      : 0;

    total += windowScore;
    count += 1;
    worstScore = Math.max(worstScore, windowScore);
    bestMirrorRatio = Math.min(bestMirrorRatio, mirrorRatio);
    mirrorSampleRatioTotal += suspiciousRatio;
    if (activeRatio > 0.22) activeWindows += 1;
    if (windowScore > 5.8 && suspiciousRatio > 0.18) mirrorWindows += 1;
  }

  const score = total / Math.max(1, count);
  const mirrorWindowRatio = mirrorWindows / Math.max(1, count);
  const activeWindowRatio = activeWindows / Math.max(1, count);
  const mirrorSampleRatio = mirrorSampleRatioTotal / Math.max(1, count);
  return {
    score,
    worstScore,
    mirrorWindows,
    activeWindows,
    mirrorWindowRatio,
    activeWindowRatio,
    mirrorSampleRatio,
    bestMirrorRatio,
    mirrorRisk: (
      worstScore > 12.5 ||
      score > 6.8 ||
      (mirrorWindows >= 4 && mirrorWindowRatio > 0.18 && activeWindowRatio > 0.2 && mirrorSampleRatio > 0.18 && score > 5.6 && worstScore > 8)
    ),
  };
}

function measurePreTiledPreviewArtifactCore(data, width, height) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  if (halfW < 8 || halfH < 8) {
    return {
      score: 0,
      duplicatePairs: 0,
      activePairs: 0,
      bestPairRatio: 1,
      duplicateRisk: false,
    };
  }

  const pairs = [
    measureRepeatedTilePairCore(data, width, height, halfW, halfH, halfW, 0),
    measureRepeatedTilePairCore(data, width, height, halfW, halfH, 0, halfH),
    measureRepeatedTilePairCore(data, width, height, halfW, halfH, halfW, halfH),
  ];
  const duplicatePairs = pairs.filter((pair) => pair.duplicate).length;
  const activePairs = pairs.filter((pair) => pair.activeRatio > 0.2).length;
  const score = pairs.reduce((sum, pair) => sum + pair.score, 0) / Math.max(1, pairs.length);
  const worstScore = Math.max(...pairs.map((pair) => pair.score));
  const bestPairRatio = Math.min(...pairs.map((pair) => pair.mismatchRatio));
  const averageSimilarity = pairs.reduce((sum, pair) => sum + pair.similarRatio, 0) / Math.max(1, pairs.length);

  return {
    score,
    worstScore,
    duplicatePairs,
    activePairs,
    bestPairRatio,
    averageSimilarity,
    pairs,
    duplicateRisk: (
      duplicatePairs >= 2 &&
      activePairs >= 2 &&
      score > 5.8 &&
      worstScore > 8 &&
      averageSimilarity > 0.22 &&
      bestPairRatio < 0.48
    ),
  };
}

function measureRepeatedTilePairCore(data, width, height, tileW, tileH, dx, dy) {
  const step = Math.max(1, Math.round(Math.min(tileW, tileH) / 90));
  const margin = Math.max(2, step * 2);
  let mismatchTotal = 0;
  let activityTotal = 0;
  let similarSamples = 0;
  let activeSamples = 0;
  let count = 0;

  for (let y = margin; y < tileH - margin; y += step) {
    for (let x = margin; x < tileW - margin; x += step) {
      const ax = x;
      const ay = y;
      const bx = x + dx;
      const by = y + dy;
      if (bx < 1 || bx >= width - 1 || by < 1 || by >= height - 1) continue;
      const detailA = pixelDetailAt(data, width, height, ax, ay);
      const detailB = pixelDetailAt(data, width, height, bx, by);
      const activity = (
        detailA.gradient * 0.42 +
        detailA.detail * 0.9 +
        detailB.gradient * 0.42 +
        detailB.detail * 0.9
      ) / 2;
      const mismatch = pixelDistance(data, width, ax, ay, bx, by);

      mismatchTotal += mismatch;
      activityTotal += activity;
      count += 1;
      if (activity > 5.8) activeSamples += 1;
      if (activity > 6.4 && mismatch < Math.max(5.2, activity * 0.42)) similarSamples += 1;
    }
  }

  const mismatch = mismatchTotal / Math.max(1, count);
  const activity = activityTotal / Math.max(1, count);
  const mismatchRatio = mismatch / Math.max(1, activity);
  const similarRatio = similarSamples / Math.max(1, count);
  const activeRatio = activeSamples / Math.max(1, count);
  const score = activeRatio > 0.2
    ? Math.max(0, activity * 0.56 - mismatch) * (0.65 + Math.min(0.9, similarRatio * 2.4)) + Math.max(0, 0.44 - mismatchRatio) * 9
    : 0;

  return {
    mismatch,
    activity,
    mismatchRatio,
    similarRatio,
    activeRatio,
    score,
    duplicate: (
      activeRatio > 0.2 &&
      similarRatio > 0.22 &&
      mismatchRatio < 0.48 &&
      score > 5.8
    ),
  };
}

function pixelDetailAt(data, width, height, x, y) {
  const safeX = Math.min(width - 2, Math.max(1, Math.round(x)));
  const safeY = Math.min(height - 2, Math.max(1, Math.round(y)));
  const center = pixelLuminance(data, width, safeX, safeY);
  const left = pixelLuminance(data, width, safeX - 1, safeY);
  const right = pixelLuminance(data, width, safeX + 1, safeY);
  const top = pixelLuminance(data, width, safeX, safeY - 1);
  const bottom = pixelLuminance(data, width, safeX, safeY + 1);
  return {
    detail: Math.abs(center * 4 - left - right - top - bottom) / 4,
    gradient: (Math.abs(right - left) + Math.abs(bottom - top)) / 2,
  };
}

function pixelLuminance(data, width, x, y) {
  const index = (Math.round(y) * width + Math.round(x)) * 4;
  return pixelLuminanceAt(data, index);
}

function pixelLuminanceAt(data, index) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function wrapIndex(value, size) {
  return ((value % size) + size) % size;
}

function pixelDistance(data, width, x1, y1, x2, y2) {
  const a = (Math.round(y1) * width + Math.round(x1)) * 4;
  const b = (Math.round(y2) * width + Math.round(x2)) * 4;
  return colorDistance(data, a, b);
}

function repairSeamsCore(data, width, height, options = {}) {
  const source = new Uint8ClampedArray(data);
  const band = Math.max(
    options.minBand || 18,
    Math.min(options.maxBand || 96, Math.round(Math.min(width, height) * (options.bandRatio || 0.026))),
  );
  const strength = options.strength ?? 0.86;
  const maxDiff = options.maxDiff ?? 120;
  const textureMix = options.textureMix ?? 0.62;
  const feather = Math.max(6, Math.min(48, Math.round(band * 0.28)));

  for (let y = 0; y < band; y += 1) {
    const weight = seamFeatherWeight(y, band) * strength;
    for (let x = 0; x < width; x += 1) {
      const top = (y * width + x) * 4;
      const bottom = ((height - 1 - y) * width + x) * 4;
      const innerTopY = Math.min(height - 1, y + band + feather);
      const innerBottomY = Math.max(0, height - 1 - y - band - feather);
      const prevX = Math.max(0, x - 1);
      const nextX = Math.min(width - 1, x + 1);
      const innerTop = (innerTopY * width + x) * 4;
      const innerBottom = (innerBottomY * width + x) * 4;
      const innerTopPrev = (innerTopY * width + prevX) * 4;
      const innerTopNext = (innerTopY * width + nextX) * 4;
      const innerBottomPrev = (innerBottomY * width + prevX) * 4;
      const innerBottomNext = (innerBottomY * width + nextX) * 4;
      blendSeamPair(data, source, top, bottom, innerTop, innerBottom, innerTopPrev, innerTopNext, innerBottomPrev, innerBottomNext, weight, maxDiff, textureMix);
    }
  }
  featherSeamTransition(data, source, width, height, band, feather, "horizontal");

  for (let x = 0; x < band; x += 1) {
    const weight = seamFeatherWeight(x, band) * strength;
    for (let y = 0; y < height; y += 1) {
      const left = (y * width + x) * 4;
      const right = (y * width + width - 1 - x) * 4;
      const innerLeftX = Math.min(width - 1, x + band + feather);
      const innerRightX = Math.max(0, width - 1 - x - band - feather);
      const prevY = Math.max(0, y - 1);
      const nextY = Math.min(height - 1, y + 1);
      const innerLeft = (y * width + innerLeftX) * 4;
      const innerRight = (y * width + innerRightX) * 4;
      const innerLeftPrev = (prevY * width + innerLeftX) * 4;
      const innerLeftNext = (nextY * width + innerLeftX) * 4;
      const innerRightPrev = (prevY * width + innerRightX) * 4;
      const innerRightNext = (nextY * width + innerRightX) * 4;
      blendSeamPair(data, source, left, right, innerLeft, innerRight, innerLeftPrev, innerLeftNext, innerRightPrev, innerRightNext, weight, maxDiff, textureMix);
    }
  }
  featherSeamTransition(data, source, width, height, band, feather, "vertical");
}

function seamScore(data, width, height) {
  let horizontal = 0;
  let vertical = 0;
  for (let x = 0; x < width; x += 1) {
    horizontal += colorDistance(data, x * 4, ((height - 1) * width + x) * 4);
  }
  for (let y = 0; y < height; y += 1) {
    vertical += colorDistance(data, y * width * 4, (y * width + width - 1) * 4);
  }
  return {
    horizontal: horizontal / width,
    vertical: vertical / height,
  };
}

function rowVariation(data, width, y) {
  let total = 0;
  for (let x = 1; x < width; x += 1) {
    total += colorDistance(data, (y * width + x - 1) * 4, (y * width + x) * 4);
  }
  return total / Math.max(1, width - 1);
}

function interiorVariation(data, width, height) {
  let total = 0;
  let count = 0;
  for (let y = 16; y < height - 16; y += 4) {
    for (let x = 16; x < width - 16; x += 4) {
      total += colorDistance(data, (y * width + x) * 4, (y * width + x + 1) * 4);
      count += 1;
    }
  }
  return total / Math.max(1, count);
}

function seamFeatherWeight(distance, band) {
  const t = Math.min(1, Math.max(0, distance / Math.max(1, band)));
  return Math.pow(1 - smoothstep(t), 1.25);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function blendSeamPair(
  data,
  source,
  a,
  b,
  innerA,
  innerB,
  innerAPrev,
  innerANext,
  innerBPrev,
  innerBNext,
  weight,
  maxDiff = Infinity,
  textureMix = 0.62
) {
  const diff = colorDistance(source, a, b);
  if (diff > maxDiff * 1.4) return;
  const safeWeight = diff > maxDiff ? weight * 0.28 : weight;
  for (let channel = 0; channel < 3; channel += 1) {
    const ai = a + channel;
    const bi = b + channel;
    const edgeAverage = (source[ai] + source[bi]) / 2;
    const innerAverage = (source[innerA + channel] + source[innerB + channel]) / 2;
    const detailA = source[innerA + channel] - (source[innerAPrev + channel] + source[innerANext + channel]) / 2;
    const detailB = source[innerB + channel] - (source[innerBPrev + channel] + source[innerBNext + channel]) / 2;
    const textureDetail = (detailA + detailB) * 0.58;
    const target = edgeAverage * (1 - textureMix) + innerAverage * textureMix + textureDetail;
    data[ai] = Math.round(data[ai] * (1 - safeWeight) + target * safeWeight);
    data[bi] = Math.round(data[bi] * (1 - safeWeight) + target * safeWeight);
  }
}

function featherSeamTransition(data, source, width, height, band, feather, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  for (let d = 0; d < feather; d += 1) {
    const weight = Math.pow(1 - d / Math.max(1, feather), 2) * 0.24;
    const nearA = band + d;
    const nearB = cross - 1 - band - d;
    const farA = Math.min(cross - 1, nearA + feather);
    const farB = Math.max(0, nearB - feather);
    if (nearA >= cross || nearB < 0) continue;
    for (let along = 0; along < length; along += 1) {
      const ax = horizontal ? along : nearA;
      const ay = horizontal ? nearA : along;
      const bx = horizontal ? along : nearB;
      const by = horizontal ? nearB : along;
      const fax = horizontal ? along : farA;
      const fay = horizontal ? farA : along;
      const fbx = horizontal ? along : farB;
      const fby = horizontal ? farB : along;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      const fa = (fay * width + fax) * 4;
      const fb = (fby * width + fbx) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        data[a + channel] = Math.round(data[a + channel] * (1 - weight) + source[fa + channel] * weight);
        data[b + channel] = Math.round(data[b + channel] * (1 - weight) + source[fb + channel] * weight);
      }
    }
  }
}

function colorDistance(data, a, b) {
  return (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
