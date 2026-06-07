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
  assert.match(certificationFunction, /seamCheck\?\.aspectWarp\?\.passed === true/, "single-image certification must reject aspect-warped exports");
  assert.match(certificationFunction, /hasValidExportGeometry\(aspectWarp\.mode, aspectWarp\.columns, aspectWarp\.rows\)/, "single-image certification must require export geometry metadata");
  assert.ok(
    downloadFunction.indexOf("taskHasCertifiedDownload(task)") < downloadFunction.indexOf("document.createElement(\"a\")"),
    "certification guard must run before the browser download link is created",
  );
});

test("current task certification rejects missing or mismatched export geometry", () => {
  const taskHasCertifiedDownload = compileFunction(appSource, "taskHasCertifiedDownload", ["hasValidExportGeometry"]);
  const certifiedTask = {
    resultJpgUrl: "/current.jpg",
    qualityPassed: true,
    seamCheck: {
      passed: true,
      printSpec: { passed: true },
      aspectWarp: { passed: true, mode: "direct-stretch", columns: 1, rows: 1 },
    },
  };

  assert.equal(taskHasCertifiedDownload(certifiedTask), true, "direct portrait tasks with complete export geometry should be downloadable");
  assert.equal(taskHasCertifiedDownload({
    ...certifiedTask,
    seamCheck: {
      ...certifiedTask.seamCheck,
      aspectWarp: { passed: true, mode: "periodic-grid", columns: 2, rows: 3 },
    },
  }), true, "periodic-grid rectified tasks with complete export geometry should be downloadable");
  assert.equal(taskHasCertifiedDownload({
    ...certifiedTask,
    seamCheck: {
      ...certifiedTask.seamCheck,
      aspectWarp: { passed: true },
    },
  }), false, "tasks missing export geometry should not be downloadable");
  assert.equal(taskHasCertifiedDownload({
    ...certifiedTask,
    seamCheck: {
      ...certifiedTask.seamCheck,
      aspectWarp: { passed: true, mode: "direct-stretch", columns: 2, rows: 3 },
    },
  }), false, "direct exports with periodic grid dimensions should not be downloadable");
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
  assert.match(recordCertificationFunction, /actual\.aspectWarpPassed === true/, "history certification must require saved aspect-warp verification");
  assert.match(recordCertificationFunction, /hasValidExportGeometry\(actual\.exportMode, actual\.tileColumns, actual\.tileRows\)/, "history certification must require export geometry metadata");
  assert.match(appSource, /exportMode === "direct-stretch" \|\| exportMode === "periodic-grid"/, "export geometry must require a known export mode");
  assert.match(appSource, /Number\.isInteger\(tileColumns\)/, "export geometry must require saved export grid columns");
  assert.match(appSource, /Number\.isInteger\(tileRows\)/, "export geometry must require saved export grid rows");
  assert.match(recordCertificationFunction, /certification\.certified === true/, "history certification must require an explicit certified handoff flag");
  assert.match(recordCertificationFunction, /gate\.fourWayRepeat === true/, "history certification must require saved four-way-repeat approval");
  assert.match(recordCertificationFunction, /gate\.qualityPassed === true/, "history certification must require saved quality approval");
  assert.match(recordCertificationFunction, /typeof gate\.seamDetailLossScore === "number"/, "history certification must require the seam detail-loss gate");
  assert.match(recordCertificationFunction, /typeof gate\.upscaleArtifactScore === "number"/, "history certification must require the low-resolution upscale gate");
  assert.match(recordCertificationFunction, /typeof gate\.richnessScore === "number"/, "history certification must require the print richness gate");
  assert.match(recordCertificationFunction, /typeof gate\.layoutBalanceScore === "number"/, "history certification must require the layout balance gate");
  assert.match(recordCertificationFunction, /typeof gate\.mirrorAxisScore === "number"/, "history certification must require the mirror-axis gate");
  assert.match(recordCertificationFunction, /typeof gate\.preTiledPreviewScore === "number"/, "history certification must require the pre-tiled preview gate");
  assert.match(recordCertificationFunction, /typeof gate\.textureDensityScore === "number"/, "history certification must require the print texture-density gate");
  assert.match(recordCertificationFunction, /typeof gate\.outerFrameScore === "number"/, "history certification must require the outer-frame gate");
  assert.match(recordCertificationFunction, /typeof gate\.aspectWarpRatio === "number"/, "history certification must require the aspect-warp gate");
  assert.match(selectedZipFunction, /item\.certified === true/, "batch zip should only include explicitly certified entries");
  assert.match(historyTemplateFunction, /historyExportModeText\(record\)/, "history records should disclose direct or periodic export mode");
  assert.match(historyTemplateFunction, /data-certified="\$\{certified\}"/, "history checkbox should carry certification state");
  assert.match(historyTemplateFunction, /disabled/, "uncertified history records should render a disabled download control");
});

