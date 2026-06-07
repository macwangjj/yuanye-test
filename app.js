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
const clientVersion = "0.7.18-test";
const generateTimeoutMs = 8 * 60 * 1000;
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

function taskHasCertifiedDownload(task) {
  return Boolean(task?.resultJpgUrl && task?.qualityPassed === true && task?.seamCheck?.passed === true);
}

function recordHasCertifiedDownload(record) {
  return Boolean(record?.imageUrl && record?.qualityPassed === true && record?.seamCheck?.passed !== false);
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
      format: "jpg",
      use: "digital textile print",
    },
    gate: {
      fourWayRepeat: check.passed === true,
      qualityPassed: task.qualityPassed === true,
      score: typeof check.score === "number" ? check.score : null,
      rating: check.rating || "",
      horizontalScore: typeof check.horizontalScore === "number" ? check.horizontalScore : null,
      verticalScore: typeof check.verticalScore === "number" ? check.verticalScore : null,
      tiledScore: Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0),
      edgeBandScore: Math.max(check.bandHorizontal?.score || 0, check.bandVertical?.score || 0),
      clarityScore: typeof clarity.detailScore === "number" ? clarity.detailScore : null,
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

function buildPrompt(previousCheck = null) {
  const styleNote = els.styleNotes.value.trim() || "严格读取参考图的艺术风格、配色、笔触、元素气质、疏密节奏与高级面料感，不新增与参考图调性冲突的元素。";
  const retryNote = previousCheck?.issues?.length
    ? `\n\n上一次自动质检未通过，问题是：${previousCheck.issues.join("、")}。本次必须重点修复这些问题：${seamFailureMessage(previousCheck)}，不要重复出现同类接缝。`
    : "";
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
- 边缘区域必须像画面内部一样自然，最终 2×2 平铺预览中不能出现任何横档、竖档或直线接缝。${retryNote}`;
}

function buildFissionPrompt(task, previousCheck = null) {
  const styleNote = els.styleNotes.value.trim() || "保持原图的艺术风格、配色、笔触、元素气质、疏密节奏与高级面料感。";
  const strength = fissionStrengthProfile();
  const parentNote = task?.parentPatternCode ? `\n- 原图编号：${task.parentPatternCode}。新图要像同一系列的延展款，但不能只是复制、裁切、镜像或轻微调色。` : "";
  const retryNote = previousCheck?.issues?.length
    ? `\n\n上一次自动质检未通过，问题是：${previousCheck.issues.join("、")}。本次必须重点修复这些问题：${seamFailureMessage(previousCheck)}，不要重复出现同类接缝。`
    : "";
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
- 最终 2×2 平铺预览中不能出现任何横档、竖档或直线接缝。${retryNote}`;
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
    for (let attempt = 1; attempt <= maxAutoRegenerations + 1; attempt += 1) {
      task.generationAttempts = attempt;
      phase = "请求图片生成接口";
      setTaskStatus(task, "生成中", attempt === 1
        ? "正在上传参考图并生成四方连续图案。"
        : `检测未通过，正在自动重新生成 ${attempt - 1}/${maxAutoRegenerations}。`, attempt === 1 ? 28 : 34);

      const payload = await requestGeneratedImage(task, lastCheck);

      phase = "显示成品预览";
      setTaskStatus(task, "生成中", "正在准备 JPG 下载文件。", 72);
      task.resultDataUrl = payload.image.dataUrl;
      task.nodes.resultThumb.innerHTML = `<img src="${task.resultDataUrl}" alt="">`;
      task.nodes.resultThumb.style.backgroundImage = "";

      phase = "导出目标 JPG";
      task.resultJpgUrl = await makeJpg(task.resultDataUrl, {
        enhance: els.autoEnhance.checked,
        strength: getEnhanceStrength(),
        repair: false,
      });
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

      task.autoRegenerated = true;
      if (attempt <= maxAutoRegenerations) {
        setTaskStatus(task, "生成中", `${seamFailureMessage(lastCheck)}，准备自动重生 ${attempt}/${maxAutoRegenerations}。`, 96);
        await delay(800);
      }
    }

    task.nodes.enhance.disabled = false;
    task.nodes.fission.disabled = false;
    task.nodes.repair.disabled = !(shouldEdgeBlendRepair(lastCheck) || shouldForcePeriodicRepair(lastCheck));
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

async function requestGeneratedImage(task, previousCheck = null) {
  return await fetchJsonWithRetry("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: {
        name: task.file.name,
        type: task.file.type,
        dataUrl: task.dataUrl,
      },
      prompt: task.generationMode === "fission" ? buildFissionPrompt(task, previousCheck) : buildPrompt(previousCheck),
      size: els.size.value,
    }),
  }, {
    retries: 1,
    timeoutMs: generateTimeoutMs,
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
  if (task.nodes.select.checked && task.resultJpgUrl && task.qualityPassed) {
    selectedDownloads.set(key, {
      name: `${task.patternCode || "YUANYE"}.jpg`,
      dataUrl: task.resultJpgUrl,
      certified: true,
    });
  } else {
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
    task.resultJpgUrl = await makeJpg(task.resultDataUrl, {
      enhance: true,
      strength: getEnhanceStrength(),
    });
    task.nodes.resultThumb.innerHTML = `<img src="${task.resultJpgUrl}" alt="">`;
    if (task.nodes.select.checked) toggleTaskSelection(task);
    const check = await runSeamCheck(task, true);
    task.qualityPassed = check.passed;
    task.nodes.select.disabled = !check.passed;
    task.nodes.select.checked = check.passed;
    toggleTaskSelection(task);
    task.nodes.repair.disabled = !shouldHybridSeamRepair(check);
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
    task.resultJpgUrl = await makeJpg(sourceUrl, {
      enhance: true,
      strength: Math.max(getEnhanceStrength(), 0.34),
    });
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
  if (!shouldEdgeBlendRepair(baseCheck) && shouldForcePeriodicRepair(baseCheck)) {
    return await forceSeamlessTask(task, options);
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
    task.nodes.repair.disabled = false;
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
    task.nodes.repair.disabled = false;
  }
}

async function aiOffsetRepairTask(task, previousCheck) {
  if (!task.resultJpgUrl) return null;

  task.aiRepairAttempts += 1;
  task.repairAttempts += 1;

  const repairSourceUrl = task.resultDataUrl || task.resultJpgUrl;
  const offsetDataUrl = await makeOffsetDataUrl(repairSourceUrl, { format: "png" });
  const maskDataUrl = await makeOffsetRepairMaskDataUrl(offsetDataUrl);
  const payload = await fetchJsonWithRetry("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
  }, {
    retries: 1,
    timeoutMs: generateTimeoutMs,
  });

  const restoredDataUrl = await makeOffsetDataUrl(payload.image.dataUrl, { reverse: true, format: "png" });
  task.resultDataUrl = restoredDataUrl;
  task.resultJpgUrl = await makeJpg(restoredDataUrl, {
    enhance: shouldPrintClarityEnhance(previousCheck),
    strength: Math.max(getEnhanceStrength(), 0.3),
    skipAiRepair: true,
    repair: false,
  });
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
    issue.includes("平铺边带") ||
    issue.includes("平铺预览") ||
    issue.includes("细线接缝") ||
    issue.includes("轻微色差") ||
    issue.includes("接缝过渡")
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
    check?.tiledHorizontal?.worstScore || 0,
    check?.tiledVertical?.worstScore || 0,
  );
}

