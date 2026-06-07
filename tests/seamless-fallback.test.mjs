import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("strict seamless fallback is allowed for structural edge-closure failures", () => {
  const shouldTryCertifiedSeamlessFallback = compileFunction(appSource, "shouldTryCertifiedSeamlessFallback");
  const structuralCheck = {
    passed: false,
    score: 260,
    horizontalScore: 240,
    verticalScore: 230,
    cornerScore: 210,
    finalIssueType: "横档未衔接，不可修复",
    issues: ["横档未衔接，不可修复", "竖档未衔接，不可修复", "回头没接，不可修复"],
    borderHorizontal: { worstMismatch: 900 },
    borderVertical: { worstMismatch: 860 },
    localHorizontal: { worstScore: 240 },
    localVertical: { worstScore: 230 },
    internalHorizontal: { worstScore: 110 },
    internalVertical: { worstScore: 120 },
    tiledHorizontal: { worstScore: 260 },
    tiledVertical: { worstScore: 250 },
    tiledCorner: { worstScore: 240, junctionRisk: true },
  };

  assert.equal(shouldTryCertifiedSeamlessFallback(structuralCheck), true, "severe edge closure should get one certified fallback candidate before regeneration");
  assert.equal(shouldTryCertifiedSeamlessFallback({
    ...structuralCheck,
    finalIssueType: "最终JPG边缘硬线，不可修复",
    issues: ["最终JPG边缘硬线，不可修复"],
  }), true, "final edge hard lines can be tried as a discardable candidate");
});

test("strict seamless fallback refuses non-structural failures that need regeneration or enhancement", () => {
  const shouldTryCertifiedSeamlessFallback = compileFunction(appSource, "shouldTryCertifiedSeamlessFallback");
  const baseCheck = {
    passed: false,
    score: 120,
    horizontalScore: 80,
    verticalScore: 75,
    cornerScore: 70,
    borderHorizontal: { worstMismatch: 220 },
    borderVertical: { worstMismatch: 210 },
    localHorizontal: { worstScore: 80 },
    localVertical: { worstScore: 75 },
    internalHorizontal: { worstScore: 30 },
    internalVertical: { worstScore: 25 },
    tiledHorizontal: { worstScore: 70 },
    tiledVertical: { worstScore: 65 },
    tiledCorner: { worstScore: 62 },
  };

  for (const issue of [
    "花型信息量不足，不可修复",
    "花型分布过于集中，不可修复",
    "疑似平铺预览输出，不可修复",
    "画框留白边界，不可修复",
    "输出比例拉伸过大，不可修复",
    "低清放大痕迹，可增强",
    "压缩块噪点，不可修复",
    "锐化光晕明显，不可修复",
    "花型元素叠加，不可修复",
  ]) {
    assert.equal(shouldTryCertifiedSeamlessFallback({ ...baseCheck, finalIssueType: issue, issues: [issue] }), false, `${issue} should not be forced through edge closure`);
  }
});

test("strict seamless fallback is skipped for extreme scores", () => {
  const shouldTryCertifiedSeamlessFallback = compileFunction(appSource, "shouldTryCertifiedSeamlessFallback");
  assert.equal(shouldTryCertifiedSeamlessFallback({
    passed: false,
    score: 700,
    horizontalScore: 660,
    verticalScore: 640,
    cornerScore: 620,
    finalIssueType: "横档未衔接，不可修复",
    issues: ["横档未衔接，不可修复"],
    borderHorizontal: { worstMismatch: 1700 },
    borderVertical: { worstMismatch: 1650 },
    localHorizontal: { worstScore: 700 },
    localVertical: { worstScore: 680 },
    internalHorizontal: { worstScore: 540 },
    internalVertical: { worstScore: 530 },
    tiledHorizontal: { worstScore: 750 },
    tiledVertical: { worstScore: 730 },
    tiledCorner: { worstScore: 740 },
  }), false, "extreme mismatches should go straight to regeneration");
});

test("generation tries strict certified fallback before automatic regeneration", () => {
  const generateTaskSource = extractFunction(appSource, "generateTask");
  const fallbackIndex = generateTaskSource.indexOf("tryCertifiedSeamlessFallback(task, lastCheck)");
  const regenerationIndex = generateTaskSource.indexOf("task.autoRegenerated = true");

  assert.notEqual(fallbackIndex, -1, "generateTask should call the strict certified fallback");
  assert.notEqual(regenerationIndex, -1, "generateTask should still auto-regenerate after failed candidates");
  assert.ok(fallbackIndex < regenerationIndex, "fallback candidate must run before the next regeneration attempt");
});

test("rejected strict fallback exposes a discardable candidate for best-candidate retention", () => {
  const fallbackSource = extractFunction(appSource, "tryCertifiedSeamlessFallback");

  assert.match(fallbackSource, /candidate: captureExternalTaskCandidate\(task, candidateJpgUrl, candidateCheck/, "failed strict fallback should expose its image as a candidate");
  assert.match(fallbackSource, /accepted: false/, "failed strict fallback must remain rejected for certification");
  assert.match(fallbackSource, /if \(!candidateCheck\.passed\)/, "candidate exposure should happen only in the rejected branch");
});

test("forced periodic repair stabilizes four-corner junctions", () => {
  const forcePeriodicSource = extractFunction(appSource, "forcePeriodicSeams");
  const shouldStabilizePeriodicCorners = compileFunction(appSource, "shouldStabilizePeriodicCorners");

  assert.match(forcePeriodicSource, /shouldStabilizePeriodicCorners\(check\)/, "force-periodic repair should gate a corner pass from the current check");
  assert.match(forcePeriodicSource, /stabilizePeriodicCorners\(data, width, height, cornerBand\)/, "force-periodic repair should run the production corner stabilizer");
  assert.equal(shouldStabilizePeriodicCorners({
    passed: false,
    finalIssueType: "四角平铺交汇明显，可修复",
    issues: ["四角平铺交汇明显，可修复"],
    tiledCorner: { worstScore: 24 },
  }), true, "corner-junction failures should get the corner stabilizer");
  assert.equal(shouldStabilizePeriodicCorners({
    passed: false,
    finalIssueType: "花型信息量不足，不可修复",
    issues: ["花型信息量不足，不可修复"],
    cornerScore: 2,
    horizontalScore: 2,
    verticalScore: 2,
    tiledCorner: { worstScore: 4 },
  }), false, "non-corner composition failures should not route through corner stabilization");
});

function compileFunction(source, name) {
  return Function(`"use strict"; return (${extractFunction(source, name)});`)();
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}
