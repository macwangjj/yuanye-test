#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  CdpClient,
  createPageSession,
  evaluate,
  launchChrome,
  normalizeImagePath,
  openQaPage,
  resolvePassword,
  summarizeResults,
} from "./qa-batch.mjs";

const defaultBase = "http://127.0.0.1:4190";

function parseArgs(argv) {
  const options = {
    base: defaultBase,
    count: 2,
    attempt: 1,
    timeoutMs: 900000,
    repair: true,
    aiRepair: true,
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
    } else if (arg === "--no-ai-repair") {
      options.aiRepair = false;
    } else if (arg === "--no-repair") {
      options.repair = false;
    } else if (arg === "--no-login") {
      options.noLogin = true;
    } else if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
    } else if (arg === "--base") {
      options.base = argv[++index] || "";
    } else if (arg.startsWith("--count=")) {
      options.count = parsePositiveInteger(arg.slice("--count=".length), "count");
    } else if (arg === "--count") {
      options.count = parsePositiveInteger(argv[++index], "count");
    } else if (arg.startsWith("--attempt=")) {
      options.attempt = parsePositiveInteger(arg.slice("--attempt=".length), "attempt");
    } else if (arg === "--attempt") {
      options.attempt = parsePositiveInteger(argv[++index], "attempt");
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout=".length), "timeout");
    } else if (arg === "--timeout") {
      options.timeoutMs = parsePositiveInteger(argv[++index], "timeout");
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
      options.images.push(normalizeImagePath(arg));
    }
  }

  if (!options.base) throw new Error("Missing --base value.");
  if (!options.images.length) throw new Error("Pass at least one site image URL or history image path.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      "Usage: node tools/qa-generate.mjs [options] <image ...>",
      "",
      "Options:",
      `  --base <url>          QA site base URL. Default: ${defaultBase}`,
      "  --count <n>           Candidates to generate per source. Default: 2",
      "  --attempt <n>         Prompt attempt number to use. Default: 1",
      "  --timeout <ms>        Per-candidate browser timeout. Default: 900000",
      "  --no-ai-repair        Disable AI seam-repair follow-up after generation.",
      "  --no-repair           Score only raw generated JPG candidates.",
      "  --password-env <name>  Env/.env variable used for site login. Default: YUANYE_PASSWORD",
      "  --password <value>     Site login password. Prefer --password-env to keep secrets out of ps output.",
      "  --no-login            Do not attempt password login before QA.",
    ].join("\n"));
    return;
  }

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
    for (const source of options.images) {
      for (let candidateIndex = 1; candidateIndex <= options.count; candidateIndex += 1) {
        process.stderr.write(`[${results.length + 1}/${options.images.length * options.count}] ${source} candidate ${candidateIndex}/${options.count}\n`);
        const result = await runGenerationCandidate(client, sessionId, {
          source,
          attempt: options.attempt,
          candidateIndex,
          candidateCount: options.count,
          aiRepair: options.aiRepair,
          repair: options.repair,
        }, options.timeoutMs);
        results.push(result);
      }
    }

    console.log(JSON.stringify(summarizeResults(results, {
      base: options.base,
      repair: options.repair ? "generate+repair" : "generate",
    }), null, 2));
  } finally {
    if (client) client.close();
    await chrome.close();
  }
}

async function runGenerationCandidate(client, sessionId, input, timeoutMs) {
  const expression = `(${async function generateCandidate(payload) {
    try {
      return await window.YUANYE_QA.makeQaGenerationCandidateFromUrl(payload.source, {
        attempt: payload.attempt,
        candidateIndex: payload.candidateIndex,
        candidateCount: payload.candidateCount,
        aiRepair: payload.aiRepair,
        repair: payload.repair,
      });
    } catch (error) {
      return {
        status: "error",
        source: payload.source,
        passed: false,
        issue: "qa-generate-error",
        error: error?.message || String(error),
      };
    }
  }.toString()})(${JSON.stringify(input)})`;
  return await evaluate(client, sessionId, expression, timeoutMs);
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