function buildOffsetRepairPrompt(previousCheck = null) {
  const issueText = previousCheck?.issues?.length ? previousCheck.issues.join("、") : "中心十字接缝风险";
  return `这张图是一个四方连续印花单元经过 Offset 偏移后的中间修缝图：原本的上下/左右边缘接缝已经被移动到画面中心，形成可能可见的水平和垂直十字接缝。

请重点重绘画面中心十字接缝附近的过渡区域，让 AI 自然生成丝滑衔接，而不是硬拼、镜像、糊边或简单平均颜色。上一轮检测问题：${issueText}。

必须严格执行：
1. 已提供蒙版：透明和半透明区域是允许重绘的中心十字接缝带，蒙版外侧应尽量保持原图稳定。
2. 允许在中心水平线和中心垂直线两侧约 20% 宽度内做自然变化、补画、重绘和过渡生成；小幅元素变化可以接受，目标是无缝和自然。
3. 保持外侧四边 10% 区域尽量稳定，因为这些外侧边界已经是连续边界，不能新增白边、黑边、画框或边缘拼接线。
4. 中心十字修复后，纹理、笔触、花枝、叶片、抽象纹路、明暗层次必须自然穿过中心线；要像原本就连续绘制，而不是后期拼接。
5. 如果中心线附近有元素断头，可以补出合理的枝叶、花瓣、纹理走向或背景过渡；如果有明暗突变，可以生成自然渐变和局部纹理变化。
6. 不要输出 2×2、3×3 或多块平铺预览，只输出单张完整图。
7. 保持原图风格、配色、密度、元素气质和面料高级感，不要新增明显无关题材，不要把整张图改成另一种风格。
8. 接缝处不能形成一条更亮、更暗、更糊、更平的边带；必须补出与周围一致的织物纹理、线条噪声、花枝走向和笔触颗粒。
9. 最终目标是把这张图再 Offset 移回后，上下左右能形成真正无缝循环。`;
}

