import assert from "node:assert/strict";
import { test } from "node:test";

test("parseImageApiJson recovers an image JSON object from concatenated upstream output", () => {
  const first = JSON.stringify({ error: { message: "temporary upstream note" } });
  const second = JSON.stringify({ data: [{ b64_json: "abc123", output_format: "png" }] });
  const parsed = parseImageApiJson(`${first}\n${second}`, "curl:gpt-image-2");

  assert.equal(parsed.data[0].b64_json, "abc123");
});

test("parseImageApiJson reports a useful excerpt for invalid upstream output", () => {
  assert.throws(
    () => parseImageApiJson("not json at all", "curl:gpt-image-2"),
    /返回片段：not json at all/,
  );
});

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
