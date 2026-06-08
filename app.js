const els = {
  fileInput: document.querySelector("#fileInput"),
  styleNotes: document.querySelector("#styleNotes"),
  density: document.querySelector("#density"),
  size: document.querySelector("#size"),
  codeRule: document.querySelector("#codeRule"),
  codePreview: document.querySelector("#codePreview"),
  autoEnhance: document.querySelector("#autoEnhance"),
  enhanceStrength: document.querySelector("#enhanceStrength"),
  fissionStrength: document.querySelector("#fissionStrength"),
  startAll: document.querySelector("#startAll"),
  resumeGeneration: document.querySelector("#resumeGeneration"),
  downloadSelected: document.querySelector("#downloadSelected"),
  pauseAll: document.querySelector("#pauseAll"),
  clearAllTasks: document.querySelector("#clearAllTasks"),
  clearDone: document.querySelector("#clearDone"),
  selectAllHistory: document.querySelector("#selectAllHistory"),
  refreshHistory: document.querySelector("#refreshHistory"),
  historyGrid: document.querySelector("#historyGrid"),
  taskList: document.querySelector("#taskList"),
  emptyState: document.querySelector("#emptyState"),
  taskTemplate: document.querySelector("#taskTemplate"),
  serverStatus: document.querySelector("#serverStatus"),
  toast: document.querySelector("#toast"),
};

const tasks = [];
const settingsStorageKey = "yuanyeSettings";
const downloadedStorageKey = "yuanyeDownloaded";
const queueDbName = "yuanyeQueue";
const queueStoreName = "tasks";
const selectedDownloads = new Map();
const clientVersion = "0.7.65-test";
const generateJobCreateTimeoutMs = 30000;
const generateJobPollTimeoutMs = 30000;
const generateJobMaxWaitMs = 20 * 60 * 1000;
const generateJobPollIntervalMs = 2500;
const maxAutoRegenerations = 3;
const maxAiSeamRepairs = 2;
let activeHistoryGroupKey = "";
let historyGroupsCache = [];
let queueDbPromise = null;
let generationPaused = false;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.setTimeout(() => els.toast.classList.remove("is-visible"), 1600);
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchJsonWithRetry(url, options = {}, { retries = 1, timeoutMs = 30000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      const text = await response.text();
      const payload = parseLocalJsonResponse(text, response.status);

      if (!response.ok) {
        const error = new Error(payload.error || `请求失败：HTTP ${response.status}`);
        error.status = response.status;
        if (response.status === 401) {
          window.location.href = "/login.html";
        }
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (!shouldRetryRequest(error) || attempt === retries) break;
      await delay(1200 * (attempt + 1));
    }
  }

  throw new Error(friendlyRequestError(lastError));
}

function parseLocalJsonResponse(text, status) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    const excerpt = text.slice(0, 180).replace(/\s+/g, " ");
    const wrapped = new Error(`本地服务返回异常：${error.message}。HTTP ${status}，返回片段：${excerpt}`);
    wrapped.status = status;
    throw wrapped;
  }
}

function shouldRetryRequest(error) {
  const message = error?.message || "";
  if (error?.name === "AbortError") return false;
  if (!error?.status) return /Load failed|Failed to fetch|NetworkError|fetch/i.test(message);
  return /openai_error|bad_response_status_code|timeout|temporarily|upstream|502|503|504/i.test(message);
}

function friendlyRequestError(error) {
  const message = error?.message || "请求失败";

  if (error?.name === "AbortError") {
    return "生成接口等待时间过长，请稍后重试；如果连续出现，请减少一次上传数量。";
  }

  if (/Load failed|Failed to fetch|NetworkError|fetch|ERR_CONNECTION_REFUSED/i.test(message)) {
    return "本地服务连接中断。请确认启动窗口仍显示 YUANYE 正在运行，然后刷新页面重试。";
  }

  if (/insufficient.*quota|insufficient_user_quota|quota|余额|额度|没有可用token|no available token/i.test(message)) {
    return "图片接口余额或 token 不足，请先补充接口额度后再生成。";
  }

  return message;
}

async function requestImageGeneration(payload, options = {}) {
  const createPayload = await fetchJsonWithRetry("/api/generate-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, {
    retries: 1,
    timeoutMs: generateJobCreateTimeoutMs,
  });

  const jobId = createPayload.job?.id;
  if (!jobId) {
    throw new Error("生成任务创建失败：服务器没有返回任务编号。");
  }

  const startedAt = Date.now();
  let pollCount = 0;
  while (Date.now() - startedAt < generateJobMaxWaitMs) {
    pollCount += 1;
    await delay(Math.min(generateJobPollIntervalMs + pollCount * 160, 5000));
    const pollPayload = await fetchJsonWithRetry(`/api/generate-jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
    }, {
      retries: 2,
      timeoutMs: generateJobPollTimeoutMs,
    });
    const job = pollPayload.job;
    if (options.onPoll) options.onPoll(job, pollCount);

    if (job?.status === "succeeded") {
      if (!job.result?.image?.dataUrl) {
        throw new Error("生成任务已完成，但没有返回图片。");
      }
      return job.result;
    }
    if (job?.status === "failed") {
      throw new Error(job.error || "生成任务失败。");
    }
  }

  throw new Error("生成任务等待超过 20 分钟。后台可能仍在处理，请稍后刷新历史记录或重新生成。");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageUrlToDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return await fileToDataUrl(blob);
}

function dataUrlByteSize(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.round((base64.length * 3) / 4);
}

function openQueueDb() {
  if (!window.indexedDB) return Promise.reject(new Error("浏览器不支持本地任务恢复。"));
  if (queueDbPromise) return queueDbPromise;

  queueDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(queueDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(queueStoreName)) {
        db.createObjectStore(queueStoreName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地任务恢复库。"));
  });

  return queueDbPromise;
}

async function withQueueStore(mode, action) {
  const db = await openQueueDb();
  return await new Promise((resolve, reject) => {
    const transaction = db.transaction(queueStoreName, mode);
    const store = transaction.objectStore(queueStoreName);
    let result;

    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("本地任务恢复库写入失败。"));
  });
}

async function saveQueuedTask(task, status = task.status) {
  try {
    await withQueueStore("readwrite", (store) => {
      store.put({
        id: task.id,
        fileName: task.file.name,
        fileType: task.file.type,
        fileSize: task.file.size,
        fileLastModified: task.file.lastModified || 0,
        dataUrl: task.dataUrl,
        patternCode: task.patternCode,
        generationMode: task.generationMode || "generate",
        parentPatternCode: task.parentPatternCode || "",
        status,
        createdAt: task.createdAt || new Date().toISOString(),
      });
    });
  } catch (error) {
    console.warn("Queue save failed", error);
  }
}

async function deleteQueuedTask(taskId) {
  try {
    await withQueueStore("readwrite", (store) => {
      store.delete(taskId);
    });
  } catch (error) {
    console.warn("Queue delete failed", error);
  }
}

async function clearQueuedTasks() {
  try {
    await withQueueStore("readwrite", (store) => {
      store.clear();
    });
  } catch (error) {
    console.warn("Queue clear failed", error);
  }
}

async function listQueuedTasks() {
  try {
    return await withQueueStore("readonly", (store) => {
      const request = store.getAll();
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("无法读取本地未完成任务。"));
      });
    });
  } catch (error) {
    console.warn("Queue read failed", error);
    return [];
  }
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || "{}");
    if (settings.codeRule) els.codeRule.value = settings.codeRule;
    if (settings.codePreviewCustom && settings.codePreview) {
      els.codePreview.value = settings.codePreview;
      els.codePreview.dataset.custom = "true";
    }
    if (settings.autoEnhance) els.autoEnhance.checked = Boolean(settings.autoEnhance);
    if (settings.enhanceStrength) els.enhanceStrength.value = settings.enhanceStrength;
    if (settings.fissionStrength) els.fissionStrength.value = settings.fissionStrength;
  } catch {
    // Keep defaults.
  }
  updateCodePreview();
}

function saveSettings() {
  localStorage.setItem(settingsStorageKey, JSON.stringify({
    codeRule: els.codeRule.value,
    codePreview: els.codePreview.value,
    codePreviewCustom: els.codePreview.dataset.custom === "true",
    autoEnhance: els.autoEnhance.checked,
    enhanceStrength: els.enhanceStrength.value,
    fissionStrength: els.fissionStrength?.value || "medium",
  }));
}

function todayParts() {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { yyyy, mm, dd, date: `${yyyy}${mm}${dd}` };
}

function formatPatternCode(rule, sequence) {
  const parts = todayParts();
  let code = (rule || "YY+日期+001")
    .replace(/\{日期\}/g, parts.date)
    .replace(/\{年月\}/g, `${parts.yyyy}${parts.mm}`)
    .replace(/\{月日\}/g, `${parts.mm}${parts.dd}`)
    .replace(/\{年\}/g, parts.yyyy)
    .replace(/\{月\}/g, parts.mm)
    .replace(/\{日\}/g, parts.dd)
    .replace(/日期/g, parts.date)
    .replace(/年月/g, `${parts.yyyy}${parts.mm}`)
    .replace(/月日/g, `${parts.mm}${parts.dd}`);

  const tokenMatch = code.match(/\{(?:seq|序号)(\d+)\}|序号(\d+)/i);
  if (tokenMatch) {
    const length = Number(tokenMatch[1] || tokenMatch[2]) || 3;
    code = code.replace(tokenMatch[0], String(sequence).padStart(length, "0"));
  } else {
    const zeroMatch = code.match(/0{2,}/);
    if (zeroMatch) {
      code = code.replace(zeroMatch[0], String(sequence).padStart(zeroMatch[0].length, "0"));
    } else {
      code = `${code}${String(sequence).padStart(3, "0")}`;
    }
  }

  return code.replace(/\+/g, "").replace(/\s+/g, "").replace(/[/:*?"<>|]/g, "-");
}

async function fetchHistoryRecords() {
  try {
    const response = await fetch("/api/history");
    const payload = await response.json();
    return payload.records || [];
  } catch {
    return [];
  }
}

async function collectUsedPatternCodes(historyRecords = null) {
  const used = new Set(tasks.map((task) => normalizePatternCode(task.patternCode)).filter(Boolean));

  try {
    const queued = await listQueuedTasks();
    queued.forEach((record) => {
      const code = normalizePatternCode(record.patternCode);
      if (code) used.add(code);
    });
  } catch {
    // If the queue cannot be read, keep checking current tasks and history.
  }

  const cachedRecords = historyGroupsCache.flatMap((group) => group.records || []);
  cachedRecords.forEach((record) => {
    const code = normalizePatternCode(record.patternCode);
    if (code) used.add(code);
  });

  (historyRecords || await fetchHistoryRecords()).forEach((record) => {
    const code = normalizePatternCode(record.patternCode);
    if (code) used.add(code);
  });

  return used;
}

function referenceCodeFromName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-\s.]*pic[_\-\s.]*hd$/i, "")
    .replace(/\s+/g, "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeReferenceCode(name) {
  return referenceCodeFromName(name).toLowerCase();
}

function buildReferenceHistoryMap(records) {
  const map = new Map();
  records.forEach((record) => {
    const key = normalizeReferenceCode(record.sourceName);
    if (!key || !record.patternCode) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  });
  return map;
}

function describeReferenceHistory(fileName, records) {
  const referenceCode = referenceCodeFromName(fileName);
  const patternCodes = [...new Set(records.map((record) => record.patternCode).filter(Boolean))];
  const previewCodes = patternCodes.slice(0, 5).join("、");
  const moreText = patternCodes.length > 5 ? ` 等 ${patternCodes.length} 个编号` : "";
  return `提醒：参考图编号 ${referenceCode} 以前生成过。历史生成图片编号：${previewCodes}${moreText}`;
}

function normalizePatternCode(value) {
  return sanitizePatternCode(value).toLowerCase();
}

function incrementPatternCode(code) {
  const match = sanitizePatternCode(code).match(/(\d+)(?!.*\d)/);
  if (!match) return `${code || "YUANYE"}-2`;

  const start = match.index;
  const digits = match[0];
  const nextNumber = Number(digits) + 1;
  return `${code.slice(0, start)}${String(nextNumber).padStart(digits.length, "0")}${code.slice(start + digits.length)}`;
}

function nextPatternCode(usedCodes = new Set()) {
  if (els.codePreview.dataset.custom === "true" && els.codePreview.value.trim()) {
    const customBase = sanitizePatternCode(els.codePreview.value.trim());
    const key = `yuanyeCustomSequence:${todayParts().date}:${customBase}`;
    const sequence = Number(localStorage.getItem(key) || "0");
    let offset = sequence;
    let code = formatCustomPatternCode(customBase, offset);
    while (usedCodes.has(normalizePatternCode(code))) {
      offset += 1;
      code = formatCustomPatternCode(customBase, offset);
    }
    localStorage.setItem(key, String(offset + 1));
    usedCodes.add(normalizePatternCode(code));
    return code;
  }

  const rule = els.codeRule.value.trim() || "YY+日期+001";
  const key = `yuanyeSequence:${todayParts().date}:${rule}`;
  let sequence = Number(localStorage.getItem(key) || "0") + 1;
  let code = formatPatternCode(rule, sequence);
  while (usedCodes.has(normalizePatternCode(code))) {
    sequence += 1;
    code = formatPatternCode(rule, sequence);
  }
  localStorage.setItem(key, String(sequence));
  usedCodes.add(normalizePatternCode(code));
  return code;
}

function updateCodePreview() {
  if (els.codePreview.dataset.custom === "true") return;
  els.codePreview.value = formatPatternCode(els.codeRule.value.trim() || "YY+日期+001", 1);
}

function sanitizePatternCode(value) {
  return String(value || "").replace(/\+/g, "").replace(/\s+/g, "").replace(/[/:*?"<>|]/g, "-");
}

function formatCustomPatternCode(base, offset) {
  const cleanBase = sanitizePatternCode(base);
  const match = cleanBase.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return `${cleanBase || "YUANYE"}${String(offset + 1).padStart(3, "0")}`;
  }

  const start = match.index;
  const digits = match[0];
  const nextNumber = Number(digits) + offset;
  return `${cleanBase.slice(0, start)}${String(nextNumber).padStart(digits.length, "0")}${cleanBase.slice(start + digits.length)}`;
}

function getEnhanceStrength() {
  const map = { light: 0.18, medium: 0.32, strong: 0.48 };
  return map[els.enhanceStrength.value] || map.medium;
}

function getDownloadedMap() {
  try {
    return JSON.parse(localStorage.getItem(downloadedStorageKey) || "{}");
  } catch {
    return {};
  }
}

function markDownloaded(name) {
  if (!name) return;
  const map = getDownloadedMap();
  map[name] = new Date().toISOString();
  localStorage.setItem(downloadedStorageKey, JSON.stringify(map));
}

function isDownloaded(name) {
  return Boolean(name && getDownloadedMap()[name]);
}

function markTaskDownloaded(task) {
  const name = downloadNameForTask(task);
  markDownloaded(name);
  task.downloaded = true;
  task.nodes.download.textContent = "已下载过";
  task.nodes.download.classList.add("is-downloaded");
}

function hasValidExportGeometry(exportMode, tileColumns, tileRows) {
  const validExportMode = exportMode === "direct-stretch" || exportMode === "periodic-grid";
  const validTileGrid = Number.isInteger(tileColumns) && tileColumns >= 1 &&
    Number.isInteger(tileRows) && tileRows >= 1;
  const exportGridMatchesMode = exportMode === "periodic-grid"
    ? tileColumns * tileRows > 1
    : tileColumns === 1 && tileRows === 1;
  return validExportMode && validTileGrid && exportGridMatchesMode;
}

function taskHasCertifiedDownload(task) {
  const aspectWarp = task?.seamCheck?.aspectWarp || {};
  return Boolean(
    task?.resultJpgUrl &&
    task?.qualityPassed === true &&
    task?.seamCheck?.passed === true &&
    task?.seamCheck?.printSpec?.passed === true &&
    task?.seamCheck?.aspectWarp?.passed === true &&
    hasValidExportGeometry(aspectWarp.mode, aspectWarp.columns, aspectWarp.rows)
  );
}

function recordHasCertifiedDownload(record) {
  const certification = record?.certification || {};
  const actual = certification.actual || {};
  const gate = certification.gate || {};
  return Boolean(
    record?.imageUrl &&
    record?.qualityPassed === true &&
    certification.certified === true &&
    actual.printSpecPassed === true &&
    actual.aspectWarpPassed === true &&
    hasValidExportGeometry(actual.exportMode, actual.tileColumns, actual.tileRows) &&
    gate.fourWayRepeat === true &&
    gate.qualityPassed === true &&
    typeof gate.seamDetailLossScore === "number" &&
    typeof gate.upscaleArtifactScore === "number" &&
    typeof gate.posterizationScore === "number" &&
    typeof gate.compressionArtifactScore === "number" &&
    typeof gate.sharpenHaloScore === "number" &&
    typeof gate.fullSizeEdgeScore === "number" &&
    typeof gate.richnessScore === "number" &&
    typeof gate.layoutBalanceScore === "number" &&
    typeof gate.mirrorAxisScore === "number" &&
    typeof gate.preTiledPreviewScore === "number" &&
    typeof gate.textureDensityScore === "number" &&
    typeof gate.outerFrameScore === "number" &&
    typeof gate.aspectWarpRatio === "number"
  );
}

function historyExportModeText(record) {
  const actual = record?.certification?.actual || {};
  if (
    actual.exportMode === "periodic-grid" &&
    Number.isInteger(actual.tileColumns) &&
    Number.isInteger(actual.tileRows)
  ) {
    return `周期转竖版 ${actual.tileColumns}×${actual.tileRows}`;
  }
  if (actual.exportMode === "direct-stretch") return "竖版直出";
  return "";
}

function updateTaskDownloadGate(task) {
  const certified = taskHasCertifiedDownload(task);
  task.nodes.download.disabled = !certified;
  task.nodes.download.classList.toggle("is-certified", certified);
  if (!certified) {
    task.nodes.download.classList.remove("is-downloaded");
    task.nodes.download.textContent = task.resultJpgUrl ? "未通过不可下载" : "下载 JPG";
    return;
  }
  task.nodes.download.textContent = task.downloaded ? "已下载过" : "下载 JPG";
  task.nodes.download.classList.toggle("is-downloaded", Boolean(task.downloaded));
}

function downloadNameForTask(task) {
  return `${task.patternCode || "YUANYE"}.jpg`;
}

function buildPrintCertification(task, actionType = "generate") {
  const check = task.seamCheck || {};
  const clarity = check.clarity || {};
  return {
    certified: taskHasCertifiedDownload(task),
    actionType,
    version: clientVersion,
    target: {
      widthPx: 4961,
      heightPx: 7559,
      dpi: 300,
      dpiMetadata: "JFIF inch density",
      format: "jpg",
      use: "digital textile print",
    },
    actual: {
      widthPx: check.printSpec?.widthPx ?? null,
      heightPx: check.printSpec?.heightPx ?? null,
      dpiX: check.printSpec?.dpiX ?? null,
      dpiY: check.printSpec?.dpiY ?? null,
      dpiUnit: check.printSpec?.dpiUnit ?? "",
      printSpecPassed: check.printSpec?.passed === true,
      sourceWidthPx: check.aspectWarp?.sourceWidth ?? null,
      sourceHeightPx: check.aspectWarp?.sourceHeight ?? null,
      sourceAspect: typeof check.aspectWarp?.sourceAspect === "number" ? check.aspectWarp.sourceAspect : null,
      exportMode: check.aspectWarp?.mode || "",
      tileColumns: check.aspectWarp?.columns || 1,
      tileRows: check.aspectWarp?.rows || 1,
      aspectWarpPassed: check.aspectWarp?.passed === true,
    },
    gate: {
      fourWayRepeat: check.passed === true,
      qualityPassed: task.qualityPassed === true,
      score: typeof check.score === "number" ? check.score : null,
      rating: check.rating || "",
      horizontalScore: typeof check.horizontalScore === "number" ? check.horizontalScore : null,
      verticalScore: typeof check.verticalScore === "number" ? check.verticalScore : null,
      tiledScore: Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0),
      cornerJunctionScore: check.tiledCorner?.score || 0,
      edgeBandScore: Math.max(check.bandHorizontal?.score || 0, check.bandVertical?.score || 0),
      seamDetailLossScore: Math.max(check.detailHorizontal?.score || 0, check.detailVertical?.score || 0),
      driftScore: Math.max(check.driftHorizontal?.score || 0, check.driftVertical?.score || 0),
      clarityScore: typeof clarity.detailScore === "number" ? clarity.detailScore : null,
      upscaleArtifactScore: typeof check.upscaleArtifact?.artifactScore === "number" ? check.upscaleArtifact.artifactScore : null,
      upscaleFlatPairRatio: typeof check.upscaleArtifact?.flatPairRatio === "number" ? check.upscaleArtifact.flatPairRatio : null,
      posterizationScore: typeof check.posterization?.posterizationScore === "number" ? check.posterization.posterizationScore : null,
      posterizationToneBinRatio: typeof check.posterization?.toneBinRatio === "number" ? check.posterization.toneBinRatio : null,
      compressionArtifactScore: typeof check.compressionArtifact?.blockScore === "number" ? check.compressionArtifact.blockScore : null,
      compressionArtifactPeriod: typeof check.compressionArtifact?.period === "number" ? check.compressionArtifact.period : null,
      sharpenHaloScore: typeof check.sharpenHalo?.haloScore === "number" ? check.sharpenHalo.haloScore : null,
      sharpenHaloRatio: typeof check.sharpenHalo?.haloRatio === "number" ? check.sharpenHalo.haloRatio : null,
      fullSizeEdgeScore: typeof check.fullSizeEdge?.score === "number" ? check.fullSizeEdge.score : null,
      fullSizeEdgePeakRatio: typeof check.fullSizeEdge?.peakRatio === "number" ? check.fullSizeEdge.peakRatio : null,
      richnessScore: typeof check.richness?.richnessScore === "number" ? check.richness.richnessScore : null,
      activeTextureRatio: typeof check.richness?.activeRatio === "number" ? check.richness.activeRatio : null,
      layoutBalanceScore: typeof check.layoutBalance?.balanceScore === "number" ? check.layoutBalance.balanceScore : null,
      edgeMotifActivity: typeof check.layoutBalance?.edgeActivity === "number" ? check.layoutBalance.edgeActivity : null,
      mirrorAxisScore: Math.max(check.mirrorHorizontal?.score || 0, check.mirrorVertical?.score || 0),
      mirrorAxisWorstScore: Math.max(check.mirrorHorizontal?.worstScore || 0, check.mirrorVertical?.worstScore || 0),
      preTiledPreviewScore: typeof check.preTiledPreview?.score === "number" ? check.preTiledPreview.score : null,
      preTiledDuplicatePairs: typeof check.preTiledPreview?.duplicatePairs === "number" ? check.preTiledPreview.duplicatePairs : null,
      textureDensityScore: typeof check.textureDensity?.textureDensityScore === "number" ? check.textureDensity.textureDensityScore : null,
      fineDetailRatio: typeof check.textureDensity?.fineDetailRatio === "number" ? check.textureDensity.fineDetailRatio : null,
      outerFrameScore: typeof check.outerFrame?.score === "number" ? check.outerFrame.score : null,
      outerFrameRiskSides: typeof check.outerFrame?.riskSides === "number" ? check.outerFrame.riskSides : null,
      aspectWarpRatio: typeof check.aspectWarp?.warpRatio === "number" ? check.aspectWarp.warpRatio : null,
      aspectStretchPercent: typeof check.aspectWarp?.stretchPercent === "number" ? check.aspectWarp.stretchPercent : null,
      issues: Array.isArray(check.issues) ? check.issues : [],
    },
  };
}

function createHistoryMarker(actionType, total = 1) {
  const now = new Date();
  const actionName = {
    batch: "批量生成任务",
    resume: "恢复生成任务",
    enhance: "高清任务",
    repair: "轻修任务",
    fission: "以图裂变任务",
    review: "人工复核任务",
    generate: "单张生成任务",
  }[actionType] || "生成任务";
  const countText = total > 1 ? ` · ${total} 张` : "";
  return {
    id: crypto.randomUUID(),
    label: `${actionName}${countText} · ${formatFullTime(now)}`,
  };
}

function buildRetryGuidance(previousCheck = null) {
  const issues = [
    previousCheck?.finalIssueType,
    ...(Array.isArray(previousCheck?.issues) ? previousCheck.issues : []),
  ]
    .map((issue) => String(issue || "").trim())
    .filter(Boolean);
  const uniqueIssues = [...new Set(issues)];
  if (!uniqueIssues.length) return "";

  const guidance = [];
  for (const issue of uniqueIssues) {
    const line = retryGuidanceForIssue(issue);
    if (line && !guidance.includes(line)) guidance.push(line);
  }
  if (!guidance.length) {
    guidance.push("总体重生：重新设计一个真实四方连续的单个循环单元，不要把上一张图裁切、镜像、模糊或简单拼贴。");
  }

  const cappedGuidance = guidance.slice(0, 6);
  const issueSummary = uniqueIssues.slice(0, 6).join("、") + (uniqueIssues.length > 6 ? "等" : "");
  return [
    `上一次自动质检未通过：${issueSummary}。这次不是轻修边缘，而是重新设计一个真正四方连续的单个循环单元。`,
    "本轮必须按失败原因纠偏：",
    ...cappedGuidance.map((line) => `- ${line}`),
    "生成前请在内部预演 3×3 平铺；若能看到任何水平/垂直线、四角硬点、模糊修补带、镜像轴或白边，就重新构图后再输出。",
  ].join("\n");
}

function collectQualityIssueText(previousCheck = null) {
  return [
    previousCheck?.finalIssueType,
    ...(Array.isArray(previousCheck?.issues) ? previousCheck.issues : []),
  ]
    .map((issue) => String(issue || "").trim())
    .filter(Boolean)
    .join("、");
}

function isStructuralSeamIssue(issueText = "") {
  return /横档|竖档|回头没接|四角平铺交汇|内部接缝线|平铺预览中心线|平铺边带|细线接缝|接缝过渡不自然|接缝细节发虚|边缘错位漂移|最终JPG边缘硬线/.test(issueText);
}

function buildAttemptStrategyGuidance(attempt = 1, previousCheck = null) {
  const attemptNumber = Math.max(1, Number(attempt) || 1);
  if (attemptNumber <= 1) return "";

  const issueText = collectQualityIssueText(previousCheck);
  const structuralSeam = isStructuralSeamIssue(issueText);
  const overlapRisk = /花型元素叠加|局部花型叠加/.test(issueText);
  const layoutRisk = /花型分布过于集中|花型信息量不足|画框留白|输出比例拉伸/.test(issueText);
  const clarityRisk = /低清放大|成品清晰度不足|印花细节密度不足|压缩块噪点|锐化光晕|色阶断层/.test(issueText);

  if (attemptNumber === 2) {
    const priority = structuralSeam
      ? "这轮采用“边缘优先闭合”策略：先设计上下左右四条边和四个角，再填充画面内部。"
      : "这轮采用“均衡满铺”策略：先确定全画面的重复节奏，再安排主体和辅助元素。";
    return [
      `本轮重生策略：第 ${attemptNumber} 次生成，不沿用上一轮构图。${priority}`,
      "- 四条边必须有真实跨边延续的小中型花枝、藤蔓、线稿或织物纹理，不能把所有主体都缩进中心。",
      "- 四角先闭合，角点附近只允许自然延展纹理和轻量辅助元素，禁止圆斑、十字结、硬补丁或重复小花。",
      "- 主体元素可以有变化，但边缘坐标必须按 offset repeat 对齐；生成前内部检查 3×3 平铺。",
      overlapRisk ? "- 上一轮有元素叠加风险：接缝附近改用自然穿插和留白，不要用贴片盖住断口。" : "- 不要通过模糊、淡化、镜像条带或纯色过渡来隐藏边缘。",
    ].join("\n");
  }

  if (attemptNumber === 3) {
    return [
      `本轮重生策略：第 ${attemptNumber} 次生成，改用“小中型 all-over 连续纹样”策略。`,
      "- 降低单个大主体比例，用多个小中型元素、细线、织物颗粒和辅助藤蔓形成稳定满铺节奏。",
      "- 边缘区域必须像内部一样有清晰纹理和可打印细节，避免空边、静音边、糊边或平涂修补带。",
      "- 不要让巨大花朵、佩斯利或动物主体压住接缝；需要跨边时只用可准确续接的细枝、叶片和纹理。",
      layoutRisk ? "- 上一轮布局风险较高：视觉重量分散到四边和四角，禁止中心独大或外框式构图。" : "- 保持服装面料的自然呼吸感，但不能牺牲边缘闭合。",
    ].join("\n");
  }

  return [
    `本轮重生策略：第 ${attemptNumber} 次生成，进入“严格生产单元”策略，降低炫技构图，优先让四方连续通过。`,
    "- 只输出一个完整竖版循环单元；不要输出预览网格、边框、拼贴展示或任何分割线。",
    "- 采用可平铺的小中型连续纹理、花枝和线稿系统，四边四角先闭合，内部再补充层次。",
    "- 任何接触边缘的线条、枝叶、颗粒、明暗和底纹都必须在对侧同坐标继续，不能断头或错位。",
    clarityRisk ? "- 上一轮有清晰度/压缩/光晕风险：用原生高清细节，避免低清放大、块噪、过锐化和硬色带。" : "- 输出必须保持高清、细节密度足、适合 300dpi 面料打印。",
  ].join("\n");
}

function retryGuidanceForIssue(issue) {
  const text = String(issue || "");
  if (text.includes("横档")) {
    return "上下边优先：上边缘和下边缘必须是同一条连续纹理的两端，花枝、线稿、织物颗粒和明暗在 Y 方向准确闭合，不能出现横向直线接缝。";
  }
  if (text.includes("竖档")) {
    return "左右边优先：左边缘和右边缘必须是同一条连续纹理的两端，枝叶方向、图案坐标和明暗在 X 方向准确闭合，不能出现竖向直线接缝。";
  }
  if (text.includes("回头没接") || text.includes("四角平铺交汇")) {
    return "四角闭合：四个角必须像同一块自然纹理的连续区域，不要在 2×2 交汇点形成硬点、圆斑、十字结、重复小花或修补块。";
  }
  if (text.includes("最终JPG边缘硬线")) {
    return "最外缘重画：禁止 1px 边框、描边、暗线、亮线或编码压边；最外一圈像素也必须延续画面内部的自然线稿和织物颗粒。";
  }
  if (text.includes("平铺预览输出")) {
    return "输出形态纠偏：只输出一个完整的单个循环单元，不要输出 2×2、3×3、拼贴预览、网格预览或带分割线的展示图。";
  }
  if (text.includes("画框留白")) {
    return "满版铺底：图案必须铺满整张画布到四边，禁止白边、黑边、相纸边、画框、留白外沿或暗角边界。";
  }
  if (text.includes("输出比例拉伸") || text.includes("成品规格")) {
    return "原生竖版：按竖版循环单元直接构图，接近 42cm×64cm 比例，不要把方图硬拉成长图，也不要输出横版或方形预览。";
  }
  if (text.includes("花型信息量不足")) {
    return "信息量补足：增加可打印的花叶、藤蔓、纹理和细线层次，让边缘与内部都有足够图案密度，避免大面积空白或单调底纹。";
  }
  if (text.includes("花型分布过于集中")) {
    return "布局均衡：把视觉重量分散到全画面，边缘和四角也要有自然延展的辅助元素，禁止单一大主体居中压住画面。";
  }
  if (text.includes("镜像轴痕")) {
    return "去机械镜像：不要用左右/上下镜像复制来做无缝，中心和边缘都要有手绘式自然差异，避免明显对称轴。";
  }
  if (text.includes("低清放大") || text.includes("成品清晰度不足") || text.includes("印花细节密度不足")) {
    return "原生高清：重新生成高分辨率细节，线稿、织物颗粒和微小纹理要清楚，禁止低分辨率放大、像素块、软糊水洗感或细节被抹平。";
  }
  if (text.includes("色阶断层")) {
    return "色阶平滑：保持自然渐变和织物层次，不要出现海报化硬色带、阴影断层或大块突兀色阶。";
  }
  if (text.includes("压缩块噪点")) {
    return "干净纹理：不要生成 JPEG 方块、马赛克块、脏噪点或规律压缩格，细节应来自图案线稿和织物颗粒。";
  }
  if (text.includes("锐化光晕")) {
    return "自然锐度：不要过度锐化，线条边缘不能有白色/黑色光晕、描边毛刺或硬反差轮廓。";
  }
  if (text.includes("边缘错位漂移")) {
    return "坐标对齐：跨边缘的枝条、藤蔓和纹理必须在对侧同一坐标继续，不允许半格偏移、斜向漂移或错位复制。";
  }
  if (text.includes("花型元素叠加") || text.includes("局部花型叠加")) {
    return "避免贴片重叠：不要把元素堆叠在接缝处遮盖问题；局部叠加区域要重画自然穿插、留白和枝叶走向，保证花叶和纹理不互相压糊。";
  }
  if (text.includes("内部接缝线") || text.includes("接缝过渡不自然") || text.includes("平铺预览中心线") || text.includes("平铺边带") || text.includes("接缝细节发虚") || text.includes("细线接缝") || text.includes("轻微色差")) {
    return "丝滑过渡：接缝或内部导线区域必须重新生成自然图案细节，不要用模糊、淡化、平均色、纯色带、镜像带、网格线或羽化条带遮盖。";
  }
  return "总体重生：重新设计一个真实四方连续的单个循环单元，不要把上一张图裁切、镜像、模糊或简单拼贴。";
}

function buildPrompt(previousCheck = null, attempt = 1) {
  const styleNote = els.styleNotes.value.trim() || "严格读取参考图的艺术风格、配色、笔触、元素气质、疏密节奏与高级面料感，不新增与参考图调性冲突的元素。";
  const attemptGuidance = buildAttemptStrategyGuidance(attempt, previousCheck);
  const strategyNote = attemptGuidance ? `\n\n${attemptGuidance}` : "";
  const retryGuidance = buildRetryGuidance(previousCheck);
  const retryNote = retryGuidance ? `\n\n${retryGuidance}` : "";
  return `请基于上传的参考图进行延展设计，生成可用于服装面料数码印花的大尺寸四方连续无缝循环图案。

必须严格执行：
1. 图案必须是 seamless pattern / tileable repeat / 四方连续结构，上下左右完整衔接，平铺后不能出现接缝、断层、错位或边缘拼接痕迹。画布最上边必须能和最下边无缝相接，最左边必须能和最右边无缝相接。
2. 只输出一个完整的单个循环单元，不要输出 2×2、3×3 或多块拼贴预览，不要把平铺分割线画进图里。
3. 保持参考图原有艺术风格、配色、元素气质与整体调性。${styleNote}
4. 整体采用${els.density.value}，元素分布均匀自然，禁止单一主体居中放大，避免视觉重心过于集中。
5. 保持画面呼吸感和高级服装面料视觉，适合连续排版和无限循环印花。
6. 细节清晰，线条干净，色彩过渡自然，避免糊边、高噪点、脏乱细节和明显 AI 痕迹。
7. 严禁任何白边、黑边、画框、边界线、边缘留白、上下横线、左右竖线、横向接缝、竖向接缝、回头没接、边缘元素断头、上下/左右明暗突变。画面必须铺满整张画布。
8. 边缘不能靠模糊、淡化、纯色带、镜像带或平均颜色来假装无缝；边缘处也必须有与画面内部一致的织物颗粒、线条细节和自然笔触。

输出意图：
- 宽 42cm × 高 64cm
- 300dpi
- JPG 交付
- 用于面料开发与数码印花打样

构图要求：
- 第一优先级是四边可平铺，不是画面丰富度；宁可边缘区域更简洁，也不能出现任何边缘断头。
- 请按 Offset 平铺思路构图：把画面上下、左右对边当成同一条连续纹路来设计，生成前先在内部预演 2×2 拼接效果。
- 四角必须能同时闭合，不要只处理单边；左上、右上、左下、右下四个角在平铺后必须自然连成一个连续区域。
- 大花、枝条、叶片、蝴蝶、佩斯利等主体元素尽量完整放在画布内部安全区，避免压到最外侧 8% 边缘。
- 如果任何主体元素接触画布边缘，它必须在对侧以同一形状、同一位置、同一角度准确延续；否则不要让主体元素接触边缘。
- 上边缘的纹理、颜色、明暗、笔触必须与下边缘对应闭合；左边缘必须与右边缘对应闭合。
- 边缘元素必须真实跨边延续，不允许只在边缘淡化、镜像糊边、纯色过渡或模糊涂抹来遮盖接缝。
- 生成时请优先采用 Offset repeat 工作法：先把潜在边缘接缝移动到画面中心进行自然重绘，再移回单元图；最终单元图边缘不应留下修补带。
- 画面内部不能出现任何横向或竖向长直拼接带、重复块硬边、网格分割线或平铺预览边界。
- 抽象纹理要保持流向连续；植物花卉要避免枝叶和花瓣在边缘断头；佩斯利、几何和民族纹样要避免规律错位、半个图形断裂或回头没有接上。
- 不要出现一个巨大主体占据中心。
- 保持稀疏、均衡、自然的服装面料图案节奏。
- 边缘区域必须像画面内部一样自然，最终 2×2 平铺预览中不能出现任何横档、竖档或直线接缝。${strategyNote}${retryNote}`;
}

function buildFissionPrompt(task, previousCheck = null, attempt = 1) {
  const styleNote = els.styleNotes.value.trim() || "保持原图的艺术风格、配色、笔触、元素气质、疏密节奏与高级面料感。";
  const strength = fissionStrengthProfile();
  const parentNote = task?.parentPatternCode ? `\n- 原图编号：${task.parentPatternCode}。新图要像同一系列的延展款，但不能只是复制、裁切、镜像或轻微调色。` : "";
  const attemptGuidance = buildAttemptStrategyGuidance(attempt, previousCheck);
  const strategyNote = attemptGuidance ? `\n\n${attemptGuidance}` : "";
  const retryGuidance = buildRetryGuidance(previousCheck);
  const retryNote = retryGuidance ? `\n\n${retryGuidance}` : "";
  return `请把上传图片作为已经成品化的无缝印花参考图，先反推它的核心提示词：风格、配色、笔触、材质质感、构图密度、面料气质和连续纹样规则；再基于这些核心提示词重新设计一张同系列但元素明显变化的新图案。

裂变要求：
- 当前裂变强度：${strength.label}。
- 保留：原图的整体风格、色彩气质、笔触/画法、精致度、面料高级感、疏密节奏和连续纹样逻辑。
- 改变：${strength.changeRule}
- 元素变化必须发生在主体元素、辅助元素、局部造型、枝叶/花瓣/纹理细节、方向节奏和留白关系上，而不只是移动位置或换颜色。
- 新图必须像同一系列的新款，不像同一张图的复制版。
- 禁止沿用原图的具体元素轮廓、重复同一朵花/同一片叶/同一块纹理、简单换色、裁切放大、镜像翻转、加滤镜或只做局部微调。${parentNote}
- ${strength.negativeRule}
- ${styleNote}

必须严格执行：
1. 图案必须是 seamless pattern / tileable repeat / 四方连续结构，上下左右完整衔接，平铺后不能出现接缝、断层、错位或边缘拼接痕迹。
2. 只输出一个完整的单个循环单元，不要输出 2×2、3×3 或多块拼贴预览，不要把平铺分割线画进图里。
3. 整体采用${els.density.value}，元素分布均匀自然，禁止单一主体居中放大，避免视觉重心过于集中。
4. 保持画面呼吸感和高级服装面料视觉，适合连续排版和无限循环印花。
5. 细节清晰，线条干净，色彩过渡自然，避免糊边、高噪点、脏乱细节和明显 AI 痕迹。
6. 严禁任何白边、黑边、画框、边界线、边缘留白、上下横线、左右竖线、横向接缝、竖向接缝、回头没接、边缘元素断头、上下/左右明暗突变。画面必须铺满整张画布。
7. 边缘不能靠模糊、淡化、纯色带、镜像带或平均颜色来假装无缝；边缘处也必须有与画面内部一致的织物颗粒、线条细节和自然笔触。

输出意图：
- 宽 42cm × 高 64cm
- 300dpi
- JPG 交付
- 用于面料开发与数码印花打样

构图要求：
- 第一优先级是四边可平铺，不是画面丰富度；宁可边缘区域更简洁，也不能出现任何边缘断头。
- 请按 Offset 平铺思路构图：把画面上下、左右对边当成同一条连续纹路来设计，生成前先在内部预演 2×2 拼接效果。
- 四角必须能同时闭合，不要只处理单边；左上、右上、左下、右下四个角在平铺后必须自然连成一个连续区域。
- 大花、枝条、叶片、蝴蝶、佩斯利等主体元素尽量完整放在画布内部安全区，避免压到最外侧 8% 边缘。
- 如果任何主体元素接触画布边缘，它必须在对侧以同一形状、同一位置、同一角度准确延续；否则不要让主体元素接触边缘。
- 上边缘的纹理、颜色、明暗、笔触必须与下边缘对应闭合；左边缘必须与右边缘对应闭合。
- 边缘元素必须真实跨边延续，不允许只在边缘淡化、镜像糊边、纯色过渡或模糊涂抹来遮盖接缝。
- 生成时请优先采用 Offset repeat 工作法：先把潜在边缘接缝移动到画面中心进行自然重绘，再移回单元图；最终单元图边缘不应留下修补带。
- 画面内部不能出现任何横向或竖向长直拼接带、重复块硬边、网格分割线或平铺预览边界。
- 最终 2×2 平铺预览中不能出现任何横档、竖档或直线接缝。${strategyNote}${retryNote}`;
}

function fissionStrengthProfile() {
  const value = els.fissionStrength?.value || "medium";
  const profiles = {
    light: {
      label: "轻度裂变，风格高度接近，元素做小幅替换",
      changeRule: "替换约 30% 到 45% 的可见元素，保留元素类别，但重画具体造型和细节；例如同为花卉时换花瓣形态、叶片姿态、枝条走向和小纹理。",
      negativeRule: "不要完全换题材，也不要让新图像原图的局部重排。",
    },
    medium: {
      label: "中度裂变，风格接近，元素明显换一批",
      changeRule: "替换约 60% 到 75% 的主体和辅助元素，保留艺术风格与色彩关系，但重新设计元素库；例如把原来的花型换成同风格的另一类花叶、果实、藤蔓、羽叶或抽象纹样组合。",
      negativeRule: "不要保留原图中最显眼的主体轮廓和标志性元素组合。",
    },
    strong: {
      label: "强度裂变，保留视觉语言，重组题材元素",
      changeRule: "替换约 80% 到 95% 的元素库，只保留配色、笔触、密度、层次和高级面料气质；主体题材可以从花卉转为果实/羽毛/藤蔓/贝壳/抽象植物/几何纹理等相邻题材。",
      negativeRule: "不要复用原图任何显眼主体、关键轮廓或局部元素组合；变化要比普通变体更明显。",
    },
  };
  return profiles[value] || profiles.medium;
}

function setEmptyState() {
  els.emptyState.style.display = tasks.length ? "none" : "grid";
}

function setTaskStatus(task, status, message, progress) {
  task.status = status;
  task.nodes.badge.textContent = status;
  task.nodes.badge.className = "status-badge";
  if (status === "生成中") task.nodes.badge.classList.add("is-running");
  if (status === "已完成") task.nodes.badge.classList.add("is-done");
  if (status === "失败" || status === "需人工复核") task.nodes.badge.classList.add("is-error");
  task.nodes.message.textContent = message;
  task.nodes.progress.style.width = `${progress}%`;
}

async function addFiles(files) {
  const historyRecords = await fetchHistoryRecords();
  const referenceHistoryMap = buildReferenceHistoryMap(historyRecords);
  const usedCodes = await collectUsedPatternCodes(historyRecords);
  let duplicateReferenceCount = 0;

  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const dataUrl = await fileToDataUrl(file);
    const priorRecords = referenceHistoryMap.get(normalizeReferenceCode(file.name)) || [];
    const task = createTask({
      id: crypto.randomUUID(),
      file: {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
      },
      dataUrl,
      patternCode: nextPatternCode(usedCodes),
      generationMode: "generate",
      status: "待处理",
      createdAt: new Date().toISOString(),
    });
    if (priorRecords.length) {
      duplicateReferenceCount += 1;
      task.nodes.message.textContent = describeReferenceHistory(file.name, priorRecords);
    }
    await saveQueuedTask(task, "待处理");
  }
  if (duplicateReferenceCount) {
    showToast(`${duplicateReferenceCount} 张参考图已有生成历史`);
  }
  setEmptyState();
}

function createTask({ id, file, dataUrl, patternCode, status = "待处理", createdAt = new Date().toISOString(), generationMode = "generate", parentPatternCode = "" }) {
  const node = els.taskTemplate.content.firstElementChild.cloneNode(true);
  const safeStatus = status === "生成中" ? "待恢复" : status;
  const task = {
    id,
    file,
    dataUrl,
    patternCode,
    generationMode,
    parentPatternCode,
    resultDataUrl: "",
    resultJpgUrl: "",
    seamScore: null,
    seamRating: "",
    seamCheck: null,
    originalSeamCheck: null,
    repairCheck: null,
    generationAttempts: 0,
    repairAttempts: 0,
    aiRepairAttempts: 0,
    locallyRepaired: false,
    autoRegenerated: false,
    qualityPassed: false,
    status: safeStatus,
    createdAt,
    nodes: {
      root: node,
      sourceThumb: node.querySelector(".source-thumb"),
      resultThumb: node.querySelector(".result-thumb"),
      name: node.querySelector(".task-name"),
      meta: node.querySelector(".task-meta"),
      badge: node.querySelector(".status-badge"),
      message: node.querySelector(".task-message"),
      progress: node.querySelector(".progress-track span"),
      generate: node.querySelector(".generate-one"),
      fission: node.querySelector(".fission-one"),
      enhance: node.querySelector(".enhance-one"),
      repair: node.querySelector(".repair-one"),
      check: node.querySelector(".check-one"),
      download: node.querySelector(".download-one"),
      select: node.querySelector(".select-one"),
    },
  };

  task.nodes.sourceThumb.innerHTML = `<img src="${dataUrl}" alt="">`;
  task.nodes.name.textContent = `${task.patternCode} · ${file.name}`;
  task.nodes.meta.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  task.nodes.generate.addEventListener("click", () => generateTask(task));
  task.nodes.fission.addEventListener("click", () => createFissionTaskFromTask(task));
  task.nodes.enhance.addEventListener("click", () => enhanceTask(task));
  task.nodes.repair.addEventListener("click", () => repairTask(task, { manual: true }));
  task.nodes.check.addEventListener("click", () => runSeamCheck(task));
  task.nodes.download.addEventListener("click", () => downloadJpg(task));
  task.nodes.select.addEventListener("change", () => toggleTaskSelection(task));

  tasks.push(task);
  els.taskList.appendChild(node);

  if (safeStatus === "待恢复" || safeStatus === "失败") {
    task.nodes.generate.textContent = "重新生成";
    setTaskStatus(task, safeStatus === "待恢复" ? "待处理" : "失败", "上次生成中断，可以点击“恢复生成”继续。", safeStatus === "失败" ? 100 : 0);
  } else {
    setTaskStatus(task, safeStatus, "准备就绪。", 0);
  }

  return task;
}

async function restoreQueuedTasks() {
  const records = await listQueuedTasks();
  const existingIds = new Set(tasks.map((task) => task.id));
  const pendingRecords = records
    .filter((record) => record?.dataUrl && !existingIds.has(record.id))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  pendingRecords.forEach((record) => {
    createTask({
      id: record.id,
      file: {
        name: record.fileName || "未命名参考图",
        type: record.fileType || "image/jpeg",
        size: record.fileSize || 0,
        lastModified: record.fileLastModified || 0,
      },
      dataUrl: record.dataUrl,
      patternCode: record.patternCode || "YUANYE",
      generationMode: record.generationMode || "generate",
      parentPatternCode: record.parentPatternCode || "",
      status: record.status || "待恢复",
      createdAt: record.createdAt || new Date().toISOString(),
    });
  });

  if (pendingRecords.length) {
    showToast(`已找回 ${pendingRecords.length} 个未完成任务`);
  }
  setEmptyState();
}

async function generateTask(task, historyMarker = createHistoryMarker(task?.generationMode === "fission" ? "fission" : "generate")) {
  if (task.status === "生成中") return;

  let phase = "准备生成";
  selectedDownloads.delete(`task:${task.id}`);
  task.resultDataUrl = "";
  task.resultJpgUrl = "";
  task.seamScore = null;
  task.seamRating = "";
  task.seamCheck = null;
  task.originalSeamCheck = null;
  task.repairCheck = null;
  task.exportMetrics = null;
  task.generationAttempts = 0;
  task.repairAttempts = 0;
  task.aiRepairAttempts = 0;
  task.locallyRepaired = false;
  task.autoRegenerated = false;
  task.qualityPassed = false;
  task.downloaded = false;
  task.nodes.select.checked = false;
  task.nodes.select.disabled = true;
  task.nodes.enhance.disabled = true;
  task.nodes.fission.disabled = true;
  task.nodes.repair.disabled = true;
  task.nodes.check.disabled = true;
  task.nodes.download.textContent = "下载 JPG";
  task.nodes.download.classList.remove("is-downloaded");
  task.nodes.resultThumb.innerHTML = `<span>成品预览</span>`;
  updateBatchState();
  setTaskStatus(task, "生成中", "正在上传参考图并生成四方连续图案。", 28);
  await saveQueuedTask(task, "生成中");
  task.nodes.generate.disabled = true;
  task.nodes.download.disabled = true;

  try {
    let lastCheck = null;
    let finalAction = "review";
    let bestCandidate = null;
    for (let attempt = 1; attempt <= maxAutoRegenerations + 1; attempt += 1) {
      task.generationAttempts = attempt;
      phase = "请求图片生成接口";
      setTaskStatus(task, "生成中", attempt === 1
        ? "正在上传参考图并生成四方连续图案。"
        : `检测未通过，正在自动重新生成 ${attempt - 1}/${maxAutoRegenerations}。`, attempt === 1 ? 28 : 34);

      const payload = await requestGeneratedImage(task, lastCheck, attempt);

      phase = "显示成品预览";
      setTaskStatus(task, "生成中", "正在准备 JPG 下载文件。", 72);
      task.resultDataUrl = payload.image.dataUrl;
      task.nodes.resultThumb.innerHTML = `<img src="${task.resultDataUrl}" alt="">`;
      task.nodes.resultThumb.style.backgroundImage = "";

      phase = "导出目标 JPG";
      task.resultJpgUrl = await makeJpg(task.resultDataUrl, makeTaskJpgOptions(task, {
        enhance: els.autoEnhance.checked,
        strength: getEnhanceStrength(),
        repair: false,
      }));
      task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;

      phase = "严格四方循环质检";
      setTaskStatus(task, "生成中", "正在做严格四方循环检查。", 90);
      lastCheck = await runSeamCheck(task, true);
      task.originalSeamCheck = task.originalSeamCheck || lastCheck;

      if (lastCheck.passed) {
        finalAction = task.generationMode === "fission" ? "fission" : "generate";
        break;
      }

      if (shouldPrintClarityEnhance(lastCheck)) {
        phase = "印花清晰度增强";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在做印花清晰度增强。`, 92);
        const clarityCheck = await finishPrintClarityTask(task, { quiet: true });
        lastCheck = clarityCheck || lastCheck;
        if (lastCheck.passed) {
          finalAction = "enhance";
          break;
        }
      }

      if (task.aiRepairAttempts < maxAiSeamRepairs && shouldAiInternalGuideRepair(lastCheck)) {
        phase = "AI 内部导线修复";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在让 AI 原位消除内部导线。`, 94);
        const internalGuideRepairCheck = await improveWithAiInternalGuideRepair(task, lastCheck);
        lastCheck = internalGuideRepairCheck || lastCheck;
        if (lastCheck.passed) {
          finalAction = "repair";
          break;
        }
      }

      if (task.aiRepairAttempts < maxAiSeamRepairs && shouldAiOffsetRepair(lastCheck)) {
        phase = "AI 丝滑过渡修缝";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在让 AI 生成丝滑过渡。`, 94);
        const aiRepairCheck = await improveWithAiOffsetRepair(task, lastCheck);
        lastCheck = aiRepairCheck || lastCheck;
        if (lastCheck.passed) {
          finalAction = "repair";
          break;
        }
      }

      if (shouldEdgeBlendRepair(lastCheck)) {
        phase = "本地轻修复";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在轻修并复检。`, 95);
        const repairCheck = await repairTask(task, { quiet: true });
        lastCheck = repairCheck || lastCheck;
        if (lastCheck.passed) {
          finalAction = "repair";
          break;
        }
      }

      if (shouldForcePeriodicRepair(lastCheck)) {
        phase = "强制四方连续处理";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在做最后兜底处理。`, 96);
        const forceCheck = await forceSeamlessTask(task, { quiet: true });
        lastCheck = forceCheck || lastCheck;
        if (lastCheck.passed) {
          finalAction = "repair";
          break;
        }
      }

      if (shouldTryCertifiedSeamlessFallback(lastCheck)) {
        phase = "严格闭合候选";
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，正在尝试严格闭合候选。`, 96);
        const fallback = await tryCertifiedSeamlessFallback(task, lastCheck);
        if (fallback?.accepted) {
          lastCheck = fallback.check;
          finalAction = "repair";
          break;
        }
        if (fallback?.candidate) {
          bestCandidate = rememberBestTaskCandidate(fallback.candidate, fallback.check, bestCandidate);
        }
      }

      bestCandidate = rememberBestTaskCandidate(task, lastCheck, bestCandidate);
      task.autoRegenerated = true;
      if (attempt <= maxAutoRegenerations) {
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，准备自动重生 ${attempt}/${maxAutoRegenerations}。`, 96);
        await delay(800);
      }
    }

    if (!lastCheck?.passed && bestCandidate && isSeamCheckBetter(bestCandidate.check, lastCheck)) {
      restoreTaskCandidate(task, bestCandidate);
      lastCheck = bestCandidate.check;
    }

    task.nodes.enhance.disabled = false;
    task.nodes.fission.disabled = false;
    task.nodes.repair.disabled = !shouldOfferTaskRepair(task, lastCheck);
    task.nodes.check.disabled = false;
    task.nodes.generate.textContent = "重新生成";
    task.qualityPassed = Boolean(lastCheck?.passed);
    updateTaskDownloadGate(task);

    if (task.qualityPassed) {
      task.nodes.select.disabled = false;
      task.nodes.select.checked = true;
      toggleTaskSelection(task);
      await saveHistory(task, historyMarker, finalAction);
      await deleteQueuedTask(task.id);
      setTaskStatus(task, "已完成", task.locallyRepaired
        ? `已轻修通过，${task.seamRating}，可以下载 JPG。`
        : `已通过，${task.seamRating}，可以下载 JPG。`, 100);
    } else {
      task.nodes.select.disabled = true;
      task.nodes.select.checked = false;
      toggleTaskSelection(task);
      updateTaskDownloadGate(task);
      await saveHistory(task, historyMarker, "review");
      await deleteQueuedTask(task.id);
      setTaskStatus(task, "需人工复核", `${seamFailureMessage(lastCheck)}。已轻修 ${task.repairAttempts} 次、重生 ${Math.max(0, task.generationAttempts - 1)} 次；未通过认证前不开放成品下载。`, 100);
    }
  } catch (error) {
    const message = `${phase}失败：${error.message}`;
    setTaskStatus(task, "失败", message, 100);
    task.nodes.generate.textContent = "重新生成";
    await saveQueuedTask(task, "失败");
    showToast(message);
  } finally {
    task.nodes.generate.disabled = false;
  }
}

