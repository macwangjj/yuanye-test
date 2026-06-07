import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const marker = "data:image/jpeg;base64,";

test("withJpegDpi patches existing JFIF density to 300 dpi", () => {
  const { withJpegDpi } = loadJpegDpiHelpers();
  const jpeg = makeJpegWithJfif(72);
  const output = dataUrlToBytes(withJpegDpi(bytesToDataUrl(jpeg), 300));

  assert.equal(output.length, jpeg.length, "existing JFIF segment should be patched in place");
  assert.equal(readUint16(output, 14), 300, "x density should be 300");
  assert.equal(readUint16(output, 16), 300, "y density should be 300");
  assert.equal(output[13], 1, "density unit should be inch");
});

test("withJpegDpi inserts JFIF density when browser JPEG has no APP0 segment", () => {
  const { withJpegDpi } = loadJpegDpiHelpers();
  const jpegWithoutJfif = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
  const output = dataUrlToBytes(withJpegDpi(bytesToDataUrl(jpegWithoutJfif), 300));

  assert.equal(output[0], 0xff);
  assert.equal(output[1], 0xd8);
  assert.equal(output[2], 0xff);
  assert.equal(output[3], 0xe0);
  assert.equal(String.fromCharCode(...output.slice(6, 11)), "JFIF\0");
  assert.equal(output[13], 1, "density unit should be inch");
  assert.equal(readUint16(output, 14), 300, "inserted x density should be 300");
  assert.equal(readUint16(output, 16), 300, "inserted y density should be 300");
  assert.deepEqual([...output.slice(20, 26)], [...jpegWithoutJfif.slice(2, 8)], "original JPEG data should follow inserted APP0 segment");
});

function loadJpegDpiHelpers() {
  const names = [
    "withJpegDpi",
    "jpegDataUrlToBytes",
    "findJfifSegmentOffset",
    "patchJfifDensity",
    "insertJfifDpiSegment",
    "buildJfifDpiSegment",
    "bytesToJpegDataUrl",
  ];
  const source = names.map((name) => extractFunction(appSource, name)).join("\n");
  const factory = new Function("atob", "btoa", `${source}\nreturn { withJpegDpi };`);
  return factory(
    (value) => Buffer.from(value, "base64").toString("binary"),
    (value) => Buffer.from(value, "binary").toString("base64"),
  );
}

function makeJpegWithJfif(dpi) {
  return new Uint8Array([
    0xff, 0xd8,
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
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
}

function bytesToDataUrl(bytes) {
  return marker + Buffer.from(bytes).toString("base64");
}

function dataUrlToBytes(dataUrl) {
  return new Uint8Array(Buffer.from(dataUrl.slice(marker.length), "base64"));
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

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
