import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("repair availability includes AI offset repair when local repair is not suitable", () => {
  const { shouldOfferTaskRepair, shouldEdgeBlendRepair, shouldForcePeriodicRepair, shouldAiOffsetRepair } = loadRepairAvailabilityHelpers();
  const check = makeAiOnlyRepairableCheck();

  assert.equal(shouldEdgeBlendRepair(check), false, "mirror-axis risk should avoid simple local edge blending");
  assert.equal(shouldForcePeriodicRepair(check), false, "mirror-axis risk should avoid forced periodic copying");
  assert.equal(shouldAiOffsetRepair(check), true, "AI offset repair should still be allowed for a bounded mirror-axis seam");
  assert.equal(shouldOfferTaskRepair({ aiRepairAttempts: 0 }, check), true, "manual repair should stay available for AI-repairable seams");
  assert.equal(shouldOfferTaskRepair({ aiRepairAttempts: 2 }, check), false, "manual repair should close after the AI repair budget is exhausted");
});

test("manual repair routes through AI offset before local edge blending", () => {
  const repairTaskSource = extractFunction(appSource, "repairTask");
  const aiBranchIndex = repairTaskSource.indexOf("return await aiOffsetRepairFollowupTask(task, baseCheck, options)");
  const forceBranchIndex = repairTaskSource.indexOf("return await forceSeamlessTask(task, options)");
  const edgeBlendIndex = repairTaskSource.indexOf("makeEdgeBlendRepairJpg(task.resultJpgUrl, baseCheck)");
  const noRouteIndex = repairTaskSource.indexOf("当前底稿不适合继续轻修");

  assert.match(repairTaskSource, /const canAiOffset = canRunAiOffsetRepair\(task, baseCheck\)/);
  assert.notEqual(aiBranchIndex, -1, "manual repair should call the AI offset follow-up task");
  assert.notEqual(forceBranchIndex, -1, "manual repair should still keep the forced-periodic fallback");
  assert.notEqual(edgeBlendIndex, -1, "manual repair should still keep local edge blending for mild seams");
  assert.notEqual(noRouteIndex, -1, "manual repair should refuse unsuitable failed bases instead of doing fake light repair");
  assert.ok(aiBranchIndex < forceBranchIndex, "AI transition repair should be attempted before forced periodic repair");
  assert.ok(aiBranchIndex < edgeBlendIndex, "AI transition repair should be attempted before simple edge blending");
});

test("generation and enhancement expose the same repair button availability gate", () => {
  const generateTaskSource = extractFunction(appSource, "generateTask");
  const enhanceTaskSource = extractFunction(appSource, "enhanceTask");

  assert.match(generateTaskSource, /task\.nodes\.repair\.disabled = !shouldOfferTaskRepair\(task, lastCheck\)/);
  assert.match(enhanceTaskSource, /task\.nodes\.repair\.disabled = !shouldOfferTaskRepair\(task, check\)/);
});

test("manual AI follow-up preserves the commercial download gate", () => {
  const aiFollowupSource = extractFunction(appSource, "aiOffsetRepairFollowupTask");

  assert.match(aiFollowupSource, /task\.qualityPassed = Boolean\(repairCheck\?\.passed\)/, "AI follow-up should only mark quality passed after certification");
  assert.match(aiFollowupSource, /task\.nodes\.select\.disabled = !repairCheck\?\.passed/, "failed AI follow-up should remain unselectable");
  assert.match(aiFollowupSource, /updateTaskDownloadGate\(task\)/, "download gate should be refreshed after the AI follow-up check");
  assert.match(aiFollowupSource, /未通过认证前不开放成品下载/, "failed AI follow-up should keep the user-facing no-download warning");
});

test("bounded final JPG edge hard lines are routed as AI-repairable", () => {
  const { applyFullSizeEdgeCheck } = loadFinalEdgeHelpers();
  const check = makeBoundedFinalEdgeHardLineCheck();

  applyFullSizeEdgeCheck(check, { edgeRisk: true, score: 72, peakRatio: 0.38 });

  assert.equal(check.passed, false, "edge hard line should still fail certification");
  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "最终JPG边缘硬线，可修复");
  assert.equal(check.issues[0], "最终JPG边缘硬线，可修复");
});