async function requestGeneratedImage(task, previousCheck = null, attempt = 1) {
  return await requestImageGeneration({
    image: {
      name: task.file.name,
      type: task.file.type,
      dataUrl: task.dataUrl,
    },
    prompt: task.generationMode === "fission" ? buildFissionPrompt(task, previousCheck, attempt) : buildPrompt(previousCheck, attempt),
    size: els.size.value,
  }, {
    onPoll: (job) => {
      if (job?.status === "running") {
        const retryText = attempt === 1 ? "" : ` ${attempt - 1}/${maxAutoRegenerations}`;
        setTaskStatus(task, "生成中", `图片接口正在生成${retryText}，请保持页面打开。`, 44);
      }
    },
  });
}

async function createFissionTaskFromTask(task) {
  if (!task.resultJpgUrl) {
    showToast("请先生成图片");
    return;
  }
  if (task.fissionStarting) return;

  task.fissionStarting = true;
  task.nodes.fission.disabled = true;
  try {
    await createFissionTask({
      dataUrl: task.resultJpgUrl,
      sourceName: `${task.patternCode || "YUANYE"}-裂变参考.jpg`,
      parentPatternCode: task.patternCode,
    });
  } finally {
    task.fissionStarting = false;
    task.nodes.fission.disabled = false;
  }
}

async function createFissionTask({ dataUrl, sourceName, parentPatternCode = "" }) {
  const usedCodes = await collectUsedPatternCodes();
  const patternCode = nextPatternCode(usedCodes);
  const task = createTask({
    id: crypto.randomUUID(),
    file: {
      name: sourceName || `${parentPatternCode || "YUANYE"}-裂变参考.jpg`,
      type: "image/jpeg",
      size: dataUrlByteSize(dataUrl),
      lastModified: Date.now(),
    },
    dataUrl,
    patternCode,
    generationMode: "fission",
    parentPatternCode,
    status: "待处理",
    createdAt: new Date().toISOString(),
  });

  task.nodes.message.textContent = parentPatternCode
    ? `已创建 ${parentPatternCode} 的裂变任务，准备生成同系列新图。`
    : "已创建裂变任务，准备生成同系列新图。";
  await saveQueuedTask(task, "待处理");
  setEmptyState();
  showToast("已加入以图裂变任务");
  await generateTask(task, createHistoryMarker("fission"));
}

function toggleTaskSelection(task) {
  const key = `task:${task.id}`;
  const certified = taskHasCertifiedDownload(task);
  if (task.nodes.select.checked && certified) {
    selectedDownloads.set(key, {
      name: `${task.patternCode || "YUANYE"}.jpg`,
      dataUrl: task.resultJpgUrl,
      certified: true,
    });
  } else {
    if (task.nodes.select.checked && !certified) {
      task.nodes.select.checked = false;
    }
    selectedDownloads.delete(key);
  }
  updateBatchState();
}

async function enhanceTask(task) {
  if (!task.resultDataUrl) {
    showToast("请先生成图片");
    return;
  }

  task.nodes.enhance.disabled = true;
  task.nodes.repair.disabled = true;
  task.nodes.fission.disabled = true;
  task.nodes.download.disabled = true;
  task.nodes.download.textContent = "下载 JPG";
  task.nodes.download.classList.remove("is-downloaded");
  setTaskStatus(task, "生成中", "正在本地高清增强并复检四方循环。", 86);

  try {
    const historyMarker = createHistoryMarker("enhance");
    task.resultJpgUrl = await makeJpg(task.resultDataUrl, makeTaskJpgOptions(task, {
      enhance: true,
      strength: getEnhanceStrength(),
    }));
    task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
    if (task.nodes.select.checked) toggleTaskSelection(task);
    const check = await runSeamCheck(task, true);
    task.qualityPassed = check.passed;
    task.nodes.select.disabled = !check.passed;
    task.nodes.select.checked = check.passed;
    toggleTaskSelection(task);
    task.nodes.repair.disabled = !shouldOfferTaskRepair(task, check);
    updateTaskDownloadGate(task);
    await saveHistory(task, historyMarker, "enhance");
    setTaskStatus(task, check.passed ? "已完成" : "需人工复核", check.passed
      ? `高清增强完成，${task.seamRating}，可以下载 JPG。`
      : `高清增强完成，但${seamFailureMessage(check)}；未通过认证前不开放成品下载。`, 100);
  } catch (error) {
    setTaskStatus(task, "失败", `高清增强失败：${error.message}`, 100);
  } finally {
    task.nodes.enhance.disabled = false;
    task.nodes.fission.disabled = false;
    updateTaskDownloadGate(task);
  }
}

async function finishPrintClarityTask(task, options = {}) {
  const sourceUrl = task.resultDataUrl || task.resultJpgUrl;
  if (!sourceUrl) return null;

  task.nodes.enhance.disabled = true;
  if (!options.quiet) {
    setTaskStatus(task, "生成中", "正在做印花清晰度增强并复检四方循环。", 88);
  }

  try {
    task.resultJpgUrl = await makeJpg(sourceUrl, makeTaskJpgOptions(task, {
      enhance: true,
      strength: Math.max(getEnhanceStrength(), 0.34),
      toneDither: shouldToneDither(task.seamCheck),
    }));
    task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
    const check = await runSeamCheck(task, true);
    task.repairCheck = check;
    task.qualityPassed = check.passed;
    task.nodes.select.disabled = !check.passed;
    task.nodes.select.checked = check.passed;
    toggleTaskSelection(task);
    updateTaskDownloadGate(task);
    if (!options.quiet) {
      setTaskStatus(task, check.passed ? "已完成" : "需人工复核", check.passed
        ? `清晰度增强完成，${task.seamRating}，可以下载 JPG。`
        : `清晰度增强后仍未通过，${seamFailureMessage(check)}；未通过认证前不开放成品下载。`, 100);
    }
    return check;
  } finally {
    task.nodes.enhance.disabled = false;
  }
}

async function repairTask(task, options = {}) {
  if (!task.resultJpgUrl) {
    if (!options.quiet) showToast("请先生成图片");
    return null;
  }

  const baseCheck = task.seamCheck || await checkSeamQuality(task.resultJpgUrl);
  const canInternalGuide = canRunAiInternalGuideRepair(task, baseCheck);
  const canAiOffset = canRunAiOffsetRepair(task, baseCheck);
  const canEdgeBlend = shouldEdgeBlendRepair(baseCheck);
  const canForcePeriodic = shouldForcePeriodicRepair(baseCheck);

  if (canInternalGuide) {
    return await aiInternalGuideRepairFollowupTask(task, baseCheck, options);
  }

  if (canAiOffset) {
    return await aiOffsetRepairFollowupTask(task, baseCheck, options);
  }

  if (!canEdgeBlend && canForcePeriodic) {
    return await forceSeamlessTask(task, options);
  }

  if (!canEdgeBlend) {
    task.nodes.repair.disabled = true;
    if (!options.quiet) {
      setTaskStatus(task, "需人工复核", `${seamFailureMessage(baseCheck)}。当前底稿不适合继续轻修，请重新生成或裂变。`, 100);
      showToast("当前底稿需要重生或裂变");
    }
    return baseCheck;
  }

  task.nodes.repair.disabled = true;
  if (!options.quiet) {
    setTaskStatus(task, "生成中", "正在做接缝平滑处理。", 88);
  }

  try {
    task.repairAttempts += 1;
    const repairedUrl = await makeEdgeBlendRepairJpg(task.resultJpgUrl, baseCheck);
    task.resultJpgUrl = repairedUrl;
    task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
    const repairCheck = await runSeamCheck(task, true);
    task.repairCheck = repairCheck;
    task.locallyRepaired = repairCheck.passed;
    task.qualityPassed = repairCheck.passed;
    task.nodes.select.disabled = !repairCheck.passed;
    task.nodes.select.checked = repairCheck.passed;
    toggleTaskSelection(task);
    updateTaskDownloadGate(task);
    if (options.manual) {
      task.nodes.select.disabled = !repairCheck.passed;
      task.nodes.select.checked = repairCheck.passed;
      toggleTaskSelection(task);
      updateTaskDownloadGate(task);
      await saveHistory(task, createHistoryMarker(repairCheck.passed ? "repair" : "review"), repairCheck.passed ? "repair" : "review");
    }
    if (!options.quiet) {
      setTaskStatus(task, repairCheck.passed ? "已完成" : "需人工复核", repairCheck.passed
        ? `已轻修通过，${task.seamRating}，可以下载 JPG。`
        : `轻修后仍未通过，${seamFailureMessage(repairCheck)}；未通过认证前不开放成品下载。`, 100);
    }
    return repairCheck;
  } catch (error) {
    if (!options.quiet) setTaskStatus(task, "失败", `接缝平滑失败：${error.message}`, 100);
    throw error;
  } finally {
    task.nodes.repair.disabled = options.quiet ? true : !shouldOfferTaskRepair(task, task.seamCheck);
  }
}

async function aiOffsetRepairFollowupTask(task, baseCheck, options = {}) {
  if (!task.resultJpgUrl) {
    if (!options.quiet) showToast("请先生成图片");
    return null;
  }

  task.nodes.repair.disabled = true;
  if (!options.quiet) {
    setTaskStatus(task, "生成中", "正在让 AI 重新生成接缝丝滑过渡。", 90);
  }

  let repairCheck = baseCheck;
  try {
    repairCheck = await improveWithAiOffsetRepair(task, baseCheck);
    task.repairCheck = repairCheck;
    task.locallyRepaired = Boolean(repairCheck?.passed);
    task.qualityPassed = Boolean(repairCheck?.passed);
    task.nodes.select.disabled = !repairCheck?.passed;
    task.nodes.select.checked = Boolean(repairCheck?.passed);
    toggleTaskSelection(task);
    updateTaskDownloadGate(task);

    if (options.manual) {
      await saveHistory(task, createHistoryMarker(repairCheck.passed ? "repair" : "review"), repairCheck.passed ? "repair" : "review");
    }

    if (!options.quiet) {
      setTaskStatus(task, repairCheck.passed ? "已完成" : "需人工复核", repairCheck.passed
        ? `AI 丝滑过渡修缝通过，${task.seamRating}，可以下载 JPG。`
        : `AI 丝滑过渡后仍未通过，${seamFailureMessage(repairCheck)}；未通过认证前不开放成品下载。`, 100);
    }
    return repairCheck;
  } catch (error) {
    if (!options.quiet) setTaskStatus(task, "失败", `AI 丝滑过渡修缝失败：${error.message}`, 100);
    throw error;
  } finally {
    task.nodes.repair.disabled = options.quiet ? true : !shouldOfferTaskRepair(task, task.seamCheck || repairCheck);
  }
}

async function aiInternalGuideRepairFollowupTask(task, baseCheck, options = {}) {
  if (!task.resultJpgUrl) {
    if (!options.quiet) showToast("请先生成图片");
    return null;
  }

  task.nodes.repair.disabled = true;
  if (!options.quiet) {
    setTaskStatus(task, "生成中", "正在让 AI 原位修复内部导线和交叉点。", 90);
  }

  let repairCheck = baseCheck;
  try {
    repairCheck = await improveWithAiInternalGuideRepair(task, baseCheck);
    task.repairCheck = repairCheck;
    task.locallyRepaired = Boolean(repairCheck?.passed);
    task.qualityPassed = Boolean(repairCheck?.passed);
    task.nodes.select.disabled = !repairCheck?.passed;
    task.nodes.select.checked = Boolean(repairCheck?.passed);
    toggleTaskSelection(task);
    updateTaskDownloadGate(task);

    if (options.manual) {
      await saveHistory(task, createHistoryMarker(repairCheck.passed ? "repair" : "review"), repairCheck.passed ? "repair" : "review");
    }

    if (!options.quiet) {
      setTaskStatus(task, repairCheck.passed ? "已完成" : "需人工复核", repairCheck.passed
        ? `AI 内部导线修复通过，${task.seamRating}，可以下载 JPG。`
        : `AI 内部导线修复后仍未通过，${seamFailureMessage(repairCheck)}；未通过认证前不开放成品下载。`, 100);
    }
    return repairCheck;
  } catch (error) {
    if (!options.quiet) setTaskStatus(task, "失败", `AI 内部导线修复失败：${error.message}`, 100);
    throw error;
  } finally {
    task.nodes.repair.disabled = options.quiet ? true : !shouldOfferTaskRepair(task, task.seamCheck || repairCheck);
  }
}

async function forceSeamlessTask(task, options = {}) {
  if (!task.resultJpgUrl) {
    if (!options.quiet) showToast("请先生成图片");
    return null;
  }

  const baseCheck = task.seamCheck || await checkSeamQuality(task.resultJpgUrl);
  task.nodes.repair.disabled = true;
  if (!options.quiet) {
    setTaskStatus(task, "生成中", "正在做强制四方连续处理。", 90);
  }

  try {
    task.repairAttempts += 1;
    task.resultJpgUrl = await makeStrictSeamlessJpg(task.resultJpgUrl, baseCheck);
    task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
    const forceCheck = await runSeamCheck(task, true);
    task.repairCheck = forceCheck;
    task.locallyRepaired = forceCheck.passed;
    task.qualityPassed = forceCheck.passed;
    task.nodes.select.disabled = !forceCheck.passed;
    task.nodes.select.checked = forceCheck.passed;
    toggleTaskSelection(task);
    updateTaskDownloadGate(task);

    if (options.manual) {
      updateTaskDownloadGate(task);
      await saveHistory(task, createHistoryMarker(forceCheck.passed ? "repair" : "review"), forceCheck.passed ? "repair" : "review");
    }

    if (!options.quiet) {
      setTaskStatus(task, forceCheck.passed ? "已完成" : "需人工复核", forceCheck.passed
        ? `强制四方连续处理通过，${task.seamRating}，可以下载 JPG。`
        : `强制处理后仍未通过，${seamFailureMessage(forceCheck)}；未通过认证前不开放成品下载。`, 100);
    }
    return forceCheck;
  } catch (error) {
    if (!options.quiet) setTaskStatus(task, "失败", `强制四方连续处理失败：${error.message}`, 100);
    throw error;
  } finally {
    task.nodes.repair.disabled = options.quiet ? true : !shouldOfferTaskRepair(task, task.seamCheck);
  }
}

async function tryCertifiedSeamlessFallback(task, baseCheck) {
  if (!task.resultJpgUrl || !shouldTryCertifiedSeamlessFallback(baseCheck)) {
    return { accepted: false, check: null };
  }

  const candidateJpgUrl = await makeStrictSeamlessJpg(task.resultJpgUrl, baseCheck);
  const candidateCheck = applyAspectWarpCheck(await checkSeamQuality(candidateJpgUrl), task.exportMetrics?.aspectWarp);
  if (!candidateCheck.passed) {
    return {
      accepted: false,
      check: candidateCheck,
      candidate: captureExternalTaskCandidate(task, candidateJpgUrl, candidateCheck, {
        locallyRepaired: true,
        qualityPassed: false,
      }),
    };
  }

  task.repairAttempts += 1;
  task.resultJpgUrl = candidateJpgUrl;
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  task.seamCheck = candidateCheck;
  task.repairCheck = candidateCheck;
  task.seamScore = candidateCheck.score;
  task.seamRating = candidateCheck.rating;
  task.locallyRepaired = true;
  task.qualityPassed = true;
  task.nodes.message.textContent = seamCheckSummary(candidateCheck);
  task.nodes.select.disabled = false;
  task.nodes.select.checked = true;
  toggleTaskSelection(task);
  updateTaskDownloadGate(task);
  return { accepted: true, check: candidateCheck };
}

async function aiInternalGuideRepairTask(task, previousCheck) {
  if (!task.resultJpgUrl) return null;

  task.aiRepairAttempts += 1;
  task.repairAttempts += 1;

  const repairSourceUrl = task.resultDataUrl || task.resultJpgUrl;
  const maskDataUrl = await makeInternalGuideRepairMaskDataUrl(repairSourceUrl);
  const payload = await requestImageGeneration({
    image: {
      name: `${task.patternCode || "YUANYE"}-internal-guide-repair.png`,
      type: "image/png",
      dataUrl: repairSourceUrl,
    },
    mask: {
      name: `${task.patternCode || "YUANYE"}-internal-guide-mask.png`,
      type: "image/png",
      dataUrl: maskDataUrl,
    },
    prompt: buildInternalGuideRepairPrompt(previousCheck),
    size: els.size.value,
  }, {
    onPoll: (job) => {
      if (job?.status === "running") {
        setTaskStatus(task, "生成中", "AI 正在原位重绘内部导线和交叉点，请保持页面打开。", 94);
      }
    },
  });

  task.resultDataUrl = await blendMaskedRepairDataUrl(repairSourceUrl, payload.image.dataUrl, maskDataUrl, { strength: 1.28 });
  task.resultJpgUrl = await makeJpg(task.resultDataUrl, makeTaskJpgOptions(task, {
    enhance: shouldPrintClarityEnhance(previousCheck),
    strength: Math.max(getEnhanceStrength(), 0.28),
    skipAiRepair: true,
    repair: false,
  }));
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  const check = await runSeamCheck(task, true);
  task.repairCheck = check;
  task.locallyRepaired = check.passed;
  task.qualityPassed = check.passed;
  task.nodes.select.disabled = !check.passed;
  task.nodes.select.checked = check.passed;
  toggleTaskSelection(task);
  updateTaskDownloadGate(task);
  return check;
}

