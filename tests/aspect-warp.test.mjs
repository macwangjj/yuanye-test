import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("aspect warp gate allows near-target portrait outputs and rejects stretched square or landscape outputs", () => {
  const { measureAspectWarp } = loadAspectWarpHelpers();
  const portrait = measureAspectWarp(1024, 1536, 4961, 7559);
  const square = measureAspectWarp(1024, 1024, 4961, 7559);
  const landscape = measureAspectWarp(1536, 1024, 4961, 7559);

  assert.equal(portrait.passed, true, `1024x1536 should be close enough to print aspect; got ${JSON.stringify(portrait)}`);
  assert.ok(portrait.warpRatio < 1.03, `portrait warp should be tiny; got ${portrait.warpRatio}`);
  assert.equal(square.passed, false, `square source must not be stretched into portrait print; got ${JSON.stringify(square)}`);
  assert.ok(square.warpRatio > 1.45, `square source should have obvious warp; got ${square.warpRatio}`);
  assert.equal(landscape.passed, false, `landscape source must not be stretched into portrait print; got ${JSON.stringify(landscape)}`);
  assert.ok(landscape.warpRatio > 2.2, `landscape source should have severe warp; got ${landscape.warpRatio}`);
});

test("aspect warp failure becomes a non-downloadable commercial certification failure", () => {
  const { measureAspectWarp, applyAspectWarpCheck } = loadAspectWarpHelpers();
  const check = {
    score: 1.2,
    passed: true,
    repairability: "pass",
    issues: [],
  };

  const result = applyAspectWarpCheck(check, measureAspectWarp(1024, 1024, 4961, 7559));

  assert.equal(result.passed, false, "aspect-warped export should fail the final quality check");
  assert.equal(result.repairability, "unrepairable", "aspect warp should route to regeneration rather than seam repair");
  assert.equal(result.finalIssueType, "输出比例拉伸过大，不可修复");
  assert.ok(result.issues.includes("输出比例拉伸过大，不可修复"), `expected aspect issue; got ${JSON.stringify(result.issues)}`);
});

function loadAspectWarpHelpers() {
  const names = ["measureAspectWarp", "seamRating", "applyAspectWarpCheck"];
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