test("history certification rejects stale or partial metadata", () => {
  const recordHasCertifiedDownload = compileFunction(appSource, "recordHasCertifiedDownload", ["hasValidExportGeometry"]);
  const historyExportModeText = compileFunction(appSource, "historyExportModeText");
  const certifiedRecord = {
    imageUrl: "/history/current.jpg",
    qualityPassed: true,
    certification: {
      certified: true,
      actual: { printSpecPassed: true, aspectWarpPassed: true, exportMode: "direct-stretch", tileColumns: 1, tileRows: 1 },
      gate: {
        fourWayRepeat: true,
        qualityPassed: true,
        seamDetailLossScore: 2.4,
        upscaleArtifactScore: 9.2,
        richnessScore: 9.8,
        layoutBalanceScore: 1.3,
        mirrorAxisScore: 0.9,
        preTiledPreviewScore: 0.4,
        textureDensityScore: 8.5,
        outerFrameScore: 0.8,
        aspectWarpRatio: 1.02,
        aspectStretchPercent: 2,
      },
    },
  };

  assert.equal(recordHasCertifiedDownload(certifiedRecord), true, "complete current certification should be downloadable");
  assert.equal(recordHasCertifiedDownload({
    ...certifiedRecord,
    certification: {
      ...certifiedRecord.certification,
      actual: { printSpecPassed: true, aspectWarpPassed: true, exportMode: "periodic-grid", tileColumns: 2, tileRows: 3 },
    },
  }), true, "periodic-grid rectified records with complete certification should be downloadable");
  assert.equal(historyExportModeText(certifiedRecord), "竖版直出", "history should label direct portrait exports");
  assert.equal(historyExportModeText({
    certification: {
      actual: { exportMode: "periodic-grid", tileColumns: 2, tileRows: 3 },
    },
  }), "周期转竖版 2×3", "history should label periodic-grid rectified exports");
  assert.equal(recordHasCertifiedDownload({
    ...certifiedRecord,
    certification: {
      ...certifiedRecord.certification,
      gate: {
        fourWayRepeat: true,
        qualityPassed: true,
      },
    },
  }), false, "records missing the seam detail-loss, upscale-artifact, richness, layout, mirror-axis, pre-tiled, texture-density, outer-frame, and aspect-warp gates should not be downloadable");
  assert.equal(recordHasCertifiedDownload({
    ...certifiedRecord,
    certification: {
      ...certifiedRecord.certification,
      actual: { printSpecPassed: true, aspectWarpPassed: true },
    },
  }), false, "records missing export-mode metadata should not be downloadable");
  assert.equal(recordHasCertifiedDownload({
    ...certifiedRecord,
    certification: {
      ...certifiedRecord.certification,
      actual: { printSpecPassed: true, aspectWarpPassed: true, exportMode: "direct-stretch", tileColumns: 2, tileRows: 3 },
    },
  }), false, "direct exports with periodic grid dimensions should not be downloadable");
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
  assert.match(appSource, /upscaleArtifactScore: typeof check\.upscaleArtifact\?\.artifactScore === "number" \? check\.upscaleArtifact\.artifactScore : null/, "certification should retain low-resolution upscale artifact score");
  assert.match(appSource, /richnessScore: typeof check\.richness\?\.richnessScore === "number" \? check\.richness\.richnessScore : null/, "certification should retain print richness score");
  assert.match(appSource, /layoutBalanceScore: typeof check\.layoutBalance\?\.balanceScore === "number" \? check\.layoutBalance\.balanceScore : null/, "certification should retain layout balance score");
  assert.match(appSource, /mirrorAxisScore: Math\.max\(check\.mirrorHorizontal\?\.score \|\| 0, check\.mirrorVertical\?\.score \|\| 0\)/, "certification should retain mirror-axis score");
  assert.match(appSource, /preTiledPreviewScore: typeof check\.preTiledPreview\?\.score === "number" \? check\.preTiledPreview\.score : null/, "certification should retain pre-tiled preview score");
  assert.match(appSource, /textureDensityScore: typeof check\.textureDensity\?\.textureDensityScore === "number" \? check\.textureDensity\.textureDensityScore : null/, "certification should retain texture-density score");
  assert.match(appSource, /outerFrameScore: typeof check\.outerFrame\?\.score === "number" \? check\.outerFrame\.score : null/, "certification should retain outer-frame score");
  assert.match(appSource, /exportMode: check\.aspectWarp\?\.mode \|\| ""/, "certification should retain export mode");
  assert.match(appSource, /tileColumns: check\.aspectWarp\?\.columns \|\| 1/, "certification should retain periodic grid columns");
  assert.match(appSource, /tileRows: check\.aspectWarp\?\.rows \|\| 1/, "certification should retain periodic grid rows");
  assert.match(appSource, /aspectWarpPassed: check\.aspectWarp\?\.passed === true/, "certification should retain aspect-warp pass state");
  assert.match(appSource, /aspectWarpRatio: typeof check\.aspectWarp\?\.warpRatio === "number" \? check\.aspectWarp\.warpRatio : null/, "certification should retain aspect-warp ratio");
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

function compileFunction(source, name, dependencies = []) {
  const dependencySource = dependencies.map((dependency) => extractFunction(source, dependency)).join("\n");
  return Function(`"use strict"; ${dependencySource}\nreturn (${extractFunction(source, name)});`)();
}