function shouldHybridSeamRepair(check) {
  if (!check || check.passed) return false;
  const structuralIssue = check.issues?.some((issue) => (
    issue.includes("横档未衔接") ||
    issue.includes("竖档未衔接") ||
    issue.includes("接缝过渡不自然") ||
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

function shouldEdgeBlendRepair(check) {
  if (!check || check.passed) return false;
  if (check.issues?.some((issue) => issue.includes("花型元素叠加") || issue.includes("回头没接"))) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  return (
    check.score <= 36 &&
    edgeDominant <= 48 &&
    borderWorst <= 145 &&
    bandWorst <= 95 &&
    (check.issues?.some((issue) => (
      issue.includes("横档") ||
      issue.includes("竖档") ||
      issue.includes("接缝过渡") ||
      issue.includes("细线接缝") ||
      issue.includes("轻微色差") ||
      issue.includes("平铺边带") ||
      issue.includes("平铺预览")
    )) || check.repairability === "repairable")
  );
}

function shouldAiOffsetRepair(check) {
  if (!check || check.passed) return false;
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const localWorst = Math.max(check.localHorizontal?.worstScore || 0, check.localVertical?.worstScore || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  return (
    check.score <= 420 &&
    edgeDominant <= 420 &&
    borderWorst <= 980 &&
    localWorst <= 280 &&
    internalWorst <= 240 &&
    bandWorst <= 320 &&
    tiledWorst <= 320
  );
}

function shouldForcePeriodicRepair(check) {
  if (!check || check.passed) return false;
  const borderWorst = Math.max(check.borderHorizontal?.worstMismatch || 0, check.borderVertical?.worstMismatch || 0);
  const internalWorst = Math.max(check.internalHorizontal?.worstScore || 0, check.internalVertical?.worstScore || 0);
  const edgeDominant = Math.max(check.horizontalScore || 0, check.verticalScore || 0);
  const bandWorst = Math.max(check.bandHorizontal?.worstScore || 0, check.bandVertical?.worstScore || 0);
  const tiledWorst = Math.max(check.tiledHorizontal?.worstScore || 0, check.tiledVertical?.worstScore || 0);
  return (
    check.score <= 140 &&
    edgeDominant <= 180 &&
    borderWorst <= 520 &&
    internalWorst <= 90 &&
    bandWorst <= 140 &&
    tiledWorst <= 140
  );
}

function shouldPrintClarityEnhance(check) {
  return Boolean(check?.issues?.some((issue) => issue.includes("清晰度不足")));
}

async function runSeamCheck(task, quiet = false) {
  if (!task.resultJpgUrl) {
    if (!quiet) showToast("请先生成图片");
    return;
  }

  const check = await checkSeamQuality(task.resultJpgUrl);
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

function checkSeamQuality(dataUrl) {
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
        resolve(measureSeamQuality(ctx, canvas.width, canvas.height));
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
    `平铺 ${Math.max(check.tiledHorizontal?.score || 0, check.tiledVertical?.score || 0).toFixed(2)}`,
    `清晰 ${Number(check.clarity?.detailScore || 0).toFixed(2)}`,
    check.repairability === "repairable" ? "可轻修" : check.repairability === "unrepairable" ? "需重生/复核" : "通过",
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
  return "检测到接缝风险";
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
        drawTileToTarget(ctx, image, canvas.width, canvas.height);
        if (options.repair !== false) {
          repairSeams(ctx, canvas.width, canvas.height, options.repairOptions || {});
        }
        const clarityStrength = printClarityStrength(image, canvas.width, canvas.height, options);
        if (clarityStrength > 0) {
          enhanceClarity(ctx, canvas.width, canvas.height, clarityStrength);
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
        const jpg = canvas.toDataURL("image/jpeg", 0.94);
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
        const jpg = canvas.toDataURL("image/jpeg", 0.94);
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
        enhanceClarity(ctx, canvas.width, canvas.height, 0.12);
        const jpg = canvas.toDataURL("image/jpeg", 0.94);
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
        const jpg = canvas.toDataURL("image/jpeg", 0.94);
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
        const jpg = canvas.toDataURL("image/jpeg", 0.95);
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
    for (let x = 0; x < width; x += 1) {
      const dx = Math.abs(x - centerX);
      const verticalEdit = seamEditStrength(dx, coreX, featherX);
      const edit = Math.max(horizontalEdit, verticalEdit);
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

function drawTileToTarget(ctx, image, targetWidth, targetHeight) {
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
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
  const tiledHorizontal = measureTiledPreviewSeam(data, width, height, "horizontal");
  const tiledVertical = measureTiledPreviewSeam(data, width, height, "vertical");
  const clarity = measurePrintClarity(data, width, height);
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
  const maxTiledScore = Math.max(tiledHorizontal.score, tiledVertical.score);
  const maxTiledWorst = Math.max(tiledHorizontal.worstScore, tiledVertical.worstScore);
  const issues = [];

  const severeHorizontal = horizontalScore > 9.5 || horizontalPeaks > peakLimitH || localHorizontal.structuralRisk || internalHorizontal.lineRisk || borderHorizontal.objectRisk;
  const severeVertical = verticalScore > 9.5 || verticalPeaks > peakLimitV || localVertical.structuralRisk || internalVertical.lineRisk || borderVertical.objectRisk;
  const severeCorner = cornerScore > 10.5 || (horizontalScore > 7.4 && verticalScore > 7.4);
  const overlayRisk = (maxPeakRatio > 0.16 && maxEdgeScore > 5.8) || (maxLocalWorst > 26 && maxLocalScore > 15) || (maxInternalWorst > 24 && maxInternalScore > 12);
  const transitionRisk = (maxEdgeScore > 8.2 && maxPeakRatio > 0.08) || (maxLocalWorst > 20 && maxLocalScore > 11) || (maxInternalWorst > 18 && maxInternalScore > 9);
  const bandArtifactRisk = maxBandScore > 11 || maxBandWorst > 18 || bandHorizontal.bandRisk || bandVertical.bandRisk;
  const tiledPreviewRisk = maxTiledScore > 9.8 || maxTiledWorst > 17 || tiledHorizontal.lineRisk || tiledVertical.lineRisk;
  const mildColor = maxEdgeScore > 3.4 && maxEdgeScore <= 7.2 && cornerScore <= 8.5 && maxPeakRatio <= 0.08 && maxLocalWorst <= 18 && maxInternalWorst <= 14;
  const thinLine = maxEdgeScore <= 6.8 && maxPeakRatio > 0.08 && maxPeakRatio <= 0.14 && cornerScore <= 8.5 && maxLocalWorst <= 20 && maxInternalWorst <= 16;

  if (severeHorizontal) issues.push("横档未衔接，不可修复");
  if (severeVertical) issues.push("竖档未衔接，不可修复");
  if (severeCorner) issues.push("回头没接，不可修复");
  if (overlayRisk && !severeHorizontal && !severeVertical) issues.push("花型元素叠加，不可修复");
  if (transitionRisk && !overlayRisk && !severeHorizontal && !severeVertical) issues.push("接缝过渡不自然，不可修复");
  if (!issues.length && tiledPreviewRisk) issues.push("平铺预览中心线明显，可修复");
  if (!issues.length && bandArtifactRisk) issues.push("平铺边带明显，可修复");
  if (!issues.length && clarity.blurRisk) issues.push("成品清晰度不足，可增强");
  if (!issues.length && thinLine) issues.push("细线接缝，可修复");
  if (!issues.length && mildColor) issues.push("轻微色差，可修复");

  const score = horizontalScore * 0.23 + verticalScore * 0.23 + cornerScore * 0.09 + maxLocalScore * 0.1 + maxInternalScore * 0.1 + maxBandScore * 0.12 + maxTiledScore * 0.13;
  let repairability = issues.some((issue) => issue.includes("不可修复"))
    ? "unrepairable"
    : issues.some((issue) => issue.includes("可修复"))
      ? "repairable"
      : "pass";
  const passed = (
    repairability === "pass" &&
    score <= 4.8 &&
    horizontalScore <= 5.8 &&
    verticalScore <= 5.8 &&
    cornerScore <= 7.5 &&
    maxBandScore <= 8.5 &&
    maxBandWorst <= 16 &&
    maxTiledScore <= 7.4 &&
    maxTiledWorst <= 15 &&
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
    tiledHorizontal,
    tiledVertical,
    clarity,
    repairability: passed ? "pass" : repairability,
    finalIssueType,
    issues,
    passed,
  };
  check.rating = seamRating(check);
  return check;
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
    bandRisk: (
      worstScore > 20 ||
      score > 12 ||
      (flatWindows >= 2 && flatRatio > 0.06) ||
      (shiftWindows >= 2 && shiftRatio > 0.08)
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
  smoothInternalGuideLines(data, width, height, check);
  ctx.putImageData(imageData, 0, 0);
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
    smoothInternalDirection(data, width, height, "horizontal");
  }
  if (needsVertical) {
    smoothInternalDirection(data, width, height, "vertical");
  }
}

function smoothInternalDirection(data, width, height, direction) {
  const horizontal = direction === "horizontal";
  const length = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const ratios = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const band = Math.max(8, Math.min(46, Math.round(cross * 0.006)));

  for (const ratio of ratios) {
    const center = Math.round(cross * ratio);
    if (center <= band * 3 || center >= cross - band * 3) continue;

    for (let delta = -band; delta <= band; delta += 1) {
      const position = center + delta;
      const t = Math.abs(delta) / Math.max(1, band);
      const weight = Math.pow(1 - t, 1.8) * 0.42;
      const before = Math.max(0, center - band * 2 - Math.abs(delta));
      const after = Math.min(cross - 1, center + band * 2 + Math.abs(delta));

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

        for (let channel = 0; channel < 3; channel += 1) {
          const target = (data[a + channel] + data[b + channel]) / 2;
          data[index + channel] = Math.round(data[index + channel] * (1 - weight) + target * weight);
        }
      }
    }
  }
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
  const binary = atob(dataUrl.slice(marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // Patch JFIF density metadata when the browser encoder includes an APP0 segment.
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    String.fromCharCode(bytes[6], bytes[7], bytes[8], bytes[9], bytes[10]) === "JFIF\0"
  ) {
    bytes[13] = 1;
    bytes[14] = (dpi >> 8) & 0xff;
    bytes[15] = dpi & 0xff;
    bytes[16] = (dpi >> 8) & 0xff;
    bytes[17] = dpi & 0xff;
  }

  let output = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return marker + btoa(output);
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
  const count = selectedDownloads.size;
  els.downloadSelected.textContent = count ? `批量下载 (${count})` : "批量下载";
}

async function downloadSelectedZip() {
  const items = [...selectedDownloads.values()].filter((item) => item.certified !== false);
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
        <span>${escapeHtml(record.rating || "未检查")}${typeof record.score === "number" ? ` · ${record.score.toFixed(2)}` : ""}${escapeHtml(repairText)}${escapeHtml(attemptsText)}${escapeHtml(issueText)}</span>
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

loadSettings();
setEmptyState();
checkServer();
loadHistory();
restoreQueuedTasks();