async function aiOffsetRepairTask(task, previousCheck) {
  if (!task.resultJpgUrl) return null;

  task.aiRepairAttempts += 1;
  task.repairAttempts += 1;

  const repairSourceUrl = task.resultDataUrl || task.resultJpgUrl;
  const offsetDataUrl = await makeOffsetDataUrl(repairSourceUrl, { format: "png" });
  const maskDataUrl = await makeOffsetRepairMaskDataUrl(offsetDataUrl);
  const payload = await requestImageGeneration({
    image: {
      name: `${task.patternCode || "YUANYE"}-offset-seam-repair.png`,
      type: "image/png",
      dataUrl: offsetDataUrl,
    },
    mask: {
      name: `${task.patternCode || "YUANYE"}-offset-seam-mask.png`,
      type: "image/png",
      dataUrl: maskDataUrl,
    },
    prompt: buildOffsetRepairPrompt(previousCheck),
    size: els.size.value,
  }, {
    onPoll: (job) => {
      if (job?.status === "running") {
        setTaskStatus(task, "生成中", "AI 正在重绘接缝过渡，请保持页面打开。", 94);
      }
    },
  });

  const blendedOffsetDataUrl = await blendMaskedRepairDataUrl(offsetDataUrl, payload.image.dataUrl, maskDataUrl, { strength: 1.08 });
  const restoredDataUrl = await makeOffsetDataUrl(blendedOffsetDataUrl, { reverse: true, format: "png" });
  task.resultDataUrl = restoredDataUrl;
  task.resultJpgUrl = await makeJpg(restoredDataUrl, makeTaskJpgOptions(task, {
    enhance: shouldPrintClarityEnhance(previousCheck),
    strength: Math.max(getEnhanceStrength(), 0.3),
    skipAiRepair: true,
    repair: false,
  }));
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  const check = await runSeamCheck(task, true);
  task.repairCheck = check;
  task.locallyRepaired = check.passed;
  task.qualityPassed = check.passed;
  task.nodes.select.disabled = !check.passed;
  task.nodes.select.checked = check.passed;
  toggleTaskSelection(task);
  updateTaskDownloadGate(task);
  return check;
}

async function improveWithAiInternalGuideRepair(task, initialCheck) {
  let best = {
    dataUrl: task.resultDataUrl,
    jpgUrl: task.resultJpgUrl,
    check: initialCheck,
  };
  let currentCheck = initialCheck;

  while (task.aiRepairAttempts < maxAiSeamRepairs && shouldAiInternalGuideRepair(currentCheck)) {
    const before = {
      dataUrl: task.resultDataUrl,
      jpgUrl: task.resultJpgUrl,
      check: currentCheck,
    };
    const repairedCheck = await aiInternalGuideRepairTask(task, currentCheck);
    if (!repairedCheck) break;

    if (isSeamCheckBetter(repairedCheck, best.check)) {
      best = {
        dataUrl: task.resultDataUrl,
        jpgUrl: task.resultJpgUrl,
        check: repairedCheck,
      };
    } else {
      task.resultDataUrl = before.dataUrl;
      task.resultJpgUrl = before.jpgUrl;
      task.seamCheck = before.check;
      task.repairCheck = before.check;
      task.seamScore = before.check.score;
      task.seamRating = before.check.rating;
      task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
      break;
    }

    currentCheck = repairedCheck;
    if (currentCheck.passed || !shouldRefineAiSeamRepair(currentCheck, before.check)) break;
  }

  task.resultDataUrl = best.dataUrl;
  task.resultJpgUrl = best.jpgUrl;
  task.seamCheck = best.check;
  task.repairCheck = best.check;
  task.seamScore = best.check.score;
  task.seamRating = best.check.rating;
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  task.nodes.message.textContent = seamCheckSummary(best.check);
  return best.check;
}

async function improveWithAiOffsetRepair(task, initialCheck) {
  let best = {
    dataUrl: task.resultDataUrl,
    jpgUrl: task.resultJpgUrl,
    check: initialCheck,
  };
  let currentCheck = initialCheck;

  while (task.aiRepairAttempts < maxAiSeamRepairs && shouldAiOffsetRepair(currentCheck)) {
    const before = {
      dataUrl: task.resultDataUrl,
      jpgUrl: task.resultJpgUrl,
      check: currentCheck,
    };
    const repairedCheck = await aiOffsetRepairTask(task, currentCheck);
    if (!repairedCheck) break;

    if (isSeamCheckBetter(repairedCheck, best.check)) {
      best = {
        dataUrl: task.resultDataUrl,
        jpgUrl: task.resultJpgUrl,
        check: repairedCheck,
      };
    } else {
      task.resultDataUrl = before.dataUrl;
      task.resultJpgUrl = before.jpgUrl;
      task.seamCheck = before.check;
      task.repairCheck = before.check;
      task.seamScore = before.check.score;
      task.seamRating = before.check.rating;
      task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
      break;
    }

    currentCheck = repairedCheck;
    if (currentCheck.passed || !shouldRefineAiSeamRepair(currentCheck, before.check)) break;
  }

  task.resultDataUrl = best.dataUrl;
  task.resultJpgUrl = best.jpgUrl;
  task.seamCheck = best.check;
  task.repairCheck = best.check;
  task.seamScore = best.check.score;
  task.seamRating = best.check.rating;
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  task.nodes.message.textContent = seamCheckSummary(best.check);
  return best.check;
}

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function captureTaskCandidate(task, check) {
  return {
    resultDataUrl: task.resultDataUrl,
    resultJpgUrl: task.resultJpgUrl,
    seamCheck: clonePlain(task.seamCheck || check),
    repairCheck: clonePlain(task.repairCheck),
    exportMetrics: clonePlain(task.exportMetrics),
    seamScore: task.seamScore,
    seamRating: task.seamRating,
    locallyRepaired: task.locallyRepaired,
    qualityPassed: task.qualityPassed,
    check: clonePlain(check),
  };
}

function captureExternalTaskCandidate(task, resultJpgUrl, check, overrides = null) {
  const options = overrides || {};
  return {
    resultDataUrl: resultJpgUrl,
    resultJpgUrl,
    seamCheck: clonePlain(check),
    repairCheck: clonePlain(check),
    exportMetrics: clonePlain(task?.exportMetrics),
    seamScore: check?.score ?? null,
    seamRating: check?.rating || "",
    locallyRepaired: Boolean(options.locallyRepaired),
    qualityPassed: Boolean(options.qualityPassed),
    check: clonePlain(check),
  };
}

function rememberBestTaskCandidate(task, check, currentBest = null) {
  if (!task?.resultJpgUrl || !check) return currentBest;
  const candidate = captureTaskCandidate(task, check);
  return !currentBest || isSeamCheckBetter(candidate.check, currentBest.check) ? candidate : currentBest;
}

function restoreTaskCandidate(task, candidate) {
  if (!candidate?.resultJpgUrl) return;
  task.resultDataUrl = candidate.resultDataUrl || "";
  task.resultJpgUrl = candidate.resultJpgUrl;
  task.seamCheck = candidate.seamCheck || candidate.check;
  task.repairCheck = candidate.repairCheck || candidate.check;
  task.exportMetrics = candidate.exportMetrics || null;
  task.seamScore = candidate.check?.score ?? candidate.seamScore ?? null;
  task.seamRating = candidate.check?.rating || candidate.seamRating || seamRating(candidate.check);
  task.locallyRepaired = Boolean(candidate.locallyRepaired);
  task.qualityPassed = Boolean(candidate.check?.passed);
  task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
  task.nodes.message.textContent = seamCheckSummary(candidate.check);
}

function isSeamCheckBetter(next, previous) {
  if (!next) return false;
  if (!previous) return true;
  if (next.passed && !previous.passed) return true;
  if (!next.passed && previous.passed) return false;
  const nextWorst = seamVisualWorstScore(next);
  const previousWorst = seamVisualWorstScore(previous);
  const scoreGain = previous.score - next.score;
  const worstGain = previousWorst - nextWorst;
  return scoreGain > Math.max(0.7, previous.score * 0.08) || worstGain > Math.max(1.2, previousWorst * 0.08);
}

function shouldRefineAiSeamRepair(next, previous) {
  if (!next || next.passed || !previous) return false;
  const visualWorst = seamVisualWorstScore(next);
  const previousWorst = seamVisualWorstScore(previous);
  return (
    taskRepairableVisualIssue(next) &&
    next.score <= previous.score * 0.92 &&
    visualWorst <= Math.max(24, previousWorst * 0.94)
  );
}

function taskRepairableVisualIssue(check) {
  return Boolean(check?.issues?.some((issue) => (
    issue.includes("局部花型叠加") ||
    issue.includes("内部接缝线") ||
    issue.includes("平铺边带") ||
    issue.includes("平铺预览") ||
    issue.includes("细线接缝") ||
    issue.includes("轻微色差") ||
    issue.includes("接缝过渡") ||
    issue.includes("镜像轴痕") ||
    issue.includes("边缘错位漂移") ||
    issue.includes("四角平铺交汇")
  )));
}

function seamVisualWorstScore(check) {
  return Math.max(
    check?.horizontalScore || 0,
    check?.verticalScore || 0,
    check?.cornerScore || 0,
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
}

function buildOffsetRepairPrompt(previousCheck = null) {
  const issueText = previousCheck?.issues?.length ? previousCheck.issues.join("、") : "中心十字接缝风险";
  return `这张图是一个四方连续印花单元经过 Offset 偏移后的中间修缝图：原本的上下/左右边缘接缝已经被移动到画面中心，形成可能可见的水平和垂直十字接缝。

请重点重绘画面中心十字接缝附近的过渡区域；如果蒙版还开放了 1/4、1/3、2/3、3/4 附近的细长内部导线带和导线交叉点，也要一并自然重绘。若上一轮有局部花型叠加，请把堆叠处改成自然穿插、合理留白和连续枝叶纹理，让 AI 生成丝滑衔接，而不是硬拼、镜像、糊边、网格线、贴片遮盖或简单平均颜色。上一轮检测问题：${issueText}。

必须严格执行：
1. 已提供蒙版：透明和半透明区域是允许重绘的中心十字接缝带，蒙版外侧应尽量保持原图稳定。
2. 允许在中心水平线、中心垂直线、蒙版开放的内部导线带以及导线交叉点附近做自然变化、补画、重绘和过渡生成；小幅元素变化可以接受，目标是无缝和自然。
3. 保持外侧四边 10% 区域尽量稳定，因为这些外侧边界已经是连续边界，不能新增白边、黑边、画框或边缘拼接线。
4. 中心十字修复后，纹理、笔触、花枝、叶片、抽象纹路、明暗层次必须自然穿过中心线；要像原本就连续绘制，而不是后期拼接。
5. 如果中心线附近有元素断头或局部花型叠加，可以补出合理的枝叶、花瓣、纹理走向、留白关系或背景过渡；如果有明暗突变，可以生成自然渐变和局部纹理变化。
6. 不要输出 2×2、3×3 或多块平铺预览，只输出单张完整图。
7. 保持原图风格、配色、密度、元素气质和面料高级感，不要新增明显无关题材，不要把整张图改成另一种风格。
8. 接缝处不能形成一条更亮、更暗、更糊、更平的边带；必须补出与周围一致的织物纹理、线条噪声、花枝走向和笔触颗粒。
9. 最终目标是把这张图再 Offset 移回后，上下左右能形成真正无缝循环。`;
}

function buildInternalGuideRepairPrompt(previousCheck = null) {
  const issueText = previousCheck?.issues?.length ? previousCheck.issues.join("、") : "内部导线或平铺交汇风险";
  return `这是一张四方连续印花单元，外侧上下左右边缘已经基本闭合，但画面内部仍可能残留平铺预览导线、网格硬线、交叉点硬斑或重复拼接痕迹。

请只重绘蒙版开放的内部导线带和导线交叉点，不要移动、重画或破坏外侧边缘。上一轮检测问题：${issueText}。

必须严格执行：
1. 已提供蒙版：透明和半透明区域是允许重绘的内部导线带和导线交叉点；蒙版外侧必须尽量保持原图稳定。
2. 重点把 1/4、1/3、1/2、2/3、3/4 附近的可见内部线、硬交叉点、十字痕迹、重复网格痕自然重绘成连续花枝、叶片、线条、背景纹理和织物颗粒。
3. 外侧四边 12% 区域必须保持稳定，因为这些边缘已经用于四方连续闭合；不能新增白边、黑边、画框、阴影硬边或边缘拼接线。
4. 小幅元素变化可以接受，但只能服务于消除内部导线和交叉点；不要把整张图改风格、改题材或大面积重构。
5. 保持原图的配色、密度、复古植物纹样、笔触颗粒和面料高级感。
6. 不要输出 2×2、3×3 或多块平铺预览，只输出单张完整图。
7. 修复后的图仍必须作为单个四方连续印花单元使用，内部不应再出现平铺网格线。`;
}

function shouldHybridSeamRepair(check) {
  if (!check || check.passed) return false;
  const structuralIssue = check.issues?.some((issue) => (
    issue.includes("横档未衔接") ||
    issue.includes("竖档未衔接") ||
    issue.includes("接缝过渡不自然") ||
    issue.includes("接缝细节发虚") ||
    issue.includes("镜像轴痕") ||
    issue.includes("细线接缝") ||
    issue.includes("轻微色差")
  ));
  const tooSevere = (
    check.issues?.some((issue) => issue.includes("花型元素叠加") || issue.includes("回头没接")) ||
    check.score > 42 ||
    check.horizontalScore > 60 ||
    check.verticalScore > 60 ||
    Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0) > 170
  );
  return Boolean(structuralIssue && !tooSevere);
}

function canRunAiOffsetRepair(task, check) {
  return Boolean(
    task &&
    (task.aiRepairAttempts || 0) < maxAiSeamRepairs &&
    shouldAiOffsetRepair(check)
  );
}

function canRunAiInternalGuideRepair(task, check) {
  return Boolean(
    task &&
    (task.aiRepairAttempts || 0) < maxAiSeamRepairs &&
    shouldAiInternalGuideRepair(check)
  );
}

function shouldOfferTaskRepair(task, check) {
  return Boolean(
    check &&
    !check.passed &&
    (
      canRunAiInternalGuideRepair(task, check) ||
      canRunAiOffsetRepair(task, check) ||
      shouldEdgeBlendRepair(check) ||
      shouldForcePeriodicRepair(check)
    )
  );
}

function shouldEdgeBlendRepair(check) {
  if (!check || check.passed) return false;
  if (check.issues?.some((issue) => issue.includes("花型信息量不足") || issue.includes("花型分布过于集中") || issue.includes("平铺预览输出") || issue.includes("画框留白"))) return false;
  if (check.issues?.some((issue) => issue.includes("镜像轴痕"))) return false;
  if (check.issues?.some((issue) => issue.includes("花型元素叠加") || issue.includes("局部花型叠加") || issue.includes("回头没接"))) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const cornerJunctionWorst = check.tiledCorner?.worstScore || 0;
  const cornerJunctionRisk = check.tiledCorner?.junctionRisk || check.issues?.some((issue) => issue.includes("四角平铺交汇"));
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const driftRisk = check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk || check.issues?.some((issue) => issue.includes("边缘错位漂移"));
  if (driftRisk && driftWorst > 10) return false;
  if (cornerJunctionRisk && cornerJunctionWorst > 10) return false;
  return (
    check.score <= 36 &&
    edgeDominant <= 48 &&
    borderWorst <= 145 &&
    bandWorst <= 95 &&
    detailWorst <= 95 &&
    (check.issues?.some((issue) => (
      issue.includes("横档") ||
      issue.includes("竖档") ||
      issue.includes("内部接缝线") ||
      issue.includes("接缝过渡") ||
      issue.includes("接缝细节发虚") ||
      issue.includes("细线接缝") ||
      issue.includes("轻微色差") ||
      issue.includes("平铺边带") ||
      issue.includes("平铺预览") ||
      issue.includes("四角平铺交汇")
    )) || check.repairability === "repairable")
  );
}

function shouldAiOffsetRepair(check) {
  if (!check || check.passed) return false;
  if (check.issues?.some((issue) => issue.includes("花型信息量不足") || issue.includes("花型分布过于集中") || issue.includes("平铺预览输出") || issue.includes("画框留白"))) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerJunctionWorst = check.tiledCorner?.worstScore || 0;
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const mirrorWorst = Math.max(check.mirrorHorizontal?.worstScore || 0, check.mirrorVertical?.worstScore || 0);
  return (
    check.score <= 420 &&
    edgeDominant <= 420 &&
    borderWorst <= 980 &&
    localWorst <= 280 &&
    internalWorst <= 240 &&
    bandWorst <= 320 &&
    detailWorst <= 320 &&
    tiledWorst <= 320 &&
    cornerJunctionWorst <= 320 &&
    driftWorst <= 360 &&
    mirrorWorst <= 360
  );
}

