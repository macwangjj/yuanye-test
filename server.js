import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Blob } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL(".", import.meta.url));
loadDotEnv();
const historyDir = join(root, "history");
const port = Number(process.env.PORT || 4173);
const host = process.env.YUANYE_HOST || "127.0.0.1";
const apiKey = (process.env.OPENAI_API_KEY || "").trim();
const imageModel = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2").trim();
const imageModelCandidates = unique([imageModel, "gpt-image-2", "gpt-image-1.5", "gpt-image-1"]);
const apiBaseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
const imageEditUrl = `${apiBaseUrl}/images/edits`;
const appVersion = "0.7.17-test";
const appPassword = (process.env.YUANYE_PASSWORD || "").trim();
const sessionSecret = (process.env.YUANYE_SESSION_SECRET || apiKey || appPassword || randomBytes(32).toString("hex")).trim();
const authEnabled = appPassword.length > 0;
const execFileAsync = promisify(execFile);
const imageRequestTimeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 300000);
const generateRouteTimeoutMs = Number(process.env.YUANYE_GENERATE_TIMEOUT_MS || 460000);

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "https://api.openai.com/v1";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function unique(values) {
  return values.filter((value, index, array) => value && array.indexOf(value) === index);
}

function isMaimaiGateway() {
  return /maimai\.it\.com/i.test(apiBaseUrl);
}

