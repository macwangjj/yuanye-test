#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const defaultBase = "http://127.0.0.1:4190";
const allowedRepairModes = new Set(["none", "pipeline", "strict", "ai-internal", "ai-offset", "ai-auto"]);

export function parseArgs(argv) {
  const options = {
    base: defaultBase,
    limit: 100,
    timeoutMs: 180000,
    includeRepairs: false,
    repair: "none",
    password: null,
    passwordEnv: "YUANYE_PASSWORD",
    noLogin: false,
    help: false,
    images: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--include-repairs") {
      options.includeRepairs = true;
    } else if (arg === "--no-login") {
      options.noLogin = true;
    } else if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
    } else if (arg === "--base") {
      options.base = argv[++index] || "";
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(arg.slice("--limit=".length), "limit");
    } else if (arg === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "limit");
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout=".length), "timeout");
    } else if (arg === "--timeout") {
      options.timeoutMs = parsePositiveInteger(argv[++index], "timeout");
    } else if (arg.startsWith("--repair=")) {
      options.repair = parseRepairMode(arg.slice("--repair=".length));
    } else if (arg === "--repair") {
      options.repair = parseRepairMode(argv[++index]);
    } else if (arg.startsWith("--password-env=")) {
      options.passwordEnv = arg.slice("--password-env=".length);
    } else if (arg === "--password-env") {
      options.passwordEnv = argv[++index] || "";
    } else if (arg.startsWith("--password=")) {
      options.password = arg.slice("--password=".length);
    } else if (arg === "--password") {
      options.password = argv[++index] || "";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.images.push(arg);
    }
  }

  if (!options.base) throw new Error("Missing --base value.");
  return options;
}

export function normalizeImagePath(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (/^(data:|https?:\/\/)/i.test(value)) return value;

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/history/")) return normalized;
  if (normalized.startsWith("history/")) return `/${normalized}`;

  const marker = "/history/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex);

  return `/history/${basename(normalized)}`;
}

export async function discoverHistoryImages(options = {}) {
  const historyDir = options.historyDir || "history";
  const includeRepairs = options.includeRepairs === true;
  const limit = Number.isFinite(options.limit) ? options.limit : 100;
  const entries = await readdir(historyDir);
  const imageNames = entries.filter((name) => {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) return false;
    if (!includeRepairs && name.startsWith("repair-")) return false;
    return true;
  });

  const rows = await Promise.all(imageNames.map(async (name) => {
    const fileStat = await stat(join(historyDir, name));
    return { name, mtimeMs: fileStat.mtimeMs };
  }));

  return rows
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, limit)
    .map((row) => `/history/${row.name}`);
}