function shouldAiInternalGuideRepair(check) {
  if (!check || check.passed) return false;
  const issueText = [
    check.finalIssueType,
    ...(Array.isArray(check.issues) ? check.issues : []),
  ].filter(Boolean).join(" ");
  if (!/内部接缝线|四角平铺交汇|平铺预览中心线|平铺边带/.test(issueText)) return false;
  if (/横档未衔接|竖档未衔接|回头没接|最终JPG边缘硬线|边缘错位漂移|花型元素叠加|局部花型叠加|镜像轴痕/.test(issueText)) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalScore = Math.max(check.internalHorizontal?.score || 0, check.internalVertical?.score || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerWorst = Math.max(check.cornerScore || 0, check.tiledCorner?.worstScore || 0);
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const borderObjectRisk = Boolean(check.borderHorizontal?.objectRisk || check.borderVertical?.objectRisk);
  const driftRisk = Boolean(check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk);
  const internalRisk = Boolean(check.internalHorizontal?.lineRisk || check.internalVertical?.lineRisk || internalWorst > 16 || internalScore > 9);
  const cornerGuideRisk = Boolean(check.tiledCorner?.junctionRisk || cornerWorst > 14 || tiledWorst > 15);
  return (
    (internalRisk || cornerGuideRisk) &&
    edgeDominant <= 8 &&
    borderWorst <= 48 &&
    driftWorst <= 8 &&
    !borderObjectRisk &&
    !driftRisk
  );
}

function shouldForcePeriodicRepair(check) {
  if (!check || check.passed) return false;
  if (check.issues?.some((issue) => issue.includes("花型信息量不足") || issue.includes("花型分布过于集中") || issue.includes("平铺预览输出") || issue.includes("画框留白"))) return false;
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerJunctionWorst = check.tiledCorner?.worstScore || 0;
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const mirrorWorst = Math.max(check.mirrorHorizontal?.worstScore || 0, check.mirrorVertical?.worstScore || 0);
  if (check.tiledCorner?.junctionRisk) return false;
  if (check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk) return false;
  if (check.mirrorHorizontal?.mirrorRisk || check.mirrorVertical?.mirrorRisk) return false;
  return (
    check.score <= 140 &&
    edgeDominant <= 180 &&
    borderWorst <= 520 &&
    internalWorst <= 90 &&
    bandWorst <= 140 &&
    detailWorst <= 140 &&
    tiledWorst <= 140 &&
    cornerJunctionWorst <= 90 &&
    driftWorst <= 90 &&
    mirrorWorst <= 90
  );
}

function shouldTryCertifiedSeamlessFallback(check) {
  if (!check || check.passed) return false;
  const issueText = [
    check.finalIssueType,
    ...(Array.isArray(check.issues) ? check.issues : []),
  ].filter(Boolean).join(" ");
  if (!issueText) return false;

  if (/花型信息量不足|花型分布过于集中|疑似平铺预览输出|画框留白|输出比例拉伸|成品规格|低清放大|成品清晰度不足|印花细节密度不足|色阶断层|压缩块噪点|锐化光晕|花型元素叠加/.test(issueText)) {
    return false;
  }
  if (!/横档|竖档|回头没接|最终JPG边缘硬线|四角平铺交汇|边缘错位漂移|接缝过渡|内部接缝线|平铺预览中心线|平铺边带|接缝细节发虚|细线接缝|轻微色差/.test(issueText)) {
    return false;
  }

  const score = Number(check.score || 0);
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerWorst = Math.max(check.cornerScore || 0, check.tiledCorner?.worstScore || 0);
  return (
    score <= 620 &&
    edgeDominant <= 620 &&
    borderWorst <= 1600 &&
    localWorst <= 680 &&
    internalWorst <= 520 &&
    tiledWorst <= 720 &&
    cornerWorst <= 720
  );
}

function shouldPrintClarityEnhance(check) {
  return Boolean(check?.issues?.some((issue) => issue.includes("清晰度不足") || issue.includes("细节密度不足") || issue.includes("放大痕迹") || issue.includes("色阶断层")));
}

function shouldToneDither(check) {
  return Boolean(check?.issues?.some((issue) => issue.includes("色阶断层")));
}

async function runSeamCheck(task, quiet = false) {
  if (!task.resultJpgUrl) {
    if (!quiet) showToast("请先生成图片");
    return;
  }

  const check = applyAspectWarpCheck(await checkSeamQuality(task.resultJpgUrl), task.exportMetrics?.aspectWarp);
  task.seamCheck = check;
  task.seamScore = check.score;
  task.seamRating = check.rating;
  task.nodes.message.textContent = seamCheckSummary(check);
  if (!quiet) showToast(`四方循环检查：${check.rating}`);
  return check;
}

function seamRating(checkOrScore) {
  const check = typeof checkOrScore === "number" ? { score: checkOrScore, passed: checkOrScore <= 3.5, issues: [] } : checkOrScore;
  if (check.passed && check.score <= 2.2) return "可通过";
  if (check.passed) return "轻微风险但可通过";
  if (check.repairability === "enhanceable") return check.finalIssueType || "可增强";
  if (check.repairability === "repairable") return check.finalIssueType || "可轻修";
  if (check.finalIssueType) return check.finalIssueType;
  if (check.issues?.includes("横档未衔接，不可修复")) return "横档未衔接，不可修复";
  if (check.issues?.includes("竖档未衔接，不可修复")) return "竖档未衔接，不可修复";
  if (check.issues?.includes("回头没接，不可修复")) return "回头没接，不可修复";
  return "有接缝风险";
}

function checkSeamScore(dataUrl) {
  return checkSeamQuality(dataUrl).then((check) => check.score);
}

function checkSeamQuality(dataUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const maxSide = 1200;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const check = measureSeamQuality(ctx, canvas.width, canvas.height);
        applyFullSizeEdgeCheck(check, measureFullSizeEdgeArtifact(image));
        const printSpec = measurePrintSpec(dataUrl, image.width, image.height);
        if (options.skipPrintSpec === true) {
          check.printSpec = printSpec;
          check.rating = seamRating(check);
        } else {
          applyPrintSpecCheck(check, printSpec);
        }
        resolve(check);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function seamCheckSummary(check) {
  const details = [
    `总分 ${check.score.toFixed(2)}`,
    `上下 ${check.horizontalScore.toFixed(2)}`,
    `左右 ${check.verticalScore.toFixed(2)}`,
    `角点 ${check.cornerScore.toFixed(2)}`,
    `边带 ${Math.max(check.bandHorizontal?.score || 0, check.bandVertical?.score || 0).toFixed(2)}`,
    `细节 ${Math.max(check.detailHorizontal?.score || 0, check.detailVertical?.score || 0).toFixed(2)}`,
    `平铺 ${Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0).toFixed(2)}`,
    `交汇 ${Number(check.tiledCorner?.score || 0).toFixed(2)}`,
    `错位 ${Math.max(check.driftHorizontal?.score || 0, check.driftVertical?.score || 0).toFixed(2)}`,
    `原边 ${Number(check.fullSizeEdge?.score || 0).toFixed(2)}`,
    `边框 ${Number(check.outerFrame?.score || 0).toFixed(2)}`,
    `清晰 ${Number(check.clarity?.detailScore || 0).toFixed(2)}`,
    `放大 ${Number(check.upscaleArtifact?.artifactScore || 0).toFixed(2)}`,
    `色阶 ${Number(check.posterization?.posterizationScore || 0).toFixed(2)}`,
    `压缩 ${Number(check.compressionArtifact?.blockScore || 0).toFixed(2)}`,
    `光晕 ${Number(check.sharpenHalo?.haloScore || 0).toFixed(2)}`,
    `信息 ${(Number(check.richness?.activeRatio || 0) * 100).toFixed(0)}%`,
    `密度 ${(Number(check.textureDensity?.fineDetailRatio || 0) * 100).toFixed(0)}%`,
    `均衡 ${Number(check.layoutBalance?.balanceScore || 0).toFixed(2)}`,
    `镜像 ${Math.max(check.mirrorHorizontal?.score || 0, check.mirrorVertical?.score || 0).toFixed(2)}`,
    `预平铺 ${Number(check.preTiledPreview?.score || 0).toFixed(2)}`,
    `比例 ${Number(check.aspectWarp?.warpRatio || 1).toFixed(2)}x`,
    check.printSpec?.passed === true ? "规格通过" : "规格失败",
    check.repairability === "enhanceable" ? "可增强" : check.repairability === "repairable" ? "可轻修" : check.repairability === "unrepairable" ? "需重生/复核" : "通过",
  ].join(" · ");
  return check.passed
    ? `四方循环检查：${check.rating}，${details}。`
    : `四方循环检查：${check.rating}，${details}。${seamFailureMessage(check)}。`;
}

function seamFailureMessage(check) {
  if (!check) return "四方循环检查未通过";
  if (check.finalIssueType) return check.finalIssueType;
  if (check.issues?.includes("横档未衔接，不可修复")) return "横档未衔接，不可修复";
  if (check.issues?.includes("竖档未衔接，不可修复")) return "竖档未衔接，不可修复";
  if (check.issues?.includes("回头没接，不可修复")) return "回头没接，不可修复";
  if (check.issues?.includes("输出比例拉伸过大，不可修复")) return "输出比例拉伸过大，不可修复";
  if (check.issues?.includes("最终JPG边缘硬线，不可修复")) return "最终JPG边缘硬线，不可修复";
  if (check.issues?.includes("花型信息量不足，不可修复")) return "花型信息量不足，不可修复";
  if (check.issues?.includes("花型分布过于集中，不可修复")) return "花型分布过于集中，不可修复";
  if (check.issues?.includes("疑似平铺预览输出，不可修复")) return "疑似平铺预览输出，不可修复";
  if (check.issues?.includes("画框留白边界，不可修复")) return "画框留白边界，不可修复";
  if (check.issues?.includes("镜像轴痕明显，可修复")) return "镜像轴痕明显，可修复";
  if (check.issues?.includes("低清放大痕迹，可增强")) return "低清放大痕迹，可增强";
  if (check.issues?.includes("色阶断层，可增强")) return "色阶断层，可增强";
  if (check.issues?.includes("压缩块噪点，不可修复")) return "压缩块噪点，不可修复";
  if (check.issues?.includes("锐化光晕明显，不可修复")) return "锐化光晕明显，不可修复";
  if (check.issues?.includes("印花细节密度不足，可增强")) return "印花细节密度不足，可增强";
  if (check.issues?.includes("接缝细节发虚，可修复")) return "接缝细节发虚，可修复";
  if (check.issues?.includes("成品规格不正确，不可下载")) return "成品规格不正确，不可下载";
  return "检测到接缝风险";
}

function makeTaskJpgOptions(task, options = {}) {
  task.exportMetrics = {};
  return {
    ...options,
    exportMetrics: task.exportMetrics,
  };
}

function makeJpg(dataUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 4961;
        canvas.height = 7559;
        const ctx = canvas.getContext("2d");

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const aspectWarp = measureAspectWarp(image.width, image.height, canvas.width, canvas.height);
        if (options.exportMetrics) {
          options.exportMetrics.aspectWarp = aspectWarp;
        }
        drawTileToTarget(ctx, image, canvas.width, canvas.height, aspectWarp);
        if (options.repair !== false) {
          repairSeams(ctx, canvas.width, canvas.height, options.repairOptions || {});
        }
        const clarityStrength = printClarityStrength(image, canvas.width, canvas.height, options);
        if (clarityStrength > 0) {
          enhanceClarity(ctx, canvas.width, canvas.height, clarityStrength);
        }
        if (options.toneDither) {
          addPrintToneDither(ctx, canvas.width, canvas.height, 1.7);
        }
        if (options.repair !== false) {
          const precheck = measureSeamQuality(ctx, canvas.width, canvas.height);
          if (shouldForcePeriodicRepair(precheck)) {
            forcePeriodicSeams(ctx, canvas.width, canvas.height, precheck);
            const secondCheck = measureSeamQuality(ctx, canvas.width, canvas.height);
            if (!secondCheck.passed && shouldForcePeriodicRepair(secondCheck)) {
              forcePeriodicSeams(ctx, canvas.width, canvas.height, secondCheck);
            }
          }
        }
        const jpg = canvas.toDataURL("image/jpeg", 0.99);
        if (!jpg || jpg === "data:,") {
          throw new Error("浏览器无法导出目标尺寸 JPG，请尝试使用 Chrome 或降低批量数量后重试。");
        }
        resolve(withJpegDpi(jpg, 300));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeOffsetRepairJpg(dataUrl, check) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        offsetRepairSeams(ctx, canvas.width, canvas.height, check);
        enhanceClarity(ctx, canvas.width, canvas.height, 0.12);
        const jpg = canvas.toDataURL("image/jpeg", 0.99);
        if (!jpg || jpg === "data:,") throw new Error("浏览器无法导出 Offset 修复 JPG。");
        resolve(withJpegDpi(jpg, 300));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeEdgeBlendRepairJpg(dataUrl, check) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        repairSeams(ctx, canvas.width, canvas.height, {
          check,
          bandRatio: 0.019,
          minBand: 12,
          maxBand: 72,
          strength: 0.58,
          maxDiff: 126,
          textureMix: 0.74,
        });
        const internalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        smoothInternalGuideLines(internalImageData.data, canvas.width, canvas.height, check);
        refineSeamForTiledPreview(internalImageData.data, canvas.width, canvas.height, check);
        ctx.putImageData(internalImageData, 0, 0);
        enhanceClarity(ctx, canvas.width, canvas.height, 0.12);
        const jpg = canvas.toDataURL("image/jpeg", 0.99);
        if (!jpg || jpg === "data:,") throw new Error("浏览器无法导出边缘融合 JPG。");
        resolve(withJpegDpi(jpg, 300));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeStrictSeamlessJpg(dataUrl, check) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        forcePeriodicSeams(ctx, canvas.width, canvas.height, check);
        const secondCheck = measureSeamQuality(ctx, canvas.width, canvas.height);
        if (!secondCheck.passed && shouldForcePeriodicRepair(secondCheck)) {
          forcePeriodicSeams(ctx, canvas.width, canvas.height, secondCheck);
        }
        enhanceClarity(ctx, canvas.width, canvas.height, 0.14);
        const jpg = canvas.toDataURL("image/jpeg", 0.99);
        if (!jpg || jpg === "data:,") throw new Error("浏览器无法导出强制四方连续 JPG。");
        resolve(withJpegDpi(jpg, 300));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeOffsetDataUrl(dataUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        drawOffsetImage(ctx, image, canvas.width, canvas.height, options);
        if (options.format === "png") {
          const png = canvas.toDataURL("image/png");
          if (!png || png === "data:,") throw new Error("浏览器无法导出 Offset PNG。");
          resolve(png);
          return;
        }
        const jpg = canvas.toDataURL("image/jpeg", 0.99);
        if (!jpg || jpg === "data:,") throw new Error("浏览器无法导出 Offset 图片。");
        resolve(withJpegDpi(jpg, 300));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeOffsetRepairMaskDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        drawOffsetRepairMask(ctx, canvas.width, canvas.height);
        const png = canvas.toDataURL("image/png");
        if (!png || png === "data:,") throw new Error("浏览器无法导出接缝蒙版。");
        resolve(png);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function makeInternalGuideRepairMaskDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        drawInternalGuideRepairMask(ctx, canvas.width, canvas.height);
        const png = canvas.toDataURL("image/png");
        if (!png || png === "data:,") throw new Error("浏览器无法导出内部导线蒙版。");
        resolve(png);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function blendMaskedRepairDataUrl(sourceDataUrl, repairedDataUrl, maskDataUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const sourceImage = new Image();
    const repairedImage = new Image();
    const maskImage = new Image();
    let loaded = 0;
    const onLoad = () => {
      loaded += 1;
      if (loaded < 3) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = sourceImage.width;
        canvas.height = sourceImage.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
        const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(repairedImage, 0, 0, canvas.width, canvas.height);
        const repaired = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
        const mask = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const strength = options.strength ?? 1;

        for (let index = 0; index < source.data.length; index += 4) {
          const edit = Math.min(1, Math.max(0, (1 - mask.data[index + 3] / 255) * strength));
          if (edit <= 0) continue;
          for (let channel = 0; channel < 3; channel += 1) {
            source.data[index + channel] = Math.round(source.data[index + channel] * (1 - edit) + repaired.data[index + channel] * edit);
          }
        }

        ctx.putImageData(source, 0, 0);
        const png = canvas.toDataURL("image/png");
        if (!png || png === "data:,") throw new Error("浏览器无法导出蒙版合成图。");
        resolve(png);
      } catch (error) {
        reject(error);
      }
    };
    const onError = () => reject(new Error("蒙版合成图加载失败。"));
    sourceImage.onload = onLoad;
    repairedImage.onload = onLoad;
    maskImage.onload = onLoad;
    sourceImage.onerror = onError;
    repairedImage.onerror = onError;
    maskImage.onerror = onError;
    sourceImage.src = sourceDataUrl;
    repairedImage.src = repairedDataUrl;
    maskImage.src = maskDataUrl;
  });
}

function drawOffsetRepairMask(ctx, width, height) {
  const imageData = ctx.createImageData(width, height);
  const { data } = imageData;
  const centerX = width / 2;
  const centerY = height / 2;
  const coreX = width * 0.052;
  const coreY = height * 0.052;
  const featherX = width * 0.22;
  const featherY = height * 0.22;

  for (let y = 0; y < height; y += 1) {
    const dy = Math.abs(y - centerY);
    const horizontalEdit = seamEditStrength(dy, coreY, featherY);
    const horizontalGuideEdit = internalGuideLineEditStrength(y, height);
    for (let x = 0; x < width; x += 1) {
      const dx = Math.abs(x - centerX);
      const verticalEdit = seamEditStrength(dx, coreX, featherX);
      const verticalGuideEdit = internalGuideLineEditStrength(x, width);
      const guideJunctionEdit = internalGuideJunctionEditStrength(x, y, width, height);
      const edit = Math.max(horizontalEdit, verticalEdit, horizontalGuideEdit, verticalGuideEdit, guideJunctionEdit);
      const alpha = Math.round(255 * (1 - edit));
      const index = (y * width + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function drawInternalGuideRepairMask(ctx, width, height) {
  const imageData = ctx.createImageData(width, height);
  const { data } = imageData;
  const protectedEdgeX = width * 0.12;
  const protectedEdgeY = height * 0.12;

  for (let y = 0; y < height; y += 1) {
    const protectY = y < protectedEdgeY || y > height - protectedEdgeY;
    const horizontalGuideEdit = protectY ? 0 : internalGuideLineEditStrength(y, height);
    for (let x = 0; x < width; x += 1) {
      const protectX = x < protectedEdgeX || x > width - protectedEdgeX;
      const verticalGuideEdit = protectX ? 0 : internalGuideLineEditStrength(x, width);
      const guideJunctionEdit = (protectX || protectY) ? 0 : internalGuideJunctionEditStrength(x, y, width, height);
      const edit = Math.max(horizontalGuideEdit, verticalGuideEdit, guideJunctionEdit);
      const alpha = Math.round(255 * (1 - edit));
      const index = (y * width + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function internalGuideLineEditStrength(position, size) {
  const guideRatios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const core = Math.max(2, size * 0.006);
  const feather = Math.max(core + 1, size * 0.055);
  let strength = 0;

  for (const ratio of guideRatios) {
    const distance = Math.abs(position - size * ratio);
    strength = Math.max(strength, seamEditStrength(distance, core, feather));
  }

  return strength * 0.72;
}

function internalGuideJunctionEditStrength(x, y, width, height) {
  const guideRatios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const size = Math.min(width, height);
  const core = Math.max(8, size * 0.018);
  const feather = Math.max(core + 1, size * 0.085);
  let strength = 0;

  for (const ratioY of guideRatios) {
    const centerY = height * ratioY;
    for (const ratioX of guideRatios) {
      const centerX = width * ratioX;
      const distance = Math.hypot((x - centerX) * (size / width), (y - centerY) * (size / height));
      strength = Math.max(strength, seamEditStrength(distance, core, feather));
    }
  }

  return strength * 0.92;
}

function seamEditStrength(distance, core, feather) {
  if (distance <= core) return 1;
  if (distance >= feather) return 0;
  const t = (distance - core) / Math.max(1, feather - core);
  return Math.pow(1 - t, 1.7);
}

function drawOffsetImage(ctx, image, width, height, options = {}) {
  const dx = options.reverse ? width - Math.floor(width / 2) : Math.floor(width / 2);
  const dy = options.reverse ? height - Math.floor(height / 2) : Math.floor(height / 2);
  const startsX = [-dx, width - dx];
  const startsY = [-dy, height - dy];

  ctx.clearRect(0, 0, width, height);
  for (const x of startsX) {
    for (const y of startsY) {
      ctx.drawImage(image, x, y, width, height);
    }
  }
}

function offsetRepairSeams(ctx, width, height, check) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const source = new Uint8ClampedArray(data);
  const band = Math.max(10, Math.min(72, Math.round(Math.min(width, height) * 0.018)));
  const repairHorizontal = check.horizontalScore >= check.verticalScore * 0.65 || check.issues?.some((issue) => issue.includes("横档"));
  const repairVertical = check.verticalScore >= check.horizontalScore * 0.65 || check.issues?.some((issue) => issue.includes("竖档"));

  if (repairHorizontal) {
    repairCenterLine(data, source, width, height, "horizontal", band);
  }

  if (repairVertical) {
    repairCenterLine(data, new Uint8ClampedArray(data), width, height, "vertical", band);
  }

  ctx.putImageData(imageData, 0, 0);
}

function repairCenterLine(data, source, width, height, direction, band) {
  const horizontal = direction === "horizontal";
  const center = horizontal ? Math.floor(height / 2) : Math.floor(width / 2);
  const cross = horizontal ? height : width;
  const length = horizontal ? width : height;

  for (let delta = -band; delta <= band; delta += 1) {
    const position = center + delta;
    if (position <= 0 || position >= cross - 1) continue;
    const t = Math.abs(delta) / Math.max(1, band);
    const repairWeight = Math.pow(1 - t, 2) * 0.86;
    const featherWeight = Math.pow(1 - t, 1.35) * 0.42;

    for (let along = 0; along < length; along += 1) {
      const x = horizontal ? along : position;
      const y = horizontal ? position : along;
      const oppositeA = wrapIndex(position - Math.sign(delta || -1) * (band + 2), cross);
      const oppositeB = wrapIndex(position + Math.sign(delta || 1) * (band + 2), cross);
      const ax = horizontal ? along : oppositeA;
      const ay = horizontal ? oppositeA : along;
      const bx = horizontal ? along : oppositeB;
      const by = horizontal ? oppositeB : along;
      const index = (y * width + x) * 4;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      const localDiff = (
        Math.abs(source[a] - source[b]) +
        Math.abs(source[a + 1] - source[b + 1]) +
        Math.abs(source[a + 2] - source[b + 2])
      ) / 3;
      const weight = localDiff > 52 ? featherWeight : repairWeight;

      for (let channel = 0; channel < 3; channel += 1) {
        const target = (source[a + channel] + source[b + channel]) / 2;
        data[index + channel] = Math.round(data[index + channel] * (1 - weight) + target * weight);
      }
    }
  }
}

function wrapIndex(value, size) {
  return ((value % size) + size) % size;
}

function blendColorOnly(data, a, b, weight) {
  const diff = (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3;
  if (diff > 22) return;

  for (let channel = 0; channel < 3; channel += 1) {
    const ai = a + channel;
    const bi = b + channel;
    const average = (data[ai] + data[bi]) / 2;
    data[ai] = Math.round(data[ai] * (1 - weight) + average * weight);
    data[bi] = Math.round(data[bi] * (1 - weight) + average * weight);
  }
}

function enhanceClarity(ctx, width, height, amount) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const source = new Uint8ClampedArray(imageData.data);
  const data = imageData.data;
  const clarity = amount * 0.16;

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = (row + x) * 4;
      const left = index - 4;
      const right = index + 4;
      const top = index - width * 4;
      const bottom = index + width * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const i = index + channel;
        const neighborAverage = (source[left + channel] + source[right + channel] + source[top + channel] + source[bottom + channel]) / 4;
        const sharpened = source[i] + (source[i] - neighborAverage) * amount;
        data[i] = Math.max(0, Math.min(255, (sharpened - 128) * (1 + clarity) + 128));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function addPrintToneDither(ctx, width, height, amount = 1.5) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = (row + x) * 4;
      const localNoise = toneDitherNoise(x, y) * amount;
      data[index] = clamp(data[index] + localNoise);
      data[index + 1] = clamp(data[index + 1] + toneDitherNoise(x + 17, y + 3) * amount * 0.84);
      data[index + 2] = clamp(data[index + 2] + toneDitherNoise(x + 5, y + 19) * amount * 0.72);
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function toneDitherNoise(x, y) {
  let value = ((x * 374761393) ^ (y * 668265263)) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 2147483647.5 - 1;
}

function printClarityStrength(image, targetWidth, targetHeight, options = {}) {
  const upscale = Math.max(targetWidth / Math.max(1, image.width), targetHeight / Math.max(1, image.height));
  const base = options.printFinish === false
    ? 0
    : upscale >= 4
      ? 0.26
      : upscale >= 2
        ? 0.2
        : 0.08;
  const requested = options.enhance ? (options.strength || getEnhanceStrength()) : 0;
  return Math.min(0.52, Math.max(base, requested));
}

function drawTileToTarget(ctx, image, targetWidth, targetHeight, aspectWarp = null) {
  if (aspectWarp?.mode !== "periodic-grid") {
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    return;
  }

  const columns = Math.max(1, Math.round(aspectWarp.columns || 1));
  const rows = Math.max(1, Math.round(aspectWarp.rows || 1));
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.round((row * targetHeight) / rows);
    const y1 = Math.round(((row + 1) * targetHeight) / rows);
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.round((column * targetWidth) / columns);
      const x1 = Math.round(((column + 1) * targetWidth) / columns);
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    }
  }
}

function measureSeams(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  let total = 0;
  let count = 0;

  for (let x = 0; x < width; x += 1) {
    const top = x * 4;
    const bottom = ((height - 1) * width + x) * 4;
    total += Math.abs(data[top] - data[bottom]);
    total += Math.abs(data[top + 1] - data[bottom + 1]);
    total += Math.abs(data[top + 2] - data[bottom + 2]);
    count += 3;
  }

  for (let y = 0; y < height; y += 1) {
    const left = y * width * 4;
    const right = (y * width + width - 1) * 4;
    total += Math.abs(data[left] - data[right]);
    total += Math.abs(data[left + 1] - data[right + 1]);
    total += Math.abs(data[left + 2] - data[right + 2]);
    count += 3;
  }

  return total / count;
}

function measureSeamQuality(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  const band = Math.max(10, Math.min(42, Math.round(Math.min(width, height) * 0.035)));
  const samplesX = Math.min(width, 180);
  const samplesY = Math.min(height, 220);
  const stepX = Math.max(1, Math.floor(width / samplesX));
  const stepY = Math.max(1, Math.floor(height / samplesY));
  let horizontal = 0;
  let horizontalCount = 0;
  let vertical = 0;
  let verticalCount = 0;
  let horizontalPeaks = 0;
  let verticalPeaks = 0;

  for (let y = 0; y < band; y += 1) {
    const weight = 1 + (band - y) / band;
    for (let x = 0; x < width; x += stepX) {
      const diff = pixelDistance(data, width, x, y, x, height - 1 - y);
      const insideTop = pixelDistance(data, width, x, Math.min(height - 1, y + band), x, Math.min(height - 1, y + band + 1));
      const insideBottom = pixelDistance(data, width, x, Math.max(0, height - 1 - y - band), x, Math.max(0, height - 2 - y - band));
      const normalized = Math.max(0, diff - (insideTop + insideBottom) * 0.35);
      horizontal += normalized * weight;
      horizontalCount += weight;
      if (diff > 18 && normalized > 10) horizontalPeaks += 1;
    }
  }

  for (let x = 0; x < band; x += 1) {
    const weight = 1 + (band - x) / band;
    for (let y = 0; y < height; y += stepY) {
      const diff = pixelDistance(data, width, x, y, width - 1 - x, y);
      const insideLeft = pixelDistance(data, width, Math.min(width - 1, x + band), y, Math.min(width - 1, x + band + 1), y);
      const insideRight = pixelDistance(data, width, Math.max(0, width - 1 - x - band), y, Math.max(0, width - 2 - x - band), y);
      const normalized = Math.max(0, diff - (insideLeft + insideRight) * 0.35);
      vertical += normalized * weight;
      verticalCount += weight;
      if (diff > 18 && normalized > 10) verticalPeaks += 1;
    }
  }

  const horizontalScore = horizontal / Math.max(1, horizontalCount);
  const verticalScore = vertical / Math.max(1, verticalCount);
  const cornerScore = measureCornerScore(data, width, height, band);
  const localHorizontal = measureLocalSeamBreaks(data, width, height, band, "horizontal");
  const localVertical = measureLocalSeamBreaks(data, width, height, band, "vertical");
  const internalHorizontal = measureInternalSeamLines(data, width, height, "horizontal");
  const internalVertical = measureInternalSeamLines(data, width, height, "vertical");
  const borderHorizontal = measureBorderObjectRisk(data, width, height, "horizontal");
  const borderVertical = measureBorderObjectRisk(data, width, height, "vertical");
  const bandHorizontal = measureEdgeBandArtifact(data, width, height, "horizontal");
  const bandVertical = measureEdgeBandArtifact(data, width, height, "vertical");
  const outerFrame = measureOuterFrameArtifact(data, width, height);
  const detailHorizontal = measureSeamDetailLoss(data, width, height, "horizontal");
  const detailVertical = measureSeamDetailLoss(data, width, height, "vertical");
  const tiledHorizontal = measureTiledPreviewSeam(data, width, height, "horizontal");
  const tiledVertical = measureTiledPreviewSeam(data, width, height, "vertical");
  const tiledCorner = measureTiledCornerJunction(data, width, height);
  const driftHorizontal = measureEdgeDrift(data, width, height, "horizontal");
  const driftVertical = measureEdgeDrift(data, width, height, "vertical");
  const clarity = measurePrintClarity(data, width, height);
  const upscaleArtifact = measureUpscaleArtifact(data, width, height);
  const posterization = measurePosterizationArtifact(data, width, height);
  const compressionArtifact = measureCompressionArtifact(data, width, height);
  const sharpenHalo = measureSharpenHaloArtifact(data, width, height);
  const richness = measurePrintRichness(data, width, height);
  const textureDensity = measurePrintTextureDensity(data, width, height);
  const layoutBalance = measurePatternBalance(data, width, height);
  const mirrorHorizontal = measureMirrorAxisArtifact(data, width, height, "horizontal");
  const mirrorVertical = measureMirrorAxisArtifact(data, width, height, "vertical");
  const preTiledPreview = measurePreTiledPreviewArtifact(data, width, height);
  const peakLimitH = Math.max(18, Math.round((band * samplesX) * 0.12));
  const peakLimitV = Math.max(18, Math.round((band * samplesY) * 0.12));
  const peakRatioH = horizontalPeaks / Math.max(1, band * samplesX);
  const peakRatioV = verticalPeaks / Math.max(1, band * samplesY);
  const maxEdgeScore = Math.max(horizontalScore, verticalScore);
  const maxPeakRatio = Math.max(peakRatioH, peakRatioV);
  const maxLocalScore = Math.max(localHorizontal.score, localVertical.score);
  const maxLocalWorst = Math.max(localHorizontal.worstScore, localVertical.worstScore);
  const maxInternalScore = Math.max(internalHorizontal.score, internalVertical.score);
  const maxInternalWorst = Math.max(internalHorizontal.worstScore, internalVertical.worstScore);
  const maxBandScore = Math.max(bandHorizontal.score, bandVertical.score);
  const maxBandWorst = Math.max(bandHorizontal.worstScore, bandVertical.worstScore);
  const maxDetailLossScore = Math.max(detailHorizontal.score, detailVertical.score);
  const maxDetailLossWorst = Math.max(detailHorizontal.worstScore, detailVertical.worstScore);
  const detailLossRisk = detailHorizontal.detailLossRisk || detailVertical.detailLossRisk;
  const maxTiledScore = Math.max(tiledHorizontal.score, tiledVertical.score);
  const maxTiledWorst = Math.max(tiledHorizontal.worstScore, tiledVertical.worstScore);
  const cornerJunctionRisk = tiledCorner.junctionRisk || tiledCorner.score > 8.5 || tiledCorner.worstScore > 16;
  const maxDriftScore = Math.max(driftHorizontal.score, driftVertical.score);
  const maxDriftWorst = Math.max(driftHorizontal.worstScore, driftVertical.worstScore);
  const driftRisk = driftHorizontal.driftRisk || driftVertical.driftRisk;
  const maxMirrorScore = Math.max(mirrorHorizontal.score, mirrorVertical.score);
  const maxMirrorWorst = Math.max(mirrorHorizontal.worstScore, mirrorVertical.worstScore);
  const mirrorRisk = mirrorHorizontal.mirrorRisk || mirrorVertical.mirrorRisk;
  const preTiledPreviewRisk = preTiledPreview.duplicateRisk;
  const issues = [];

  const horizontalMismatchRisk = horizontalScore > 9.5 || horizontalPeaks > peakLimitH || localHorizontal.structuralRisk || internalHorizontal.lineRisk;
  const verticalMismatchRisk = verticalScore > 9.5 || verticalPeaks > peakLimitV || localVertical.structuralRisk || internalVertical.lineRisk;
  const severeHorizontal = (horizontalMismatchRisk && !driftHorizontal.driftRisk) || borderHorizontal.objectRisk;
  const severeVertical = (verticalMismatchRisk && !driftVertical.driftRisk) || borderVertical.objectRisk;
  const severeCorner = (cornerScore > 10.5 || (horizontalScore > 7.4 && verticalScore > 7.4)) && !driftRisk;
  const overlayRisk = (maxPeakRatio > 0.16 && maxEdgeScore > 5.8) || (maxLocalWorst > 26 && maxLocalScore > 15) || (maxInternalWorst > 24 && maxInternalScore > 12);
  const transitionRisk = (maxEdgeScore > 8.2 && maxPeakRatio > 0.08) || (maxLocalWorst > 20 && maxLocalScore > 11) || (maxInternalWorst > 18 && maxInternalScore > 9);
  const bandArtifactRisk = maxBandScore > 11 || maxBandWorst > 18 || bandHorizontal.bandRisk || bandVertical.bandRisk;
  const seamDetailRisk = maxDetailLossScore > 8.8 || maxDetailLossWorst > 16 || detailLossRisk;
  const tiledPreviewRisk = maxTiledScore > 9.8 || maxTiledWorst > 17 || tiledHorizontal.lineRisk || tiledVertical.lineRisk;
  const mildColor = maxEdgeScore > 3.4 && maxEdgeScore <= 7.2 && cornerScore <= 8.5 && maxPeakRatio <= 0.08 && maxLocalWorst <= 18 && maxInternalWorst <= 14;
  const thinLine = maxEdgeScore <= 6.8 && maxPeakRatio > 0.08 && maxPeakRatio <= 0.14 && cornerScore <= 8.5 && maxLocalWorst <= 20 && maxInternalWorst <= 16;

  if (severeHorizontal) issues.push("横档未衔接，不可修复");
  if (severeVertical) issues.push("竖档未衔接，不可修复");
  if (severeCorner) issues.push("回头没接，不可修复");
  if (!issues.length && richness.lowInformationRisk) issues.push("花型信息量不足，不可修复");
  if (!issues.length && layoutBalance.centerDominanceRisk) issues.push("花型分布过于集中，不可修复");
  if (!issues.length && preTiledPreviewRisk) issues.push("疑似平铺预览输出，不可修复");
  if (!issues.length && outerFrame.frameRisk) issues.push("画框留白边界，不可修复");
  if (!issues.length && mirrorRisk) issues.push("镜像轴痕明显，可修复");
  if (!issues.length && driftRisk) issues.push("边缘错位漂移，可修复");
  if (!issues.length && cornerJunctionRisk) issues.push("四角平铺交汇明显，可修复");
  if (overlayRisk && !driftRisk && !severeHorizontal && !severeVertical) issues.push("花型元素叠加，不可修复");
  if (transitionRisk && !driftRisk && !overlayRisk && !severeHorizontal && !severeVertical) issues.push("接缝过渡不自然，不可修复");
  if (!issues.length && tiledPreviewRisk) issues.push("平铺预览中心线明显，可修复");
  if (!issues.length && bandArtifactRisk) issues.push("平铺边带明显，可修复");
  if (!issues.length && seamDetailRisk) issues.push("接缝细节发虚，可修复");
  if (!issues.length && clarity.blurRisk) issues.push("成品清晰度不足，可增强");
  if (!issues.length && upscaleArtifact.upscaleArtifactRisk) issues.push("低清放大痕迹，可增强");
  if (!issues.length && posterization.posterizationRisk) issues.push("色阶断层，可增强");
  if (!issues.length && compressionArtifact.compressionRisk) issues.push("压缩块噪点，不可修复");
  if (!issues.length && sharpenHalo.haloRisk) issues.push("锐化光晕明显，不可修复");
  if (!issues.length && textureDensity.lowTextureDensityRisk) issues.push("印花细节密度不足，可增强");
  if (!issues.length && thinLine) issues.push("细线接缝，可修复");
  if (!issues.length && mildColor) issues.push("轻微色差，可修复");

  const score = horizontalScore * 0.14 + verticalScore * 0.14 + cornerScore * 0.07 + maxLocalScore * 0.08 + maxInternalScore * 0.08 + maxBandScore * 0.08 + maxDetailLossScore * 0.08 + maxTiledScore * 0.09 + tiledCorner.score * 0.06 + maxDriftScore * 0.07 + maxMirrorScore * 0.06 + preTiledPreview.score * 0.03 + outerFrame.score * 0.02;
  let repairability = issues.some((issue) => issue.includes("不可修复"))
    ? "unrepairable"
    : issues.some((issue) => issue.includes("可修复"))
      ? "repairable"
      : issues.some((issue) => issue.includes("可增强"))
        ? "enhanceable"
        : "pass";
  const passed = (
    repairability === "pass" &&
    score <= 4.8 &&
    horizontalScore <= 5.8 &&
    verticalScore <= 5.8 &&
    cornerScore <= 7.5 &&
    maxBandScore <= 8.5 &&
    maxBandWorst <= 16 &&
    maxDetailLossScore <= 7.2 &&
    maxDetailLossWorst <= 14 &&
    !detailLossRisk &&
    maxTiledScore <= 7.4 &&
    maxTiledWorst <= 15 &&
    tiledCorner.score <= 7.2 &&
    tiledCorner.worstScore <= 15 &&
    !cornerJunctionRisk &&
    maxDriftScore <= 7.2 &&
    maxDriftWorst <= 14 &&
    !driftRisk &&
    maxMirrorScore <= 6.8 &&
    maxMirrorWorst <= 13 &&
    !mirrorRisk &&
    !preTiledPreviewRisk &&
    !outerFrame.frameRisk &&
    !richness.lowInformationRisk &&
    !upscaleArtifact.upscaleArtifactRisk &&
    !posterization.posterizationRisk &&
    !compressionArtifact.compressionRisk &&
    !sharpenHalo.haloRisk &&
    !textureDensity.lowTextureDensityRisk &&
    !layoutBalance.centerDominanceRisk &&
    !clarity.blurRisk
  );
  if (!passed && repairability === "pass") {
    repairability = "unrepairable";
    issues.push("接缝过渡不自然，不可修复");
  }
  const finalIssueType = passed ? "通过" : issues[0] || "接缝风险";
  const check = {
    score,
    horizontalScore,
    verticalScore,
    cornerScore,
    horizontalPeaks,
    verticalPeaks,
    peakRatioH,
    peakRatioV,
    localHorizontal,
    localVertical,
    internalHorizontal,
    internalVertical,
    borderHorizontal,
    borderVertical,
    bandHorizontal,
    bandVertical,
    outerFrame,
    detailHorizontal,
    detailVertical,
    tiledHorizontal,
    tiledVertical,
    tiledCorner,
    driftHorizontal,
    driftVertical,
    mirrorHorizontal,
    mirrorVertical,
    preTiledPreview,
    clarity,
    upscaleArtifact,
    posterization,
    compressionArtifact,
    sharpenHalo,
    richness,
    textureDensity,
    layoutBalance,
    repairability: passed ? "pass" : repairability,
    finalIssueType,
    issues,
    passed,
  };
  normalizeRepairableSeamIssue(check);
  check.rating = seamRating(check);
  return check;
}

function installQaTools() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("qa") !== "1") return;

  document.documentElement.dataset.yuanyeQa = "1";
  window.YUANYE_QA = Object.freeze({
    version: clientVersion,
    checkSeamQuality,
    checkSeamStructureQuality: (dataUrl) => checkSeamQuality(dataUrl, { skipPrintSpec: true }),
    imageUrlToDataUrl,
    seamCheckSummary,
    seamFailureMessage,
    shouldAiOffsetRepair,
    shouldAiInternalGuideRepair,
    shouldOfferTaskRepair,
    normalizeRepairableSeamIssue,
    buildOffsetRepairPrompt,
    buildInternalGuideRepairPrompt,
    makeOffsetRepairMaskDataUrl,
    makeInternalGuideRepairMaskDataUrl,
    makeEdgeBlendRepairJpg,
    makeStrictSeamlessJpg,
  });

  const output = document.createElement("pre");
  output.id = "qaOutput";
  output.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-height:42vh;overflow:auto;padding:12px;border:1px solid #94a3b8;background:#0f172a;color:#e2e8f0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;";
  output.textContent = JSON.stringify({ status: "ready", version: clientVersion }, null, 2);
  document.body.appendChild(output);

  const checkUrl = params.get("qaCheck");
  if (checkUrl) {
    if (params.get("qaRepair") === "pipeline") {
      runQaRepairPipelineCheck(checkUrl, params.get("qaMode") || "full", output);
    } else if (params.get("qaRepair") === "edge") {
      runQaRepairCheck(checkUrl, params.get("qaMode") || "full", output);
    } else {
      runQaCheck(checkUrl, params.get("qaMode") || "full", output);
    }
  }
}

async function runQaCheck(url, mode, output) {
  output.textContent = JSON.stringify({ status: "running", mode, url }, null, 2);
  try {
    const check = await checkSeamQuality(url, { skipPrintSpec: mode === "structure" });
    output.textContent = JSON.stringify(compactQaCheck(check, { mode, url }), null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "error",
      mode,
      url,
      error: error.message || String(error),
    }, null, 2);
  }
}

async function runQaRepairCheck(url, mode, output) {
  output.textContent = JSON.stringify({ status: "repairing", mode, url }, null, 2);
  try {
    const before = await checkSeamQuality(url, { skipPrintSpec: mode === "structure" });
    const repairedDataUrl = await makeEdgeBlendRepairJpg(url, before);
    const after = await checkSeamQuality(repairedDataUrl, { skipPrintSpec: mode === "structure" });
    output.textContent = JSON.stringify({
      status: "done",
      mode,
      url,
      repair: "edge",
      before: compactQaCheck(before, { mode, url }),
      after: compactQaCheck(after, { mode, url: "repaired-data-url" }),
    }, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "error",
      mode,
      url,
      repair: "edge",
      error: error.message || String(error),
    }, null, 2);
  }
}

async function runQaRepairPipelineCheck(url, mode, output) {
  output.textContent = JSON.stringify({ status: "repairing", mode, url, repair: "pipeline" }, null, 2);
  try {
    const skipPrintSpec = mode === "structure";
    const jpegQuality = getQaJpegQuality();
    const before = await checkSeamQuality(url, { skipPrintSpec });
    const image = await loadImageForCanvas(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    repairSeams(ctx, canvas.width, canvas.height, {
      check: before,
      bandRatio: 0.019,
      minBand: 12,
      maxBand: 72,
      strength: 0.58,
      maxDiff: 126,
      textureMix: 0.74,
    });
    const afterEdge = await checkSeamQuality(canvas.toDataURL("image/jpeg", jpegQuality), { skipPrintSpec });

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    smoothInternalGuideLines(imageData.data, canvas.width, canvas.height, before);
    ctx.putImageData(imageData, 0, 0);
    const afterInternal = await checkSeamQuality(canvas.toDataURL("image/jpeg", jpegQuality), { skipPrintSpec });

    const refinedData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    refineSeamForTiledPreview(refinedData.data, canvas.width, canvas.height, before);
    ctx.putImageData(refinedData, 0, 0);
    const rawAfterRefine = measureSeamQuality(ctx, canvas.width, canvas.height);
    const afterRefine = await checkSeamQuality(withJpegDpi(canvas.toDataURL("image/jpeg", jpegQuality), 300), { skipPrintSpec });

    output.textContent = JSON.stringify({
      status: "done",
      mode,
      url,
      repair: "pipeline",
      jpegQuality,
      before: compactQaCheck(before, { mode, url }),
      afterEdge: compactQaCheck(afterEdge, { mode, url: "after-edge" }),
      afterInternal: compactQaCheck(afterInternal, { mode, url: "after-internal" }),
      rawAfterRefine: compactQaCheck(rawAfterRefine, { mode, url: "after-refine-raw-canvas" }),
      afterRefine: compactQaCheck(afterRefine, { mode, url: "after-refine" }),
    }, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "error",
      mode,
      url,
      repair: "pipeline",
      error: error.message || String(error),
    }, null, 2);
  }
}

function loadImageForCanvas(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function getQaJpegQuality() {
  const value = Number(new URLSearchParams(window.location.search).get("qaJpegQuality") || 0.99);
  if (!Number.isFinite(value)) return 0.99;
  return Math.max(0.75, Math.min(1, value));
}

function compactQaCheck(check, context = {}) {
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const peakRatio = Math.max(check.peakRatioH || 0, check.peakRatioV || 0);
  const localScore = Math.max(check.localHorizontal?.score || 0, check.localVertical?.score || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalScore = Math.max(check.internalHorizontal?.score || 0, check.internalVertical?.score || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerWorst = Math.max(check.cornerScore || 0, check.tiledCorner?.worstScore || 0);
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  return {
    status: "done",
    mode: context.mode || "full",
    url: context.url || "",
    passed: check.passed,
    repairability: check.repairability,
    rating: check.rating,
    finalIssueType: check.finalIssueType || "",
    score: Number(check.score || 0),
    horizontalScore: Number(check.horizontalScore || 0),
    verticalScore: Number(check.verticalScore || 0),
    cornerScore: Number(check.cornerScore || 0),
    tiledScore: Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0),
    tiledCornerScore: check.tiledCorner?.score || 0,
    driftScore: Math.max(check.driftHorizontal?.score || 0, check.driftVertical?.score || 0),
    fullSizeEdgeScore: check.fullSizeEdge?.score || 0,
    printSpecPassed: check.printSpec?.passed === true,
    printWidth: check.printSpec?.widthPx || null,
    printHeight: check.printSpec?.heightPx || null,
    dpiX: check.printSpec?.dpiX || null,
    dpiY: check.printSpec?.dpiY || null,
    issues: Array.isArray(check.issues) ? check.issues : [],
    repairMetrics: {
      edgeDominant,
      peakRatio,
      localScore,
      localWorst,
      borderWorst,
      internalScore,
      internalWorst,
      bandWorst,
      detailWorst,
      tiledWorst,
      cornerWorst,
      driftWorst,
      borderObjectRisk: Boolean(check.borderHorizontal?.objectRisk || check.borderVertical?.objectRisk),
      driftRisk: Boolean(check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk),
    },
    tiledCorner: check.tiledCorner || null,
    tiledHorizontal: check.tiledHorizontal || null,
    tiledVertical: check.tiledVertical || null,
    bandHorizontal: check.bandHorizontal || null,
    bandVertical: check.bandVertical || null,
    outerFrame: check.outerFrame || null,
    summary: seamCheckSummary(check),
  };
}

function normalizeRepairableSeamIssue(check) {
  if (!check || check.passed || !Array.isArray(check.issues) || !check.issues.length) return check;
  const issueText = check.issues.join(" ");
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const peakRatio = Math.max(check.peakRatioH || 0, check.peakRatioV || 0);
  const localScore = Math.max(check.localHorizontal?.score || 0, check.localVertical?.score || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalScore = Math.max(check.internalHorizontal?.score || 0, check.internalVertical?.score || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const borderObjectRisk = Boolean(check.borderHorizontal?.objectRisk || check.borderVertical?.objectRisk);
  const driftRisk = Boolean(check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk);
  const internalLineRisk = Boolean(check.internalHorizontal?.lineRisk || check.internalVertical?.lineRisk || internalWorst > 16 || internalScore > 9);
  const cornerScore = Math.max(check.cornerScore || 0, check.tiledCorner?.score || 0);
  const cornerWorst = Math.max(check.cornerScore || 0, check.tiledCorner?.worstScore || 0);
  const cornerOnlyRisk = cornerScore > 7.2 || cornerWorst > 14 || check.tiledCorner?.junctionRisk;
  const structuralSeamRisk = /横档未衔接|竖档未衔接|回头没接|接缝过渡不自然|边缘错位漂移/.test(issueText);
  const localizedOverlayRisk = issueText.includes("花型元素叠加") && (
    edgeDominant <= 28 &&
    peakRatio <= 0.24 &&
    localScore <= 22 &&
    localWorst <= 42 &&
    internalScore <= 24 &&
    internalWorst <= 54 &&
    borderWorst <= 220 &&
    !borderObjectRisk &&
    !driftRisk
  );
  const softBorderObjectRisk = borderObjectRisk && (
    borderWorst <= 72 &&
    edgeDominant <= 18 &&
    peakRatio <= 0.44 &&
    localScore <= 18 &&
    localWorst <= 48 &&
    bandWorst <= 72 &&
    detailWorst <= 72 &&
    tiledWorst <= 72 &&
    cornerWorst <= 66 &&
    driftWorst <= 12 &&
    !driftRisk
  );
  const nearMissStructuralRisk = structuralSeamRisk && !issueText.includes("花型元素叠加") && (
    (check.score || 0) <= 32 &&
    edgeDominant <= 30 &&
    peakRatio <= 0.44 &&
    localScore <= 36 &&
    localWorst <= 88 &&
    borderWorst <= 280 &&
    internalWorst <= 120 &&
    bandWorst <= 160 &&
    detailWorst <= 150 &&
    tiledWorst <= 120 &&
    cornerWorst <= 88 &&
    driftWorst <= 58 &&
    (!borderObjectRisk || softBorderObjectRisk) &&
    !driftRisk
  );

  if (/花型信息量不足|花型分布过于集中|疑似平铺预览输出|画框留白|输出比例拉伸|成品规格|低清放大|成品清晰度不足|印花细节密度不足|色阶断层|压缩块噪点|锐化光晕|最终JPG边缘硬线/.test(issueText)) {
    return check;
  }
  if (issueText.includes("花型元素叠加") && !localizedOverlayRisk) {
    return check;
  }

  const edgeClosureStable = (
    edgeDominant <= 9.2 &&
    peakRatio <= 0.14 &&
    localScore <= 11 &&
    localWorst <= 23 &&
    borderWorst <= 96 &&
    !borderObjectRisk &&
    !driftRisk
  );

  if (!localizedOverlayRisk && !nearMissStructuralRisk && (!edgeClosureStable || (!internalLineRisk && !cornerOnlyRisk))) return check;

  const repairableIssues = [];
  if (localizedOverlayRisk) repairableIssues.push("局部花型叠加，可修复");
  if (nearMissStructuralRisk && !edgeClosureStable) repairableIssues.push("结构接缝轻度失配，可修复");
  if (internalLineRisk) repairableIssues.push("内部接缝线明显，可修复");
  if (cornerOnlyRisk) repairableIssues.push("四角平铺交汇明显，可修复");
  if (!repairableIssues.length) repairableIssues.push("接缝过渡不自然，可修复");

  check.issues = repairableIssues;
  check.repairability = "repairable";
  check.finalIssueType = repairableIssues[0];
  return check;
}

function measureFullSizeEdgeArtifact(image) {
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (width < 8 || height < 8) {
    return {
      score: Infinity,
      peakRatio: 1,
      horizontal: { score: Infinity, edgeRisk: true },
      vertical: { score: Infinity, edgeRisk: true },
      edgeRisk: true,
    };
  }

  const size = Math.min(width, height);
  const depth = Math.max(4, Math.min(18, Math.round(size * 0.002)));
  const horizontal = measureFullSizeEdgeAxis(image, depth, "horizontal");
  const vertical = measureFullSizeEdgeAxis(image, depth, "vertical");
  const score = Math.max(horizontal.score, vertical.score);
  const peakRatio = Math.max(horizontal.peakRatio, vertical.peakRatio);

  return {
    score,
    peakRatio,
    horizontal,
    vertical,
    edgeRisk: horizontal.edgeRisk || vertical.edgeRisk,
  };
}

function measureFullSizeEdgeAxis(image, depth, direction) {
  const horizontal = direction === "horizontal";
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceLength = horizontal ? sourceWidth : sourceHeight;
  const sampleLength = Math.max(80, Math.min(1200, sourceLength));
  const canvas = document.createElement("canvas");
  canvas.width = horizontal ? sampleLength : depth * 2;
  canvas.height = horizontal ? depth * 2 : sampleLength;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (horizontal) {
    ctx.drawImage(image, 0, 0, sourceWidth, depth, 0, 0, sampleLength, depth);
    ctx.drawImage(image, 0, sourceHeight - depth, sourceWidth, depth, 0, depth, sampleLength, depth);
  } else {
    ctx.drawImage(image, 0, 0, depth, sourceHeight, 0, 0, depth, sampleLength);
    ctx.drawImage(image, sourceWidth - depth, 0, depth, sourceHeight, depth, 0, depth, sampleLength);
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return measureFullSizeEdgeStrip(imageData, canvas.width, canvas.height, horizontal ? "horizontal" : "vertical", depth, sampleLength);
}

function measureFullSizeEdgeStrip(data, width, height, direction, depth, length) {
  const horizontal = direction === "horizontal";
  let seamTotal = 0;
  let seamWorst = 0;
  let seamPeaks = 0;
  let lineTotal = 0;
  let lineWorst = 0;
  let linePeaks = 0;
  let count = 0;

  for (let position = 0; position < length; position += 1) {
    const topOuter = fullSizeStripPoint(position, 0, depth, horizontal);
    const bottomOuter = fullSizeStripPoint(position, depth - 1, depth, horizontal, true);
    const topInner = fullSizeStripPoint(position, 1, depth, horizontal);
    const bottomInner = fullSizeStripPoint(position, depth - 2, depth, horizontal, true);
    const topInner2 = fullSizeStripPoint(position, 2, depth, horizontal);
    const bottomInner2 = fullSizeStripPoint(position, depth - 3, depth, horizontal, true);
    const seam = stripPixelDistance(data, width, topOuter.x, topOuter.y, bottomOuter.x, bottomOuter.y);
    const topJump = stripPixelDistance(data, width, topOuter.x, topOuter.y, topInner.x, topInner.y);
    const bottomJump = stripPixelDistance(data, width, bottomOuter.x, bottomOuter.y, bottomInner.x, bottomInner.y);
    const innerActivity = (
      stripPixelDistance(data, width, topInner.x, topInner.y, topInner2.x, topInner2.y) +
      stripPixelDistance(data, width, bottomInner.x, bottomInner.y, bottomInner2.x, bottomInner2.y)
    ) / 2;
    const edgeJump = (topJump + bottomJump) / 2;
    const lineScore = Math.max(0, edgeJump - innerActivity * 1.8 - 7);

    seamTotal += seam;
    seamWorst = Math.max(seamWorst, seam);
    lineTotal += lineScore;
    lineWorst = Math.max(lineWorst, lineScore);
    if (seam > Math.max(18, innerActivity * 2 + 6)) seamPeaks += 1;
    if (lineScore > 8 && edgeJump > 22) linePeaks += 1;
    count += 1;
  }

  const seamAverage = seamTotal / Math.max(1, count);
  const seamPeakRatio = seamPeaks / Math.max(1, count);
  const lineAverage = lineTotal / Math.max(1, count);
  const linePeakRatio = linePeaks / Math.max(1, count);
  const score = seamAverage * 0.55 + seamPeakRatio * 95 + lineAverage * 0.7 + linePeakRatio * 70;
  const edgeRisk = (
    (seamAverage > 9.5 && seamPeakRatio > 0.025) ||
    (seamWorst > 48 && seamPeakRatio > 0.012) ||
    (lineAverage > 7.5 && linePeakRatio > 0.08 && lineWorst > 18) ||
    score > 22
  );

  return {
    score,
    peakRatio: Math.max(seamPeakRatio, linePeakRatio),
    seamAverage,
    seamWorst,
    seamPeakRatio,
    lineAverage,
    lineWorst,
    linePeakRatio,
    edgeRisk,
  };
}

function fullSizeStripPoint(position, offset, depth, horizontal, secondSide = false) {
  const safeOffset = Math.max(0, Math.min(depth - 1, offset));
  if (horizontal) {
    return {
      x: position,
      y: secondSide ? depth + safeOffset : safeOffset,
    };
  }
  return {
    x: secondSide ? depth + safeOffset : safeOffset,
    y: position,
  };
}

function stripPixelDistance(data, width, x1, y1, x2, y2) {
  const a = (Math.round(y1) * width + Math.round(x1)) * 4;
  const b = (Math.round(y2) * width + Math.round(x2)) * 4;
  return (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3;
}

function pixelDistance(data, width, x1, y1, x2, y2) {
  const a = (Math.round(y1) * width + Math.round(x1)) * 4;
  const b = (Math.round(y2) * width + Math.round(x2)) * 4;
  return (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3;
}

function measureCornerScore(data, width, height, band) {
  const size = Math.max(8, Math.round(band * 1.4));
  let total = 0;
  let count = 0;

  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      total += pixelDistance(data, width, x, y, width - size + x, height - size + y);
      total += pixelDistance(data, width, width - size + x, y, x, height - size + y);
      count += 2;
    }
  }

  return total / Math.max(1, count);
}

function measureLocalSeamBreaks(data, width, height, band, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const windowSize = Math.max(18, Math.min(72, Math.round(length / 28)));
  const windowStep = Math.max(8, Math.round(windowSize * 0.45));
  const depth = Math.max(8, Math.min(band, Math.round(cross * 0.018)));
  const sampleStep = Math.max(1, Math.round(Math.min(windowSize, depth) / 10));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let severeWindows = 0;
  let activeWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let diffTotal = 0;
    let activityTotal = 0;
    let sampleCount = 0;

    for (let offset = start; offset < end; offset += sampleStep) {
      for (let d = 0; d < depth; d += sampleStep) {
        const x1 = horizontal ? offset : d;
        const y1 = horizontal ? d : offset;
        const x2 = horizontal ? offset : width - 1 - d;
        const y2 = horizontal ? height - 1 - d : offset;
        const nearA = horizontal
          ? Math.min(height - 1, d + sampleStep)
          : Math.min(width - 1, d + sampleStep);
        const nearB = horizontal
          ? Math.max(0, height - 1 - d - sampleStep)
          : Math.max(0, width - 1 - d - sampleStep);

        diffTotal += pixelDistance(data, width, x1, y1, x2, y2);
        activityTotal += horizontal
          ? (
            pixelDistance(data, width, x1, y1, x1, nearA) +
            pixelDistance(data, width, x2, y2, x2, nearB)
          ) / 2
          : (
            pixelDistance(data, width, x1, y1, nearA, y1) +
            pixelDistance(data, width, x2, y2, nearB, y2)
          ) / 2;
        sampleCount += 1;
      }
    }

    const diff = diffTotal / Math.max(1, sampleCount);
    const activity = activityTotal / Math.max(1, sampleCount);
    const structuralScore = Math.max(0, diff - activity * 0.28);
    total += structuralScore;
    count += 1;
    worstScore = Math.max(worstScore, structuralScore);

    if (activity > 5.5 || diff > 18) activeWindows += 1;
    if (structuralScore > 18 && diff > 20) severeWindows += 1;
  }

  const score = total / Math.max(1, count);
  const severeRatio = severeWindows / Math.max(1, count);
  const activeRatio = activeWindows / Math.max(1, count);
  const structuralRisk = (
    (worstScore > 26 && severeWindows >= 1 && activeRatio > 0.08) ||
    (worstScore > 21 && severeWindows >= 2) ||
    (score > 13.5 && severeRatio > 0.08)
  );

  return {
    score,
    worstScore,
    severeWindows,
    activeWindows,
    severeRatio,
    activeRatio,
    structuralRisk,
  };
}

function measureInternalSeamLines(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const ratios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const sampleStep = Math.max(1, Math.round(length / 240));
  const offset = Math.max(2, Math.round(cross * 0.006));
  const guard = Math.max(8, Math.round(cross * 0.04));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let riskyLines = 0;

  for (const ratio of ratios) {
    const line = Math.round(cross * ratio);
    if (line <= guard || line >= cross - guard) continue;
    let diffTotal = 0;
    let localTotal = 0;
    let peakCount = 0;
    let sampleCount = 0;

    for (let position = 0; position < length; position += sampleStep) {
      const before = Math.max(0, line - offset);
      const after = Math.min(cross - 1, line + offset);
      const farBefore = Math.max(0, line - offset * 3);
      const farAfter = Math.min(cross - 1, line + offset * 3);
      const diff = horizontal
        ? pixelDistance(data, width, position, before, position, after)
        : pixelDistance(data, width, before, position, after, position);
      const centerDiff = horizontal
        ? (
          pixelDistance(data, width, position, line, position, farBefore) +
          pixelDistance(data, width, position, line, position, farAfter)
        ) / 2
        : (
          pixelDistance(data, width, line, position, farBefore, position) +
          pixelDistance(data, width, line, position, farAfter, position)
        ) / 2;
      const local = horizontal
        ? (
          pixelDistance(data, width, position, before, position, farBefore) +
          pixelDistance(data, width, position, after, position, farAfter)
        ) / 2
        : (
          pixelDistance(data, width, before, position, farBefore, position) +
          pixelDistance(data, width, after, position, farAfter, position)
        ) / 2;

      const score = Math.max(0, Math.max(diff, centerDiff * 0.95) - local * 0.35);
      diffTotal += score;
      localTotal += local;
      if (score > 14 && Math.max(diff, centerDiff) > 16) peakCount += 1;
      sampleCount += 1;
    }

    const lineScore = diffTotal / Math.max(1, sampleCount);
    const localActivity = localTotal / Math.max(1, sampleCount);
    const peakRatio = peakCount / Math.max(1, sampleCount);
    const weightedScore = lineScore * (1 + Math.min(0.7, peakRatio * 3));

    total += weightedScore;
    count += 1;
    worstScore = Math.max(worstScore, weightedScore);
    if (
      (weightedScore > 14 && peakRatio > 0.1) ||
      (weightedScore > 10 && peakRatio > 0.22 && localActivity > 2.5)
    ) {
      riskyLines += 1;
    }
  }

  const score = total / Math.max(1, count);
  return {
    score,
    worstScore,
    riskyLines,
    lineRisk: riskyLines > 0 || worstScore > 18 || score > 12,
  };
}

function measureBorderObjectRisk(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const edgeDepth = Math.max(4, Math.round(cross * 0.012));
  const windowSize = Math.max(18, Math.min(84, Math.round(length / 22)));
  const windowStep = Math.max(8, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(windowSize / 16));
  let objectWindows = 0;
  let mismatchWindows = 0;
  let worstMismatch = 0;
  let worstActivity = 0;
  let totalMismatch = 0;
  let count = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let activityA = 0;
    let activityB = 0;
    let mismatch = 0;
    let sampleCount = 0;

    for (let position = start; position < end; position += sampleStep) {
      for (let depth = 0; depth < edgeDepth; depth += 1) {
        const ax = horizontal ? position : depth;
        const ay = horizontal ? depth : position;
        const bx = horizontal ? position : width - 1 - depth;
        const by = horizontal ? height - 1 - depth : position;
        const ai = (Math.round(ay) * width + Math.round(ax)) * 4;
        const bi = (Math.round(by) * width + Math.round(bx)) * 4;
        const innerA = horizontal
          ? Math.min(height - 1, depth + edgeDepth)
          : Math.min(width - 1, depth + edgeDepth);
        const innerB = horizontal
          ? Math.max(0, height - 1 - depth - edgeDepth)
          : Math.max(0, width - 1 - depth - edgeDepth);

        activityA += edgeActivity(data, width, ax, ay, horizontal ? ax : innerA, horizontal ? innerA : ay);
        activityB += edgeActivity(data, width, bx, by, horizontal ? bx : innerB, horizontal ? innerB : by);
        mismatch += pixelDistance(data, width, ax, ay, bx, by);
        sampleCount += 1;

        // Bright or high-contrast objects sitting on only one edge are the
        // classic "half flower / half stem" failure in textile repeats.
        const lumA = pixelLuminanceAt(data, ai);
        const lumB = pixelLuminanceAt(data, bi);
        mismatch += Math.max(0, Math.abs(lumA - lumB) - 18) * 0.55;
      }
    }

    const avgActivityA = activityA / Math.max(1, sampleCount);
    const avgActivityB = activityB / Math.max(1, sampleCount);
    const avgMismatch = mismatch / Math.max(1, sampleCount);
    const oneSidedActivity = Math.abs(avgActivityA - avgActivityB);
    const objectActivity = Math.max(avgActivityA, avgActivityB);
    const objectMismatch = avgMismatch + oneSidedActivity * 0.7;

    totalMismatch += objectMismatch;
    count += 1;
    worstMismatch = Math.max(worstMismatch, objectMismatch);
    worstActivity = Math.max(worstActivity, objectActivity);
    if (objectActivity > 13 || oneSidedActivity > 8) objectWindows += 1;
    if (objectMismatch > 24 && objectActivity > 8) mismatchWindows += 1;
  }

  const score = totalMismatch / Math.max(1, count);
  const objectRatio = objectWindows / Math.max(1, count);
  const mismatchRatio = mismatchWindows / Math.max(1, count);
  return {
    score,
    worstMismatch,
    worstActivity,
    objectWindows,
    mismatchWindows,
    objectRatio,
    mismatchRatio,
    objectRisk: (worstMismatch > 30 && mismatchWindows >= 1) || (mismatchRatio > 0.08 && objectRatio > 0.12),
  };
}

function measureEdgeBandArtifact(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(6, Math.min(34, Math.round(cross * 0.014)));
  const innerGap = Math.max(depth * 3, Math.round(cross * 0.04));
  const windowSize = Math.max(24, Math.min(96, Math.round(length / 24)));
  const windowStep = Math.max(10, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(Math.min(windowSize, depth) / 10));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let flatWindows = 0;
  let shiftWindows = 0;
  let seamShiftSum = 0;
  let bandShiftSum = 0;
  let edgeActivitySum = 0;
  let innerActivitySum = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let seamShiftTotal = 0;
    let bandShiftTotal = 0;
    let edgeActivityTotal = 0;
    let innerActivityTotal = 0;
    let sampleCount = 0;

    for (let position = start; position < end; position += sampleStep) {
      for (let offset = 0; offset < depth; offset += sampleStep) {
        const aCross = offset;
        const bCross = cross - 1 - offset;
        const innerA = Math.min(cross - 1, offset + innerGap);
        const innerB = Math.max(0, cross - 1 - offset - innerGap);
        const nextA = Math.min(cross - 1, aCross + sampleStep);
        const nextB = Math.max(0, bCross - sampleStep);
        const nextInnerA = Math.min(cross - 1, innerA + sampleStep);
        const nextInnerB = Math.max(0, innerB - sampleStep);

        const ax = horizontal ? position : aCross;
        const ay = horizontal ? aCross : position;
        const bx = horizontal ? position : bCross;
        const by = horizontal ? bCross : position;
        const iax = horizontal ? position : innerA;
        const iay = horizontal ? innerA : position;
        const ibx = horizontal ? position : innerB;
        const iby = horizontal ? innerB : position;
        const nax = horizontal ? position : nextA;
        const nay = horizontal ? nextA : position;
        const nbx = horizontal ? position : nextB;
        const nby = horizontal ? nextB : position;
        const niax = horizontal ? position : nextInnerA;
        const niay = horizontal ? nextInnerA : position;
        const nibx = horizontal ? position : nextInnerB;
        const niby = horizontal ? nextInnerB : position;

        seamShiftTotal += pixelDistance(data, width, ax, ay, bx, by);
        bandShiftTotal += (
          pixelDistance(data, width, ax, ay, iax, iay) +
          pixelDistance(data, width, bx, by, ibx, iby)
        ) / 2;
        edgeActivityTotal += (
          pixelDistance(data, width, ax, ay, nax, nay) +
          pixelDistance(data, width, bx, by, nbx, nby)
        ) / 2;
        innerActivityTotal += (
          pixelDistance(data, width, iax, iay, niax, niay) +
          pixelDistance(data, width, ibx, iby, nibx, niby)
        ) / 2;
        sampleCount += 1;
      }
    }

    const seamShift = seamShiftTotal / Math.max(1, sampleCount);
    const bandShift = bandShiftTotal / Math.max(1, sampleCount);
    const edgeActivity = edgeActivityTotal / Math.max(1, sampleCount);
    const innerActivity = innerActivityTotal / Math.max(1, sampleCount);
    const activityDrop = Math.max(0, innerActivity - edgeActivity);
    const stripScore = Math.max(0, bandShift - innerActivity * 0.2) * 0.52 + activityDrop * 0.95 + Math.max(0, seamShift - edgeActivity * 0.45) * 0.18;

    seamShiftSum += seamShift;
    bandShiftSum += bandShift;
    edgeActivitySum += edgeActivity;
    innerActivitySum += innerActivity;
    total += stripScore;
    count += 1;
    worstScore = Math.max(worstScore, stripScore);
    if (activityDrop > 7.5 && bandShift > 9) flatWindows += 1;
    if (bandShift > 14 || stripScore > 14) shiftWindows += 1;
  }

  const score = total / Math.max(1, count);
  const flatRatio = flatWindows / Math.max(1, count);
  const shiftRatio = shiftWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    flatWindows,
    shiftWindows,
    flatRatio,
    shiftRatio,
    seamShift: seamShiftSum / Math.max(1, count),
    bandShift: bandShiftSum / Math.max(1, count),
    edgeActivity: edgeActivitySum / Math.max(1, count),
    innerActivity: innerActivitySum / Math.max(1, count),
    bandRisk: (
      worstScore > 20 ||
      score > 12 ||
      (flatWindows >= 2 && flatRatio > 0.06) ||
      (shiftWindows >= 2 && shiftRatio > 0.08)
    ),
  };
}

function measureOuterFrameArtifact(data, width, height) {
  const size = Math.min(width, height);
  const frameDepth = Math.max(8, Math.min(72, Math.round(size * 0.055)));
  const innerOffset = Math.max(frameDepth * 2, Math.round(size * 0.14));
  const sideStats = [
    measureFrameSide(data, width, height, 0, 0, width, frameDepth, 0, innerOffset, width, Math.min(height, innerOffset + frameDepth)),
    measureFrameSide(data, width, height, 0, height - frameDepth, width, height, 0, Math.max(0, height - innerOffset - frameDepth), width, Math.max(0, height - innerOffset)),
    measureFrameSide(data, width, height, 0, 0, frameDepth, height, innerOffset, 0, Math.min(width, innerOffset + frameDepth), height),
    measureFrameSide(data, width, height, width - frameDepth, 0, width, height, Math.max(0, width - innerOffset - frameDepth), 0, Math.max(0, width - innerOffset), height),
  ];
  const riskSides = sideStats.filter((side) => side.risk).length;
  const score = sideStats.reduce((sum, side) => sum + side.score, 0) / Math.max(1, sideStats.length);
  const worstScore = Math.max(...sideStats.map((side) => side.score));
  const averageEdgeActivity = sideStats.reduce((sum, side) => sum + side.edge.activity, 0) / Math.max(1, sideStats.length);
  const averageInnerActivity = sideStats.reduce((sum, side) => sum + side.inner.activity, 0) / Math.max(1, sideStats.length);

  return {
    score,
    worstScore,
    riskSides,
    averageEdgeActivity,
    averageInnerActivity,
    sides: sideStats,
    frameRisk: riskSides >= 3 || (riskSides >= 2 && score > 9.5 && worstScore > 14),
  };
}

function measureFrameSide(data, width, height, ex0, ey0, ex1, ey1, ix0, iy0, ix1, iy1) {
  const edge = measureFrameRegion(data, width, height, ex0, ey0, ex1, ey1);
  const inner = measureFrameRegion(data, width, height, ix0, iy0, ix1, iy1);
  const activityDrop = Math.max(0, inner.activity - edge.activity);
  const flatDrop = Math.max(0, inner.lumStd - edge.lumStd);
  const lumShift = Math.abs(edge.lumMean - inner.lumMean);
  const extremeFlatEdge = edge.lumStd < 4.5 && (edge.lumMean > 226 || edge.lumMean < 28);
  const frameLike = (
    inner.activity > 4.6 &&
    edge.activity < Math.max(2.8, inner.activity * 0.46) &&
    edge.lumStd < Math.max(8, inner.lumStd * 0.72) &&
    (lumShift > 10 || activityDrop > 4.8 || extremeFlatEdge)
  );
  const score = activityDrop * 0.86 + flatDrop * 0.32 + Math.max(0, lumShift - 8) * 0.38 + (extremeFlatEdge ? 8 : 0);

  return {
    edge,
    inner,
    activityDrop,
    flatDrop,
    lumShift,
    score,
    risk: frameLike && score > 6.8,
  };
}

function measureFrameRegion(data, width, height, x0, y0, x1, y1) {
  const left = Math.max(1, Math.min(width - 2, Math.round(x0)));
  const top = Math.max(1, Math.min(height - 2, Math.round(y0)));
  const right = Math.max(left + 1, Math.min(width - 1, Math.round(x1)));
  const bottom = Math.max(top + 1, Math.min(height - 1, Math.round(y1)));
  const step = Math.max(1, Math.round(Math.max(right - left, bottom - top) / 96));
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let activityTotal = 0;
  let count = 0;

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const luminance = pixelLuminance(data, width, x, y);
      const detail = pixelDetailAt(data, width, height, x, y);
      lumTotal += luminance;
      lumSquareTotal += luminance * luminance;
      activityTotal += detail.gradient * 0.48 + detail.detail * 0.88;
      count += 1;
    }
  }

  const lumMean = lumTotal / Math.max(1, count);
  const lumStd = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - lumMean * lumMean));
  const activity = activityTotal / Math.max(1, count);
  return {
    lumMean,
    lumStd,
    activity,
  };
}

