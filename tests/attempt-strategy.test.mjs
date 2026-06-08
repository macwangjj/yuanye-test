import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("first generation attempt stays clean and does not add retry strategy", () => {
  const { buildAttemptStrategyGuidance } = loadAttemptStrategy();

  assert.equal(buildAttemptStrategyGuidance(1, null), "");
});

test("second structural failure attempt switches to edge-first closure", () => {
  const { buildAttemptStrategyGuidance } = loadAttemptStrategy();
  const guidance = buildAttemptStrategyGuidance(2, {
    finalIssueType: "横档未衔接，不可修复",
    issues: ["竖档未衔接，不可修复", "回头没接，不可修复"],
  });

  assert.match(guidance, /边缘优先闭合/);
  assert.match(guidance, /先设计上下左右四条边和四个角/);
  assert.match(guidance, /真实跨边延续/);
  assert.match(guidance, /3×3 平铺/);
  assert.match(guidance, /不沿用上一轮构图/);
});

test("third attempt lowers motif risk with small all-over repeat structure", () => {
  const { buildAttemptStrategyGuidance } = loadAttemptStrategy();
  const guidance = buildAttemptStrategyGuidance(3, {
    finalIssueType: "花型分布过于集中，不可修复",
    issues: ["画框留白边界，不可修复"],
  });

  assert.match(guidance, /小中型 all-over 连续纹样/);
  assert.match(guidance, /降低单个大主体比例/);
  assert.match(guidance, /边缘区域必须像内部一样有清晰纹理/);
  assert.match(guidance, /视觉重量分散到四边和四角/);
});

test("final retry attempt prioritizes a strict production tile over ambitious composition", () => {
  const { buildAttemptStrategyGuidance } = loadAttemptStrategy();
  const guidance = buildAttemptStrategyGuidance(4, {
    finalIssueType: "低清放大痕迹，可增强",
    issues: ["锐化光晕明显，不可修复"],
  });

  assert.match(guidance, /严格生产单元/);
  assert.match(guidance, /优先让四方连续通过/);
  assert.match(guidance, /只输出一个完整竖版循环单元/);
  assert.match(guidance, /原生高清细节/);
});

test("generation loop forwards attempt number into the image prompt", () => {
  const generateTaskSource = extractFunction(appSource, "generateTask");
  const requestGeneratedImageSource = extractFunction(appSource, "requestGeneratedImage");

  assert.match(generateTaskSource, /generationCandidateCountForAttempt\(attempt, lastCheck\)/);
  assert.match(generateTaskSource, /requestGeneratedImage\(task, lastCheck, attempt, candidateIndex, candidateCount\)/);
  assert.match(requestGeneratedImageSource, /function requestGeneratedImage\(task, previousCheck = null, attempt = 1, candidateIndex = 1, candidateCount = 1\)/);
  assert.match(requestGeneratedImageSource, /buildPrompt\(previousCheck, attempt, candidateIndex, candidateCount\)/);
  assert.match(requestGeneratedImageSource, /buildFissionPrompt\(task, previousCheck, attempt, candidateIndex, candidateCount\)/);
});

test("normal and fission prompt builders both include attempt-specific guidance", () => {
  const calls = appSource.match(/buildAttemptStrategyGuidance\(attempt, previousCheck\)/g) || [];

  assert.equal(calls.length, 2, "normal generation and fission generation should both use attempt strategies");
});

test("structural seam retries sample more differentiated candidates", () => {
  const { generationCandidateCountForAttempt, buildCandidateVariationGuidance } = loadAttemptStrategy();

  assert.equal(generationCandidateCountForAttempt(1, null), 2);
  assert.equal(generationCandidateCountForAttempt(2, { issues: ["横档未衔接，不可修复"] }), 3);
  assert.equal(generationCandidateCountForAttempt(3, { issues: ["花型信息量不足，不可修复"] }), 3);

  const guidance = buildCandidateVariationGuidance(2, 3, 2, { issues: ["四角平铺交汇明显，可修复"] });
  assert.match(guidance, /第 2\/3 个候选/);
  assert.match(guidance, /all-over 连续纹样/);
  assert.match(guidance, /严格检测/);
});

function loadAttemptStrategy() {
  const source = [
    extractFunction(appSource, "collectQualityIssueText"),
    extractFunction(appSource, "isStructuralSeamIssue"),
    extractFunction(appSource, "buildAttemptStrategyGuidance"),
    extractFunction(appSource, "generationCandidateCountForAttempt"),
    extractFunction(appSource, "buildCandidateVariationGuidance"),
  ].join("\n");
  return Function(`"use strict";
    const maxAutoRegenerations = 3;
    const generationCandidateSamplesBase = 2;
    const generationCandidateSamplesMax = 3;
    ${source}
    return {
      buildAttemptStrategyGuidance,
      buildCandidateVariationGuidance,
      collectQualityIssueText,
      generationCandidateCountForAttempt,
      isStructuralSeamIssue,
    };
  `)();
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
