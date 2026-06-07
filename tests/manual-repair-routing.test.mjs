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

test("closed edges with internal guide lines are classified as repairable, not terminal failures", () => {
  const normalizeRepairableSeamIssue = compileFunction(appSource, "normalizeRepairableSeamIssue");
  const check = makeClosedEdgeInternalLineCheck();

  normalizeRepairableSeamIssue(check);

  assert.equal(check.repairability, "repairable");
  assert.equal(check.finalIssueType, "内部接缝线明显，可修复");
  assert.deepEqual(check.issues, ["内部接缝线明显，可修复", "四角平铺交汇明显，可修复"]);
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

test("AI offset repair mask opens common internal guide-line bands", () => {
  const { internalGuideLineEditStrength } = loadMaskHelpers();
  const maskSource = extractFunction(appSource, "drawOffsetRepairMask");
  const quarter = internalGuideLineEditStrength(250, 1000);
  const third = internalGuideLineEditStrength(333, 1000);
  const far = internalGuideLineEditStrength(120, 1000);

  assert.ok(quarter > 0.68, `quarter guide band should be editable; got ${quarter}`);
  assert.ok(third > 0.62, `third guide band should be editable; got ${third}`);
  assert.equal(far, 0, `far non-guide area should stay protected; got ${far}`);
  assert.match(maskSource, /internalGuideLineEditStrength\(y, height\)/);
  assert.match(maskSource, /internalGuideLineEditStrength\(x, width\)/);
});

test("AI offset repair prompt names internal guide-line redraws", () => {
  const buildOffsetRepairPrompt = compileFunction(appSource, "buildOffsetRepairPrompt");
  const prompt = buildOffsetRepairPrompt({ issues: ["内部接缝线明显，可修复"] });

  assert.ok(prompt.includes("1/4、1/3、2/3、3/4"));
  assert.match(prompt, /内部导线带/);
  assert.match(prompt, /网格线/);
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
  ].join("\n");
  return Function(`"use strict"; ${source}
    return { internalGuideLineEditStrength };
  `)();
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
