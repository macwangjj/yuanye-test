import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as qaBatch from "../tools/qa-batch.mjs";

const qaGenerateSource = readFileSync(new URL("../tools/qa-generate.mjs", import.meta.url), "utf8");

test("qa-generate reuses the browser QA harness and real generation endpoint", () => {
  assert.equal(typeof qaBatch.launchChrome, "function");
  assert.equal(typeof qaBatch.openQaPage, "function");
  assert.equal(typeof qaBatch.evaluate, "function");
  assert.equal(typeof qaBatch.CdpClient, "function");
  assert.match(qaGenerateSource, /makeQaGenerationCandidateFromUrl/);
  assert.match(qaGenerateSource, /candidateIndex/);
  assert.match(qaGenerateSource, /summarizeResults/);
});
