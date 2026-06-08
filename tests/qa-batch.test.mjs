import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeImagePath,
  parseArgs,
  summarizeResults,
} from "../tools/qa-batch.mjs";

test("qa-batch parses batch options without changing the strict seam standard", () => {
  const options = parseArgs([
    "--base",
    "http://127.0.0.1:4190",
    "--limit=25",
    "--timeout",
    "240000",
    "--repair=pipeline",
    "--password-env",
    "YUANYE_PASSWORD",
    "--include-repairs",
    "history/a.jpg",
  ]);

  assert.equal(options.base, "http://127.0.0.1:4190");
  assert.equal(options.limit, 25);
  assert.equal(options.timeoutMs, 240000);
  assert.equal(options.repair, "pipeline");
  assert.equal(options.passwordEnv, "YUANYE_PASSWORD");
  assert.equal(options.includeRepairs, true);
  assert.deepEqual(options.images, ["history/a.jpg"]);
});

test("qa-batch rejects unsupported repair modes", () => {
  assert.throws(
    () => parseArgs(["--repair=loose"]),
    /Invalid repair mode/,
  );
});

test("qa-batch accepts strict periodic repair mode", () => {
  const options = parseArgs(["--repair", "strict"]);
  assert.equal(options.repair, "strict");
});

test("qa-batch accepts AI repair modes", () => {
  assert.equal(parseArgs(["--repair=ai-internal"]).repair, "ai-internal");
  assert.equal(parseArgs(["--repair=ai-offset"]).repair, "ai-offset");
  assert.equal(parseArgs(["--repair=ai-auto"]).repair, "ai-auto");
});

test("qa-batch normalizes local history image paths to site URLs", () => {
  assert.equal(normalizeImagePath("history/sample.jpg"), "/history/sample.jpg");
  assert.equal(normalizeImagePath("/Users/macwang/Desktop/codex/WFSTYH/history/sample.jpg"), "/history/sample.jpg");
  assert.equal(normalizeImagePath("sample.jpg"), "/history/sample.jpg");
  assert.equal(normalizeImagePath("https://example.com/sample.jpg"), "https://example.com/sample.jpg");
});

test("qa-batch summarizes pass rate and failure distribution", () => {
  const summary = summarizeResults([
    { status: "ok", path: "/history/a.jpg", passed: true },
    { status: "ok", path: "/history/b.jpg", passed: false, issue: "四角平铺交汇明显，可修复" },
    { status: "error", path: "/history/c.jpg", passed: false, error: "读取图片失败" },
    { status: "ok", path: "/history/d.jpg", passed: true },
  ], {
    base: "http://127.0.0.1:4190",
    repair: "none",
  });

  assert.equal(summary.count, 4);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.errored, 1);
  assert.equal(summary.passRate, 0.5);
  assert.deepEqual(summary.issues, [
    { issue: "四角平铺交汇明显，可修复", count: 1 },
    { issue: "读取图片失败", count: 1 },
  ]);
});
