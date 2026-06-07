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