function measureSeamDetailLoss(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const band = Math.max(5, Math.min(28, Math.round(cross * 0.012)));
  const innerGap = Math.max(band * 4, Math.round(cross * 0.055));
  const windowSize = Math.max(28, Math.min(128, Math.round(length / 24)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(band / 7));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let softWindows = 0;
  let activeWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let edgeDetailTotal = 0;
    let innerDetailTotal = 0;
    let edgeGradientTotal = 0;
    let innerGradientTotal = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 2, Math.max(1, along));

      for (let depth = 1; depth <= band; depth += depthStep) {
        const aCross = Math.min(cross - 2, Math.max(1, depth));
        const bCross = Math.max(1, cross - 1 - depth);
        const innerA = Math.min(cross - 2, depth + innerGap);
        const innerB = Math.max(1, cross - 1 - depth - innerGap);
        const ax = horizontal ? safeAlong : aCross;
        const ay = horizontal ? aCross : safeAlong;
        const bx = horizontal ? safeAlong : bCross;
        const by = horizontal ? bCross : safeAlong;
        const iax = horizontal ? safeAlong : innerA;
        const iay = horizontal ? innerA : safeAlong;
        const ibx = horizontal ? safeAlong : innerB;
        const iby = horizontal ? innerB : safeAlong;
        const edgeA = pixelDetailAt(data, width, height, ax, ay);
        const edgeB = pixelDetailAt(data, width, height, bx, by);
        const innerDetailA = pixelDetailAt(data, width, height, iax, iay);
        const innerDetailB = pixelDetailAt(data, width, height, ibx, iby);

        edgeDetailTotal += (edgeA.detail + edgeB.detail) / 2;
        innerDetailTotal += (innerDetailA.detail + innerDetailB.detail) / 2;
        edgeGradientTotal += (edgeA.gradient + edgeB.gradient) / 2;
        innerGradientTotal += (innerDetailA.gradient + innerDetailB.gradient) / 2;
        sampleCount += 1;
      }
    }

    const edgeDetail = edgeDetailTotal / Math.max(1, sampleCount);
    const innerDetail = innerDetailTotal / Math.max(1, sampleCount);
    const edgeGradient = edgeGradientTotal / Math.max(1, sampleCount);
    const innerGradient = innerGradientTotal / Math.max(1, sampleCount);
    const detailLoss = Math.max(0, innerDetail - edgeDetail);
    const gradientLoss = Math.max(0, innerGradient - edgeGradient);
    const lossRatio = detailLoss / Math.max(1, innerDetail);
    const activeInterior = innerDetail > 3.8 || innerGradient > 7.5;
    const windowScore = activeInterior
      ? detailLoss * 1.18 + Math.max(0, lossRatio - 0.32) * 16 + gradientLoss * 0.18
      : 0;

    total += windowScore;
    count += 1;
    worstScore = Math.max(worstScore, windowScore);
    if (activeInterior) activeWindows += 1;
    if (
      activeInterior &&
      (windowScore > 10.5 || (lossRatio > 0.48 && detailLoss > 2.6 && gradientLoss > 2.5))
    ) {
      softWindows += 1;
    }
  }

  const score = total / Math.max(1, count);
  const softRatio = softWindows / Math.max(1, count);
  const activeRatio = activeWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    softWindows,
    activeWindows,
    softRatio,
    activeRatio,
    detailLossRisk: (
      worstScore > 17 ||
      score > 9.2 ||
      (softWindows >= 2 && softRatio > 0.08 && activeRatio > 0.18)
    ),
  };
}

function measureEdgeDrift(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(4, Math.min(18, Math.round(cross * 0.012)));
  const maxShift = Math.max(4, Math.min(24, Math.round(length * 0.05)));
  const windowSize = Math.max(28, Math.min(132, Math.round(length / 22)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.48));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(depth / 6));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let shiftedWindows = 0;
  let totalShift = 0;
  let worstShift = 0;
  let dominantShift = 0;
  let bestConfidence = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let activityTotal = 0;
    let activityCount = 0;

    for (let position = start; position < end; position += sampleStep) {
      const along = Math.min(length - 1, position);
      const nextAlong = wrapIndex(along + sampleStep, length);
      for (let offset = 0; offset < depth; offset += depthStep) {
        const aCross = offset;
        const bCross = cross - 1 - offset;
        const innerA = Math.min(cross - 1, offset + depthStep);
        const innerB = Math.max(0, cross - 1 - offset - depthStep);
        const ax = horizontal ? along : aCross;
        const ay = horizontal ? aCross : along;
        const bx = horizontal ? along : bCross;
        const by = horizontal ? bCross : along;
        const anx = horizontal ? nextAlong : innerA;
        const any = horizontal ? innerA : nextAlong;
        const bnx = horizontal ? nextAlong : innerB;
        const bny = horizontal ? innerB : nextAlong;

        activityTotal += (
          pixelDistance(data, width, ax, ay, anx, any) +
          pixelDistance(data, width, bx, by, bnx, bny)
        ) / 2;
        activityCount += 1;
      }
    }

    const edgeActivity = activityTotal / Math.max(1, activityCount);
    let zeroDiff = Infinity;
    let bestDiff = Infinity;
    let bestShift = 0;

    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
      let diffTotal = 0;
      let sampleCount = 0;

      for (let position = start; position < end; position += sampleStep) {
        const alongA = Math.min(length - 1, position);
        const alongB = wrapIndex(alongA + shift, length);
        for (let offset = 0; offset < depth; offset += depthStep) {
          const ax = horizontal ? alongA : offset;
          const ay = horizontal ? offset : alongA;
          const bx = horizontal ? alongB : width - 1 - offset;
          const by = horizontal ? height - 1 - offset : alongB;
          diffTotal += pixelDistance(data, width, ax, ay, bx, by);
          sampleCount += 1;
        }
      }

      const diff = diffTotal / Math.max(1, sampleCount);
      if (shift === 0) zeroDiff = diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestShift = shift;
      }
    }

    const improvement = Math.max(0, zeroDiff - bestDiff);
    const shiftAbs = Math.abs(bestShift);
    const confidence = improvement / Math.max(1, zeroDiff);
    const explainableShift = (
      shiftAbs >= 2 &&
      zeroDiff > 8 &&
      edgeActivity > 3.5 &&
      bestDiff < zeroDiff * 0.78 &&
      improvement > Math.max(3.2, edgeActivity * 0.16)
    );
    const driftScore = explainableShift
      ? improvement * Math.min(1, shiftAbs / 6) * (0.65 + Math.min(0.55, confidence)) + Math.max(0, zeroDiff - bestDiff * 1.32) * 0.35
      : 0;

    total += driftScore;
    count += 1;
    if (driftScore > worstScore) {
      worstScore = driftScore;
      worstShift = shiftAbs;
      dominantShift = bestShift;
      bestConfidence = confidence;
    }
    if (driftScore > 8 && shiftAbs >= 2) {
      shiftedWindows += 1;
      totalShift += shiftAbs;
    }
  }

  const score = total / Math.max(1, count);
  const shiftedRatio = shiftedWindows / Math.max(1, count);
  const averageShift = totalShift / Math.max(1, shiftedWindows);
  return {
    score,
    worstScore,
    shiftedWindows,
    shiftedRatio,
    averageShift,
    worstShift,
    dominantShift,
    confidence: bestConfidence,
    driftRisk: (
      worstScore > 13.5 ||
      score > 8.5 ||
      (shiftedWindows >= 2 && shiftedRatio > 0.08 && averageShift >= 2.4 && worstScore > 9.5)
    ),
  };
}

function measureTiledCornerJunction(data, width, height) {
  const size = Math.min(width, height);
  const radius = Math.max(8, Math.min(48, Math.round(size * 0.018)));
  const innerGap = Math.max(radius * 3, Math.round(size * 0.055));
  const sampleStep = Math.max(1, Math.round(radius / 8));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let spotSamples = 0;
  let seamSamples = 0;
  let haloSamples = 0;
  let centerJumpTotal = 0;
  let haloShiftTotal = 0;
  let activityTotal = 0;

  for (let dy = 0; dy < radius; dy += sampleStep) {
    for (let dx = 0; dx < radius; dx += sampleStep) {
      const br = { x: width - 1 - dx, y: height - 1 - dy };
      const bl = { x: dx, y: height - 1 - dy };
      const tr = { x: width - 1 - dx, y: dy };
      const tl = { x: dx, y: dy };
      const ibr = { x: Math.max(0, br.x - innerGap), y: Math.max(0, br.y - innerGap) };
      const ibl = { x: Math.min(width - 1, bl.x + innerGap), y: Math.max(0, bl.y - innerGap) };
      const itr = { x: Math.max(0, tr.x - innerGap), y: Math.min(height - 1, tr.y + innerGap) };
      const itl = { x: Math.min(width - 1, tl.x + innerGap), y: Math.min(height - 1, tl.y + innerGap) };
      const nbr = { x: Math.max(0, br.x - sampleStep), y: Math.max(0, br.y - sampleStep) };
      const nbl = { x: Math.min(width - 1, bl.x + sampleStep), y: Math.max(0, bl.y - sampleStep) };
      const ntr = { x: Math.max(0, tr.x - sampleStep), y: Math.min(height - 1, tr.y + sampleStep) };
      const ntl = { x: Math.min(width - 1, tl.x + sampleStep), y: Math.min(height - 1, tl.y + sampleStep) };

      const verticalJump = (
        pixelDistance(data, width, br.x, br.y, bl.x, bl.y) +
        pixelDistance(data, width, tr.x, tr.y, tl.x, tl.y)
      ) / 2;
      const horizontalJump = (
        pixelDistance(data, width, br.x, br.y, tr.x, tr.y) +
        pixelDistance(data, width, bl.x, bl.y, tl.x, tl.y)
      ) / 2;
      const diagonalJump = (
        pixelDistance(data, width, br.x, br.y, tl.x, tl.y) +
        pixelDistance(data, width, bl.x, bl.y, tr.x, tr.y)
      ) / 2;
      const cornerToInner = (
        pixelDistance(data, width, br.x, br.y, ibr.x, ibr.y) +
        pixelDistance(data, width, bl.x, bl.y, ibl.x, ibl.y) +
        pixelDistance(data, width, tr.x, tr.y, itr.x, itr.y) +
        pixelDistance(data, width, tl.x, tl.y, itl.x, itl.y)
      ) / 4;
      const localActivity = (
        pixelDistance(data, width, br.x, br.y, nbr.x, nbr.y) +
        pixelDistance(data, width, bl.x, bl.y, nbl.x, nbl.y) +
        pixelDistance(data, width, tr.x, tr.y, ntr.x, ntr.y) +
        pixelDistance(data, width, tl.x, tl.y, ntl.x, ntl.y)
      ) / 4;
      const innerActivity = (
        pixelDistance(data, width, ibr.x, ibr.y, Math.max(0, ibr.x - sampleStep), Math.max(0, ibr.y - sampleStep)) +
        pixelDistance(data, width, ibl.x, ibl.y, Math.min(width - 1, ibl.x + sampleStep), Math.max(0, ibl.y - sampleStep)) +
        pixelDistance(data, width, itr.x, itr.y, Math.max(0, itr.x - sampleStep), Math.min(height - 1, itr.y + sampleStep)) +
        pixelDistance(data, width, itl.x, itl.y, Math.min(width - 1, itl.x + sampleStep), Math.min(height - 1, itl.y + sampleStep))
      ) / 4;
      const centerJump = Math.max(verticalJump, horizontalJump);
      const gradientBudget = Math.max(
        5.5,
        innerActivity * 0.34,
        localActivity * Math.min(18, innerGap / Math.max(1, sampleStep)) * 0.74,
      );
      const haloShift = Math.max(0, cornerToInner - gradientBudget);
      const activityDrop = Math.max(0, innerActivity - localActivity);
      const seamSpike = Math.max(0, centerJump - Math.max(9, localActivity * 0.72));
      const diagonalSpike = Math.max(0, diagonalJump - Math.max(10, localActivity * 0.8));
      const sampleScore = seamSpike * 0.52 + haloShift * 0.46 + activityDrop * 0.82 + diagonalSpike * 0.22;

      total += sampleScore;
      count += 1;
      centerJumpTotal += centerJump;
      haloShiftTotal += haloShift;
      activityTotal += localActivity;
      worstScore = Math.max(worstScore, sampleScore);
      if (sampleScore > 13) spotSamples += 1;
      if (seamSpike > 9) seamSamples += 1;
      if (haloShift > 13 || activityDrop > 8.5) haloSamples += 1;
    }
  }

  const score = total / Math.max(1, count);
  const spotRatio = spotSamples / Math.max(1, count);
  const seamRatio = seamSamples / Math.max(1, count);
  const haloRatio = haloSamples / Math.max(1, count);
  return {
    score,
    worstScore,
    centerJump: centerJumpTotal / Math.max(1, count),
    haloShift: haloShiftTotal / Math.max(1, count),
    localActivity: activityTotal / Math.max(1, count),
    spotSamples,
    seamSamples,
    haloSamples,
    spotRatio,
    seamRatio,
    haloRatio,
    junctionRisk: (
      worstScore > 18 ||
      score > 9.5 ||
      (spotSamples >= 3 && spotRatio > 0.08) ||
      (haloSamples >= 3 && haloRatio > 0.12) ||
      (seamSamples >= 2 && seamRatio > 0.08)
    ),
  };
}

function measureTiledPreviewSeam(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const radius = Math.max(8, Math.min(42, Math.round(cross * 0.016)));
  const innerGap = Math.max(radius * 2, Math.round(cross * 0.045));
  const windowSize = Math.max(24, Math.min(112, Math.round(length / 24)));
  const windowStep = Math.max(10, Math.round(windowSize * 0.5));
  const sampleStep = Math.max(1, Math.round(windowSize / 18));
  const depthStep = Math.max(1, Math.round(radius / 9));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let peakWindows = 0;
  let haloWindows = 0;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let centerJumpTotal = 0;
    let nearJumpTotal = 0;
    let haloShiftTotal = 0;
    let edgeActivityTotal = 0;
    let innerActivityTotal = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 1, along);
      centerJumpTotal += previewPixelDistance(data, width, safeAlong, -1, safeAlong, 0, horizontal, cross);
      nearJumpTotal += (
        previewPixelDistance(data, width, safeAlong, -2, safeAlong, -1, horizontal, cross) +
        previewPixelDistance(data, width, safeAlong, 0, safeAlong, 1, horizontal, cross)
      ) / 2;

      for (let depth = 0; depth < radius; depth += depthStep) {
        const edgeA = -1 - depth;
        const edgeB = depth;
        const innerA = -1 - depth - innerGap;
        const innerB = depth + innerGap;
        const nextEdgeA = edgeA - depthStep;
        const nextEdgeB = edgeB + depthStep;
        const nextInnerA = innerA - depthStep;
        const nextInnerB = innerB + depthStep;

        haloShiftTotal += (
          previewPixelDistance(data, width, safeAlong, edgeA, safeAlong, innerA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, edgeB, safeAlong, innerB, horizontal, cross)
        ) / 2;
        edgeActivityTotal += (
          previewPixelDistance(data, width, safeAlong, edgeA, safeAlong, nextEdgeA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, edgeB, safeAlong, nextEdgeB, horizontal, cross)
        ) / 2;
        innerActivityTotal += (
          previewPixelDistance(data, width, safeAlong, innerA, safeAlong, nextInnerA, horizontal, cross) +
          previewPixelDistance(data, width, safeAlong, innerB, safeAlong, nextInnerB, horizontal, cross)
        ) / 2;
        sampleCount += 1;
      }
    }

    const edgeSamples = Math.max(1, Math.ceil((end - start) / sampleStep));
    const centerJump = centerJumpTotal / edgeSamples;
    const nearJump = nearJumpTotal / edgeSamples;
    const haloShift = haloShiftTotal / Math.max(1, sampleCount);
    const edgeActivity = edgeActivityTotal / Math.max(1, sampleCount);
    const innerActivity = innerActivityTotal / Math.max(1, sampleCount);
    const activityDrop = Math.max(0, innerActivity - edgeActivity);
    const lineSpike = Math.max(0, centerJump - nearJump * 1.35 - innerActivity * 0.18);
    const haloScore = Math.max(0, haloShift - innerActivity * 0.24) * 0.5 + activityDrop * 0.82;
    const score = lineSpike * 0.9 + haloScore + Math.max(0, centerJump - edgeActivity * 0.7) * 0.18;

    total += score;
    count += 1;
    worstScore = Math.max(worstScore, score);
    if (lineSpike > 5.5 || centerJump > Math.max(11, nearJump * 2.2)) peakWindows += 1;
    if (haloScore > 11 || activityDrop > 8) haloWindows += 1;
  }

  const score = total / Math.max(1, count);
  const peakRatio = peakWindows / Math.max(1, count);
  const haloRatio = haloWindows / Math.max(1, count);
  return {
    score,
    worstScore,
    peakWindows,
    haloWindows,
    peakRatio,
    haloRatio,
    lineRisk: (
      worstScore > 18 ||
      score > 10.5 ||
      (peakWindows >= 2 && peakRatio > 0.07) ||
      (haloWindows >= 2 && haloRatio > 0.08)
    ),
  };
}

function previewPixelDistance(data, width, alongA, crossA, alongB, crossB, horizontal, crossSize) {
  const normalizedA = wrapIndex(Math.round(crossA), crossSize);
  const normalizedB = wrapIndex(Math.round(crossB), crossSize);
  const x1 = horizontal ? alongA : normalizedA;
  const y1 = horizontal ? normalizedA : alongA;
  const x2 = horizontal ? alongB : normalizedB;
  const y2 = horizontal ? normalizedB : alongB;
  return pixelDistance(data, width, x1, y1, x2, y2);
}

