import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("internal guide AI repair is routed before offset seam repair", () => {
  const generateTaskSource = extractFunction(appSource, "generateTask");
  const repairTaskSource = extractFunction(appSource, "repairTask");
  const offerSource = extractFunction(appSource, "shouldOfferTaskRepair");

  const internalIndex = generateTaskSource.indexOf("shouldAiInternalGuideRepair(lastCheck)");
  const offsetIndex = generateTaskSource.indexOf("shouldAiOffsetRepair(lastCheck)");
  assert.notEqual(internalIndex, -1);
  assert.notEqual(offsetIndex, -1);
  assert.ok(internalIndex < offsetIndex, "internal guide repair should run before offset repair");

  assert.match(repairTaskSource, /canRunAiInternalGuideRepair\(task, baseCheck\)/);
  assert.ok(
    repairTaskSource.indexOf("aiInternalGuideRepairFollowupTask") < repairTaskSource.indexOf("aiOffsetRepairFollowupTask"),
    "manual repair should prefer original-coordinate guide repair",
  );
  assert.match(offerSource, /canRunAiInternalGuideRepair\(task, check\)/);
});

test("internal guide repair mask and prompt protect already-closed outer edges", () => {
  const maskSource = extractFunction(appSource, "drawInternalGuideRepairMask");
  const promptSource = extractFunction(appSource, "buildInternalGuideRepairPrompt");
  const predicateSource = extractFunction(appSource, "shouldAiInternalGuideRepair");

  assert.match(maskSource, /protectedEdgeX = width \* 0\.12/);
  assert.match(maskSource, /internalGuideLineEditStrength/);
  assert.match(maskSource, /internalGuideJunctionEditStrength/);
  assert.match(promptSource, /外侧上下左右边缘已经基本闭合/);
  assert.match(promptSource, /不要移动、重画或破坏外侧边缘/);
  assert.match(predicateSource, /edgeDominant <= 8/);
  assert.match(predicateSource, /borderWorst <= 48/);
  assert.match(predicateSource, /!driftRisk/);
});

test("internal guide repair task uses an original-coordinate mask without offsetting the tile", () => {
  const taskSource = extractFunction(appSource, "aiInternalGuideRepairTask");

  assert.match(taskSource, /makeInternalGuideRepairMaskDataUrl\(repairSourceUrl\)/);
  assert.match(taskSource, /buildInternalGuideRepairPrompt\(previousCheck\)/);
  assert.match(taskSource, /blendMaskedRepairDataUrl\(repairSourceUrl, payload\.image\.dataUrl, maskDataUrl/);
  assert.doesNotMatch(taskSource, /makeOffsetDataUrl/);
});

test("masked AI repair results are composited through the mask before use", () => {
  const blendSource = extractFunction(appSource, "blendMaskedRepairDataUrl");
  const offsetTaskSource = extractFunction(appSource, "aiOffsetRepairTask");

  assert.match(blendSource, /1 - mask\.data\[index \+ 3\] \/ 255/);
  assert.match(blendSource, /source\.data\[index \+ channel\] \* \(1 - edit\)/);
  assert.match(offsetTaskSource, /blendMaskedRepairDataUrl\(offsetDataUrl, payload\.image\.dataUrl, maskDataUrl/);
  assert.match(offsetTaskSource, /makeOffsetDataUrl\(blendedOffsetDataUrl/);
});

function extractFunction(source, name) {
  const start = Math.max(source.indexOf(`async function ${name}`), source.indexOf(`function ${name}`));
  assert.notEqual(start, -1, `${name} should exist`);
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = parenStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (parenDepth === 0) {
      braceStart = source.indexOf("{", index);
      break;
    }
  }
  assert.notEqual(braceStart, -1, `${name} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}
