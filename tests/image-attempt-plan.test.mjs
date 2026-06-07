import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("maimai image attempts exhaust requested portrait size before auto fallback", () => {
  const { buildImageAttempts } = loadAttemptPlanner();
  const attempts = buildImageAttempts({
    model: "gpt-image-2",
    size: "1024x1536",
    maimaiGateway: true,
  });
  const firstAuto = attempts.findIndex((attempt) => attempt.size === "auto");
  const requestedHighQuality = attempts.findIndex((attempt) => attempt.size === "1024x1536" && attempt.highQuality === true);

  assert.notEqual(firstAuto, -1, "maimai plan should retain auto as a fallback");
  assert.notEqual(requestedHighQuality, -1, "maimai plan should include a high-quality requested-size attempt");
  assert.ok(requestedHighQuality < firstAuto, `requested-size high-quality attempt should run before auto; got ${JSON.stringify(attempts)}`);
  assert.deepEqual(attempts.slice(0, 4).map((attempt) => attempt.size), ["1024x1536", "1024x1536", "1024x1536", "1024x1536"]);
});

test("standard image attempts keep masked repair before unmasked generation", () => {
  const { buildImageAttempts } = loadAttemptPlanner();
  const attempts = buildImageAttempts({
    model: "gpt-image-2",
    size: "1024x1536",
    hasMask: true,
    maimaiGateway: false,
  });

  assert.equal(attempts[0].masked, true, "masked repair should remain first when a mask is available");
  assert.equal(attempts[0].size, "1024x1536");
  assert.equal(attempts[0].highQuality, true);
});

function loadAttemptPlanner() {
  const source = extractFunction(serverSource, "buildImageAttempts");
  return Function(`"use strict"; ${source}\nreturn { buildImageAttempts };`)();
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(")", start);
  const braceStart = source.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}
