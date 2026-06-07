import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("best candidate memory keeps the strongest failed image instead of the latest worse one", () => {
  const { rememberBestTaskCandidate, restoreTaskCandidate } = loadBestCandidateHelpers();
  const task = fakeTask({
    resultDataUrl: "data:good",
    resultJpgUrl: "/good.jpg",
    check: makeCheck({ score: 9, worst: 14, rating: "best failed candidate" }),
    exportMetrics: { aspectWarp: { mode: "direct-stretch", columns: 1, rows: 1 } },
  });

  let best = rememberBestTaskCandidate(task, task.seamCheck, null);
  task.resultDataUrl = "data:worse";
  task.resultJpgUrl = "/worse.jpg";
  task.seamCheck = makeCheck({ score: 40, worst: 80, rating: "latest worse candidate" });
  task.repairCheck = task.seamCheck;
  task.exportMetrics.aspectWarp.mode = "mutated-after-capture";
  best = rememberBestTaskCandidate(task, task.seamCheck, best);

  assert.equal(best.resultJpgUrl, "/good.jpg", "later worse attempts should not replace the best failed candidate");
  assert.equal(best.exportMetrics.aspectWarp.mode, "direct-stretch", "candidate metadata should be cloned, not mutated by later attempts");

  restoreTaskCandidate(task, best);

  assert.equal(task.resultJpgUrl, "/good.jpg");
  assert.equal(task.resultDataUrl, "data:good");
  assert.equal(task.seamScore, 9);
  assert.equal(task.seamRating, "best failed candidate");
  assert.equal(task.nodes.resultThumb.innerHTML, '<img src="/good.jpg" alt="">');
  assert.equal(task.nodes.message.textContent, "summary:best failed candidate");
});

test("best candidate memory replaces an older failed image when a later candidate is clearly better", () => {
  const { rememberBestTaskCandidate } = loadBestCandidateHelpers();
  const task = fakeTask({
    resultDataUrl: "data:bad",
    resultJpgUrl: "/bad.jpg",
    check: makeCheck({ score: 35, worst: 70, rating: "bad" }),
  });

  let best = rememberBestTaskCandidate(task, task.seamCheck, null);
  task.resultDataUrl = "data:better";
  task.resultJpgUrl = "/better.jpg";
  task.seamCheck = makeCheck({ score: 12, worst: 18, rating: "better" });
  task.repairCheck = task.seamCheck;
  best = rememberBestTaskCandidate(task, task.seamCheck, best);

  assert.equal(best.resultJpgUrl, "/better.jpg");
  assert.equal(best.check.rating, "better");
});

test("generation loop remembers failed candidates before auto-regeneration and restores the best one before review", () => {
  const generateTaskSource = extractFunction(appSource, "generateTask");
  const rememberIndex = generateTaskSource.indexOf("bestCandidate = rememberBestTaskCandidate(task, lastCheck, bestCandidate)");
  const fallbackRememberIndex = generateTaskSource.indexOf("bestCandidate = rememberBestTaskCandidate(fallback.candidate, fallback.check, bestCandidate)");
  const regenerationIndex = generateTaskSource.indexOf("task.autoRegenerated = true");
  const restoreIndex = generateTaskSource.indexOf("restoreTaskCandidate(task, bestCandidate)");
  const finalGateIndex = generateTaskSource.indexOf("task.nodes.enhance.disabled = false");

  assert.notEqual(rememberIndex, -1, "failed attempts should be remembered as best-candidate contenders");
  assert.notEqual(fallbackRememberIndex, -1, "failed strict-seamless fallback candidates should also compete as best candidates");
  assert.notEqual(regenerationIndex, -1, "generation loop should still auto-regenerate failed attempts");
  assert.ok(fallbackRememberIndex < regenerationIndex, "discardable strict fallback candidates must be considered before regeneration overwrites the task");
  assert.ok(rememberIndex < regenerationIndex, "candidate must be captured before the attempt is overwritten by regeneration");
  assert.notEqual(restoreIndex, -1, "failed generation should restore the best candidate before review");
  assert.ok(restoreIndex < finalGateIndex, "best candidate must be restored before download gates and history save run");
});

function loadBestCandidateHelpers() {
  const source = [
    extractFunction(appSource, "seamVisualWorstScore"),
    extractFunction(appSource, "isSeamCheckBetter"),
    extractFunction(appSource, "clonePlain"),
    extractFunction(appSource, "captureTaskCandidate"),
    extractFunction(appSource, "captureExternalTaskCandidate"),
    extractFunction(appSource, "rememberBestTaskCandidate"),
    extractFunction(appSource, "restoreTaskCandidate"),
  ].join("\n");
  return Function(`"use strict";
    function seamRating(check) { return check?.rating || "fallback rating"; }
    function seamCheckSummary(check) { return "summary:" + (check?.rating || "none"); }
    ${source}
    return { rememberBestTaskCandidate, restoreTaskCandidate };
  `)();
}

function fakeTask({ resultDataUrl, resultJpgUrl, check, exportMetrics = {} }) {
  return {
    resultDataUrl,
    resultJpgUrl,
    seamCheck: check,
    repairCheck: check,
    exportMetrics,
    seamScore: check.score,
    seamRating: check.rating,
    locallyRepaired: false,
    qualityPassed: false,
    nodes: {
      resultThumb: { innerHTML: "" },
      message: { textContent: "" },
    },
  };
}

function makeCheck({ score, worst, rating }) {
  return {
    passed: false,
    score,
    rating,
    horizontalScore: score,
    verticalScore: score,
    cornerScore: Math.max(0, score - 2),
    tiledCorner: { worstScore: worst },
    bandHorizontal: { worstScore: worst * 0.7 },
    bandVertical: { worstScore: worst * 0.65 },
    detailHorizontal: { worstScore: worst * 0.4 },
    detailVertical: { worstScore: worst * 0.35 },
    issues: ["横档未衔接，不可修复"],
  };
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
