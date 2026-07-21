import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const MAX_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_PNG_DIMENSION = 4096;
export const MAX_PNG_PIXELS = 16 * 1024 * 1024;
const MAX_PNG_INFLATED_BYTES = 128 * 1024 * 1024;

const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function scanlineLengths(width, height, bitsPerPixel, interlace) {
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const lengths = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    if (width <= startX || height <= startY) continue;
    const passWidth = Math.ceil((width - startX) / stepX);
    const passHeight = Math.ceil((height - startY) / stepY);
    const rowLength = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row += 1) lengths.push(rowLength);
  }
  return lengths;
}

function validateChunks(bytes, label) {
  let offset = 8;
  let chunkIndex = 0;
  let foundIdat = false;
  let foundIend = false;
  let idatEnded = false;
  const idatChunks = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error(`${label} PNG has a truncated chunk header`);
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw new Error(`${label} PNG has a truncated ${type || "unknown"} chunk`);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = pngCrc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) throw new Error(`${label} PNG ${type || "unknown"} chunk failed CRC validation`);
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new Error(`${label} PNG must begin with a 13-byte IHDR chunk`);
    }
    if (chunkIndex > 0 && type === "IHDR") throw new Error(`${label} PNG contains a duplicate IHDR chunk`);
    if (type === "IDAT") {
      if (idatEnded) throw new Error(`${label} PNG IDAT chunks must be consecutive`);
      foundIdat = true;
      idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (foundIdat && type !== "IEND") {
      idatEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) throw new Error(`${label} PNG has an invalid terminal IEND chunk`);
      foundIend = true;
    }
    if (foundIend) break;
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!foundIdat || !foundIend) throw new Error(`${label} PNG must contain IDAT data and a terminal IEND chunk`);

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  const allowedDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])], [2, new Set([8, 16])], [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])], [6, new Set([8, 16])],
  ]);
  if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION
    || width * height > MAX_PNG_PIXELS) {
    throw new Error(`${label} PNG dimensions exceed the bounded ingestion contract`);
  }
  if (!allowedDepths.get(colorType)?.has(bitDepth) || compression !== 0 || filter !== 0
    || !new Set([0, 1]).has(interlace)) {
    throw new Error(`${label} PNG has an unsupported or invalid IHDR encoding`);
  }
  const samplesPerPixel = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const rows = scanlineLengths(width, height, samplesPerPixel * bitDepth, interlace);
  const expectedLength = rows.reduce((sum, length) => sum + length + 1, 0);
  if (expectedLength > MAX_PNG_INFLATED_BYTES) {
    throw new Error(`${label} PNG inflated data exceeds the bounded ingestion contract`);
  }
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedLength + 1 });
  } catch {
    throw new Error(`${label} PNG IDAT stream cannot be inflated`);
  }
  if (inflated.length !== expectedLength) {
    throw new Error(`${label} PNG inflated data does not match its IHDR geometry`);
  }
  let rowOffset = 0;
  for (const length of rows) {
    if (inflated[rowOffset] > 4) throw new Error(`${label} PNG contains an invalid scanline filter`);
    rowOffset += length + 1;
  }
  return { width, height };
}

export function parsePngEvidence(encoded, mimeType, label = "retained image") {
  if (mimeType !== "image/png" || typeof encoded !== "string" || encoded.length === 0) {
    throw new Error(`${label} must retain one non-empty image/png block`);
  }
  if (encoded.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 4) {
    throw new Error(`${label} PNG exceeds the 32 MiB ingestion limit`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 57 || bytes.length > MAX_PNG_BYTES
    || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    || bytes.toString("base64") !== encoded) {
    throw new Error(`${label} image block is not canonical PNG base64`);
  }
  const dimensions = validateChunks(bytes, label);
  return {
    bytes,
    ...dimensions,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