function measurePrintClarity(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 260));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const center = pixelLuminance(data, width, x, y);
      const left = pixelLuminance(data, width, x - step, y);
      const right = pixelLuminance(data, width, x + step, y);
      const top = pixelLuminance(data, width, x, y - step);
      const bottom = pixelLuminance(data, width, x, y + step);
      const gradient = (Math.abs(right - left) + Math.abs(bottom - top)) / 2;
      const detail = Math.abs(center * 4 - left - right - top - bottom) / 4;

      gradientTotal += gradient;
      detailTotal += detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const detailRatio = detailScore / Math.max(1, gradientScore);
  const riskScore = Math.max(0, 3.2 - detailScore) + Math.max(0, 0.18 - detailRatio) * 18 + Math.max(0, gradientScore - detailScore * 2.6) * 0.18;
  const softBlurRisk = contrastScore > 10 && gradientScore > 6 && detailScore < 2.2 && detailRatio < 0.26;
  const blurRisk = (contrastScore > 13 && gradientScore > 4.2 && riskScore > 2.6) || softBlurRisk;

  return {
    detailScore,
    gradientScore,
    contrastScore,
    detailRatio,
    riskScore,
    softBlurRisk,
    blurRisk,
  };
}

function measureUpscaleArtifact(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 360));
  const rowStep = Math.max(sampleStep * 4, Math.round(height / 84));
  const colStep = Math.max(sampleStep * 4, Math.round(width / 84));
  let flatPairs = 0;
  let strongJumps = 0;
  let stairPairs = 0;
  let runSegments = 0;
  let runLengthTotal = 0;
  let diffTotal = 0;
  let diffSquareTotal = 0;
  let count = 0;

  function scanLine(length, luminanceAt) {
    let previousDiff = null;
    let flatRun = 0;
    for (let position = sampleStep; position < length; position += sampleStep) {
      const diff = Math.abs(luminanceAt(position) - luminanceAt(position - sampleStep));
      diffTotal += diff;
      diffSquareTotal += diff * diff;
      count += 1;

      if (diff < 0.55) {
        flatPairs += 1;
        flatRun += 1;
      } else {
        if (flatRun >= 3) {
          runSegments += 1;
          runLengthTotal += flatRun;
        }
        flatRun = 0;
      }

      if (diff > 11) strongJumps += 1;
      if (
        previousDiff !== null &&
        ((previousDiff < 0.65 && diff > 11) || (previousDiff > 11 && diff < 0.65))
      ) {
        stairPairs += 1;
      }
      previousDiff = diff;
    }

    if (flatRun >= 3) {
      runSegments += 1;
      runLengthTotal += flatRun;
    }
  }

  for (let y = 0; y < height; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = 0; x < width; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const flatPairRatio = flatPairs / Math.max(1, count);
  const strongJumpRatio = strongJumps / Math.max(1, count);
  const stairPairRatio = stairPairs / Math.max(1, count);
  const runRatio = runSegments / Math.max(1, count);
  const averageRun = runLengthTotal / Math.max(1, runSegments);
  const meanDiff = diffTotal / Math.max(1, count);
  const diffVariance = Math.max(0, diffSquareTotal / Math.max(1, count) - meanDiff * meanDiff);
  const diffBurstScore = Math.sqrt(diffVariance) / Math.max(1, meanDiff);
  const artifactScore = flatPairRatio * 22 +
    strongJumpRatio * 18 +
    stairPairRatio * 36 +
    Math.min(8, averageRun) * 0.8 +
    diffBurstScore * 3;
  const upscaleArtifactRisk = (
    flatPairRatio > 0.68 &&
    strongJumpRatio > 0.06 &&
    stairPairRatio > 0.14 &&
    averageRun > 3.4 &&
    artifactScore > 32
  );

  return {
    artifactScore,
    flatPairRatio,
    strongJumpRatio,
    stairPairRatio,
    runRatio,
    averageRun,
    diffBurstScore,
    upscaleArtifactRisk,
  };
}

function measurePosterizationArtifact(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 360));
  const rowStep = Math.max(sampleStep * 4, Math.round(height / 90));
  const colStep = Math.max(sampleStep * 4, Math.round(width / 90));
  const toneBins = new Set();
  let flatPairs = 0;
  let bandEdges = 0;
  let moderateJumps = 0;
  let diffCount = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let detailTotal = 0;
  let gradientTotal = 0;
  let sampleCount = 0;

  function scanLine(length, luminanceAt) {
    const values = [];
    for (let position = 0; position < length; position += sampleStep) {
      values.push(luminanceAt(position));
    }
    const diffs = [];
    for (let index = 1; index < values.length; index += 1) {
      diffs.push(Math.abs(values[index] - values[index - 1]));
    }
    for (let index = 0; index < diffs.length; index += 1) {
      const diff = diffs[index];
      const before = index > 0 ? diffs[index - 1] : diff;
      const after = index < diffs.length - 1 ? diffs[index + 1] : diff;
      diffCount += 1;
      if (diff < 0.9) flatPairs += 1;
      if (diff >= 2.6 && diff <= 16) {
        moderateJumps += 1;
        if (before < 1.1 || after < 1.1) {
          bandEdges += 1;
        }
      }
    }
  }

  for (let y = 0; y < height; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = 0; x < width; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const textureStep = Math.max(1, Math.round(Math.max(width, height) / 180));
  for (let y = textureStep; y < height - textureStep; y += textureStep) {
    for (let x = textureStep; x < width - textureStep; x += textureStep) {
      const luminance = pixelLuminance(data, width, x, y);
      const detail = pixelDetailAt(data, width, height, x, y);
      toneBins.add(Math.round(luminance / 3));
      lumTotal += luminance;
      lumSquareTotal += luminance * luminance;
      detailTotal += detail.detail;
      gradientTotal += detail.gradient;
      sampleCount += 1;
    }
  }

  const flatPairRatio = flatPairs / Math.max(1, diffCount);
  const bandEdgeRatio = bandEdges / Math.max(1, diffCount);
  const moderateJumpRatio = moderateJumps / Math.max(1, diffCount);
  const toneBinRatio = toneBins.size / 86;
  const mean = lumTotal / Math.max(1, sampleCount);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, sampleCount) - mean * mean));
  const detailScore = detailTotal / Math.max(1, sampleCount);
  const gradientScore = gradientTotal / Math.max(1, sampleCount);
  const posterizationScore = flatPairRatio * 14 +
    bandEdgeRatio * 38 +
    moderateJumpRatio * 8 +
    Math.max(0, 0.36 - toneBinRatio) * 42 +
    Math.max(0, 2.4 - detailScore) * 2.4;
  const posterizationRisk = (
    contrastScore > 10 &&
    toneBinRatio < 0.29 &&
    flatPairRatio > 0.68 &&
    (bandEdgeRatio > 0.018 || detailScore < 1.6) &&
    posterizationScore > 21.5
  );

  return {
    posterizationScore,
    flatPairRatio,
    bandEdgeRatio,
    moderateJumpRatio,
    toneBinRatio,
    toneBins: toneBins.size,
    contrastScore,
    detailScore,
    gradientScore,
    posterizationRisk,
  };
}

function measureCompressionArtifact(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 420));
  const periods = [4, 6, 8, 10, 12, 16, 20, 24].filter((period) => period < Math.min(width, height) / 3);
  let best = {
    period: 0,
    blockScore: 0,
    gridScore: 0,
    boundaryRatio: 0,
    boundaryAvg: 0,
    interiorAvg: 0,
    peakRatio: 0,
    axisBalance: 0,
    flatBlockRatio: 0,
    blockMeanJump: 0,
    blockStd: 0,
    localTexture: 0,
  };
  let detailTotal = 0;
  let gradientTotal = 0;
  let textureCount = 0;
  const textureStep = Math.max(1, Math.round(Math.max(width, height) / 180));

  for (let y = textureStep; y < height - textureStep; y += textureStep) {
    for (let x = textureStep; x < width - textureStep; x += textureStep) {
      const detail = pixelDetailAt(data, width, height, x, y);
      detailTotal += detail.detail;
      gradientTotal += detail.gradient;
      textureCount += 1;
    }
  }

  const localTexture = (detailTotal * 0.68 + gradientTotal * 0.32) / Math.max(1, textureCount);

  for (const period of periods) {
    const vertical = measureCompressionGridAxis(data, width, height, period, false, sampleStep);
    const horizontal = measureCompressionGridAxis(data, width, height, period, true, sampleStep);
    const blocks = measureCompressionBlocks(data, width, height, period, localTexture);
    const boundaryRatio = (vertical.boundaryRatio + horizontal.boundaryRatio) / 2;
    const peakRatio = (vertical.peakRatio + horizontal.peakRatio) / 2;
    const boundaryAvg = (vertical.boundaryAvg + horizontal.boundaryAvg) / 2;
    const interiorAvg = (vertical.interiorAvg + horizontal.interiorAvg) / 2;
    const axisBalance = Math.min(vertical.peakRatio, horizontal.peakRatio) / Math.max(0.001, Math.max(vertical.peakRatio, horizontal.peakRatio));
    const gridScore = Math.max(0, boundaryRatio - 1.24) * 12 +
      peakRatio * 44 +
      Math.max(0, boundaryAvg - interiorAvg - 1.8) * 0.55 +
      blocks.flatBlockRatio * 5 +
      Math.max(0, blocks.blockMeanJump - localTexture * 0.72) * 0.22 +
      axisBalance * 2;
    const compressionEvidence = Math.max(0, blocks.flatBlockRatio - 0.24) * 2.4 +
      Math.max(0, blocks.blockMeanJump / Math.max(1, localTexture) - 0.88) * 0.62 +
      Math.max(0, 5.5 - interiorAvg) * 0.18;
    const blockScore = gridScore * Math.min(1.25, compressionEvidence);

    if (blockScore > best.blockScore) {
      best = {
        period,
        blockScore,
        gridScore,
        boundaryRatio,
        boundaryAvg,
        interiorAvg,
        peakRatio,
        axisBalance,
        flatBlockRatio: blocks.flatBlockRatio,
        blockMeanJump: blocks.blockMeanJump,
        blockStd: blocks.blockStd,
        localTexture,
      };
    }
  }

  const compressionRisk = best.blockScore > 18 &&
    best.peakRatio > 0.1 &&
    best.boundaryRatio > 1.42 &&
    best.axisBalance > 0.28 &&
    (
      best.flatBlockRatio > 0.28 ||
      best.blockMeanJump > best.localTexture * 0.9 ||
      best.interiorAvg < 4.8
    );

  return {
    ...best,
    compressionRisk,
  };
}

function measureSharpenHaloArtifact(data, width, height) {
  const sampleStep = Math.max(1, Math.round(Math.max(width, height) / 420));
  const rowStep = Math.max(sampleStep * 3, Math.round(height / 120));
  const colStep = Math.max(sampleStep * 3, Math.round(width / 120));
  let haloSamples = 0;
  let severeSamples = 0;
  let count = 0;
  let scoreTotal = 0;
  let contrastTotal = 0;

  function scanLine(length, luminanceAt) {
    for (let position = sampleStep * 2; position < length - sampleStep * 2; position += sampleStep) {
      const a = luminanceAt(position - sampleStep * 2);
      const b = luminanceAt(position - sampleStep);
      const c = luminanceAt(position);
      const d = luminanceAt(position + sampleStep);
      const e = luminanceAt(position + sampleStep * 2);
      const outer = (a + e) / 2;
      const ring = (b + d) / 2;
      const darkCore = c < outer - 18 && b > Math.max(a, c) + 8 && d > Math.max(e, c) + 8;
      const lightCore = c > outer + 18 && b < Math.min(a, c) - 8 && d < Math.min(e, c) - 8;
      let localHalo = 0;

      if (darkCore) {
        localHalo = Math.min(b - Math.max(a, c), d - Math.max(e, c), outer - c) +
          Math.max(0, ring - outer) * 0.7;
      }
      if (lightCore) {
        localHalo = Math.min(Math.min(a, c) - b, Math.min(e, c) - d, c - outer) +
          Math.max(0, outer - ring) * 0.7;
      }

      const edgeContrast = Math.max(Math.abs(b - c), Math.abs(d - c), Math.abs(a - b), Math.abs(e - d));
      if (localHalo > 6 && edgeContrast > 24) {
        haloSamples += 1;
        scoreTotal += localHalo;
        contrastTotal += edgeContrast;
        if (localHalo > 13 && edgeContrast > 40) severeSamples += 1;
      }
      count += 1;
    }
  }

  for (let y = sampleStep * 2; y < height - sampleStep * 2; y += rowStep) {
    scanLine(width, (x) => pixelLuminance(data, width, x, y));
  }
  for (let x = sampleStep * 2; x < width - sampleStep * 2; x += colStep) {
    scanLine(height, (y) => pixelLuminance(data, width, x, y));
  }

  const haloRatio = haloSamples / Math.max(1, count);
  const severeRatio = severeSamples / Math.max(1, count);
  const averageHalo = scoreTotal / Math.max(1, haloSamples);
  const averageContrast = contrastTotal / Math.max(1, haloSamples);
  const densityWeight = Math.min(1, haloRatio / 0.02);
  const haloScore = haloRatio * 120 +
    severeRatio * 180 +
    Math.max(0, averageHalo - 8) * 0.18 * densityWeight +
    Math.max(0, averageContrast - 36) * 0.035 * densityWeight;
  const haloRisk = haloScore > 5.2 &&
    haloRatio > 0.018 &&
    averageHalo > 8.2 &&
    averageContrast > 30;

  return {
    haloScore,
    haloRatio,
    severeRatio,
    averageHalo,
    averageContrast,
    haloSamples,
    severeSamples,
    sampleCount: count,
    haloRisk,
  };
}

function measureCompressionGridAxis(data, width, height, period, horizontal, sampleStep) {
  const cross = horizontal ? height : width;
  const length = horizontal ? width : height;
  const crossStep = Math.max(sampleStep, Math.round(cross / 150));
  let boundaryTotal = 0;
  let interiorTotal = 0;
  let peaks = 0;
  let count = 0;

  for (let line = period; line < length - period; line += period) {
    for (let crossPos = 1; crossPos < cross - 1; crossPos += crossStep) {
      const ax = horizontal ? line : crossPos;
      const ay = horizontal ? crossPos : line;
      const bx = horizontal ? line - 1 : crossPos;
      const by = horizontal ? crossPos : line - 1;
      const in1x = horizontal ? Math.min(width - 1, line + 1) : crossPos;
      const in1y = horizontal ? crossPos : Math.min(height - 1, line + 1);
      const in2x = horizontal ? Math.min(width - 1, line + 2) : crossPos;
      const in2y = horizontal ? crossPos : Math.min(height - 1, line + 2);
      const in3x = horizontal ? Math.max(0, line - 2) : crossPos;
      const in3y = horizontal ? crossPos : Math.max(0, line - 2);
      const in4x = horizontal ? Math.max(0, line - 3) : crossPos;
      const in4y = horizontal ? crossPos : Math.max(0, line - 3);
      const boundary = Math.abs(pixelLuminance(data, width, ax, ay) - pixelLuminance(data, width, bx, by));
      const interior = (
        Math.abs(pixelLuminance(data, width, in2x, in2y) - pixelLuminance(data, width, in1x, in1y)) +
        Math.abs(pixelLuminance(data, width, in3x, in3y) - pixelLuminance(data, width, in4x, in4y))
      ) / 2;

      boundaryTotal += boundary;
      interiorTotal += interior;
      count += 1;
      if (boundary > Math.max(4.8, interior * 1.8 + 1.8)) peaks += 1;
    }
  }

  const boundaryAvg = boundaryTotal / Math.max(1, count);
  const interiorAvg = interiorTotal / Math.max(1, count);
  return {
    boundaryAvg,
    interiorAvg,
    boundaryRatio: boundaryAvg / Math.max(1, interiorAvg),
    peakRatio: peaks / Math.max(1, count),
  };
}

function measureCompressionBlocks(data, width, height, period, localTexture) {
  const blockStep = Math.max(1, Math.round(period / 4));
  let flatBlocks = 0;
  let blocks = 0;
  let jumpTotal = 0;
  let jumpCount = 0;
  let stdTotal = 0;

  for (let y = 0; y < height - period; y += period) {
    for (let x = 0; x < width - period; x += period) {
      const block = compressionBlockMean(data, width, x, y, period, blockStep);
      stdTotal += block.std;
      blocks += 1;
      if (block.std < Math.max(3.2, localTexture * 0.58)) flatBlocks += 1;

      if (x + period < width - period) {
        const right = compressionBlockMean(data, width, x + period, y, period, blockStep);
        jumpTotal += Math.abs(block.mean - right.mean);
        jumpCount += 1;
      }
      if (y + period < height - period) {
        const bottom = compressionBlockMean(data, width, x, y + period, period, blockStep);
        jumpTotal += Math.abs(block.mean - bottom.mean);
        jumpCount += 1;
      }
    }
  }

  return {
    flatBlockRatio: flatBlocks / Math.max(1, blocks),
    blockMeanJump: jumpTotal / Math.max(1, jumpCount),
    blockStd: stdTotal / Math.max(1, blocks),
  };
}

function compressionBlockMean(data, width, x, y, period, blockStep) {
  let total = 0;
  let totalSquare = 0;
  let count = 0;
  const start = Math.max(1, Math.round(period * 0.22));
  const end = Math.max(start + 1, Math.round(period * 0.78));

  for (let by = start; by < end; by += blockStep) {
    for (let bx = start; bx < end; bx += blockStep) {
      const luminance = pixelLuminance(data, width, x + bx, y + by);
      total += luminance;
      totalSquare += luminance * luminance;
      count += 1;
    }
  }

  const mean = total / Math.max(1, count);
  const variance = Math.max(0, totalSquare / Math.max(1, count) - mean * mean);
  return {
    mean,
    std: Math.sqrt(variance),
  };
}

function measurePrintRichness(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 260));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let colorSpreadTotal = 0;
  let activeSamples = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const index = (Math.round(y) * width + Math.round(x)) * 4;
      const center = pixelLuminanceAt(data, index);
      const left = pixelLuminance(data, width, x - step, y);
      const right = pixelLuminance(data, width, x + step, y);
      const top = pixelLuminance(data, width, x, y - step);
      const bottom = pixelLuminance(data, width, x, y + step);
      const gradient = (Math.abs(right - left) + Math.abs(bottom - top)) / 2;
      const detail = Math.abs(center * 4 - left - right - top - bottom) / 4;
      const channelMax = Math.max(data[index], data[index + 1], data[index + 2]);
      const channelMin = Math.min(data[index], data[index + 1], data[index + 2]);

      gradientTotal += gradient;
      detailTotal += detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      colorSpreadTotal += channelMax - channelMin;
      if (gradient > 3.2 || detail > 1.25) {
        activeSamples += 1;
      }
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const colorSpreadScore = colorSpreadTotal / Math.max(1, count);
  const activeRatio = activeSamples / Math.max(1, count);
  const richnessScore = contrastScore * 0.34 + gradientScore * 0.32 + detailScore * 0.88 + activeRatio * 18;
  const lowInformationRisk = (
    contrastScore < 4.6 &&
    gradientScore < 2.7 &&
    detailScore < 1.05 &&
    activeRatio < 0.055 &&
    richnessScore < 5.2
  );

  return {
    richnessScore,
    activeRatio,
    detailScore,
    gradientScore,
    contrastScore,
    colorSpreadScore,
    lowInformationRisk,
  };
}

function measurePrintTextureDensity(data, width, height) {
  const step = Math.max(1, Math.round(Math.max(width, height) / 280));
  let gradientTotal = 0;
  let detailTotal = 0;
  let lumTotal = 0;
  let lumSquareTotal = 0;
  let activeSamples = 0;
  let fineDetailSamples = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const detail = pixelDetailAt(data, width, height, x, y);
      const center = pixelLuminance(data, width, x, y);
      const detailRatio = detail.detail / Math.max(1, detail.gradient);

      gradientTotal += detail.gradient;
      detailTotal += detail.detail;
      lumTotal += center;
      lumSquareTotal += center * center;
      if (detail.gradient > 4.6 || detail.detail > 1.35) activeSamples += 1;
      if (detail.detail > 2.2 || (detail.gradient > 7 && detailRatio > 0.22)) fineDetailSamples += 1;
      count += 1;
    }
  }

  const gradientScore = gradientTotal / Math.max(1, count);
  const detailScore = detailTotal / Math.max(1, count);
  const mean = lumTotal / Math.max(1, count);
  const contrastScore = Math.sqrt(Math.max(0, lumSquareTotal / Math.max(1, count) - mean * mean));
  const activeRatio = activeSamples / Math.max(1, count);
  const fineDetailRatio = fineDetailSamples / Math.max(1, count);
  const textureDensityScore = detailScore * 1.25 + gradientScore * 0.28 + fineDetailRatio * 26 + activeRatio * 8;
  const lowTextureDensityRisk = (
    contrastScore > 5.8 &&
    activeRatio < 0.22 &&
    fineDetailRatio < 0.09 &&
    detailScore < 1.85 &&
    gradientScore < 5.6 &&
    textureDensityScore < 6.2
  );

  return {
    textureDensityScore,
    activeRatio,
    fineDetailRatio,
    detailScore,
    gradientScore,
    contrastScore,
    lowTextureDensityRisk,
  };
}

function measurePatternBalance(data, width, height) {
  const columns = 5;
  const rows = 5;
  const cellScores = [];
  let total = 0;
  let activeCells = 0;
  let centerTotal = 0;
  let centerCount = 0;
  let edgeTotal = 0;
  let edgeCount = 0;
  let maxCell = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor((column / columns) * width);
      const x1 = Math.floor(((column + 1) / columns) * width);
      const y0 = Math.floor((row / rows) * height);
      const y1 = Math.floor(((row + 1) / rows) * height);
      const activity = measureCellActivity(data, width, height, x0, y0, x1, y1);
      const centerCell = column >= 1 && column <= 3 && row >= 1 && row <= 3;
      const edgeCell = column === 0 || column === columns - 1 || row === 0 || row === rows - 1;

      cellScores.push(activity);
      total += activity;
      maxCell = Math.max(maxCell, activity);
      if (activity > 4.4) activeCells += 1;
      if (centerCell) {
        centerTotal += activity;
        centerCount += 1;
      }
      if (edgeCell) {
        edgeTotal += activity;
        edgeCount += 1;
      }
    }
  }

  const average = total / Math.max(1, cellScores.length);
  const centerActivity = centerTotal / Math.max(1, centerCount);
  const edgeActivity = edgeTotal / Math.max(1, edgeCount);
  const activeCellRatio = activeCells / Math.max(1, cellScores.length);
  const centerToEdgeRatio = centerActivity / Math.max(0.8, edgeActivity);
  const dominanceRatio = maxCell / Math.max(1, average);
  const balanceScore = Math.max(0, centerToEdgeRatio - 1.7) * 2.4 + Math.max(0, dominanceRatio - 3.2) * 1.2 + Math.max(0, 0.38 - activeCellRatio) * 8;
  const centerDominanceRisk = (
    centerActivity > 4.8 &&
    edgeActivity < 2.9 &&
    activeCellRatio < 0.34 &&
    centerToEdgeRatio > 3.4 &&
    dominanceRatio > 4.2 &&
    balanceScore > 6.2
  );

  return {
    balanceScore,
    centerActivity,
    edgeActivity,
    activeCellRatio,
    centerToEdgeRatio,
    dominanceRatio,
    centerDominanceRisk,
  };
}

function measureCellActivity(data, width, height, x0, y0, x1, y1) {
  const cellWidth = Math.max(1, x1 - x0);
  const cellHeight = Math.max(1, y1 - y0);
  const step = Math.max(1, Math.round(Math.max(cellWidth, cellHeight) / 18));
  let total = 0;
  let count = 0;

  for (let y = Math.max(1, y0 + step); y < Math.min(height - 1, y1 - step); y += step) {
    for (let x = Math.max(1, x0 + step); x < Math.min(width - 1, x1 - step); x += step) {
      const detail = pixelDetailAt(data, width, height, x, y);
      total += detail.gradient * 0.42 + detail.detail * 0.92;
      count += 1;
    }
  }

  return total / Math.max(1, count);
}

function measureMirrorAxisArtifact(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const axisIndex = Math.floor(cross / 2);
  const radius = Math.max(8, Math.min(64, Math.round(cross * 0.038)));
  const depthStep = Math.max(1, Math.round(radius / 10));
  const sampleStep = Math.max(1, Math.round(length / 260));
  const windowSize = Math.max(30, Math.min(132, Math.round(length / 22)));
  const windowStep = Math.max(12, Math.round(windowSize * 0.5));
  let total = 0;
  let count = 0;
  let worstScore = 0;
  let mirrorWindows = 0;
  let activeWindows = 0;
  let mirrorSampleRatioTotal = 0;
  let bestMirrorRatio = 1;

  for (let start = 0; start < length; start += windowStep) {
    const end = Math.min(length, start + windowSize);
    let mirrorTotal = 0;
    let crossActivityTotal = 0;
    let alongActivityTotal = 0;
    let suspiciousSamples = 0;
    let activeSamples = 0;
    let sampleCount = 0;

    for (let along = start; along < end; along += sampleStep) {
      const safeAlong = Math.min(length - 2, Math.max(1, along));
      const nextAlong = Math.min(length - 1, safeAlong + sampleStep);

      for (let depth = 0; depth < radius; depth += depthStep) {
        const leftCross = Math.max(1, Math.min(cross - 2, axisIndex - 1 - depth));
        const rightCross = Math.max(1, Math.min(cross - 2, axisIndex + depth));
        const leftOuter = Math.max(1, Math.min(cross - 2, leftCross - depthStep));
        const rightOuter = Math.max(1, Math.min(cross - 2, rightCross + depthStep));
        const left = horizontal ? { x: safeAlong, y: leftCross } : { x: leftCross, y: safeAlong };
        const right = horizontal ? { x: safeAlong, y: rightCross } : { x: rightCross, y: safeAlong };
        const leftFar = horizontal ? { x: safeAlong, y: leftOuter } : { x: leftOuter, y: safeAlong };
        const rightFar = horizontal ? { x: safeAlong, y: rightOuter } : { x: rightOuter, y: safeAlong };
        const leftNext = horizontal ? { x: nextAlong, y: leftCross } : { x: leftCross, y: nextAlong };
        const rightNext = horizontal ? { x: nextAlong, y: rightCross } : { x: rightCross, y: nextAlong };
        const mirrorDiff = pixelDistance(data, width, left.x, left.y, right.x, right.y);
        const crossActivity = (
          pixelDistance(data, width, left.x, left.y, leftFar.x, leftFar.y) +
          pixelDistance(data, width, right.x, right.y, rightFar.x, rightFar.y)
        ) / 2;
        const alongActivity = (
          pixelDistance(data, width, left.x, left.y, leftNext.x, leftNext.y) +
          pixelDistance(data, width, right.x, right.y, rightNext.x, rightNext.y)
        ) / 2;
        const activity = crossActivity * 0.75 + alongActivity * 0.25;

        mirrorTotal += mirrorDiff;
        crossActivityTotal += crossActivity;
        alongActivityTotal += alongActivity;
        sampleCount += 1;
        if (activity > 6.5) activeSamples += 1;
        if (activity > 7.2 && mirrorDiff < Math.max(5.2, activity * 0.42)) suspiciousSamples += 1;
      }
    }

    const mirrorDiff = mirrorTotal / Math.max(1, sampleCount);
    const crossActivity = crossActivityTotal / Math.max(1, sampleCount);
    const alongActivity = alongActivityTotal / Math.max(1, sampleCount);
    const activity = crossActivity * 0.75 + alongActivity * 0.25;
    const mirrorRatio = mirrorDiff / Math.max(1, activity);
    const suspiciousRatio = suspiciousSamples / Math.max(1, sampleCount);
    const activeRatio = activeSamples / Math.max(1, sampleCount);
    const mirrorExcess = Math.max(0, activity * 0.72 - mirrorDiff);
    const windowScore = activeRatio > 0.22
      ? mirrorExcess * (0.55 + Math.min(0.85, suspiciousRatio * 3.2)) + Math.max(0, 0.45 - mirrorRatio) * 8
      : 0;

    total += windowScore;
    count += 1;
    worstScore = Math.max(worstScore, windowScore);
    bestMirrorRatio = Math.min(bestMirrorRatio, mirrorRatio);
    mirrorSampleRatioTotal += suspiciousRatio;
    if (activeRatio > 0.22) activeWindows += 1;
    if (windowScore > 5.8 && suspiciousRatio > 0.18) mirrorWindows += 1;
  }

  const score = total / Math.max(1, count);
  const mirrorWindowRatio = mirrorWindows / Math.max(1, count);
  const activeWindowRatio = activeWindows / Math.max(1, count);
  const mirrorSampleRatio = mirrorSampleRatioTotal / Math.max(1, count);
  return {
    score,
    worstScore,
    mirrorWindows,
    activeWindows,
    mirrorWindowRatio,
    activeWindowRatio,
    mirrorSampleRatio,
    bestMirrorRatio,
    mirrorRisk: (
      worstScore > 12.5 ||
      score > 6.8 ||
      (mirrorWindows >= 4 && mirrorWindowRatio > 0.18 && activeWindowRatio > 0.2 && mirrorSampleRatio > 0.18 && score > 5.6 && worstScore > 8)
    ),
  };
}

function measurePreTiledPreviewArtifact(data, width, height) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  if (halfW < 8 || halfH < 8) {
    return {
      score: 0,
      duplicatePairs: 0,
      activePairs: 0,
      bestPairRatio: 1,
      duplicateRisk: false,
    };
  }

  const pairs = [
    measureRepeatedTilePair(data, width, height, halfW, halfH, halfW, 0),
    measureRepeatedTilePair(data, width, height, halfW, halfH, 0, halfH),
    measureRepeatedTilePair(data, width, height, halfW, halfH, halfW, halfH),
  ];
  const duplicatePairs = pairs.filter((pair) => pair.duplicate).length;
  const activePairs = pairs.filter((pair) => pair.activeRatio > 0.2).length;
  const score = pairs.reduce((sum, pair) => sum + pair.score, 0) / Math.max(1, pairs.length);
  const worstScore = Math.max(...pairs.map((pair) => pair.score));
  const bestPairRatio = Math.min(...pairs.map((pair) => pair.mismatchRatio));
  const averageSimilarity = pairs.reduce((sum, pair) => sum + pair.similarRatio, 0) / Math.max(1, pairs.length);

  return {
    score,
    worstScore,
    duplicatePairs,
    activePairs,
    bestPairRatio,
    averageSimilarity,
    pairs,
    duplicateRisk: (
      duplicatePairs >= 2 &&
      activePairs >= 2 &&
      score > 5.8 &&
      worstScore > 8 &&
      averageSimilarity > 0.22 &&
      bestPairRatio < 0.48
    ),
  };
}

function measureRepeatedTilePair(data, width, height, tileW, tileH, dx, dy) {
  const step = Math.max(1, Math.round(Math.min(tileW, tileH) / 90));
  const margin = Math.max(2, step * 2);
  let mismatchTotal = 0;
  let activityTotal = 0;
  let similarSamples = 0;
  let activeSamples = 0;
  let count = 0;

  for (let y = margin; y < tileH - margin; y += step) {
    for (let x = margin; x < tileW - margin; x += step) {
      const ax = x;
      const ay = y;
      const bx = x + dx;
      const by = y + dy;
      if (bx < 1 || bx >= width - 1 || by < 1 || by >= height - 1) continue;
      const detailA = pixelDetailAt(data, width, height, ax, ay);
      const detailB = pixelDetailAt(data, width, height, bx, by);
      const activity = (
        detailA.gradient * 0.42 +
        detailA.detail * 0.9 +
        detailB.gradient * 0.42 +
        detailB.detail * 0.9
      ) / 2;
      const mismatch = pixelDistance(data, width, ax, ay, bx, by);

      mismatchTotal += mismatch;
      activityTotal += activity;
      count += 1;
      if (activity > 5.8) activeSamples += 1;
      if (activity > 6.4 && mismatch < Math.max(5.2, activity * 0.42)) similarSamples += 1;
    }
  }

  const mismatch = mismatchTotal / Math.max(1, count);
  const activity = activityTotal / Math.max(1, count);
  const mismatchRatio = mismatch / Math.max(1, activity);
  const similarRatio = similarSamples / Math.max(1, count);
  const activeRatio = activeSamples / Math.max(1, count);
  const score = activeRatio > 0.2
    ? Math.max(0, activity * 0.56 - mismatch) * (0.65 + Math.min(0.9, similarRatio * 2.4)) + Math.max(0, 0.44 - mismatchRatio) * 9
    : 0;

  return {
    mismatch,
    activity,
    mismatchRatio,
    similarRatio,
    activeRatio,
    score,
    duplicate: (
      activeRatio > 0.2 &&
      similarRatio > 0.22 &&
      mismatchRatio < 0.48 &&
      score > 5.8
    ),
  };
}

function pixelDetailAt(data, width, height, x, y) {
  const safeX = Math.min(width - 2, Math.max(1, Math.round(x)));
  const safeY = Math.min(height - 2, Math.max(1, Math.round(y)));
  const center = pixelLuminance(data, width, safeX, safeY);
  const left = pixelLuminance(data, width, safeX - 1, safeY);
  const right = pixelLuminance(data, width, safeX + 1, safeY);
  const top = pixelLuminance(data, width, safeX, safeY - 1);
  const bottom = pixelLuminance(data, width, safeX, safeY + 1);
  return {
    detail: Math.abs(center * 4 - left - right - top - bottom) / 4,
    gradient: (Math.abs(right - left) + Math.abs(bottom - top)) / 2,
  };
}

function pixelLuminance(data, width, x, y) {
  const index = (Math.round(y) * width + Math.round(x)) * 4;
  return pixelLuminanceAt(data, index);
}

function edgeActivity(data, width, x1, y1, x2, y2) {
  return pixelDistance(data, width, x1, y1, x2, y2);
}

function pixelLuminanceAt(data, index) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function repairSeams(ctx, width, height, options = {}) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const source = new Uint8ClampedArray(data);
  const check = options.check || null;
  const band = Math.max(
    options.minBand || 18,
    Math.min(options.maxBand || 96, Math.round(Math.min(width, height) * (options.bandRatio || 0.026)))
  );
  const strength = options.strength ?? 0.86;
  const maxDiff = options.maxDiff ?? 120;
  const textureMix = options.textureMix ?? 0.62;
  const feather = Math.max(6, Math.min(48, Math.round(band * 0.28)));
  const repairHorizontal = !check || check.horizontalScore >= check.verticalScore * 0.55 || check.issues?.some((issue) => issue.includes("横档"));
  const repairVertical = !check || check.verticalScore >= check.horizontalScore * 0.55 || check.issues?.some((issue) => issue.includes("竖档"));

  if (repairHorizontal) {
    for (let y = 0; y < band; y += 1) {
      const weight = seamFeatherWeight(y, band) * strength;
      const topY = y;
      const bottomY = height - 1 - y;

      for (let x = 0; x < width; x += 1) {
        const top = (topY * width + x) * 4;
        const bottom = (bottomY * width + x) * 4;
        const innerTopY = Math.min(height - 1, y + band + feather);
        const innerBottomY = Math.max(0, height - 1 - y - band - feather);
        const prevX = Math.max(0, x - 1);
        const nextX = Math.min(width - 1, x + 1);
        const innerTop = (innerTopY * width + x) * 4;
        const innerBottom = (innerBottomY * width + x) * 4;
        const innerTopPrev = (innerTopY * width + prevX) * 4;
        const innerTopNext = (innerTopY * width + nextX) * 4;
        const innerBottomPrev = (innerBottomY * width + prevX) * 4;
        const innerBottomNext = (innerBottomY * width + nextX) * 4;
        blendSeamPair(data, source, top, bottom, innerTop, innerBottom, innerTopPrev, innerTopNext, innerBottomPrev, innerBottomNext, weight, maxDiff, textureMix);
      }
    }
    featherSeamTransition(data, source, width, height, band, feather, "horizontal");
  }

  if (repairVertical) {
    for (let x = 0; x < band; x += 1) {
      const weight = seamFeatherWeight(x, band) * strength;
      const leftX = x;
      const rightX = width - 1 - x;

      for (let y = 0; y < height; y += 1) {
        const left = (y * width + leftX) * 4;
        const right = (y * width + rightX) * 4;
        const innerLeftX = Math.min(width - 1, x + band + feather);
        const innerRightX = Math.max(0, width - 1 - x - band - feather);
        const prevY = Math.max(0, y - 1);
        const nextY = Math.min(height - 1, y + 1);
        const innerLeft = (y * width + innerLeftX) * 4;
        const innerRight = (y * width + innerRightX) * 4;
        const innerLeftPrev = (prevY * width + innerLeftX) * 4;
        const innerLeftNext = (nextY * width + innerLeftX) * 4;
        const innerRightPrev = (prevY * width + innerRightX) * 4;
        const innerRightNext = (nextY * width + innerRightX) * 4;
        blendSeamPair(data, source, left, right, innerLeft, innerRight, innerLeftPrev, innerLeftNext, innerRightPrev, innerRightNext, weight, maxDiff, textureMix);
      }
    }
    featherSeamTransition(data, source, width, height, band, feather, "vertical");
  }

  ctx.putImageData(imageData, 0, 0);
}