test("severe final JPG edge hard lines stay regeneration-only", () => {
  const { applyFullSizeEdgeCheck } = loadFinalEdgeHelpers();
  const check = makeSevereFinalEdgeHardLineCheck();

  applyFullSizeEdgeCheck(check, { edgeRisk: true, score: 86, peakRatio: 0.58 });

  assert.equal(check.passed, false);
  assert.equal(check.repairability, "unrepairable");
  assert.equal(check.finalIssueType, "最终JPG边缘硬线，不可修复");
  assert.equal(check.issues[0], "最终JPG边缘硬线，不可修复");
});

test("closed edges with internal guide lines are classified as repairable, not terminal failures", () => {
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = makeClosedEdgeInternalLineCheck();

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "内部接缝线明显，可修复");
  assert.deepEqual(check.issues, ["内部接缝线明显，可修复", "四角平铺交汇明显，可修复"]);
});

test("near-miss structural seams are classified as AI-repairable", () => {
  const { shouldAiOffsetRepair, shouldOfferTaskRepair } = loadRepairAvailabilityHelpers();
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = makeNearMissStructuralSeamCheck();

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "结构接缝轻度失配，可修复");
  assert.equal(shouldAiOffsetRepair(check), true, "near-miss structural seams should route to AI offset repair");
  assert.equal(shouldOfferTaskRepair({ aiRepairAttempts: 0 }, check), true, "manual repair should stay available");
});

test("near-miss structural seams allow soft border object risk", () => {
  const { shouldAiOffsetRepair } = loadRepairAvailabilityHelpers();
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = {
    ...makeNearMissStructuralSeamCheck(),
    peakRatioH: 0.42,
    peakRatioV: 0.37,
    borderHorizontal: { worstMismatch: 55, objectRisk: true },
    borderVertical: { worstMismatch: 52, objectRisk: false },
    localVertical: { score: 14, worstScore: 38 },
    internalHorizontal: { score: 43, worstScore: 47, lineRisk: false },
    bandHorizontal: { worstScore: 38 },
    bandVertical: { worstScore: 40 },
    tiledCorner: { score: 13, worstScore: 56, junctionRisk: false },
    driftHorizontal: { driftRisk: false, worstScore: 6 },
    driftVertical: { driftRisk: false, worstScore: 5 },
  };

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "结构接缝轻度失配，可修复");
  assert.equal(shouldAiOffsetRepair(check), true);
});

test("near-miss structural reclassification still rejects drift or object-risk seams", () => {
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const driftCheck = {
    ...makeNearMissStructuralSeamCheck(),
    driftHorizontal: { driftRisk: true, worstScore: 72 },
  };
  const objectCheck = {
    ...makeNearMissStructuralSeamCheck(),
    borderVertical: { worstMismatch: 120, objectRisk: true },
  };

  normalizeRepairableSeamIssue(driftCheck);
  normalizeRepairableSeamIssue(objectCheck);

  assert.equal(driftCheck.repairability, "unrepairable");
  assert.equal(objectCheck.repairability, "unrepairable");
});

test("hard visual failures are not reclassified as repairable internal lines", () => {
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = {
    ...makeClosedEdgeInternalLineCheck(),
    issues: ["花型元素叠加，不可修复", "横档未衔接，不可修复"],
    finalIssueType: "花型元素叠加，不可修复",
  };

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "unrepairable");
  assert.equal(check.finalIssueType, "花型元素叠加，不可修复");
});

test("localized motif overlap can route to AI repair without weakening severe overlap rejection", () => {
  const { shouldOfferTaskRepair, shouldEdgeBlendRepair, shouldAiOffsetRepair } = loadRepairAvailabilityHelpers();
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = makeLocalizedOverlapCheck();

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "局部花型叠加，可修复");
  assert.deepEqual(check.issues, ["局部花型叠加，可修复", "内部接缝线明显，可修复", "四角平铺交汇明显，可修复"]);
  assert.equal(shouldAiOffsetRepair(check), true, "bounded local overlap should be eligible for AI redraw");
  assert.equal(shouldEdgeBlendRepair(check), false, "bounded local overlap should not use simple edge blending");
  assert.equal(shouldOfferTaskRepair({ aiRepairAttempts: 0 }, check), true, "manual repair should stay available for local overlap");
});

