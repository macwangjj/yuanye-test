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
  const taskSelectionFunction = extractFunction(appSource, "toggleTaskSelection");
  const batchStateFunction = extractFunction(appSource, "updateBatchState");
  const selectGroupFunction = extractFunction(appSource, "selectActiveHistoryGroup");
  const downloadGroupFunction = extractFunction(appSource, "downloadActiveHistoryGroup");
  const selectedZipFunction = extractFunction(appSource, "downloadSelectedZip");
  const historyTemplateFunction = extractFunction(appSource, "historyRecordTemplate");
  const recordCertificationFunction = extractFunction(appSource, "recordHasCertifiedDownload");

  assert.match(taskSelectionFunction, /taskHasCertifiedDownload\(task\)/, "current task selection should use the same commercial certification gate as single downloads");
  assert.match(batchStateFunction, /item\.certified === true/, "batch count should only include explicitly certified items");
  assert.match(selectGroupFunction, /filter\(recordHasCertifiedDownload\)/, "history selection should filter to certified records");
  assert.match(downloadGroupFunction, /filter\(recordHasCertifiedDownload\)/, "history group download should filter to certified records");
  assert.match(recordCertificationFunction, /actual\.printSpecPassed === true/, "history certification must require saved print spec verification");
  assert.match(recordCertificationFunction, /certification\.certified === true/, "history certification must require an explicit certified handoff flag");
  assert.match(recordCertificationFunction, /gate\.fourWayRepeat === true/, "history certification must require saved four-way-repeat approval");
  assert.match(recordCertificationFunction, /gate\.qualityPassed === true/, "history certification must require saved quality approval");
  assert.match(recordCertificationFunction, /typeof gate\.seamDetailLossScore === "number"/, "history certification must require the seam detail-loss gate");
  assert.match(recordCertificationFunction, /typeof gate\.richnessScore === "number"/, "history certification must require the print richness gate");
  assert.match(recordCertificationFunction, /typeof gate\.layoutBalanceScore === "number"/, "history certification must require the layout balance gate");
  assert.match(recordCertificationFunction, /typeof gate\.mirrorAxisScore === "number"/, "history certification must require the mirror-axis gate");
  assert.match(recordCertificationFunction, /typeof gate\.preTiledPreviewScore === "number"/, "history certification must require the pre-tiled preview gate");
  assert.match(recordCertificationFunction, /typeof gate\.textureDensityScore === "number"/, "history certification must require the print texture-density gate");
  assert.match(recordCertificationFunction, /typeof gate\.outerFrameScore === "number"/, "history certification must require the outer-frame gate");
  assert.match(selectedZipFunction, /item\.certified === true/, "batch zip should only include explicitly certified entries");
  assert.match(historyTemplateFunction, /data-certified="\$\{certified\}"/, "history checkbox should carry certification state");
  assert.match(historyTemplateFunction, /disabled/, "uncertified history records should render a disabled download control");
});

test("history certification rejects stale or partial metadata", () => {
  const recordHasCertifiedDownload = compileFunction(appSource, "recordHasCertifiedDownload");
  const certifiedRecord = {
    imageUrl: "/history/current.jpg",
    qualityPassed: true,
    certification: {
      certified: true,
      actual: { printSpecPassed: true },
      gate: {
        fourWayRepeat: true,
        qualityPassed: true,
        seamDetailLossScore: 2.4,
        richnessScore: 9.8,
        layoutBalanceScore: 1.3,
        mirrorAxisScore: 0.9,
        preTiledPreviewScore: 0.4,
        textureDensityScore: 8.5,
        outerFrameScore: 0.8,
      },
    },
  };

  assert.equal(recordHasCertifiedDownload(certifiedRecord), true, "complete current certification should be downloadable");
  assert.equal(recordHasCertifiedDownload({
    ...certifiedRecord,
    certification: {
      ...certifiedRecord.certification,
      gate: {
        fourWayRepeat: true,
        qualityPassed: true,
      },
    },
  }), false, "records missing the seam detail-loss, richness, layout, mirror-axis, pre-tiled, texture-density, and outer-frame gates should not be downloadable");
  assert.equal(recordHasCertifiedDownload({
    imageUrl: "/history/old.jpg",
    qualityPassed: true,
    seamCheck: { passed: true },
    certification: {
      actual: { printSpecPassed: true },
    },
  }), false, "old records with only print-spec metadata should not be downloadable");
});

test("saved history records retain print certification metadata", () => {
  assert.match(appSource, /certification: buildPrintCertification\(task, actionType\)/, "client should send certification metadata");
  assert.match(appSource, /dpiMetadata: "JFIF inch density"/, "certification should state the JPG DPI metadata contract");
  assert.match(appSource, /printSpecPassed: check\.printSpec\?\.passed === true/, "certification should retain actual print-spec result");
  assert.match(appSource, /cornerJunctionScore: check\.tiledCorner\?\.score \|\| 0/, "certification should retain four-corner junction score");
  assert.match(appSource, /seamDetailLossScore: Math\.max\(check\.detailHorizontal\?\.score \|\| 0, check\.detailVertical\?\.score \|\| 0\)/, "certification should retain seam detail-loss score");
  assert.match(appSource, /richnessScore: typeof check\.richness\?\.richnessScore === "number" \? check\.richness\.richnessScore : null/, "certification should retain print richness score");
  assert.match(appSource, /layoutBalanceScore: typeof check\.layoutBalance\?\.balanceScore === "number" \? check\.layoutBalance\.balanceScore : null/, "certification should retain layout balance score");
  assert.match(appSource, /mirrorAxisScore: Math\.max\(check\.mirrorHorizontal\?\.score \|\| 0, check\.mirrorVertical\?\.score \|\| 0\)/, "certification should retain mirror-axis score");
  assert.match(appSource, /preTiledPreviewScore: typeof check\.preTiledPreview\?\.score === "number" \? check\.preTiledPreview\.score : null/, "certification should retain pre-tiled preview score");
  assert.match(appSource, /textureDensityScore: typeof check\.textureDensity\?\.textureDensityScore === "number" \? check\.textureDensity\.textureDensityScore : null/, "certification should retain texture-density score");
  assert.match(appSource, /outerFrameScore: typeof check\.outerFrame\?\.score === "number" \? check\.outerFrame\.score : null/, "certification should retain outer-frame score");
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

function compileFunction(source, name) {
  return Function(`"use strict"; return (${extractFunction(source, name)});`)();
}
