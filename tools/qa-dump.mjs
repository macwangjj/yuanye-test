import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const summaryOnly = process.argv.includes("--summary");
const url = process.argv.find((arg) => /^https?:\/\//.test(arg));
const timeoutArg = process.argv.find((arg) => /^\d+$/.test(arg));
const timeoutMs = Number(timeoutArg || 140000);

if (!url) {
  console.error("Usage: node tools/qa-dump.mjs <qa-url> [timeout-ms]");
  process.exit(2);
}

const userDataDir = await mkdtemp(join(tmpdir(), "wfstyh-chrome-qa-"));
const { stdout } = await execFileAsync(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--disable-background-networking",
  `--user-data-dir=${userDataDir}`,
  `--virtual-time-budget=${timeoutMs}`,
  "--dump-dom",
  url,
], {
  maxBuffer: 80 * 1024 * 1024,
  timeout: timeoutMs + 20000,
});

const match = stdout.match(/<pre id="qaOutput"[^>]*>([\s\S]*?)<\/pre>/);
if (!match) {
  console.error("Could not find #qaOutput in Chrome output.");
  console.log(stdout.slice(-8000));
  process.exit(1);
}

const text = decodeHtml(match[1]).trim();
let payload;
try {
  payload = JSON.parse(text);
} catch (error) {
  console.error("Could not parse #qaOutput JSON.");
  console.error(error.message);
  console.log(text.slice(0, 8000));
  process.exit(1);
}

console.log(JSON.stringify(summaryOnly ? summarize(payload) : payload, null, 2));

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function summarize(payload) {
  const stages = {};
  for (const key of ["before", "afterEdge", "afterInternal", "rawAfterRefine", "afterRefine", "after"]) {
    if (payload[key]) stages[key] = summarizeCheck(payload[key]);
  }
  if (payload.passed !== undefined || payload.score !== undefined) {
    stages.check = summarizeCheck(payload);
  }
  return {
    status: payload.status,
    repair: payload.repair,
    mode: payload.mode,
    url: payload.url,
    stages,
  };
}

function summarizeCheck(check) {
  return {
    passed: check.passed,
    issue: check.finalIssueType,
    score: round(check.score),
    horizontal: round(check.horizontalScore),
    vertical: round(check.verticalScore),
    corner: round(check.cornerScore),
    tiled: round(check.tiledScore),
    tiledCorner: round(check.tiledCornerScore),
    internal: round(check.repairMetrics?.internalScore),
    internalWorst: round(check.repairMetrics?.internalWorst),
    bandH: summarizeBand(check.bandHorizontal),
    bandV: summarizeBand(check.bandVertical),
    tiledH: summarizeTiled(check.tiledHorizontal),
    tiledV: summarizeTiled(check.tiledVertical),
    cornerJunction: summarizeCorner(check.tiledCorner),
    printSpecPassed: check.printSpecPassed,
  };
}

function summarizeBand(band) {
  if (!band) return null;
  return {
    score: round(band.score),
    worst: round(band.worstScore),
    shift: band.shiftWindows,
    shiftRatio: round(band.shiftRatio),
    bandShift: round(band.bandShift),
    edgeActivity: round(band.edgeActivity),
    innerActivity: round(band.innerActivity),
    risk: band.bandRisk,
  };
}

function summarizeTiled(tiled) {
  if (!tiled) return null;
  return {
    score: round(tiled.score),
    worst: round(tiled.worstScore),
    halo: tiled.haloWindows,
    haloRatio: round(tiled.haloRatio),
    risk: tiled.lineRisk,
  };
}

function summarizeCorner(corner) {
  if (!corner) return null;
  return {
    score: round(corner.score),
    worst: round(corner.worstScore),
    halo: corner.haloSamples,
    haloRatio: round(corner.haloRatio),
    localActivity: round(corner.localActivity),
    risk: corner.junctionRisk,
  };
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : value ?? null;
}