test("AI offset repair mask opens common internal guide-line bands", () => {
  const { internalGuideLineEditStrength, internalGuideJunctionEditStrength } = loadMaskHelpers();
  const maskSource = extractFunction(appSource, "drawOffsetRepairMask");
  const quarter = internalGuideLineEditStrength(250, 1000);
  const third = internalGuideLineEditStrength(333, 1000);
  const far = internalGuideLineEditStrength(120, 1000);
  const junction = internalGuideJunctionEditStrength(250, 250, 1000, 1000);
  const offJunction = internalGuideJunctionEditStrength(120, 120, 1000, 1000);

  assert.ok(quarter > 0.68, `quarter guide band should be editable; got ${quarter}`);
  assert.ok(third > 0.62, `third guide band should be editable; got ${third}`);
  assert.equal(far, 0, `far non-guide area should stay protected; got ${far}`);
  assert.ok(junction > 0.9, `guide-line junction should be strongly editable; got ${junction}`);
  assert.equal(offJunction, 0, `off-junction textile area should stay protected; got ${offJunction}`);
  assert.match(maskSource, /internalGuideLineEditStrength\(y, height\)/);
  assert.match(maskSource, /internalGuideLineEditStrength\(x, width\)/);
  assert.match(maskSource, /internalGuideJunctionEditStrength\(x, y, width, height\)/);
});

test("AI offset repair mask makes seam bands transparent and protected areas opaque", () => {
  const { drawOffsetRepairMask } = loadMaskRenderer();
  const width = 1000;
  const height = 1000;
  const ctx = createMaskContext(width, height);

  drawOffsetRepairMask(ctx, width, height);

  assert.ok(alphaAt(ctx.imageData.data, width, 500, 500) < 8, "center offset seam should be fully editable");
  assert.ok(alphaAt(ctx.imageData.data, width, 250, 120) < 100, "internal guide band should be editable");
  assert.ok(alphaAt(ctx.imageData.data, width, 250, 250) < 24, "internal guide junction should be strongly editable");
  assert.equal(alphaAt(ctx.imageData.data, width, 120, 120), 255, "off-seam textile area should stay protected");
});

test("AI offset repair prompt names internal guide-line redraws", () => {
  const buildOffsetRepairPrompt = compileFunction(appSource, "buildOffsetRepairPrompt");
  const prompt = buildOffsetRepairPrompt({ issues: ["内部接缝线明显，可修复", "局部花型叠加，可修复"] });

  assert.ok(prompt.includes("1/4、1/3、2/3、3/4"));
  assert.match(prompt, /内部导线带/);
  assert.match(prompt, /导线交叉点/);
  assert.match(prompt, /网格线/);
  assert.match(prompt, /局部花型叠加/);
  assert.match(prompt, /贴片遮盖/);
});

function loadRepairAvailabilityHelpers() {
  const source = [
    "const maxAiSeamRepairs = 2;",
    extractFunction(appSource, "shouldEdgeBlendRepair"),
    extractFunction(appSource, "shouldAiOffsetRepair"),
    extractFunction(appSource, "shouldForcePeriodicRepair"),
    extractFunction(appSource, "canRunAiOffsetRepair"),
    extractFunction(appSource, "shouldOfferTaskRepair"),
  ].join("\n");
  return Function(`"use strict"; ${source}
    return { shouldOfferTaskRepair, shouldEdgeBlendRepair, shouldForcePeriodicRepair, shouldAiOffsetRepair };
  `)();
}

function loadMaskHelpers() {
  const source = [
    extractFunction(appSource, "seamEditStrength"),
    extractFunction(appSource, "internalGuideLineEditStrength"),
    extractFunction(appSource, "internalGuideJunctionEditStrength"),
  ].join("\n");
  return Function(`"use strict"; ${source}
    return { internalGuideLineEditStrength, internalGuideJunctionEditStrength };
  `)();
}

function loadMaskRenderer() {
  const source = [
    extractFunction(appSource, "seamEditStrength"),
    extractFunction(appSource, "internalGuideLineEditStrength"),
    extractFunction(appSource, "internalGuideJunctionEditStrength"),
    extractFunction(appSource, "drawOffsetRepairMask"),
  ].join("\n");
  return Function(`"use strict"; ${source}
    return { drawOffsetRepairMask };
  `)();
}

