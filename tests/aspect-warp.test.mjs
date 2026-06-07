import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("aspect warp gate allows portrait output and rectifies square tiles with a low-distortion periodic grid", () => {
  const { measureAspectWarp } = loadAspectWarpHelpers();
  const portrait = measureAspectWarp(1024, 1536, 4961, 7559);
  const square = measureAspectWarp(1024, 1024, 4961, 7559);
  const landscape = measureAspectWarp(1536, 1024, 4961, 7559);

  assert.equal(portrait.passed, true, `1024x1536 should be close enough to print aspect; got ${JSON.stringify(portrait)}`);
  assert.equal(portrait.mode, "direct-stretch");
  assert.ok(portrait.warpRatio < 1.03, `portrait warp should be tiny; got ${portrait.warpRatio}`);
  assert.equal(square.passed, true, `square seamless source should be exportable through a periodic grid; got ${JSON.stringify(square)}`);
  assert.equal(square.mode, "periodic-grid");
  assert.equal(square.columns, 2);
  assert.equal(square.rows, 3);
  assert.ok(square.warpRatio < 1.03, `square source should avoid gross stretching through a 2x3 grid; got ${square.warpRatio}`);
  assert.equal(landscape.passed, false, `landscape source must not be stretched into portrait print; got ${JSON.stringify(landscape)}`);
  assert.ok(landscape.warpRatio > 1.08, `landscape source should remain over the allowed warp threshold; got ${landscape.warpRatio}`);
});

test("aspect warp failure becomes a non-downloadable commercial certification failure", () => {
  const { measureAspectWarp, applyAspectWarpCheck } = loadAspectWarpHelpers();
  const check = {
    score: 1.2,
    passed: true,
    repairability: "pass",
    issues: [],
  };

  const result = applyAspectWarpCheck(check, measureAspectWarp(1536, 1024, 4961, 7559));

  assert.equal(result.passed, false, "aspect-warped export should fail the final quality check");
  assert.equal(result.repairability, "unrepairable", "aspect warp should route to regeneration rather than seam repair");
  assert.equal(result.finalIssueType, "输出比例拉伸过大，不可修复");
  assert.ok(result.issues.includes("输出比例拉伸过大，不可修复"), `expected aspect issue; got ${JSON.stringify(result.issues)}`);
});

function loadAspectWarpHelpers() {
  const names = ["measureAspectWarp", "measureAspectWarpFit", "bestPeriodicAspectFit", "seamRating", "applyAspectWarpCheck"];
  const source = names.map((name) => extractFunction(appSource, name)).join("\n");
  return Function(`"use strict"; ${source}\nreturn { measureAspectWarp, applyAspectWarpCheck };`)();
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