export function summarizeResults(results, options = {}) {
  const issueCounts = new Map();
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for (const result of results) {
    if (result.status === "ok" && result.passed === true) {
      passed += 1;
      continue;
    }

    failed += 1;
    if (result.status === "error") errored += 1;
    const issue = result.issue || result.error || "unknown";
    issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
  }

  return {
    status: "done",
    base: options.base || null,
    repair: options.repair || "none",
    count: results.length,
    passed,
    failed,
    errored,
    passRate: results.length ? round(passed / results.length) : 0,
    issues: Array.from(issueCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([issue, count]) => ({ issue, count })),
    results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      "Usage: node tools/qa-batch.mjs [options] [image ...]",
      "",
      "Options:",
      `  --base <url>          QA site base URL. Default: ${defaultBase}`,
      "  --limit <n>           Number of discovered history images to test. Default: 100",
      "  --timeout <ms>        Per-image browser evaluation timeout. Default: 180000",
      "  --include-repairs     Include history files whose names start with repair-.",
      "  --repair <mode>       none, pipeline, strict, ai-internal, ai-offset, or ai-auto. Default: none",
      "  --password-env <name>  Env/.env variable used for site login. Default: YUANYE_PASSWORD",
      "  --password <value>     Site login password. Prefer --password-env to keep secrets out of ps output.",
      "  --no-login            Do not attempt password login before QA.",
      "",
      "If no images are passed, the newest non-repair JPG files in history/ are tested.",
    ].join("\n"));
    return;
  }

  const discovered = options.images.length
    ? options.images.map(normalizeImagePath).filter(Boolean)
    : await discoverHistoryImages({
      includeRepairs: options.includeRepairs,
      limit: options.limit,
    });

  if (!discovered.length) throw new Error("No images found to test.");

  const chrome = await launchChrome();
  let client;
  try {
    client = await CdpClient.connect(chrome.wsUrl);
    const sessionId = await createPageSession(client);
    await openQaPage(client, sessionId, {
      base: options.base,
      timeoutMs: options.timeoutMs,
      password: resolvePassword(options),
    });

    const results = [];
    for (let index = 0; index < discovered.length; index += 1) {
      const imagePath = discovered[index];
      process.stderr.write(`[${index + 1}/${discovered.length}] ${imagePath}\n`);
      const result = await runImageCheck(client, sessionId, imagePath, options.repair, options.timeoutMs);
      results.push(result);
    }

    console.log(JSON.stringify(summarizeResults(results, {
      base: options.base,
      repair: options.repair,
    }), null, 2));
  } finally {
    if (client) client.close();
    await chrome.close();
  }
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function parseRepairMode(value) {
  const mode = String(value || "").trim();
  if (!allowedRepairModes.has(mode)) {
    throw new Error(`Invalid repair mode: ${value}. Use none, pipeline, strict, ai-internal, ai-offset, or ai-auto.`);
  }
  return mode;
}

export async function launchChrome() {
  const userDataDir = await mkdtempChromeProfile();
  const child = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const wsUrl = await waitForDevToolsUrl(child);
  return {
    wsUrl,
    async close() {
      if (!child.killed) child.kill("SIGTERM");
      await waitForExit(child, 3000);
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

async function mkdtempChromeProfile() {
  const { mkdtemp } = await import("node:fs/promises");
  return await mkdtemp(join(tmpdir(), "wfstyh-chrome-qa-batch-"));
}

function waitForDevToolsUrl(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => {
      finish(reject, new Error(`Chrome did not expose a DevTools URL.\n${output.slice(-2000)}`));
    }, 20000);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(resolve, match[1]);
    };

    const onExit = (code) => {
      finish(reject, new Error(`Chrome exited before DevTools became ready: ${code}\n${output.slice(-2000)}`));
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", (error) => finish(reject, error));

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      callback(value);
    }
  });
}

export async function createPageSession(client) {
  const target = await client.send("Target.createTarget", { url: "about:blank" });
  const attached = await client.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  await client.send("Page.enable", {}, attached.sessionId);
  await client.send("Runtime.enable", {}, attached.sessionId);
  return attached.sessionId;
}

export async function openQaPage(client, sessionId, options) {
  const { base, timeoutMs, password } = options;
  const url = qaPageUrl(base);
  if (password) {
    await loginToSite(client, sessionId, base, password, timeoutMs);
  }

  await client.send("Page.navigate", { url }, sessionId);
  const deadline = Date.now() + timeoutMs;
  let redirectedToLogin = false;
  while (Date.now() < deadline) {
    const ready = await evaluate(client, sessionId, "document.readyState === 'complete' && !!window.YUANYE_QA", 10000);
    if (ready === true) return;
    redirectedToLogin = await evaluate(client, sessionId, "location.pathname === '/login.html'", 10000) === true;
    if (redirectedToLogin && !password) break;
    await sleep(250);
  }
  if (redirectedToLogin) {
    throw new Error("QA page redirected to login. Set --password-env YUANYE_PASSWORD or pass --password.");
  }
  throw new Error(`QA page did not become ready: ${url}`);
}

async function loginToSite(client, sessionId, base, password, timeoutMs) {
  await client.send("Page.navigate", { url: loginPageUrl(base) }, sessionId);
  await waitForDocumentReady(client, sessionId, timeoutMs);
  const result = await evaluate(client, sessionId, `(${async function login(passwordValue) {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordValue }),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    return {
      ok: response.ok,
      status: response.status,
      error: payload.error || null,
    };
  }.toString()})(${JSON.stringify(password)})`, timeoutMs);

  if (!result?.ok) {
    throw new Error(`Site login failed: HTTP ${result?.status || "unknown"} ${result?.error || ""}`.trim());
  }
}