function loadFinalEdgeHelpers() {
  const source = [
    extractFunction(appSource, "seamRating"),
    extractFunction(appSource, "shouldAiOffsetRepair"),
    extractFunction(appSource, "isBoundedFinalEdgeHardLine"),
    extractFunction(appSource, "applyFullSizeEdgeCheck"),
  ].join("\n");
  return Function(`"use strict"; ${source}
    return { applyFullSizeEdgeCheck };
  `)();
}

function createMaskContext(width, height) {
  return {
    imageData: null,
    createImageData(w, h) {
      assert.equal(w, width);
      assert.equal(h, height);
      return { data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(imageData) {
      this.imageData = imageData;
    },
  };
}

function alphaAt(data, width, x, y) {
  return data[(y * width + x) * 4 + 3];
}

function makeAiOnlyRepairableCheck() {
  return {
    passed: false,
    score: 92,
    horizontalScore: 72,
    verticalScore: 68,
    cornerScore: 58,
    issues: ["镜像轴痕明显，可修复", "接缝过渡不自然，可修复"],
    borderHorizontal: { worstMismatch: 340 },
    borderVertical: { worstMismatch: 320 },
    localHorizontal: { worstScore: 88 },
    localVertical: { worstScore: 82 },
    internalHorizontal: { worstScore: 62 },
    internalVertical: { worstScore: 59 },
    bandHorizontal: { worstScore: 96 },
    bandVertical: { worstScore: 92 },
    detailHorizontal: { worstScore: 90 },
    detailVertical: { worstScore: 88 },
    tiledHorizontal: { worstScore: 84 },
    tiledVertical: { worstScore: 79 },
    tiledCorner: { worstScore: 55 },
    driftHorizontal: { worstScore: 42 },
    driftVertical: { worstScore: 39 },
    mirrorHorizontal: { worstScore: 86, mirrorRisk: true },
    mirrorVertical: { worstScore: 72, mirrorRisk: true },
  };
}

function makeBoundedFinalEdgeHardLineCheck() {
  return {
    passed: false,
    score: 17.8,
    horizontalScore: 22.6,
    verticalScore: 19.4,
    cornerScore: 31.2,
    peakRatioH: 0.46,
    peakRatioV: 0.52,
    repairability: "unrepairable",
    finalIssueType: "横档未衔接，不可修复",
    issues: ["横档未衔接，不可修复", "竖档未衔接，不可修复"],
    borderHorizontal: { worstMismatch: 72, objectRisk: true },
    borderVertical: { worstMismatch: 64, objectRisk: false },
    localHorizontal: { score: 22, worstScore: 42 },
    localVertical: { score: 19, worstScore: 38 },
    internalHorizontal: { worstScore: 48 },
    internalVertical: { worstScore: 36 },
    bandHorizontal: { worstScore: 34 },
    bandVertical: { worstScore: 30 },
    detailHorizontal: { worstScore: 42 },
    detailVertical: { worstScore: 40 },
    tiledHorizontal: { worstScore: 64 },
    tiledVertical: { worstScore: 58 },
    tiledCorner: { worstScore: 42 },
    driftHorizontal: { driftRisk: false, worstScore: 12 },
    driftVertical: { driftRisk: false, worstScore: 10 },
    mirrorHorizontal: { worstScore: 0, mirrorRisk: false },
    mirrorVertical: { worstScore: 0, mirrorRisk: false },
  };
}

function makeSevereFinalEdgeHardLineCheck() {
  return {
    passed: false,
    score: 63.57,
    horizontalScore: 80.69,
    verticalScore: 62.94,
    cornerScore: 78.53,
    repairability: "unrepairable",
    finalIssueType: "横档未衔接，不可修复",
    issues: ["横档未衔接，不可修复", "竖档未衔接，不可修复"],
    borderHorizontal: { worstMismatch: 240 },
    borderVertical: { worstMismatch: 210 },
    localHorizontal: { worstScore: 90 },
    localVertical: { worstScore: 78 },
    internalHorizontal: { worstScore: 66 },
    internalVertical: { worstScore: 58 },
    bandHorizontal: { worstScore: 120 },
    bandVertical: { worstScore: 112 },
    detailHorizontal: { worstScore: 42 },
    detailVertical: { worstScore: 40 },
    tiledHorizontal: { worstScore: 150 },
    tiledVertical: { worstScore: 142 },
    tiledCorner: { worstScore: 95 },
    driftHorizontal: { worstScore: 28 },
    driftVertical: { worstScore: 24 },
    mirrorHorizontal: { worstScore: 0, mirrorRisk: false },
    mirrorVertical: { worstScore: 0, mirrorRisk: false },
  };
}

function makeNearMissStructuralSeamCheck() {
  return {
    passed: false,
    score: 17.86,
    horizontalScore: 7.1,
    verticalScore: 11.2,
    cornerScore: 17.1,
    peakRatioH: 0.18,
    peakRatioV: 0.16,
    repairability: "unrepairable",
    finalIssueType: "横档未衔接，不可修复",
    issues: ["横档未衔接，不可修复", "竖档未衔接，不可修复", "回头没接，不可修复"],
    borderHorizontal: { worstMismatch: 132, objectRisk: false },
    borderVertical: { worstMismatch: 128, objectRisk: false },
    localHorizontal: { score: 18, worstScore: 45 },
    localVertical: { score: 20, worstScore: 48 },
    internalHorizontal: { score: 8, worstScore: 34, lineRisk: false },
    internalVertical: { score: 7, worstScore: 31, lineRisk: false },
    bandHorizontal: { worstScore: 74 },
    bandVertical: { worstScore: 78 },
    detailHorizontal: { worstScore: 42 },
    detailVertical: { worstScore: 44 },
    tiledHorizontal: { worstScore: 62 },
    tiledVertical: { worstScore: 64 },
    tiledCorner: { score: 9, worstScore: 24, junctionRisk: false },
    driftHorizontal: { driftRisk: false, worstScore: 22 },
    driftVertical: { driftRisk: false, worstScore: 24 },
  };
}

function makeClosedEdgeInternalLineCheck() {
  return {
    passed: false,
    score: 8.2,
    horizontalScore: 1.2,
    verticalScore: 0.8,
    cornerScore: 14.5,
    peakRatioH: 0.04,
    peakRatioV: 0.03,
    issues: ["横档未衔接，不可修复", "竖档未衔接，不可修复", "回头没接，不可修复"],
    finalIssueType: "横档未衔接，不可修复",
    repairability: "unrepairable",
    borderHorizontal: { worstMismatch: 8, objectRisk: false },
    borderVertical: { worstMismatch: 6, objectRisk: false },
    localHorizontal: { score: 0.4, worstScore: 1.3 },
    localVertical: { score: 0.2, worstScore: 0.9 },
    internalHorizontal: { score: 28, worstScore: 38, lineRisk: true },
    internalVertical: { score: 31, worstScore: 42, lineRisk: true },
    tiledCorner: { score: 9, worstScore: 16, junctionRisk: false },
    driftHorizontal: { driftRisk: false },
    driftVertical: { driftRisk: false },
  };
}

function makeLocalizedOverlapCheck() {
  return {
    passed: false,
    score: 18,
    horizontalScore: 14,
    verticalScore: 13,
    cornerScore: 11,
    peakRatioH: 0.18,
    peakRatioV: 0.17,
    issues: ["花型元素叠加，不可修复", "横档未衔接，不可修复"],
    finalIssueType: "花型元素叠加，不可修复",
    repairability: "unrepairable",
    borderHorizontal: { worstMismatch: 88, objectRisk: false },
    borderVertical: { worstMismatch: 92, objectRisk: false },
    localHorizontal: { score: 14, worstScore: 28 },
    localVertical: { score: 12, worstScore: 26 },
    internalHorizontal: { score: 16, worstScore: 34, lineRisk: true },
    internalVertical: { score: 14, worstScore: 32, lineRisk: true },
    tiledCorner: { score: 8.6, worstScore: 15.2, junctionRisk: false },
    driftHorizontal: { worstScore: 6, driftRisk: false },
    driftVertical: { worstScore: 5, driftRisk: false },
    bandHorizontal: { worstScore: 20 },
    bandVertical: { worstScore: 18 },
    detailHorizontal: { worstScore: 18 },
    detailVertical: { worstScore: 16 },
    tiledHorizontal: { worstScore: 22 },
    tiledVertical: { worstScore: 20 },
    mirrorHorizontal: { worstScore: 8, mirrorRisk: false },
    mirrorVertical: { worstScore: 7, mirrorRisk: false },
  };
}

function compileFunction(source, name) {
  return Function(`"use strict"; return (${extractFunction(source, name)});`)();
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(")", start);
  const braceStart = source.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}