function hasValidLookingApiKey(value) {
  if (!value) return false;
  if (/dummy|这里粘贴|你的|api key/i.test(value)) return false;
  return value.length >= 20;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendRedirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function signSession(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSessionCookie(request) {
  const value = `yuanye:${Date.now()}`;
  const token = `${value}.${signSession(value)}`;
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `yuanye_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secure}`;
}

function hasValidSession(request) {
  if (!authEnabled) return true;
  const token = parseCookies(request).yuanye_session || "";
  const [value, signature] = token.split(".");
  if (!value || !signature) return false;
  const expected = signSession(value);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isPublicPath(pathname) {
  return pathname === "/login.html" || pathname === "/api/login" || pathname === "/styles.css";
}

function handleUnauthorized(request, response) {
  const wantsJson = request.url.startsWith("/api/") || String(request.headers.accept || "").includes("application/json");
  if (wantsJson) {
    sendJson(response, 401, { error: "请先登录 YUANYE。" });
    return;
  }
  sendRedirect(response, "/login.html");
}

async function ensureHistoryDir() {
  await mkdir(historyDir, { recursive: true });
}

function safeSlug(value) {
  return String(value || "pattern")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "pattern";
}

async function listHistory() {
  await ensureHistoryDir();
  const files = await readdir(historyDir);
  const records = [];

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(join(historyDir, file), "utf8"));
      records.push(record);
    } catch {
      // Ignore incomplete records.
    }
  }

  return records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizePatternCode(value) {
  return safeSlug(value).toLowerCase();
}

function incrementPatternCode(code) {
  const cleanCode = safeSlug(code);
  const match = cleanCode.match(/(\d+)(?!.*\d)/);
  if (!match) return `${cleanCode || "YUANYE"}-2`;

  const start = match.index;
  const digits = match[0];
  const nextNumber = Number(digits) + 1;
  return `${cleanCode.slice(0, start)}${String(nextNumber).padStart(digits.length, "0")}${cleanCode.slice(start + digits.length)}`;
}

async function uniquePatternCode(patternCode) {
  let code = safeSlug(patternCode || "");
  if (!code) return "";

  const used = new Set((await listHistory()).map((record) => normalizePatternCode(record.patternCode)).filter(Boolean));
  while (used.has(normalizePatternCode(code))) {
    code = incrementPatternCode(code);
  }
  return code;
}

async function saveHistory(payload) {
  await ensureHistoryDir();
  const image = parseDataUrl(payload.dataUrl);
  const extension = image.type.includes("jpeg") ? "jpg" : image.type.includes("webp") ? "webp" : "png";
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
  const patternCode = await uniquePatternCode(payload.patternCode || "");
  const baseName = `${id}-${patternCode || safeSlug(payload.sourceName)}`;
  const imageName = `${baseName}.${extension}`;
  const metaName = `${baseName}.json`;
  const record = {
    id,
    patternCode,
    sourceName: payload.sourceName || "未命名参考图",
    parentPatternCode: payload.parentPatternCode || "",
    createdAt: new Date().toISOString(),
    generationId: payload.generationId || id,
    generationLabel: payload.generationLabel || "",
    actionType: payload.actionType || "generate",
    score: payload.score ?? null,
    rating: payload.rating || "",
    seamCheck: payload.seamCheck || null,
    originalSeamCheck: payload.originalSeamCheck || null,
    repairCheck: payload.repairCheck || null,
    issueTypes: Array.isArray(payload.issueTypes) ? payload.issueTypes : [],
    generationAttempts: Number(payload.generationAttempts || 1),
    repairAttempts: Number(payload.repairAttempts || 0),
    aiRepairAttempts: Number(payload.aiRepairAttempts || 0),
    locallyRepaired: Boolean(payload.locallyRepaired),
    autoRegenerated: Boolean(payload.autoRegenerated),
    qualityPassed: payload.qualityPassed ?? null,
    enhanceStrength: payload.enhanceStrength || "",
    imageUrl: `/history/${imageName}`,
    downloadName: `${patternCode || safeSlug(payload.sourceName)}.${extension}`,
  };

  await writeFile(join(historyDir, imageName), image.buffer);
  await writeFile(join(historyDir, metaName), JSON.stringify(record, null, 2), "utf8");
  return record;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 40 * 1024 * 1024) {
        reject(new Error("上传文件过大，请单张控制在 40MB 以内。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("图片数据格式不正确。");
  return {
    type: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function generateImage(payload) {
  if (!hasValidLookingApiKey(apiKey)) {
    throw new Error("服务器没有配置有效的 OPENAI_API_KEY，请在 .env 中填写真实接口 Key 后重启服务。");
  }

  const source = parseDataUrl(payload.image.dataUrl);
  const mask = payload.mask?.dataUrl ? parseDataUrl(payload.mask.dataUrl) : null;
  const size = ["1024x1024", "1536x1024", "1024x1536", "auto"].includes(payload.size) ? payload.size : "1024x1536";
  const sourceType = normalizeImageType(source.type);
  const imageBlob = new Blob([source.buffer], { type: sourceType });
  const maskBlob = mask ? new Blob([mask.buffer], { type: normalizeImageType(mask.type) }) : null;

  const attempts = imageModelCandidates.flatMap((model) => {
    if (isMaimaiGateway()) {
      return [
        { model, fieldName: "image", size, highQuality: false },
        { model, transport: "curl", size, highQuality: false },
        { model, fieldName: "image", size: "auto", highQuality: false },
        { model, transport: "curl", size: "auto", highQuality: false },
        { model, fieldName: "image", size, highQuality: true },
        { model, transport: "curl", size, highQuality: true },
      ];
    }

    const maskedAttempts = maskBlob
      ? [
        { model, fieldName: "image", size, highQuality: true, masked: true },
        { model, transport: "curl", size, highQuality: true, masked: true },
        { model, fieldName: "image", size: "auto", highQuality: false, masked: true },
        { model, transport: "curl", size: "auto", highQuality: false, masked: true },
      ]
      : [];
    return [
      ...maskedAttempts,
      { model, fieldName: "image[]", size, highQuality: true },
      { model, fieldName: "image", size, highQuality: true },
      { model, transport: "curl", size, highQuality: true },
      { model, fieldName: "image[]", size: "auto", highQuality: false },
      { model, fieldName: "image", size: "auto", highQuality: false },
      { model, transport: "curl", size: "auto", highQuality: false },
      { model, transport: "json", size, highQuality: true },
      { model, transport: "json", size: "auto", highQuality: false },
    ];
  });

  let lastError;
  for (const attempt of attempts) {
    try {
      return await withTransientRetry(() => runImageAttempt({
        attempt,
        imageBlob,
        maskBlob: attempt.masked ? maskBlob : null,
        imageDataUrl: payload.image.dataUrl,
        prompt: payload.prompt,
      }));
    } catch (error) {
      lastError = error;
      if (!isRetriableImageError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("图片生成失败。");
}

async function runImageAttempt({ attempt, imageBlob, maskBlob, imageDataUrl, prompt }) {
  if (attempt.transport === "json") {
    return await callImageEditJson({
      imageDataUrl,
      prompt,
      size: attempt.size,
      highQuality: attempt.highQuality,
      model: attempt.model,
    });
  }

  if (attempt.transport === "curl") {
    return await callImageEditCurl({
      imageBlob,
      maskBlob,
      prompt,
      size: attempt.size,
      highQuality: attempt.highQuality,
      model: attempt.model,
    });
  }

  return await callImageEditMultipart({
    imageBlob,
    maskBlob,
    prompt,
    ...attempt,
  });
}

async function withTransientRetry(fn) {
  let lastError;
  for (let index = 0; index < 3; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientUpstreamError(error) || index === 2) break;
      await delay(1200 * (index + 1));
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withOperationTimeout(promise, timeoutMs, message) {
  let timeout;
  const guard = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, guard]).finally(() => clearTimeout(timeout));
}

function normalizeImageType(type) {
  if (["image/png", "image/jpeg", "image/webp"].includes(type)) {
    return type;
  }
  return "image/png";
}

function extensionForType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
}

function isRetriableImageError(error) {
  if (/insufficient.*quota|insufficient_user_quota|quota|余额|额度|没有可用token|no available token/i.test(error.message)) {
    return false;
  }
  return /pattern|参数|parameter|unsupported|unknown|invalid|field|字段|model_not_found|No available channel|multipart|convert_request_failed|parse|fetch failed|bad_response_status_code|openai_error|curl|Command failed|timed out|ECONNRESET|socket|network/i.test(error.message);
}

function isTransientUpstreamError(error) {
  if (/insufficient.*quota|insufficient_user_quota|quota|余额|额度|没有可用token|no available token/i.test(error.message)) {
    return false;
  }
  return /bad_response_status_code|openai_error|502|503|504|timeout|timed out|temporarily|upstream|ECONNRESET|socket|network/i.test(error.message);
}

async function callImageEditJson({ imageDataUrl, prompt, size, highQuality, model }) {
  const body = {
    model,
    prompt,
    images: [{ image_url: imageDataUrl }],
    size,
    n: 1,
  };

  if (highQuality) {
    body.quality = "high";
    body.output_format = "jpeg";
    body.output_compression = 95;
  }

  const response = await fetchWithTimeout(imageEditUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, imageRequestTimeoutMs, `json:${model}`);

  return await readImageResponse(response, `json:${model}`);
}

async function callImageEditMultipart({ imageBlob, maskBlob, prompt, size, highQuality, fieldName, model }) {
  const form = new FormData();
  const extension = extensionForType(imageBlob.type);
  form.append("model", model);
  form.append("prompt", prompt);
  form.append(fieldName, imageBlob, `reference.${extension}`);
  if (maskBlob) {
    form.append("mask", maskBlob, "seam-mask.png");
  }
  form.append("size", size);
  form.append("n", "1");

  if (highQuality) {
    form.append("quality", "high");
    form.append("output_format", "jpeg");
    form.append("output_compression", "95");
  }

  const response = await fetchWithTimeout(imageEditUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  }, imageRequestTimeoutMs, `multipart:${fieldName}:${model}`);

  return await readImageResponse(response, `multipart:${fieldName}:${model}`);
}

async function fetchWithTimeout(url, options, timeoutMs, attempt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`图片接口等待超过 ${Math.round(timeoutMs / 1000)} 秒，已自动停止本次尝试。（attempt=${attempt}）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageEditCurl({ imageBlob, maskBlob, prompt, size, highQuality, model }) {
  const extension = extensionForType(imageBlob.type);
  const dir = await mkdtemp(join(tmpdir(), "seamless-studio-"));
  const imagePath = join(dir, `reference.${extension}`);
  const maskPath = join(dir, "seam-mask.png");

  try {
    const bytes = Buffer.from(await imageBlob.arrayBuffer());
    await writeFile(imagePath, bytes);
    if (maskBlob) {
      await writeFile(maskPath, Buffer.from(await maskBlob.arrayBuffer()));
    }

    const args = [
      "-sS",
      "-m",
      "300",
      "--connect-timeout",
      "20",
      "--retry",
      "2",
      "--retry-delay",
      "2",
      imageEditUrl,
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-F",
      `model=${model}`,
      "-F",
      `prompt=${prompt}`,
      "-F",
      `size=${size}`,
      "-F",
      "n=1",
      "-F",
      `image=@${imagePath};type=${imageBlob.type}`,
    ];
    if (maskBlob) {
      args.push("-F", `mask=@${maskPath};type=${maskBlob.type || "image/png"}`);
    }

    if (highQuality) {
      args.push("-F", "quality=high", "-F", "output_format=jpeg", "-F", "output_compression=95");
    }

    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 320000,
    });
    const result = parseImageApiJson(stdout, `curl:${model}`);
    return await readImageResult(result, `curl:${model}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readImageResponse(response, attempt) {
  const requestId = response.headers.get("x-request-id") || "";
  const text = await response.text();
  const result = parseImageApiJson(text, attempt, { allowEmpty: !response.ok });
  if (!response.ok) {
    const message = result?.error?.message || "OpenAI 图片生成接口返回错误。";
    const details = [
      result?.error?.type && `type=${result.error.type}`,
      result?.error?.param && `param=${result.error.param}`,
      result?.error?.code && `code=${result.error.code}`,
      requestId && `request id=${requestId}`,
    ]
      .filter(Boolean)
      .join("，");
    console.error(`OpenAI image error (${attempt}):`, JSON.stringify(result?.error || result));
    throw new Error(details ? `${message}（attempt=${attempt}，${details}）` : `${message}（attempt=${attempt}）`);
  }

  return await readImageResult(result, attempt);
}

function parseImageApiJson(text, attempt, options = {}) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) {
    if (options.allowEmpty) return {};
    throw new Error(`图片接口返回空内容。（attempt=${attempt}）`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const candidates = extractJsonObjects(raw);
    const parsed = candidates
      .map((candidate) => {
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const withImage = parsed.find((item) => item?.data?.[0]?.b64_json || item?.data?.[0]?.url);
    if (withImage) return withImage;
    if (parsed.length) return parsed.at(-1);

    const excerpt = raw.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`图片接口返回内容不是有效 JSON：${error.message}。返回片段：${excerpt}（attempt=${attempt}）`);
  }
}

function extractJsonObjects(text) {
  const results = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return results;
}

async function readImageResult(result, attempt) {
  if (result?.error) {
    const message = result.error.message || "OpenAI 图片生成接口返回错误。";
    const details = [
      result.error.type && `type=${result.error.type}`,
      result.error.param && `param=${result.error.param}`,
      result.error.code && `code=${result.error.code}`,
    ]
      .filter(Boolean)
      .join("，");
    console.error(`OpenAI image error (${attempt}):`, JSON.stringify(result.error));
    throw new Error(details ? `${message}（attempt=${attempt}，${details}）` : `${message}（attempt=${attempt}）`);
  }

  const item = result?.data?.[0];
  if (item?.b64_json) {
    const format = item.output_format || result.output_format || "jpeg";
    return {
      dataUrl: `data:image/${format};base64,${item.b64_json}`,
    };
  }

  if (item?.url) {
    return {
      dataUrl: await downloadImageAsDataUrl(item.url),
    };
  }

  throw new Error(`接口没有返回图片数据。（attempt=${attempt}）`);
}

async function downloadImageAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`生成成功但下载图片失败：HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(root, `.${decodeURIComponent(pathname)}`);

  if (!isInside(root, filePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

async function serveHistoryFile(request, response) {
  const url = new URL(request.url, "http://localhost");
  const fileName = decodeURIComponent(url.pathname.replace("/history/", ""));
  const filePath = resolve(historyDir, `.${fileName.startsWith("/") ? fileName : `/${fileName}`}`);

  if (!isInside(historyDir, filePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function isInside(parentDir, childPath) {
  const relativePath = relative(resolve(parentDir), resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (authEnabled && !isPublicPath(url.pathname) && !hasValidSession(request)) {
      handleUnauthorized(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/login") {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      if (String(payload.password || "") !== appPassword) {
        sendJson(response, 401, { error: "密码不正确。" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": createSessionCookie(request),
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/logout") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "yuanye_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        hasKey: hasValidLookingApiKey(apiKey),
        version: appVersion,
        model: imageModel,
        modelCandidates: imageModelCandidates,
        baseUrl: apiBaseUrl,
        auth: authEnabled,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/generate") {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      const image = await withOperationTimeout(
        generateImage(payload),
        generateRouteTimeoutMs,
        `生成等待超过 ${Math.round(generateRouteTimeoutMs / 1000)} 秒，请稍后重试；如果连续出现，请减少自动重生次数或检查图片接口状态。`,
      );
      sendJson(response, 200, { image });
      return;
    }

    if (request.method === "GET" && request.url === "/api/history") {
      sendJson(response, 200, { records: await listHistory() });
      return;
    }

    if (request.method === "POST" && request.url === "/api/history") {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      sendJson(response, 200, { record: await saveHistory(payload) });
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && request.url.startsWith("/history/")) {
      await serveHistoryFile(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "服务器错误" });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用，请设置 PORT=其他端口 后重试。`);
    process.exit(1);
  }
  if (error.code === "EPERM") {
    console.error("当前环境不允许启动本地服务，请在正常电脑终端中运行。");
    process.exit(1);
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Seamless Studio running at http://${host}:${port}`);
});
