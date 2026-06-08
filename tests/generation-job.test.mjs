import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("server exposes background image generation jobs", () => {
  assert.match(serverSource, /const generationJobs = new Map\(\)/);
  assert.match(serverSource, /function createGenerationJob\(payload\)/);
  assert.match(serverSource, /async function runGenerationJob\(id, payload\)/);
  assert.match(serverSource, /request\.url === "\/api\/generate-jobs"/);
  assert.match(serverSource, /url\.pathname\.startsWith\("\/api\/generate-jobs\/"\)/);
  assert.match(serverSource, /sendJson\(response, 202, \{ job: publicGenerationJob\(job\) \}\)/);
});

test("slow image timeouts move to the next request form instead of retrying one slow attempt", () => {
  const withTransientRetrySource = extractFunction(serverSource, "withTransientRetry");
  const isSlowImageTimeoutErrorSource = extractFunction(serverSource, "isSlowImageTimeoutError");
  const fetchWithTimeoutSource = extractFunction(serverSource, "fetchWithTimeout");

  assert.match(withTransientRetrySource, /isSlowImageTimeoutError\(error\)/);
  assert.match(withTransientRetrySource, /break/);
  assert.match(isSlowImageTimeoutErrorSource, /图片接口等待超过/);
  assert.match(isSlowImageTimeoutErrorSource, /UND_ERR_HEADERS_TIMEOUT/);
  assert.match(fetchWithTimeoutSource, /isSlowImageTimeoutError\(error\)/);
});

test("non-image model errors skip the rest of that model attempts", () => {
  const generateImageSource = extractFunction(serverSource, "generateImage");
  const isNonImageModelErrorSource = extractFunction(serverSource, "isNonImageModelError");

  assert.match(generateImageSource, /const skippedModels = new Set\(\)/);
  assert.match(generateImageSource, /skippedModels\.has\(attempt\.model\)/);
  assert.match(generateImageSource, /isNonImageModelError\(error\)/);
  assert.match(generateImageSource, /skippedModels\.add\(attempt\.model\)/);
  assert.match(isNonImageModelErrorSource, /requires an image model/);
});

test("frontend uses background jobs for long image generation and AI seam repair", () => {
  const requestGeneratedImageSource = extractFunction(appSource, "requestGeneratedImage");
  const aiOffsetRepairTaskSource = extractFunction(appSource, "aiOffsetRepairTask");
  const requestImageGenerationSource = extractFunction(appSource, "requestImageGeneration");

  assert.match(requestImageGenerationSource, /"\/api\/generate-jobs"/);
  assert.match(requestImageGenerationSource, /`\/api\/generate-jobs\/\$\{encodeURIComponent\(jobId\)\}`/);
  assert.match(requestImageGenerationSource, /generateJobMaxWaitMs/);
  assert.match(requestGeneratedImageSource, /requestImageGeneration\(/);
  assert.doesNotMatch(requestGeneratedImageSource, /"\/api\/generate"/);
  assert.match(aiOffsetRepairTaskSource, /requestImageGeneration\(/);
  assert.doesNotMatch(aiOffsetRepairTaskSource, /"\/api\/generate"/);
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