function forcePeriodicSeams(ctx, width, height, check = null) {
  repairSeams(ctx, width, height, {
    check,
    bandRatio: 0.04,
    minBand: 48,
    maxBand: 210,
    strength: 0.78,
    maxDiff: Infinity,
    textureMix: 0.7,
  });

  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const band = Math.max(18, Math.min(118, Math.round(Math.min(width, height) * 0.022)));
  lockOppositeBands(data, width, height, band, "horizontal");
  lockOppositeBands(data, width, height, band, "vertical");
  restoreEdgeMicroTexture(data, width, height, band, "horizontal");
  restoreEdgeMicroTexture(data, width, height, band, "vertical");
  if (shouldStabilizePeriodicCorners(check)) {
    const cornerBand = Math.max(16, Math.min(96, Math.round(Math.min(width, height) * 0.018)));
    stabilizePeriodicCorners(data, width, height, cornerBand);
  }
  smoothInternalGuideLines(data, width, height, check);
  refineSeamForTiledPreview(data, width, height, check);
  ctx.putImageData(imageData, 0, 0);
}

function shouldStabilizePeriodicCorners(check = null) {
  if (!check) return true;
  const issueText = [
    check.finalIssueType,
    ...(Array.isArray(check.issues) ? check.issues : []),
  ].filter(Boolean).join(" ");
  return (
    /回头没接|四角平铺交汇|横档|竖档|最终JPG边缘硬线|平铺预览中心线|平铺边带|接缝过渡/.test(issueText) ||
    (check.cornerScore || 0) > 7.5 ||
    (check.tiledCorner?.worstScore || 0) > 12 ||
    ((check.horizontalScore || 0) > 7.4 && (check.verticalScore || 0) > 7.4)
  );
}

function shouldRefineSeamForTiledPreview(check = null) {
  if (!check) return true;
  const issueText = [
    check.finalIssueType,
    ...(Array.isArray(check.issues) ? check.issues : []),
  ].filter(Boolean).join(" ");
  return (
    /四角平铺交汇|平铺边带|平铺预览中心线|画框留白边界|接缝过渡|最终JPG边缘硬线|横档|竖档|回头没接/.test(issueText) ||
    check.tiledCorner?.junctionRisk ||
    (check.tiledCorner?.worstScore || 0) > 10 ||
    (check.tiledCorner?.score || 0) > 4.8 ||
    check.bandHorizontal?.bandRisk ||
    check.bandVertical?.bandRisk ||
    check.outerFrame?.frameRisk ||
    Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0) > 6.2
  );
}

function refineSeamForTiledPreview(data, width, height, check = null) {
  if (!shouldRefineSeamForTiledPreview(check)) return;

  stabilizeEdgeClosureBands(data, width, height, "horizontal");
  stabilizeEdgeClosureBands(data, width, height, "vertical");
  restoreEdgeZeroMeanTexture(data, width, height, "horizontal");
  restoreEdgeZeroMeanTexture(data, width, height, "vertical");
  harmonizeEdgeHaloBands(data, width, height, "horizontal");
  harmonizeEdgeHaloBands(data, width, height, "vertical");
  smoothEdgeHaloActivity(data, width, height, "horizontal");
  smoothEdgeHaloActivity(data, width, height, "vertical");

  if (shouldStabilizePeriodicCorners(check)) {
    const cornerBand = Math.max(48, Math.min(250, Math.round(Math.min(width, height) * 0.05)));
    stabilizePeriodicCorners(data, width, height, cornerBand);
    restoreTiledCornerActivity(data, width, height);
    smoothTiledCornerReferencePatches(data, width, height);
    softenTiledCornerSpikes(data, width, height);
    lockTiledCornerPatch(data, width, height);
  }
}

function stabilizeEdgeClosureBands(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const size = Math.min(width, height);
  const band = Math.max(32, Math.min(320, Math.round(size * 0.062)));
  const sampleOffset = Math.max(96, Math.round(cross * 0.045));
  const source = new Uint8ClampedArray(data);

  for (let d = 0; d < band; d += 1) {
    const weight = seamFeatherWeight(d, band) * 0.94;
    const aCross = d;
    const bCross = cross - 1 - d;
    const innerA = Math.min(cross - 1, d + sampleOffset);
    const innerB = Math.max(0, cross - 1 - d - sampleOffset);

    for (let along = 0; along < length; along += 1) {
      const a = periodicIndex(width, along, aCross, horizontal);
      const b = periodicIndex(width, along, bCross, horizontal);
      const ia = periodicIndex(width, along, innerA, horizontal);
      const ib = periodicIndex(width, along, innerB, horizontal);

      for (let channel = 0; channel < 3; channel += 1) {
        const edgeAverage = (source[a + channel] + source[b + channel]) / 2;
        const innerAverage = (source[ia + channel] + source[ib + channel]) / 2;
        const target = edgeAverage * 0.16 + innerAverage * 0.84;
        data[a + channel] = clamp(data[a + channel] * (1 - weight) + target * weight);
        data[b + channel] = clamp(data[b + channel] * (1 - weight) + target * weight);
      }
    }
  }
}

function restoreEdgeZeroMeanTexture(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const size = Math.min(width, height);
  const band = Math.max(32, Math.min(320, Math.round(size * 0.062)));
  const sampleOffset = Math.max(96, Math.round(cross * 0.045));
  const sampleStep = Math.max(6, Math.min(34, Math.round(size * 0.0068)));
  const source = new Uint8ClampedArray(data);

  for (let d = 0; d < band; d += 1) {
    const textureWeight = (0.34 + 0.66 * Math.pow(1 - d / Math.max(1, band), 1.15)) * 0.72;
    const aCross = d;
    const bCross = cross - 1 - d;
    const innerA = Math.min(cross - 1, d + sampleOffset);
    const innerB = Math.max(0, cross - 1 - d - sampleOffset);
    const mean = [0, 0, 0];

    for (let along = 0; along < length; along += 1) {
      const details = edgeTextureDetail(source, width, length, cross, along, innerA, innerB, sampleStep, horizontal);
      mean[0] += details[0];
      mean[1] += details[1];
      mean[2] += details[2];
    }
    mean[0] /= Math.max(1, length);
    mean[1] /= Math.max(1, length);
    mean[2] /= Math.max(1, length);

    for (let along = 0; along < length; along += 1) {
      const a = periodicIndex(width, along, aCross, horizontal);
      const b = periodicIndex(width, along, bCross, horizontal);
      const details = edgeTextureDetail(source, width, length, cross, along, innerA, innerB, sampleStep, horizontal);

      for (let channel = 0; channel < 3; channel += 1) {
        const detail = details[channel] - mean[channel] * 0.7;
        data[a + channel] = clamp(data[a + channel] + detail * textureWeight);
        data[b + channel] = clamp(data[b + channel] + detail * textureWeight);
      }
    }
  }
}

function edgeTextureDetail(source, width, length, cross, along, innerA, innerB, sampleStep, horizontal) {
  const prevAlong = clampCoord(along - sampleStep, length);
  const nextAlong = clampCoord(along + sampleStep, length);
  const prevA = clampCoord(innerA - sampleStep, cross);
  const nextA = clampCoord(innerA + sampleStep, cross);
  const prevB = clampCoord(innerB - sampleStep, cross);
  const nextB = clampCoord(innerB + sampleStep, cross);
  const ia = periodicIndex(width, along, innerA, horizontal);
  const ib = periodicIndex(width, along, innerB, horizontal);
  const blurA = [
    periodicIndex(width, along, prevA, horizontal),
    periodicIndex(width, along, nextA, horizontal),
    periodicIndex(width, prevAlong, innerA, horizontal),
    periodicIndex(width, nextAlong, innerA, horizontal),
  ];
  const blurB = [
    periodicIndex(width, along, prevB, horizontal),
    periodicIndex(width, along, nextB, horizontal),
    periodicIndex(width, prevAlong, innerB, horizontal),
    periodicIndex(width, nextAlong, innerB, horizontal),
  ];
  const detail = [0, 0, 0];

  for (let channel = 0; channel < 3; channel += 1) {
    const averageA = blurA.reduce((sum, index) => sum + source[index + channel], 0) / blurA.length;
    const averageB = blurB.reduce((sum, index) => sum + source[index + channel], 0) / blurB.length;
    detail[channel] = ((source[ia + channel] - averageA) + (source[ib + channel] - averageB)) / 2;
  }
  return detail;
}

function harmonizeEdgeHaloBands(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(8, Math.min(38, Math.round(cross * 0.014)));
  const innerGap = Math.max(depth * 3, Math.round(cross * 0.04));
  const source = new Uint8ClampedArray(data);

  for (let d = 0; d < depth; d += 1) {
    const edgeWeight = Math.pow(1 - d / Math.max(1, depth), 1.25) * 0.08;
    const haloWeight = 0.52 + Math.pow(1 - d / Math.max(1, depth), 1.05) * 0.42;
    const aCross = d;
    const bCross = cross - 1 - d;
    const haloA = Math.min(cross - 1, d + innerGap);
    const haloB = Math.max(0, cross - 1 - d - innerGap);

    for (let along = 0; along < length; along += 1) {
      const a = periodicIndex(width, along, aCross, horizontal);
      const b = periodicIndex(width, along, bCross, horizontal);
      const ha = periodicIndex(width, along, haloA, horizontal);
      const hb = periodicIndex(width, along, haloB, horizontal);

      for (let channel = 0; channel < 3; channel += 1) {
        const edgeAverage = (source[a + channel] + source[b + channel]) / 2;
        const haloAverage = (source[ha + channel] + source[hb + channel]) / 2;
        const target = edgeAverage * 0.82 + haloAverage * 0.18;
        data[a + channel] = clamp(data[a + channel] * (1 - edgeWeight) + target * edgeWeight);
        data[b + channel] = clamp(data[b + channel] * (1 - edgeWeight) + target * edgeWeight);
        data[ha + channel] = clamp(data[ha + channel] * (1 - haloWeight) + target * haloWeight);
        data[hb + channel] = clamp(data[hb + channel] * (1 - haloWeight) + target * haloWeight);
      }
    }
  }
}

function smoothEdgeHaloActivity(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const depth = Math.max(8, Math.min(38, Math.round(cross * 0.014)));
  const innerGap = Math.max(depth * 3, Math.round(cross * 0.04));
  const sampleStep = Math.max(2, Math.min(8, Math.round(Math.min(width, height) * 0.0015)));
  const source = new Uint8ClampedArray(data);

  for (let d = 0; d < depth; d += 1) {
    const edgeWeight = Math.pow(1 - d / Math.max(1, depth), 1.2) * 0.42;
    const haloWeight = Math.pow(1 - d / Math.max(1, depth), 1.05) * 0.08;
    const pairs = [
      [d, edgeWeight],
      [cross - 1 - d, edgeWeight],
      [Math.min(cross - 1, d + innerGap), haloWeight],
      [Math.max(0, cross - 1 - d - innerGap), haloWeight],
    ];

    for (const [crossPos, weight] of pairs) {
      if (weight <= 0) continue;
      for (let along = 0; along < length; along += 1) {
        const center = periodicIndex(width, along, crossPos, horizontal);
        const prevAlong = periodicIndex(width, clampCoord(along - sampleStep, length), crossPos, horizontal);
        const nextAlong = periodicIndex(width, clampCoord(along + sampleStep, length), crossPos, horizontal);
        const prevCross = periodicIndex(width, along, clampCoord(crossPos - sampleStep, cross), horizontal);
        const nextCross = periodicIndex(width, along, clampCoord(crossPos + sampleStep, cross), horizontal);

        for (let channel = 0; channel < 3; channel += 1) {
          const blur = (
            source[prevAlong + channel] +
            source[nextAlong + channel] +
            source[prevCross + channel] +
            source[nextCross + channel]
          ) / 4;
          data[center + channel] = clamp(data[center + channel] * (1 - weight) + blur * weight);
        }
      }
    }
  }
}

function periodicIndex(width, along, cross, horizontal) {
  const x = horizontal ? along : cross;
  const y = horizontal ? cross : along;
  return (y * width + x) * 4;
}

function lockOppositeBands(data, width, height, band, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;

  for (let d = 0; d < band; d += 1) {
    const edgeWeight = Math.pow(1 - d / band, 1.9);
    const innerWeight = edgeWeight * 0.58;
    const aCross = d;
    const bCross = cross - 1 - d;

    for (let along = 0; along < length; along += 1) {
      const ax = horizontal ? along : aCross;
      const ay = horizontal ? aCross : along;
      const bx = horizontal ? along : bCross;
      const by = horizontal ? bCross : along;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const ai = a + channel;
        const bi = b + channel;
        const average = (data[ai] + data[bi]) / 2;
        data[ai] = Math.round(data[ai] * (1 - innerWeight) + average * innerWeight);
        data[bi] = Math.round(data[bi] * (1 - innerWeight) + average * innerWeight);
      }
    }
  }
}

function stabilizePeriodicCorners(data, width, height, band) {
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const safeBand = Math.max(8, Math.min(Math.round(size * 0.08), band));
  const innerOffset = Math.max(safeBand * 2, Math.round(size * 0.055));

  for (let y = 0; y < safeBand; y += 1) {
    for (let x = 0; x < safeBand; x += 1) {
      const radial = Math.hypot(x, y) / Math.max(1, safeBand);
      const feather = Math.max(0, 1 - radial);
      if (feather <= 0) continue;

      const weight = Math.pow(feather, 1.45) * 0.74;
      const points = [
        [x, y],
        [width - 1 - x, y],
        [x, height - 1 - y],
        [width - 1 - x, height - 1 - y],
      ];
      const innerPoints = [
        [Math.min(width - 1, x + innerOffset), Math.min(height - 1, y + innerOffset)],
        [Math.max(0, width - 1 - x - innerOffset), Math.min(height - 1, y + innerOffset)],
        [Math.min(width - 1, x + innerOffset), Math.max(0, height - 1 - y - innerOffset)],
        [Math.max(0, width - 1 - x - innerOffset), Math.max(0, height - 1 - y - innerOffset)],
      ];
      const indices = points.map(([px, py]) => (py * width + px) * 4);
      const innerIndices = innerPoints.map(([px, py]) => (py * width + px) * 4);

      for (let channel = 0; channel < 3; channel += 1) {
        const cornerAverage = indices.reduce((sum, index) => sum + source[index + channel], 0) / indices.length;
        const innerAverage = innerIndices.reduce((sum, index) => sum + source[index + channel], 0) / innerIndices.length;
        const detail = innerIndices.reduce((sum, index) => sum + localDetailAt(source, width, height, index, channel), 0) / innerIndices.length;
        const target = cornerAverage * 0.64 + innerAverage * 0.36 + detail * 0.32;

        for (const index of indices) {
          data[index + channel] = Math.round(data[index + channel] * (1 - weight) + target * weight);
        }
      }
    }
  }
}

function restoreTiledCornerActivity(data, width, height) {
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const radius = Math.max(32, Math.min(250, Math.round(size * 0.05)));
  const innerOffset = Math.max(Math.round(size * 0.046), Math.round(radius * 0.82));
  const sampleStep = Math.max(8, Math.min(56, Math.round(size * 0.011)));
  const lowMix = 0.04;
  const detailAmount = 1.55;
  const meanPull = 0.58;

  for (let y = 0; y < radius; y += 1) {
    for (let x = 0; x < radius; x += 1) {
      const radial = Math.hypot(x, y) / Math.max(1, radius);
      if (radial > 1) continue;
      const weight = (0.12 + 0.88 * Math.pow(1 - radial, 1.08));
      const points = [
        [x, y],
        [width - 1 - x, y],
        [x, height - 1 - y],
        [width - 1 - x, height - 1 - y],
      ];
      const innerPoints = [
        [Math.min(width - 1, x + innerOffset), Math.min(height - 1, y + innerOffset), 1, 1],
        [Math.max(0, width - 1 - x - innerOffset), Math.min(height - 1, y + innerOffset), -1, 1],
        [Math.min(width - 1, x + innerOffset), Math.max(0, height - 1 - y - innerOffset), 1, -1],
        [Math.max(0, width - 1 - x - innerOffset), Math.max(0, height - 1 - y - innerOffset), -1, -1],
      ];
      const pointIndices = points.map(([px, py]) => (py * width + px) * 4);
      const innerIndices = innerPoints.map(([px, py]) => (py * width + px) * 4);
      const blurIndices = innerPoints.map(([px, py, sx, sy]) => [
        (clampCoord(py + sy * sampleStep, height) * width + clampCoord(px + sx * sampleStep, width)) * 4,
        (clampCoord(py - sy * sampleStep, height) * width + clampCoord(px - sx * sampleStep, width)) * 4,
        (py * width + clampCoord(px + sx * sampleStep, width)) * 4,
        (clampCoord(py + sy * sampleStep, height) * width + px) * 4,
      ]);

      for (let channel = 0; channel < 3; channel += 1) {
        const current = pointIndices.reduce((sum, index) => sum + source[index + channel], 0) / pointIndices.length;
        const inner = innerIndices.reduce((sum, index) => sum + source[index + channel], 0) / innerIndices.length;
        const blur = blurIndices.reduce((sum, indices) => {
          return sum + indices.reduce((innerSum, index) => innerSum + source[index + channel], 0) / indices.length;
        }, 0) / blurIndices.length;
        const detail = inner - blur;
        const rawTarget = current * (1 - lowMix) + inner * lowMix + detail * detailAmount;
        const target = rawTarget + (current - rawTarget) * meanPull;

        for (const index of pointIndices) {
          data[index + channel] = clamp(data[index + channel] * (1 - weight) + target * weight);
        }
      }
    }
  }
}

function smoothTiledCornerReferencePatches(data, width, height) {
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const center = Math.max(20, Math.round(size * 0.0645));
  const radius = Math.max(18, Math.min(130, Math.round(size * 0.026)));
  const sampleStep = Math.max(6, Math.min(20, Math.round(size * 0.0036)));
  const strength = 0.36;
  const centers = [
    [center, center],
    [width - 1 - center, center],
    [center, height - 1 - center],
    [width - 1 - center, height - 1 - center],
  ];

  for (const [cx, cy] of centers) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const y = clampCoord(cy + dy, height);
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = clampCoord(cx + dx, width);
        const radial = Math.hypot(dx, dy) / Math.max(1, radius);
        if (radial > 1) continue;
        const weight = Math.pow(1 - radial, 1.35) * strength;
        const index = (y * width + x) * 4;
        const sampleIndices = [
          (clampCoord(y + sampleStep, height) * width + x) * 4,
          (clampCoord(y - sampleStep, height) * width + x) * 4,
          (y * width + clampCoord(x + sampleStep, width)) * 4,
          (y * width + clampCoord(x - sampleStep, width)) * 4,
        ];

        for (let channel = 0; channel < 3; channel += 1) {
          const blur = sampleIndices.reduce((sum, sampleIndex) => sum + source[sampleIndex + channel], 0) / sampleIndices.length;
          data[index + channel] = clamp(data[index + channel] * (1 - weight) + blur * weight);
        }
      }
    }
  }
}

function softenTiledCornerSpikes(data, width, height) {
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const radius = Math.max(28, Math.min(82, Math.round(size * 0.016)));
  const sampleStep = Math.max(3, Math.min(10, Math.round(size * 0.002)));

  for (let y = 0; y < radius; y += 1) {
    for (let x = 0; x < radius; x += 1) {
      const radial = Math.hypot(x, y) / Math.max(1, radius);
      if (radial > 1) continue;
      const weight = Math.pow(1 - radial, 1.25) * 0.24;
      const points = [
        [x, y],
        [width - 1 - x, y],
        [x, height - 1 - y],
        [width - 1 - x, height - 1 - y],
      ];
      const pointIndices = points.map(([px, py]) => (py * width + px) * 4);

      for (let channel = 0; channel < 3; channel += 1) {
        const cornerAverage = pointIndices.reduce((sum, index) => sum + source[index + channel], 0) / pointIndices.length;

        for (const [pointOffset, [px, py]] of points.entries()) {
          const index = pointIndices[pointOffset];
          const samples = [
            (clampCoord(py + sampleStep, height) * width + px) * 4,
            (clampCoord(py - sampleStep, height) * width + px) * 4,
            (py * width + clampCoord(px + sampleStep, width)) * 4,
            (py * width + clampCoord(px - sampleStep, width)) * 4,
          ];
          const blur = samples.reduce((sum, sampleIndex) => sum + source[sampleIndex + channel], 0) / samples.length;
          const target = blur * 0.68 + cornerAverage * 0.32;
          data[index + channel] = clamp(data[index + channel] * (1 - weight) + target * weight);
        }
      }
    }
  }
}

function lockTiledCornerPatch(data, width, height) {
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const seamBand = Math.max(10, Math.min(42, Math.round(size * 0.035)));
  const patch = Math.max(8, Math.round(seamBand * 1.4));

  for (let y = 0; y < patch; y += 1) {
    for (let x = 0; x < patch; x += 1) {
      const points = [
        [x, y],
        [width - patch + x, y],
        [x, height - patch + y],
        [width - patch + x, height - patch + y],
      ];
      const indices = points.map(([px, py]) => (py * width + px) * 4);

      for (let channel = 0; channel < 3; channel += 1) {
        const average = indices.reduce((sum, index) => sum + source[index + channel], 0) / indices.length;

        for (const index of indices) {
          data[index + channel] = clamp(average);
        }
      }
    }
  }
}

function localDetailAt(source, width, height, index, channel) {
  const pixel = Math.floor(index / 4);
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const left = (y * width + Math.max(0, x - 1)) * 4 + channel;
  const right = (y * width + Math.min(width - 1, x + 1)) * 4 + channel;
  const top = (Math.max(0, y - 1) * width + x) * 4 + channel;
  const bottom = (Math.min(height - 1, y + 1) * width + x) * 4 + channel;
  return source[index + channel] - (source[left] + source[right] + source[top] + source[bottom]) / 4;
}

function restoreEdgeMicroTexture(data, width, height, band, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const source = new Uint8ClampedArray(data);
  const sampleOffset = Math.max(band + 8, Math.round(cross * 0.035));

  for (let d = 0; d < band; d += 1) {
    const textureWeight = Math.pow(1 - d / Math.max(1, band), 1.6) * 0.22;
    const aCross = d;
    const bCross = cross - 1 - d;
    const innerA = Math.min(cross - 1, d + sampleOffset);
    const innerB = Math.max(0, cross - 1 - d - sampleOffset);

    for (let along = 1; along < length - 1; along += 1) {
      const ax = horizontal ? along : aCross;
      const ay = horizontal ? aCross : along;
      const bx = horizontal ? along : bCross;
      const by = horizontal ? bCross : along;
      const iax = horizontal ? along : innerA;
      const iay = horizontal ? innerA : along;
      const ibx = horizontal ? along : innerB;
      const iby = horizontal ? innerB : along;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      const ia = (iay * width + iax) * 4;
      const ib = (iby * width + ibx) * 4;
      const iaPrev = horizontal ? ia - 4 : ia - width * 4;
      const iaNext = horizontal ? ia + 4 : ia + width * 4;
      const ibPrev = horizontal ? ib - 4 : ib - width * 4;
      const ibNext = horizontal ? ib + 4 : ib + width * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const detailA = source[ia + channel] - (source[iaPrev + channel] + source[iaNext + channel]) / 2;
        const detailB = source[ib + channel] - (source[ibPrev + channel] + source[ibNext + channel]) / 2;
        const detail = (detailA + detailB) * 0.5;
        data[a + channel] = clamp(data[a + channel] + detail * textureWeight);
        data[b + channel] = clamp(data[b + channel] + detail * textureWeight);
      }
    }
  }
}

function smoothInternalGuideLines(data, width, height, check = null) {
  const needsHorizontal = !check || check.internalHorizontal?.lineRisk || check.internalHorizontal?.worstScore > 10;
  const needsVertical = !check || check.internalVertical?.lineRisk || check.internalVertical?.worstScore > 10;
  if (!needsHorizontal && !needsVertical) return;

  if (needsHorizontal) {
    repairInternalGuideDirection(data, width, height, "horizontal");
  }
  if (needsVertical) {
    repairInternalGuideDirection(data, width, height, "vertical");
  }
  if (
    check?.tiledCorner?.junctionRisk ||
    (check?.tiledCorner?.worstScore || 0) > 10 ||
    (needsHorizontal && needsVertical)
  ) {
    stabilizeInternalGuideJunctions(data, width, height);
  }
}

function repairInternalGuideDirection(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const ratios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const band = Math.max(32, Math.min(520, Math.round(cross * 0.066)));
  const coreBand = Math.max(18, Math.min(260, Math.round(cross * 0.031)));
  const sampleOffset = Math.max(band + coreBand, Math.round(cross * 0.082));
  const source = new Uint8ClampedArray(data);

  for (const ratio of ratios) {
    const center = Math.round(cross * ratio);
    if (center <= sampleOffset + band || center >= cross - sampleOffset - band) continue;
    const plateauBefore = Math.max(0, center - sampleOffset);
    const plateauAfter = Math.min(cross - 1, center + sampleOffset);

    for (let delta = -band; delta <= band; delta += 1) {
      const position = center + delta;
      const absDelta = Math.abs(delta);
      const t = absDelta / Math.max(1, band);
      const coreT = absDelta <= coreBand ? 1 : Math.max(0, 1 - (absDelta - coreBand) / Math.max(1, band - coreBand));
      const weight = absDelta <= coreBand ? 0.97 : Math.pow(1 - t, 1.38) * 0.88;
      const plateauMix = Math.pow(coreT, 0.74);
      const sideT = (delta + band) / Math.max(1, band * 2);
      const before = Math.max(0, center - sampleOffset - Math.max(0, -delta));
      const after = Math.min(cross - 1, center + sampleOffset + Math.max(0, delta));

      for (let along = 0; along < length; along += 1) {
        const x = horizontal ? along : position;
        const y = horizontal ? position : along;
        const ax = horizontal ? along : before;
        const ay = horizontal ? before : along;
        const bx = horizontal ? along : after;
        const by = horizontal ? after : along;
        const index = (y * width + x) * 4;
        const a = (ay * width + ax) * 4;
        const b = (by * width + bx) * 4;
        const prevAlong = Math.max(0, along - 1);
        const nextAlong = Math.min(length - 1, along + 1);
        const aPrev = horizontal ? (ay * width + prevAlong) * 4 : (prevAlong * width + ax) * 4;
        const aNext = horizontal ? (ay * width + nextAlong) * 4 : (nextAlong * width + ax) * 4;
        const bPrev = horizontal ? (by * width + prevAlong) * 4 : (prevAlong * width + bx) * 4;
        const bNext = horizontal ? (by * width + nextAlong) * 4 : (nextAlong * width + bx) * 4;
        const pax = horizontal ? along : plateauBefore;
        const pay = horizontal ? plateauBefore : along;
        const pbx = horizontal ? along : plateauAfter;
        const pby = horizontal ? plateauAfter : along;
        const pa = (pay * width + pax) * 4;
        const pb = (pby * width + pbx) * 4;
        const paPrev = horizontal ? (pay * width + prevAlong) * 4 : (prevAlong * width + pax) * 4;
        const paNext = horizontal ? (pay * width + nextAlong) * 4 : (nextAlong * width + pax) * 4;
        const pbPrev = horizontal ? (pby * width + prevAlong) * 4 : (prevAlong * width + pbx) * 4;
        const pbNext = horizontal ? (pby * width + nextAlong) * 4 : (nextAlong * width + pbx) * 4;

        for (let channel = 0; channel < 3; channel += 1) {
          const gradientTarget = source[a + channel] * (1 - sideT) + source[b + channel] * sideT;
          const plateauTarget = (source[pa + channel] + source[pb + channel]) / 2;
          const detailA = source[a + channel] - (source[aPrev + channel] + source[aNext + channel]) / 2;
          const detailB = source[b + channel] - (source[bPrev + channel] + source[bNext + channel]) / 2;
          const plateauDetailA = source[pa + channel] - (source[paPrev + channel] + source[paNext + channel]) / 2;
          const plateauDetailB = source[pb + channel] - (source[pbPrev + channel] + source[pbNext + channel]) / 2;
          const gradientDetail = detailA * (1 - sideT) + detailB * sideT;
          const plateauDetail = (plateauDetailA + plateauDetailB) / 2;
          const baseTarget = gradientTarget * (1 - plateauMix) + plateauTarget * plateauMix;
          const textureDetail = gradientDetail * (1 - plateauMix) + plateauDetail * plateauMix;
          const target = baseTarget + textureDetail * 0.38;
          data[index + channel] = clamp(data[index + channel] * (1 - weight) + target * weight);
        }
      }
    }
    featherInternalGuideTransition(data, source, width, height, center, band, Math.max(18, Math.round(band * 0.48)), direction);
  }
}

function featherInternalGuideTransition(data, source, width, height, center, band, feather, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;

  for (let delta = 0; delta < feather; delta += 1) {
    const weight = Math.pow(1 - delta / Math.max(1, feather), 2) * 0.18;
    const innerA = Math.max(0, center - band - 1 - delta);
    const innerB = Math.min(cross - 1, center + band + 1 + delta);
    const farA = Math.max(0, innerA - feather);
    const farB = Math.min(cross - 1, innerB + feather);

    for (let along = 0; along < length; along += 1) {
      const ax = horizontal ? along : innerA;
      const ay = horizontal ? innerA : along;
      const bx = horizontal ? along : innerB;
      const by = horizontal ? innerB : along;
      const fax = horizontal ? along : farA;
      const fay = horizontal ? farA : along;
      const fbx = horizontal ? along : farB;
      const fby = horizontal ? farB : along;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      const fa = (fay * width + fax) * 4;
      const fb = (fby * width + fbx) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        data[a + channel] = clamp(data[a + channel] * (1 - weight) + source[fa + channel] * weight);
        data[b + channel] = clamp(data[b + channel] * (1 - weight) + source[fb + channel] * weight);
      }
    }
  }
}

function stabilizeInternalGuideJunctions(data, width, height) {
  const ratios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const source = new Uint8ClampedArray(data);
  const size = Math.min(width, height);
  const radius = Math.max(10, Math.min(82, Math.round(size * 0.018)));
  const sampleOffset = Math.max(radius * 2, Math.round(size * 0.045));
  const protectedEdgeX = width * 0.08;
  const protectedEdgeY = height * 0.08;

  for (const ratioY of ratios) {
    const centerY = Math.round(height * ratioY);
    if (centerY < protectedEdgeY || centerY > height - protectedEdgeY) continue;
    for (const ratioX of ratios) {
      const centerX = Math.round(width * ratioX);
      if (centerX < protectedEdgeX || centerX > width - protectedEdgeX) continue;

      for (let dy = -radius; dy <= radius; dy += 1) {
        const y = centerY + dy;
        if (y <= 0 || y >= height - 1) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = centerX + dx;
          if (x <= 0 || x >= width - 1) continue;
          const radial = Math.hypot(dx, dy) / Math.max(1, radius);
          if (radial > 1) continue;
          const weight = Math.pow(1 - radial, 1.4) * 0.58;
          const samples = [
            [clampCoord(x - sampleOffset, width), clampCoord(y - sampleOffset, height)],
            [clampCoord(x + sampleOffset, width), clampCoord(y - sampleOffset, height)],
            [clampCoord(x - sampleOffset, width), clampCoord(y + sampleOffset, height)],
            [clampCoord(x + sampleOffset, width), clampCoord(y + sampleOffset, height)],
          ];
          const index = (y * width + x) * 4;
          const sampleIndices = samples.map(([sx, sy]) => (sy * width + sx) * 4);

          for (let channel = 0; channel < 3; channel += 1) {
            const average = sampleIndices.reduce((sum, sampleIndex) => sum + source[sampleIndex + channel], 0) / sampleIndices.length;
            const detail = sampleIndices.reduce((sum, sampleIndex) => sum + localDetailAt(source, width, height, sampleIndex, channel), 0) / sampleIndices.length;
            const target = average + detail * 0.26;
            data[index + channel] = clamp(data[index + channel] * (1 - weight) + target * weight);
          }
        }
      }
    }
  }
}

