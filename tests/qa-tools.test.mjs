import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("QA seam tools are gated behind the qa query flag", () => {
  const installQaTools = extractFunction(appSource, "installQaTools");

  assert.match(installQaTools, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(installQaTools, /params\.get\("qa"\) !== "1"/);
  assert.match(installQaTools, /window\.YUANYE_QA = Object\.freeze/);
  assert.match(installQaTools, /checkSeamStructureQuality: \(dataUrl\) => checkSeamQuality\(dataUrl, \{ skipPrintSpec: true \}\)/);
  assert.match(installQaTools, /makeQaAiInternalGuideRepairJpg/);
  assert.match(installQaTools, /makeQaAiOffsetRepairJpg/);
  assert.match(installQaTools, /output\.id = "qaOutput"/);
  assert.match(installQaTools, /params\.get\("qaCheck"\)/);
  assert.match(installQaTools, /runQaCheck\(checkUrl, params\.get\("qaMode"\) \|\| "full", output\)/);
});

test("regular seam checks still apply the commercial print-spec gate", () => {
  assert.match(appSource, /function checkSeamQuality\(dataUrl, options = \{\}\)/);
  assert.match(appSource, /if \(options\.skipPrintSpec === true\)/);
  assert.match(appSource, /applyPrintSpecCheck\(check, printSpec\)/);
});

test("QA tools are installed before startup history and queue work", () => {
  const installIndex = appSource.indexOf("installQaTools();");
  const loadSettingsIndex = appSource.indexOf("loadSettings();");
  const loadHistoryIndex = appSource.lastIndexOf("loadHistory();");

  assert.notEqual(installIndex, -1);
  assert.ok(installIndex < loadSettingsIndex);
  assert.ok(installIndex < loadHistoryIndex);
});

test("QA tools expose real generation candidate checks", () => {
  const installQaTools = extractFunction(appSource, "installQaTools");
  const generatorSource = extractFunction(appSource, "makeQaGenerationCandidateFromUrl");

  assert.match(installQaTools, /makeQaGenerationCandidateFromUrl/);
  assert.match(generatorSource, /requestImageGeneration/);
  assert.match(generatorSource, /candidateIndex/);
  assert.match(generatorSource, /makeQaAiOffsetRepairJpg/);
  assert.match(generatorSource, /checkSeamQuality/);
});

test("QA check output keeps structure mode separate from commercial certification", () => {
  const runQaCheck = extractFunction(appSource, "runQaCheck");

  assert.match(runQaCheck, /checkSeamQuality\(url, \{ skipPrintSpec: mode === "structure" \}\)/);
  assert.match(appSource, /printSpecPassed: check\.printSpec\?\.passed === true/);
  assert.match(appSource, /issues: Array\.isArray\(check\.issues\) \? check\.issues : \[\]/);
  assert.match(appSource, /summary: seamCheckSummary\(check\)/);
});

test("QA repair pipeline can vary JPEG quality for diagnostics only", () => {
  const runQaRepairPipelineCheck = extractFunction(appSource, "runQaRepairPipelineCheck");
  const getQaJpegQuality = extractFunction(appSource, "getQaJpegQuality");

  assert.match(runQaRepairPipelineCheck, /const jpegQuality = getQaJpegQuality\(\)/);
  assert.match(runQaRepairPipelineCheck, /toDataURL\("image\/jpeg", jpegQuality\)/);
  assert.match(runQaRepairPipelineCheck, /jpegQuality,/);
  assert.match(getQaJpegQuality, /qaJpegQuality/);
  assert.match(getQaJpegQuality, /Math\.max\(0\.75, Math\.min\(1, value\)\)/);
});

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
