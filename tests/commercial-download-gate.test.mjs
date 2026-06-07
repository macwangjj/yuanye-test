import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("single-image download is gated by commercial certification", () => {
  const downloadFunction = extractFunction(appSource, "downloadJpg");
  const certificationFunction = extractFunction(appSource, "taskHasCertifiedDownload");

  assert.match(downloadFunction, /taskHasCertifiedDownload\(task\)/, "downloadJpg must check certification before creating a download link");
  assert.match(certificationFunction, /seamCheck\?\.printSpec\?\.passed === true/, "single-image certification must require print spec verification");
  assert.ok(
    downloadFunction.indexOf("taskHasCertifiedDownload(task)") < downloadFunction.indexOf("document.createElement(\"a\")"),
    "certification guard must run before the browser download link is created",
  );
});

test("history and batch downloads only include certified records", () => {
  const selectGroupFunction = extractFunction(appSource, "selectActiveHistoryGroup");
  const downloadGroupFunction = extractFunction(appSource, "downloadActiveHistoryGroup");
  const selectedZipFunction = extractFunction(appSource, "downloadSelectedZip");
  const historyTemplateFunction = extractFunction(appSource, "historyRecordTemplate");
  const recordCertificationFunction = extractFunction(appSource, "recordHasCertifiedDownload");

  assert.match(selectGroupFunction, /filter\(recordHasCertifiedDownload\)/, "history selection should filter to certified records");
  assert.match(downloadGroupFunction, /filter\(recordHasCertifiedDownload\)/, "history group download should filter to certified records");
  assert.match(recordCertificationFunction, /certification\?\.actual\?\.printSpecPassed === true/, "history certification must require saved print spec verification");
  assert.match(selectedZipFunction, /certified !== false/, "batch zip should reject explicitly uncertified entries");
  assert.match(historyTemplateFunction, /data-certified="\$\{certified\}"/, "history checkbox should carry certification state");
  assert.match(historyTemplateFunction, /disabled/, "uncertified history records should render a disabled download control");
});

test("saved history records retain print certification metadata", () => {
  assert.match(appSource, /certification: buildPrintCertification\(task, actionType\)/, "client should send certification metadata");
  assert.match(appSource, /dpiMetadata: "JFIF inch density"/, "certification should state the JPG DPI metadata contract");
  assert.match(appSource, /printSpecPassed: check\.printSpec\?\.passed === true/, "certification should retain actual print-spec result");
  assert.match(appSource, /cornerJunctionScore: check\.tiledCorner\?\.score \|\| 0/, "certification should retain four-corner junction score");
  assert.match(appSource, /seamDetailLossScore: Math\.max\(check\.detailHorizontal\?\.score \|\| 0, check\.detailVertical\?\.score \|\| 0\)/, "certification should retain seam detail-loss score");
  assert.match(appSource, /driftScore: Math\.max\(check\.driftHorizontal\?\.score \|\| 0, check\.driftVertical\?\.score \|\| 0\)/, "certification should retain edge-drift score");
  assert.match(serverSource, /certification: payload\.certification \|\| null/, "server should persist certification metadata");
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