async function waitForDocumentReady(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(client, sessionId, "document.readyState === 'complete'", 10000);
    if (ready === true) return;
    await sleep(250);
  }
  throw new Error("Page did not finish loading.");
}

async function runImageCheck(client, sessionId, imagePath, repair, timeoutMs) {
  const expression = buildCheckExpression(imagePath, repair);
  return await evaluate(client, sessionId, expression, timeoutMs);
}

function buildCheckExpression(imagePath, repair) {
  return `(${async function batchCheck(input) {
    const round = (value) => typeof value === "number" ? Math.round(value * 1000) / 1000 : value ?? null;
    const band = (item) => item ? ({
      score: round(item.score),
      worst: round(item.worstScore),
      shift: item.shiftWindows,
      shiftRatio: round(item.shiftRatio),
      bandShift: round(item.bandShift),
      edgeActivity: round(item.edgeActivity),
      innerActivity: round(item.innerActivity),
      risk: item.bandRisk,
    }) : null;
    const tiled = (item) => item ? ({
      score: round(item.score),
      worst: round(item.worstScore),
      halo: item.haloWindows,
      haloRatio: round(item.haloRatio),
      risk: item.lineRisk,
    }) : null;
    const corner = (item) => item ? ({
      score: round(item.score),
      worst: round(item.worstScore),
      halo: item.haloSamples,
      haloRatio: round(item.haloRatio),
      localActivity: round(item.localActivity),
      risk: item.junctionRisk,
    }) : null;
    const compact = (check) => ({
      passed: check.passed,
      issue: check.finalIssueType || null,
      score: round(check.score),
      horizontal: round(check.horizontalScore),
      vertical: round(check.verticalScore),
      corner: round(check.cornerScore),
      tiled: round(check.tiledScore ?? Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0)),
      tiledCorner: round(check.tiledCornerScore),
      internal: round(check.repairMetrics?.internalScore ?? Math.max(check.internalHorizontal?.score || 0, check.internalVertical?.score || 0)),
      bandH: band(check.bandHorizontal),
      bandV: band(check.bandVertical),
      tiledH: tiled(check.tiledHorizontal),
      tiledV: tiled(check.tiledVertical),
      cornerJunction: corner(check.tiledCorner),
      printSpecPassed: check.printSpecPassed,
    });
    const visualWorst = (check) => Math.max(
      check?.localHorizontal?.worstScore || 0,
      check?.localVertical?.worstScore || 0,
      check?.internalHorizontal?.worstScore || 0,
      check?.internalVertical?.worstScore || 0,
      check?.bandHorizontal?.worstScore || 0,
      check?.bandVertical?.worstScore || 0,
      check?.detailHorizontal?.worstScore || 0,
      check?.detailVertical?.worstScore || 0,
      check?.tiledHorizontal?.worstScore || 0,
      check?.tiledVertical?.worstScore || 0,
      check?.tiledCorner?.worstScore || 0,
      check?.driftHorizontal?.worstScore || 0,
      check?.driftVertical?.worstScore || 0,
      check?.mirrorHorizontal?.worstScore || 0,
      check?.mirrorVertical?.worstScore || 0,
    );
    const better = (next, previous) => {
      if (!next) return false;
      if (!previous) return true;
      if (next.passed && !previous.passed) return true;
      if (!next.passed && previous.passed) return false;
      const scoreGain = (previous.score || 0) - (next.score || 0);
      const worstGain = visualWorst(previous) - visualWorst(next);
      return scoreGain > Math.max(0.7, (previous.score || 0) * 0.08) || worstGain > Math.max(1.2, visualWorst(previous) * 0.08);
    };

    try {
      const qa = window.YUANYE_QA;
      const before = await qa.checkSeamStructureQuality(input.path);
      let final = before;
      const steps = [];
      if (input.repair === "pipeline" || input.repair === "strict") {
        const repaired = input.repair === "strict"
          ? await qa.makeStrictSeamlessJpg(input.path, before)
          : await qa.makeEdgeBlendRepairJpg(input.path, before);
        final = await qa.checkSeamStructureQuality(repaired);
        steps.push(input.repair);
      } else if (input.repair === "ai-internal") {
        const repaired = await qa.makeQaAiInternalGuideRepairJpg(input.path, before);
        final = await qa.checkSeamStructureQuality(repaired);
        steps.push("ai-internal");
      } else if (input.repair === "ai-offset") {
        const repaired = await qa.makeQaAiOffsetRepairJpg(input.path, before);
        final = await qa.checkSeamStructureQuality(repaired);
        steps.push("ai-offset");
      } else if (input.repair === "ai-auto") {
        let currentPath = input.path;
        let current = before;
        if (qa.shouldAiInternalGuideRepair(current)) {
          const candidatePath = await qa.makeQaAiInternalGuideRepairJpg(currentPath, current);
          const candidate = await qa.checkSeamStructureQuality(candidatePath);
          if (better(candidate, current)) {
            currentPath = candidatePath;
            current = candidate;
            steps.push("ai-internal");
          } else {
            steps.push("ai-internal:rejected");
          }
        }
        if (!current.passed && qa.shouldAiOffsetRepair(current)) {
          const candidatePath = await qa.makeQaAiOffsetRepairJpg(currentPath, current);
          const candidate = await qa.checkSeamStructureQuality(candidatePath);
          if (better(candidate, current)) {
            currentPath = candidatePath;
            current = candidate;
            steps.push("ai-offset");
          } else {
            steps.push("ai-offset:rejected");
          }
        }
        if (!current.passed && qa.shouldOfferTaskRepair?.({ aiRepairAttempts: 2 }, current)) {
          const candidatePath = await qa.makeEdgeBlendRepairJpg(currentPath, current);
          const candidate = await qa.checkSeamStructureQuality(candidatePath);
          if (better(candidate, current)) {
            currentPath = candidatePath;
            current = candidate;
            steps.push("pipeline");
          } else {
            steps.push("pipeline:rejected");
          }
        }
        final = current;
      }
      const check = compact(final);
      return {
        status: "ok",
        path: input.path,
        repair: input.repair,
        passed: check.passed,
        issue: check.issue,
        score: check.score,
        tiled: check.tiled,
        tiledCorner: check.tiledCorner,
        internal: check.internal,
        steps,
        check,
        before: input.repair === "none" ? undefined : compact(before),
      };
    } catch (error) {
      return {
        status: "error",
        path: input.path,
        repair: input.repair,
        passed: false,
        issue: "qa-error",
        error: error?.message || String(error),
      };
    }
  }.toString()})(${JSON.stringify({ path: imagePath, repair })})`;
}

function qaPageUrl(base) {
  const url = new URL(base);
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.search = "qa=1";
  url.hash = "";
  return url.toString();
}

function loginPageUrl(base) {
  const url = new URL(base);
  url.pathname = "/login.html";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolvePassword(options) {
  if (options.noLogin) return "";
  if (typeof options.password === "string") return options.password;
  if (!options.passwordEnv) return "";
  return process.env[options.passwordEnv] || readDotEnvValue(options.passwordEnv) || "";
}

function readDotEnvValue(name) {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== name) continue;
    return match[2].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

export async function evaluate(client, sessionId, expression, timeoutMs) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId, timeoutMs);

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed.");
  }
  return response.result?.value;
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => this.rejectAll(new Error("CDP socket closed.")));
    socket.addEventListener("error", () => this.rejectAll(new Error("CDP socket error.")));
  }

  static connect(url) {
    if (typeof WebSocket !== "function") {
      throw new Error("This Node.js runtime does not provide global WebSocket.");
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
    });
  }

  send(method, params = {}, sessionId = null, timeoutMs = 60000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    this.socket.close();
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result || {});
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : value ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
