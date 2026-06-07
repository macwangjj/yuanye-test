import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("retry guidance gives final JPG edge seams a hard-edge-specific correction", () => {
  const { buildRetryGuidance } = loadRetryGuidance();
  const guidance = buildRetryGuidance({
    issues: ["最终JPG边缘硬线，不可修复"],
  });

  assert.match(guidance, /最终JPG边缘硬线/);
  assert.match(guidance, /1px/);
  assert.match(guidance, /最外一圈像素/);
  assert.match(guidance, /自然线稿和织物颗粒/);
});

test("retry guidance tells the model to regenerate one tile instead of a tiled preview", () => {
  const { buildRetryGuidance } = loadRetryGuidance();
  const guidance = buildRetryGuidance({
    issues: ["疑似平铺预览输出，不可修复"],
  });

  assert.match(guidance, /只输出一个完整的单个循环单元/);
  assert.match(guidance, /不要输出 2×2、3×3/);
  assert.match(guidance, /拼贴预览/);
});

test("retry guidance turns low-resolution failures into native high-detail constraints", () => {
  const { buildRetryGuidance } = loadRetryGuidance();
  const guidance = buildRetryGuidance({
    issues: ["低清放大痕迹，可增强", "印花细节密度不足，可增强"],
  });

  assert.match(guidance, /原生高清/);
  assert.match(guidance, /高分辨率细节/);
  assert.match(guidance, /禁止低分辨率放大/);
  assert.match(guidance, /细节被抹平/);
});

test("retry guidance deduplicates repeated issue categories and caps instructions", () => {
  const { buildRetryGuidance } = loadRetryGuidance();
  const guidance = buildRetryGuidance({
    finalIssueType: "低清放大痕迹，可增强",
    issues: [
      "低清放大痕迹，可增强",
      "成品清晰度不足，可增强",
      "最终JPG边缘硬线，不可修复",
      "疑似平铺预览输出，不可修复",
      "画框留白边界，不可修复",
      "镜像轴痕明显，可修复",
      "边缘错位漂移，可修复",
      "压缩块噪点，不可修复",
      "锐化光晕明显，不可修复",
    ],
  });
  const bullets = guidance.split("\n").filter((line) => line.startsWith("- "));
  const nativeHighDetailMentions = guidance.match(/原生高清/g) || [];

  assert.ok(bullets.length <= 6, `retry guidance should stay focused; got ${bullets.length} bullets`);
  assert.equal(nativeHighDetailMentions.length, 1, "related clarity/upscale issues should share one guidance line");
  assert.match(guidance, /等。/);
});

test("generation prompts use structured retry guidance for normal and fission modes", () => {
  const calls = appSource.match(/buildRetryGuidance\(previousCheck\)/g) || [];

  assert.equal(calls.length, 2, "normal generation and fission generation should both use retry guidance");
  assert.doesNotMatch(appSource, /上一次自动质检未通过，问题是：\$\{previousCheck\.issues\.join/);
});

function loadRetryGuidance() {
  const source = [
    extractFunction(appSource, "retryGuidanceForIssue"),
    extractFunction(appSource, "buildRetryGuidance"),
  ].join("\n");
  return Function(`"use strict"; ${source}\nreturn { buildRetryGuidance, retryGuidanceForIssue };`)();
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