function clampCoord(value, size) {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function seamFeatherWeight(distance, band) {
  const t = Math.min(1, Math.max(0, distance / Math.max(1, band)));
  return Math.pow(1 - smoothstep(t), 1.25);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function blendSeamPair(
  data,
  source,
  a,
  b,
  innerA,
  innerB,
  innerAPrev,
  innerANext,
  innerBPrev,
  innerBNext,
  weight,
  maxDiff = Infinity,
  textureMix = 0.62
) {
  const diff = colorDistance(source, a, b);
  if (diff > maxDiff * 1.4) return;
  const safeWeight = diff > maxDiff ? weight * 0.28 : weight;
  for (let channel = 0; channel < 3; channel += 1) {
    const ai = a + channel;
    const bi = b + channel;
    const edgeAverage = (source[ai] + source[bi]) / 2;
    const innerAverage = (source[innerA + channel] + source[innerB + channel]) / 2;
    const detailA = source[innerA + channel] - (source[innerAPrev + channel] + source[innerANext + channel]) / 2;
    const detailB = source[innerB + channel] - (source[innerBPrev + channel] + source[innerBNext + channel]) / 2;
    const textureDetail = (detailA + detailB) * 0.58;
    const target = edgeAverage * (1 - textureMix) + innerAverage * textureMix + textureDetail;
    data[ai] = Math.round(data[ai] * (1 - safeWeight) + target * safeWeight);
    data[bi] = Math.round(data[bi] * (1 - safeWeight) + target * safeWeight);
  }
}

function featherSeamTransition(data, source, width, height, band, feather, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;

  for (let d = 0; d < feather; d += 1) {
    const weight = Math.pow(1 - d / Math.max(1, feather), 2) * 0.24;
    const nearA = band + d;
    const nearB = cross - 1 - band - d;
    const farA = Math.min(cross - 1, nearA + feather);
    const farB = Math.max(0, nearB - feather);
    if (nearA >= cross || nearB < 0) continue;

    for (let along = 0; along < length; along += 1) {
      const ax = horizontal ? along : nearA;
      const ay = horizontal ? nearA : along;
      const bx = horizontal ? along : nearB;
      const by = horizontal ? nearB : along;
      const fax = horizontal ? along : farA;
      const fay = horizontal ? farA : along;
      const fbx = horizontal ? along : farB;
      const fby = horizontal ? farB : along;
      const a = (ay * width + ax) * 4;
      const b = (by * width + bx) * 4;
      const fa = (fay * width + fax) * 4;
      const fb = (fby * width + fbx) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        data[a + channel] = Math.round(data[a + channel] * (1 - weight) + source[fa + channel] * weight);
        data[b + channel] = Math.round(data[b + channel] * (1 - weight) + source[fb + channel] * weight);
      }
    }
  }
}

function colorDistance(data, a, b) {
  return (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3;
}

function withJpegDpi(dataUrl, dpi) {
  const marker = "data:image/jpeg;base64,";
  if (!dataUrl.startsWith(marker)) return dataUrl;
  const bytes = jpegDataUrlToBytes(dataUrl, marker);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return dataUrl;

  const jfifOffset = findJfifSegmentOffset(bytes);
  if (jfifOffset >= 0) {
    const patched = new Uint8Array(bytes);
    patchJfifDensity(patched, jfifOffset, dpi);
    return bytesToJpegDataUrl(patched, marker);
  }

  return bytesToJpegDataUrl(insertJfifDpiSegment(bytes, dpi), marker);
}

function jpegDataUrlToBytes(dataUrl, marker) {
  const binary = atob(dataUrl.slice(marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function findJfifSegmentOffset(bytes) {
  let index = 2;
  while (index + 4 < bytes.length && bytes[index] === 0xff) {
    const marker = bytes[index + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = (bytes[index + 2] << 8) | bytes[index + 3];
    if (length < 2 || index + 2 + length > bytes.length) break;
    if (
      marker === 0xe0 &&
      bytes[index + 4] === 0x4a &&
      bytes[index + 5] === 0x46 &&
      bytes[index + 6] === 0x49 &&
      bytes[index + 7] === 0x46 &&
      bytes[index + 8] === 0x00
    ) {
      return index;
    }
    index += 2 + length;
  }
  return -1;
}

function patchJfifDensity(bytes, offset, dpi) {
  bytes[offset + 11] = 1;
  bytes[offset + 12] = (dpi >> 8) & 0xff;
  bytes[offset + 13] = dpi & 0xff;
  bytes[offset + 14] = (dpi >> 8) & 0xff;
  bytes[offset + 15] = dpi & 0xff;
}

function insertJfifDpiSegment(bytes, dpi) {
  const segment = buildJfifDpiSegment(dpi);
  const output = new Uint8Array(bytes.length + segment.length);
  output.set(bytes.subarray(0, 2), 0);
  output.set(segment, 2);
  output.set(bytes.subarray(2), 2 + segment.length);
  return output;
}

function buildJfifDpiSegment(dpi) {
  return new Uint8Array([
    0xff, 0xe0,
    0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01,
    0x01,
    (dpi >> 8) & 0xff,
    dpi & 0xff,
    (dpi >> 8) & 0xff,
    dpi & 0xff,
    0x00, 0x00,
  ]);
}

function bytesToJpegDataUrl(bytes, marker) {
  let output = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return marker + btoa(output);
}

function measurePrintSpec(dataUrl, widthPx, heightPx) {
  const expected = { widthPx: 4961, heightPx: 7559, dpi: 300 };
  const density = readJpegDpi(dataUrl);
  const formatPassed = String(dataUrl || "").startsWith("data:image/jpeg;base64,");
  const dimensionsPassed = widthPx === expected.widthPx && heightPx === expected.heightPx;
  const dpiPassed = density.dpiX === expected.dpi && density.dpiY === expected.dpi && density.unit === 1;
  const issues = [];
  if (!formatPassed) issues.push("格式不是 JPG");
  if (!dimensionsPassed) issues.push(`像素 ${widthPx}×${heightPx}，应为 ${expected.widthPx}×${expected.heightPx}`);
  if (!dpiPassed) issues.push(`DPI ${density.dpiX || "未知"}×${density.dpiY || "未知"}，应为 ${expected.dpi}`);

  return {
    widthPx,
    heightPx,
    expectedWidthPx: expected.widthPx,
    expectedHeightPx: expected.heightPx,
    dpiX: density.dpiX,
    dpiY: density.dpiY,
    dpiUnit: density.unitName,
    format: formatPassed ? "jpg" : "unknown",
    formatPassed,
    dimensionsPassed,
    dpiPassed,
    passed: formatPassed && dimensionsPassed && dpiPassed,
    issues,
  };
}

function measureAspectWarp(sourceWidth, sourceHeight, targetWidth = 4961, targetHeight = 7559) {
  const safeSourceWidth = Number(sourceWidth) || 0;
  const safeSourceHeight = Number(sourceHeight) || 0;
  const safeTargetWidth = Number(targetWidth) || 0;
  const safeTargetHeight = Number(targetHeight) || 0;
  const valid = safeSourceWidth > 0 && safeSourceHeight > 0 && safeTargetWidth > 0 && safeTargetHeight > 0;
  const sourceAspect = valid ? safeSourceWidth / safeSourceHeight : 0;
  const targetAspect = valid ? safeTargetWidth / safeTargetHeight : 0;
  const directFit = measureAspectWarpFit(safeSourceWidth, safeSourceHeight, safeTargetWidth, safeTargetHeight, 1, 1, "direct-stretch");
  const fit = directFit.passed ? directFit : bestPeriodicAspectFit(safeSourceWidth, safeSourceHeight, safeTargetWidth, safeTargetHeight, directFit);

  return {
    sourceWidth: safeSourceWidth,
    sourceHeight: safeSourceHeight,
    targetWidth: safeTargetWidth,
    targetHeight: safeTargetHeight,
    sourceAspect,
    targetAspect,
    horizontalScale: fit.horizontalScale,
    verticalScale: fit.verticalScale,
    warpRatio: fit.warpRatio,
    stretchPercent: fit.stretchPercent,
    mode: fit.mode,
    columns: fit.columns,
    rows: fit.rows,
    cellAspect: fit.cellAspect,
    periodicRectified: fit.mode === "periodic-grid",
    passed: valid && fit.passed,
  };
}

function measureAspectWarpFit(sourceWidth, sourceHeight, targetWidth, targetHeight, columns, rows, mode) {
  const valid = sourceWidth > 0 && sourceHeight > 0 && targetWidth > 0 && targetHeight > 0 && columns > 0 && rows > 0;
  const cellWidth = valid ? targetWidth / columns : 0;
  const cellHeight = valid ? targetHeight / rows : 0;
  const horizontalScale = valid ? cellWidth / sourceWidth : 0;
  const verticalScale = valid ? cellHeight / sourceHeight : 0;
  const minScale = Math.min(horizontalScale, verticalScale);
  const maxScale = Math.max(horizontalScale, verticalScale);
  const warpRatio = valid && minScale > 0 ? maxScale / minScale : Infinity;
  const stretchPercent = Number.isFinite(warpRatio) ? (warpRatio - 1) * 100 : Infinity;

  return {
    mode,
    columns,
    rows,
    cellAspect: valid ? cellWidth / cellHeight : 0,
    horizontalScale,
    verticalScale,
    warpRatio,
    stretchPercent,
    passed: valid && warpRatio <= 1.08,
  };
}

function bestPeriodicAspectFit(sourceWidth, sourceHeight, targetWidth, targetHeight, directFit) {
  let best = directFit;
  const maxColumns = 3;
  const maxRows = 4;
  for (let rows = 1; rows <= maxRows; rows += 1) {
    for (let columns = 1; columns <= maxColumns; columns += 1) {
      if (columns === 1 && rows === 1) continue;
      const fit = measureAspectWarpFit(sourceWidth, sourceHeight, targetWidth, targetHeight, columns, rows, "periodic-grid");
      const fitTiles = columns * rows;
      const bestTiles = best.columns * best.rows;
      if (
        fit.warpRatio < best.warpRatio - 0.002 ||
        (Math.abs(fit.warpRatio - best.warpRatio) <= 0.002 && fitTiles < bestTiles)
      ) {
        best = fit;
      }
    }
  }
  return best;
}

function readJpegDpi(dataUrl) {
  const marker = "data:image/jpeg;base64,";
  if (!String(dataUrl || "").startsWith(marker)) {
    return { unit: 0, unitName: "unknown", dpiX: null, dpiY: null };
  }
  const bytes = jpegDataUrlToBytes(dataUrl, marker);
  const offset = findJfifSegmentOffset(bytes);
  if (offset < 0) return { unit: 0, unitName: "unknown", dpiX: null, dpiY: null };
  const unit = bytes[offset + 11];
  const xDensity = (bytes[offset + 12] << 8) | bytes[offset + 13];
  const yDensity = (bytes[offset + 14] << 8) | bytes[offset + 15];
  if (unit === 1) {
    return { unit, unitName: "inch", dpiX: xDensity, dpiY: yDensity };
  }
  if (unit === 2) {
    return { unit, unitName: "cm", dpiX: Math.round(xDensity * 2.54), dpiY: Math.round(yDensity * 2.54) };
  }
  return { unit, unitName: "none", dpiX: null, dpiY: null };
}

function applyAspectWarpCheck(check, aspectWarp) {
  const measured = aspectWarp || measureAspectWarp(0, 0);
  check.aspectWarp = measured;
  if (measured.passed) {
    check.rating = seamRating(check);
    return check;
  }

  const issue = "输出比例拉伸过大，不可修复";
  if (!check.issues.includes(issue)) {
    if (check.finalIssueType === "成品规格不正确，不可下载") {
      check.issues.push(issue);
    } else {
      check.issues.unshift(issue);
    }
  }
  check.passed = false;
  check.repairability = "unrepairable";
  if (check.finalIssueType !== "成品规格不正确，不可下载") {
    check.finalIssueType = issue;
  }
  check.rating = seamRating(check);
  return check;
}

function applyPrintSpecCheck(check, printSpec) {
  check.printSpec = printSpec;
  if (printSpec.passed) {
    check.rating = seamRating(check);
    return check;
  }

  if (!check.issues.includes("成品规格不正确，不可下载")) {
    check.issues.unshift("成品规格不正确，不可下载");
  }
  check.passed = false;
  check.repairability = "unrepairable";
  check.finalIssueType = "成品规格不正确，不可下载";
  check.rating = seamRating(check);
  return check;
}

function applyFullSizeEdgeCheck(check, fullSizeEdge) {
  check.fullSizeEdge = fullSizeEdge;
  if (!fullSizeEdge?.edgeRisk) {
    check.rating = seamRating(check);
    return check;
  }

  const repairableIssue = "最终JPG边缘硬线，可修复";
  const unrepairableIssue = "最终JPG边缘硬线，不可修复";
  const finalEdgeCandidate = {
    ...check,
    fullSizeEdge,
    issues: [repairableIssue, ...(check.issues || [])],
    finalIssueType: repairableIssue,
    repairability: "repairable",
  };
  const issue = (
    isBoundedFinalEdgeHardLine(check, fullSizeEdge) &&
    shouldAiOffsetRepair(finalEdgeCandidate)
  ) ? repairableIssue : unrepairableIssue;

  check.issues = [issue, ...check.issues.filter((item) => item !== repairableIssue && item !== unrepairableIssue)];
  check.passed = false;
  if (issue === repairableIssue) {
    check.repairability = "repairable";
  } else {
    check.repairability = "unrepairable";
  }
  check.finalIssueType = issue;
  check.rating = seamRating(check);
  return check;
}

function isBoundedFinalEdgeHardLine(check, fullSizeEdge) {
  if (!check || !fullSizeEdge?.edgeRisk) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const peakRatio = Math.max(check.peakRatioH || 0, check.peakRatioV || 0);
  const localScore = Math.max(check.localHorizontal?.score || 0, check.localVertical?.score || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const detailWorst = Math.max(check.detailHorizontal?.worstScore || 0, check.detailVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  const cornerWorst = Math.max(check.cornerScore || 0, check.tiledCorner?.worstScore || 0);
  const driftWorst = Math.max(check.driftHorizontal?.worstScore || 0, check.driftVertical?.worstScore || 0);
  const driftRisk = Boolean(check.driftHorizontal?.driftRisk || check.driftVertical?.driftRisk);
  const borderObjectRisk = Boolean(check.borderHorizontal?.objectRisk || check.borderVertical?.objectRisk);
  const softObjectRisk = borderObjectRisk && borderWorst <= 110 && localWorst <= 58 && edgeDominant <= 33;

  return (
    (check.score || 0) <= 28 &&
    (fullSizeEdge.score || 0) <= 120 &&
    (fullSizeEdge.peakRatio || 0) <= 0.72 &&
    edgeDominant <= 34 &&
    peakRatio <= 0.76 &&
    localScore <= 34 &&
    localWorst <= 92 &&
    borderWorst <= 132 &&
    internalWorst <= 142 &&
    bandWorst <= 76 &&
    detailWorst <= 96 &&
    tiledWorst <= 112 &&
    cornerWorst <= 66 &&
    driftWorst <= 38 &&
    (!driftRisk || driftWorst <= 24) &&
    (!borderObjectRisk || softObjectRisk)
  );
}

function downloadJpg(task) {
  if (!task.resultJpgUrl) return;
  if (!taskHasCertifiedDownload(task)) {
    showToast("这张图未通过商用下载认证，请先修复或重新生成。");
    updateTaskDownloadGate(task);
    return;
  }
  const link = document.createElement("a");
  link.href = task.resultJpgUrl;
  link.download = downloadNameForTask(task);
  document.body.appendChild(link);
  link.click();
  link.remove();
  markTaskDownloaded(task);
  showToast("已标记为下载过");
}

function updateBatchState() {
  if (!els.downloadSelected) return;
  const count = [...selectedDownloads.values()].filter((item) => item.certified === true).length;
  els.downloadSelected.textContent = count ? `批量下载 (${count})` : "批量下载";
}

async function downloadSelectedZip() {
  const items = [...selectedDownloads.values()].filter((item) => item.certified === true);
  if (!items.length) {
    showToast("请先勾选已通过认证的图案");
    return;
  }

  els.downloadSelected.disabled = true;
  showToast("正在打包所选图案");

  try {
    const files = [];
    for (const item of items) {
      const bytes = item.dataUrl ? dataUrlToBytes(item.dataUrl) : await fetchBytes(item.url);
      files.push({ name: item.name, bytes });
      markDownloaded(item.name);
    }

    const zipBlob = createZip(files);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(zipBlob);
    link.download = `YUANYE-${todayParts().date}-selected.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    tasks.forEach((task) => {
      if (isDownloaded(downloadNameForTask(task))) {
        task.downloaded = true;
        task.nodes.download.textContent = "已下载过";
        task.nodes.download.classList.add("is-downloaded");
      }
    });
    await loadHistory();
  } catch (error) {
    showToast(`打包失败：${error.message}`);
  } finally {
    els.downloadSelected.disabled = false;
  }
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载历史图失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

async function saveHistory(task, historyMarker = createHistoryMarker("generate"), actionType = "generate") {
  try {
    const response = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceName: task.file.name,
        patternCode: task.patternCode,
        parentPatternCode: task.parentPatternCode || "",
        dataUrl: task.resultJpgUrl,
        generationId: historyMarker.id,
        generationLabel: historyMarker.label,
        actionType,
        score: task.seamScore,
        rating: task.seamRating,
        seamCheck: task.seamCheck,
        originalSeamCheck: task.originalSeamCheck,
        repairCheck: task.repairCheck,
        issueTypes: task.seamCheck?.issues || [],
        generationAttempts: task.generationAttempts || 1,
        repairAttempts: task.repairAttempts || 0,
        aiRepairAttempts: task.aiRepairAttempts || 0,
        locallyRepaired: task.locallyRepaired,
        autoRegenerated: task.autoRegenerated,
        qualityPassed: task.qualityPassed,
        certification: buildPrintCertification(task, actionType),
        enhanceStrength: els.enhanceStrength.value,
      }),
    });
    if (response.ok) {
      const payload = await response.json();
      const savedCode = payload.record?.patternCode;
      if (savedCode && savedCode !== task.patternCode) {
        task.patternCode = savedCode;
        task.nodes.name.textContent = `${task.patternCode} · ${task.file.name}`;
      }
      await loadHistory();
    }
  } catch {
    // History is useful, but generation should not fail if saving history fails.
  }
}

async function loadHistory() {
  if (!els.historyGrid) return;
  const response = await fetch("/api/history");
  const payload = await response.json();
  const records = payload.records || [];

  if (!records.length) {
    els.historyGrid.innerHTML = `<div class="history-empty">还没有历史记录</div>`;
    return;
  }

  const groups = groupHistoryByGeneration(records);
  historyGroupsCache = groups;
  if (!groups.some((group) => group.key === activeHistoryGroupKey)) {
    activeHistoryGroupKey = groups[0]?.key || "";
  }
  renderHistoryManager();
}

function renderHistoryManager(options = {}) {
  const restoreScroll = options.restoreScroll || null;
  const groups = historyGroupsCache;
  const activeGroup = groups.find((group) => group.key === activeHistoryGroupKey) || groups[0];
  if (!activeGroup) {
    els.historyGrid.innerHTML = `<div class="history-empty">还没有历史记录</div>`;
    return;
  }

  els.historyGrid.innerHTML = `
    <div class="history-manager">
      <aside class="history-sidebar">
        ${groups
          .map((group) => `
            <button class="history-task ${group.key === activeGroup.key ? "is-active" : ""}" data-key="${escapeHtml(group.key)}">
              <strong>${escapeHtml(historyTaskTitle(group))}</strong>
              <span>${escapeHtml(group.subLabel)} · ${group.records.length} 张</span>
            </button>
          `)
          .join("")}
      </aside>
      <section class="history-detail">
        <div class="history-detail-head">
          <div class="history-detail-title">
            <strong>${escapeHtml(activeGroup.label)}</strong>
            <span>${escapeHtml(activeGroup.subLabel)} · ${activeGroup.records.length} 张</span>
          </div>
          <div class="history-detail-actions">
            <button class="secondary history-select-active" type="button">选择合格稿件</button>
            <button class="secondary history-download-active" type="button">下载合格稿件</button>
          </div>
        </div>
        <div class="history-group-list">
          ${activeGroup.records.map((record) => historyRecordTemplate(record)).join("")}
        </div>
      </section>
    </div>
  `;

  els.historyGrid.querySelectorAll(".history-task").forEach((button) => {
    button.addEventListener("click", () => {
      const sidebar = els.historyGrid.querySelector(".history-sidebar");
      const detail = els.historyGrid.querySelector(".history-detail");
      activeHistoryGroupKey = button.dataset.key;
      renderHistoryManager({
        restoreScroll: {
          pageY: window.scrollY,
          sidebarTop: sidebar?.scrollTop || 0,
          detailTop: detail?.scrollTop || 0,
        },
      });
    });
  });
  els.historyGrid.querySelector(".history-select-active")?.addEventListener("click", () => {
    selectActiveHistoryGroup();
  });
  els.historyGrid.querySelector(".history-download-active")?.addEventListener("click", async () => {
    await downloadActiveHistoryGroup();
  });
  els.historyGrid.querySelectorAll(".history-check").forEach((button) => {
    button.addEventListener("click", async () => {
      const check = await checkSeamQuality(button.dataset.url);
      showToast(`历史图检查：${check.rating} · ${check.score.toFixed(2)}`);
    });
  });
  els.historyGrid.querySelectorAll(".history-fission").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const record = findHistoryRecord(button.dataset.id);
        if (!record?.imageUrl) throw new Error("没有找到这张历史图");
        const dataUrl = await imageUrlToDataUrl(record.imageUrl);
        await createFissionTask({
          dataUrl,
          sourceName: `${record.patternCode || record.sourceName || "YUANYE"}-裂变参考.jpg`,
          parentPatternCode: record.patternCode || "",
        });
      } catch (error) {
        showToast(`裂变失败：${error.message}`);
      } finally {
        button.disabled = false;
      }
    });
  });
  els.historyGrid.querySelectorAll(".history-select-one").forEach((input) => {
    input.addEventListener("change", () => {
      const key = `history:${input.dataset.id}`;
      if (input.checked && input.dataset.certified === "true") {
        selectedDownloads.set(key, { name: input.dataset.name, url: input.dataset.url, certified: true });
      } else {
        selectedDownloads.delete(key);
      }
      updateBatchState();
    });
  });
  els.historyGrid.querySelectorAll(".history-download").forEach((link) => {
    link.addEventListener("click", () => {
      markDownloaded(link.dataset.name);
      link.textContent = "再次下载";
      link.classList.add("is-downloaded");
      const card = link.closest(".history-record");
      if (card && !card.querySelector(".downloaded-chip")) {
        const chip = document.createElement("span");
        chip.className = "downloaded-chip";
        chip.textContent = "已下载过";
        card.querySelector(".history-body")?.appendChild(chip);
      }
    });
  });
  els.historyGrid.querySelectorAll(".history-preview").forEach((button) => {
    button.addEventListener("click", () => {
      openPreview(button.dataset.url, button.dataset.name);
    });
  });

  if (restoreScroll) {
    const sidebar = els.historyGrid.querySelector(".history-sidebar");
    const detail = els.historyGrid.querySelector(".history-detail");
    if (sidebar) sidebar.scrollTop = restoreScroll.sidebarTop || 0;
    if (detail) detail.scrollTop = restoreScroll.detailTop || 0;
    window.scrollTo(window.scrollX, restoreScroll.pageY || 0);
  }
}

function selectActiveHistoryGroup() {
  const activeGroup = historyGroupsCache.find((group) => group.key === activeHistoryGroupKey) || historyGroupsCache[0];
  if (!activeGroup) {
    showToast("没有可选择的历史任务");
    return;
  }

  const certifiedRecords = activeGroup.records.filter(recordHasCertifiedDownload);
  certifiedRecords.forEach((record) => {
    const name = record.downloadName || `${record.patternCode || "yuanye-pattern"}.jpg`;
    selectedDownloads.set(`history:${record.id}`, {
      name,
      url: record.imageUrl,
      certified: true,
    });
  });

  els.historyGrid.querySelectorAll(".history-select-one").forEach((input) => {
    input.checked = input.dataset.certified === "true";
  });
  updateBatchState();
  showToast(certifiedRecords.length ? `已选择合格稿件 ${certifiedRecords.length} 张` : "当前任务没有通过认证的稿件");
}

async function downloadActiveHistoryGroup() {
  const activeGroup = historyGroupsCache.find((group) => group.key === activeHistoryGroupKey) || historyGroupsCache[0];
  const button = els.historyGrid.querySelector(".history-download-active");
  const certifiedRecords = (activeGroup?.records || []).filter(recordHasCertifiedDownload);
  if (!certifiedRecords.length) {
    showToast("当前任务没有通过认证的可下载稿件");
    return;
  }

  if (button) button.disabled = true;
  showToast(`正在打包合格稿件 ${certifiedRecords.length} 张`);

  try {
    const files = [];
    for (const record of certifiedRecords) {
      const name = record.downloadName || `${record.patternCode || "yuanye-pattern"}.jpg`;
      const bytes = await fetchBytes(record.imageUrl);
      files.push({ name, bytes });
      markDownloaded(name);
    }

    const zipBlob = createZip(files);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(zipBlob);
    link.download = `${safeZipName(activeGroup.label)}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    await loadHistory();
  } catch (error) {
    showToast(`当前任务打包失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function safeZipName(value) {
  const name = String(value || `YUANYE-${todayParts().date}`).replace(/[\\/:*?"<>|]+/g, "-").trim();
  return name || `YUANYE-${todayParts().date}`;
}

function historyTaskTitle(group) {
  const label = group.label.replace(/\s*·\s*\d{4}\/\d{2}\/\d{2}.*$/, "");
  return label || "生成任务";
}

function historyRecordTemplate(record) {
  const name = record.downloadName || `${record.patternCode || "yuanye-pattern"}.jpg`;
  const selectedKey = `history:${record.id}`;
  const certified = recordHasCertifiedDownload(record);
  const qualityText = record.qualityPassed === false ? "需人工复核" : record.qualityPassed === true ? "已通过" : "";
  const certificationText = certified ? "商用下载认证" : "未认证下载";
  const exportModeText = historyExportModeText(record);
  const attemptsText = record.generationAttempts > 1 ? ` · 重生${record.generationAttempts - 1}次` : "";
  const repairText = record.locallyRepaired ? ` · 已轻修${record.repairAttempts || 1}次` : record.repairAttempts ? ` · 轻修${record.repairAttempts}次未通过` : "";
  const issueText = Array.isArray(record.issueTypes) && record.issueTypes.length ? ` · ${record.issueTypes.join("、")}` : "";
  return `
    <article class="history-record">
      <button class="history-preview-thumb history-preview" type="button" data-url="${record.imageUrl}" data-name="${escapeHtml(record.patternCode || record.sourceName)}">
        <img src="${record.imageUrl}" alt="">
      </button>
      <div class="history-body">
        <strong>${escapeHtml(record.patternCode || record.sourceName)}</strong>
        <span>${escapeHtml(record.sourceName)}</span>
        <span>${formatFullTime(new Date(record.createdAt))}</span>
        <span>${escapeHtml(record.rating || "未检查")}${typeof record.score === "number" ? ` · ${record.score.toFixed(2)}` : ""}${exportModeText ? ` · ${escapeHtml(exportModeText)}` : ""}${escapeHtml(repairText)}${escapeHtml(attemptsText)}${escapeHtml(issueText)}</span>
        ${qualityText ? `<span>${escapeHtml(qualityText)}</span>` : ""}
        <span class="${certified ? "certified-chip" : "uncertified-chip"}">${certificationText}</span>
        ${isDownloaded(record.downloadName) ? `<span class="downloaded-chip">已下载过</span>` : ""}
      </div>
      <div class="history-actions">
        <label class="select-pill history-select">
          <input class="history-select-one" type="checkbox" data-id="${record.id}" data-url="${record.imageUrl}" data-name="${escapeHtml(name)}" data-certified="${certified}" ${selectedDownloads.has(selectedKey) && certified ? "checked" : ""} ${certified ? "" : "disabled"} />
          <span>选择</span>
        </label>
        <button class="secondary history-preview" type="button" data-url="${record.imageUrl}" data-name="${escapeHtml(record.patternCode || record.sourceName)}">预览</button>
        <button class="secondary history-fission" type="button" data-id="${escapeHtml(record.id)}">以图裂变</button>
        <button class="secondary history-check" data-url="${record.imageUrl}">检查循环</button>
        ${certified
          ? `<a class="secondary history-download ${isDownloaded(record.downloadName) ? "is-downloaded" : ""}" href="${record.imageUrl}" download="${escapeHtml(name)}" data-name="${escapeHtml(name)}">${isDownloaded(record.downloadName) ? "再次下载" : "下载"}</a>`
          : `<button class="secondary history-download" type="button" disabled>未认证</button>`}
      </div>
    </article>
  `;
}

function findHistoryRecord(recordId) {
  return historyGroupsCache
    .flatMap((group) => group.records || [])
    .find((record) => String(record.id) === String(recordId));
}

function openPreview(url, name) {
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.innerHTML = `
    <div class="preview-panel" role="dialog" aria-modal="true">
      <div class="preview-head">
        <strong>${escapeHtml(name || "图案预览")}</strong>
        <div class="preview-actions">
          <button class="secondary preview-tile" type="button">一键平铺预览</button>
          <button class="secondary preview-inspect" type="button" aria-pressed="false">区域放大</button>
          <button class="secondary preview-close" type="button">关闭</button>
        </div>
      </div>
      <div class="preview-body">
        <div class="preview-stage">
          <img class="preview-image" src="${url}" alt="">
        </div>
        <aside class="preview-inspector" aria-live="polite">
          <div class="preview-inspector-head">
            <strong>局部放大</strong>
            <span>3.5×</span>
          </div>
          <div class="preview-zoom-window">
            <div class="preview-zoom-view"></div>
          </div>
          <div class="preview-jumps">
            <button class="secondary" type="button" data-region="center">中心</button>
            <button class="secondary" type="button" data-region="horizontal">横缝</button>
            <button class="secondary" type="button" data-region="vertical">竖缝</button>
            <button class="secondary" type="button" data-region="corner">角点</button>
          </div>
        </aside>
      </div>
    </div>
  `;

  const close = () => {
    window.removeEventListener("resize", updateInspection);
    modal.remove();
  };
  let tileMode = 1;
  let inspectEnabled = false;
  let draggingSample = false;
  const samplePoint = { x: 0.5, y: 0.5 };
  const sampleSize = 88;
  const zoomFactor = 3.5;
  const stage = modal.querySelector(".preview-stage");
  const tileButton = modal.querySelector(".preview-tile");
  const inspectButton = modal.querySelector(".preview-inspect");
  const zoomView = modal.querySelector(".preview-zoom-view");
  const sampleBox = document.createElement("div");
  sampleBox.className = "preview-sample-box";
  sampleBox.style.width = `${sampleSize}px`;
  sampleBox.style.height = `${sampleSize}px`;

  const targetSelector = () => tileMode === 1 ? ".preview-image" : ".tile-preview";
  const getPreviewTarget = () => stage.querySelector(targetSelector());

  const setInspectEnabled = (enabled) => {
    inspectEnabled = enabled;
    modal.classList.toggle("has-inspector", inspectEnabled);
    inspectButton.classList.toggle("is-active", inspectEnabled);
    inspectButton.setAttribute("aria-pressed", String(inspectEnabled));
    inspectButton.textContent = inspectEnabled ? "关闭区域" : "区域放大";
    updateInspection();
  };

  const renderPreviewMode = () => {
    stage.classList.toggle("is-tiled", tileMode > 1);
    if (tileMode === 1) {
      stage.innerHTML = `<img class="preview-image" src="${url}" alt="">`;
      tileButton.textContent = "一键平铺预览";
      stage.appendChild(sampleBox);
      updateInspection();
      return;
    }

    const cells = Array.from({ length: tileMode * tileMode }, () => `<span style="background-image: url('${htmlAttr(url)}')"></span>`).join("");
    stage.innerHTML = `<div class="tile-preview tile-${tileMode}" aria-label="${tileMode}×${tileMode} 平铺预览">${cells}</div>`;
    tileButton.textContent = tileMode === 2 ? "切换 3×3" : "单张预览";
    stage.appendChild(sampleBox);
    updateInspection();
  };

  const updateInspection = () => {
    const target = getPreviewTarget();
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const localX = samplePoint.x * rect.width;
    const localY = samplePoint.y * rect.height;
    const sampleLeft = rect.left - stageRect.left + stage.scrollLeft + localX - sampleSize / 2;
    const sampleTop = rect.top - stageRect.top + stage.scrollTop + localY - sampleSize / 2;
    const tileColumns = tileMode > 1 ? tileMode : 1;
    const tileRows = tileMode > 1 ? tileMode : 1;
    const unitWidth = rect.width / tileColumns;
    const unitHeight = rect.height / tileRows;
    const zoomRect = zoomView.getBoundingClientRect();
    const zoomWidth = zoomRect.width || 300;
    const zoomHeight = zoomRect.height || 300;

    sampleBox.style.transform = `translate(${sampleLeft}px, ${sampleTop}px)`;
    zoomView.style.backgroundImage = `url('${htmlAttr(url)}')`;
    zoomView.style.backgroundRepeat = tileMode > 1 ? "repeat" : "no-repeat";
    zoomView.style.backgroundSize = tileMode > 1
      ? `${unitWidth * zoomFactor}px ${unitHeight * zoomFactor}px`
      : `${rect.width * zoomFactor}px ${rect.height * zoomFactor}px`;
    zoomView.style.backgroundPosition = `${zoomWidth / 2 - localX * zoomFactor}px ${zoomHeight / 2 - localY * zoomFactor}px`;
  };

  const setSampleFromPointer = (event) => {
    if (!inspectEnabled) return;
    const target = getPreviewTarget();
    if (!target) return;
    const rect = target.getBoundingClientRect();
    samplePoint.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    samplePoint.y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
    updateInspection();
  };

  const setSampleRegion = (region) => {
    if (region === "horizontal") {
      samplePoint.x = 0.5;
      samplePoint.y = tileMode > 1 ? 1 / tileMode : 0.04;
    } else if (region === "vertical") {
      samplePoint.x = tileMode > 1 ? 1 / tileMode : 0.04;
      samplePoint.y = 0.5;
    } else if (region === "corner") {
      const edge = tileMode > 1 ? 1 / tileMode : 0.04;
      samplePoint.x = edge;
      samplePoint.y = edge;
    } else {
      samplePoint.x = 0.5;
      samplePoint.y = 0.5;
    }
    setInspectEnabled(true);
  };

  tileButton.addEventListener("click", () => {
    tileMode = tileMode === 1 ? 2 : tileMode === 2 ? 3 : 1;
    renderPreviewMode();
  });
  inspectButton.addEventListener("click", () => {
    setInspectEnabled(!inspectEnabled);
  });
  stage.addEventListener("pointerdown", (event) => {
    if (!inspectEnabled) return;
    draggingSample = true;
    stage.setPointerCapture?.(event.pointerId);
    setSampleFromPointer(event);
  });
  stage.addEventListener("pointermove", (event) => {
    if (draggingSample) setSampleFromPointer(event);
  });
  stage.addEventListener("pointerup", (event) => {
    draggingSample = false;
    stage.releasePointerCapture?.(event.pointerId);
  });
  stage.addEventListener("pointercancel", () => {
    draggingSample = false;
  });
  stage.addEventListener("scroll", updateInspection);
  modal.querySelectorAll(".preview-jumps button").forEach((button) => {
    button.addEventListener("click", () => {
      setSampleRegion(button.dataset.region);
    });
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  window.addEventListener("resize", updateInspection);
  modal.querySelector(".preview-close").addEventListener("click", close);
  document.body.appendChild(modal);
  renderPreviewMode();
}

function htmlAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function groupHistoryByGeneration(records) {
  const groups = new Map();
  for (const record of records) {
    const date = new Date(record.createdAt);
    const key = record.generationId || record.id || date.toISOString();
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: record.generationLabel || `${record.actionType === "enhance" ? "高清记录" : "生成记录"} · ${formatFullTime(date)}`,
        subLabel: historyDateLabel(date),
        time: date.getTime(),
        records: [],
      });
    }
    groups.get(key).records.push(record);
  }
  return [...groups.values()].sort((a, b) => b.time - a.time);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function historyDateLabel(date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today - target) / 86400000);
  const absolute = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  if (diffDays === 0) return `今天 · ${absolute}`;
  if (diffDays === 1) return `昨天 · ${absolute}`;
  if (diffDays > 1 && diffDays <= 30) return `${diffDays} 天前 · ${absolute}`;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFullTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

async function startAll() {
  generationPaused = false;
  const pending = tasks.filter((task) => task.status !== "已完成" && task.status !== "生成中");
  if (!pending.length) {
    showToast("没有待生成任务");
    return;
  }
  const historyMarker = createHistoryMarker("batch", pending.length);
  els.startAll.disabled = true;
  if (els.resumeGeneration) els.resumeGeneration.disabled = true;
  for (const task of pending) {
    if (generationPaused) break;
    await generateTask(task, historyMarker);
  }
  els.startAll.disabled = false;
  if (els.resumeGeneration) els.resumeGeneration.disabled = false;
  if (generationPaused) showToast("已暂停后续任务");
}

async function resumeGeneration() {
  generationPaused = false;
  await restoreQueuedTasks();
  const pending = tasks.filter((task) => task.status !== "已完成" && task.status !== "生成中");
  if (!pending.length) {
    showToast("没有需要恢复的任务");
    return;
  }

  const historyMarker = createHistoryMarker("resume", pending.length);
  els.startAll.disabled = true;
  if (els.resumeGeneration) els.resumeGeneration.disabled = true;
  showToast(`开始恢复 ${pending.length} 个任务`);
  for (const task of pending) {
    if (generationPaused) break;
    await generateTask(task, historyMarker);
  }
  els.startAll.disabled = false;
  if (els.resumeGeneration) els.resumeGeneration.disabled = false;
  if (generationPaused) showToast("已暂停后续恢复任务");
}

function pauseAllTasks() {
  generationPaused = true;
  showToast("已暂停，当前生成中的图片完成后停止后续任务");
}

async function clearAllCurrentTasks() {
  generationPaused = true;
  selectedDownloads.clear();
  await clearQueuedTasks();
  tasks.forEach((task) => task.nodes.root.remove());
  tasks.splice(0, tasks.length);
  updateBatchState();
  setEmptyState();
  showToast("当前任务栏已清空");
}

async function checkServer() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    const provider = payload.baseUrl ? new URL(payload.baseUrl).host : "";
    els.serverStatus.textContent = payload.hasKey
      ? `本地服务已连接 · ${payload.version || "旧版本"} · ${provider}`
      : "缺少 OPENAI_API_KEY";
    els.serverStatus.className = `server-pill ${payload.hasKey ? "is-ready" : "is-error"}`;
  } catch {
    els.serverStatus.textContent = "请通过本地服务打开页面";
    els.serverStatus.className = "server-pill is-error";
  }
}

els.fileInput.addEventListener("change", (event) => {
  addFiles([...event.target.files]);
  event.target.value = "";
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles([...event.dataTransfer.files]);
});

els.startAll.addEventListener("click", startAll);
els.resumeGeneration?.addEventListener("click", resumeGeneration);
els.downloadSelected?.addEventListener("click", downloadSelectedZip);
els.pauseAll?.addEventListener("click", pauseAllTasks);
els.clearAllTasks?.addEventListener("click", clearAllCurrentTasks);
els.selectAllHistory?.addEventListener("click", () => {
  const inputs = [...els.historyGrid.querySelectorAll(".history-select-one:not(:disabled)")];
  const shouldSelect = inputs.some((input) => !input.checked);
  inputs.forEach((input) => {
    input.checked = shouldSelect;
    input.dispatchEvent(new Event("change"));
  });
  els.selectAllHistory.textContent = shouldSelect ? "取消全选" : "全选当前任务";
});

els.clearDone.addEventListener("click", () => {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index].status === "已完成") {
      tasks[index].nodes.root.remove();
      tasks.splice(index, 1);
    }
  }
  setEmptyState();
});

els.refreshHistory?.addEventListener("click", loadHistory);
els.codeRule?.addEventListener("input", () => {
  els.codePreview.dataset.custom = "false";
  updateCodePreview();
  saveSettings();
});
els.codePreview?.addEventListener("input", () => {
  els.codePreview.dataset.custom = els.codePreview.value.trim() ? "true" : "false";
  if (els.codePreview.dataset.custom === "false") updateCodePreview();
  saveSettings();
});
els.autoEnhance?.addEventListener("change", saveSettings);
els.enhanceStrength?.addEventListener("change", saveSettings);
els.fissionStrength?.addEventListener("change", saveSettings);

installQaTools();
loadSettings();
setEmptyState();
checkServer();
loadHistory();
restoreQueuedTasks();
