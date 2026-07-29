import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_LIB_RSS_MAXIMUM_BYTES,
  PDF_LIB_RSS_MINIMUM_BYTES,
  PdfLibRssFrameParser,
  calculatePdfLibRssLimit,
} from "../server/pdf-lib-subprocess.js";
import {
  PDF_LIB_RSS_READY,
  PDF_LIB_RSS_SAMPLE,
  PDF_LIB_RSS_TERMINAL,
  encodePdfLibRssFrame,
  writePdfLibRssFrameCompletely,
} from "../server/pdf-lib-rss-monitor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function frames(...rows) {
  return Buffer.concat(rows.map(([type, sequence, rss]) =>
    encodePdfLibRssFrame(type, sequence, rss)));
}

function parser(maximumRssBytes = PDF_LIB_RSS_MAXIMUM_BYTES) {
  return new PdfLibRssFrameParser({ maximumRssBytes });
}

function changedFrame(frame, offset, value) {
  const changed = Buffer.from(frame);
  changed[offset] = value;
  return changed;
}

describe("pdf-lib RSS monitor protocol", () => {
  it("uses the bounded source-proportional threshold without safe-integer overflow", () => {
    expect(calculatePdfLibRssLimit(1)).toBe(PDF_LIB_RSS_MINIMUM_BYTES);
    expect(calculatePdfLibRssLimit(64 * 1024 * 1024)).toBe(
      PDF_LIB_RSS_MINIMUM_BYTES,
    );
    expect(calculatePdfLibRssLimit(100 * 1024 * 1024)).toBe(
      656 * 1024 * 1024,
    );
    expect(calculatePdfLibRssLimit(192 * 1024 * 1024)).toBe(
      PDF_LIB_RSS_MAXIMUM_BYTES,
    );
    expect(calculatePdfLibRssLimit(193 * 1024 * 1024)).toBe(
      PDF_LIB_RSS_MAXIMUM_BYTES,
    );
    expect(calculatePdfLibRssLimit(Number.MAX_SAFE_INTEGER)).toBe(
      PDF_LIB_RSS_MAXIMUM_BYTES,
    );
  });

  it("accepts split and coalesced fixed frames while retaining only a trailing fragment", () => {
    const bytes = frames(
      [PDF_LIB_RSS_READY, 0, 100],
      [PDF_LIB_RSS_SAMPLE, 1, 200],
      [PDF_LIB_RSS_TERMINAL, 2, 150],
    );
    const split = parser();
    split.add(bytes.subarray(0, 7));
    split.add(bytes.subarray(7, 39));
    split.add(bytes.subarray(39));
    expect(split.finish()).toMatchObject({
      frames: 3,
      lastSequence: 2,
      maximumObservedRss: 200,
    });

    const coalesced = parser();
    coalesced.add(bytes);
    expect(coalesced.finish()).toMatchObject({ frames: 3, lastSequence: 2 });
  });

  it("retries EINTR and completes partial synchronous frame writes", () => {
    const source = encodePdfLibRssFrame(PDF_LIB_RSS_READY, 0, 123);
    const destination = Buffer.alloc(source.length);
    let destinationOffset = 0;
    let attempts = 0;
    writePdfLibRssFrameCompletely(3, source, (
      _fd,
      bytes,
      offset,
      length,
    ) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("interrupted");
        error.code = "EINTR";
        throw error;
      }
      const written = Math.min(3, length);
      bytes.copy(
        destination,
        destinationOffset,
        offset,
        offset + written,
      );
      destinationOffset += written;
      return written;
    });
    expect(destination.equals(source)).toBe(true);
    expect(attempts).toBeGreaterThan(2);
  });

  it.each([
    [
      "wrong magic",
      changedFrame(frames([PDF_LIB_RSS_READY, 0, 100]), 0, 0),
    ],
    [
      "wrong version",
      changedFrame(frames([PDF_LIB_RSS_READY, 0, 100]), 4, 2),
    ],
    [
      "unknown type",
      Buffer.concat([
        frames([PDF_LIB_RSS_READY, 0, 100]),
        changedFrame(frames([PDF_LIB_RSS_SAMPLE, 1, 100]), 5, 99),
      ]),
    ],
    ["missing READY", frames([PDF_LIB_RSS_SAMPLE, 0, 100])],
    [
      "duplicate READY",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_READY, 1, 100],
      ),
    ],
    [
      "sequence gap",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_SAMPLE, 2, 100],
      ),
    ],
    [
      "sequence duplicate",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_SAMPLE, 1, 100],
        [PDF_LIB_RSS_SAMPLE, 1, 100],
      ),
    ],
    [
      "sequence regression",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_SAMPLE, 1, 100],
        [PDF_LIB_RSS_SAMPLE, 0, 100],
      ),
    ],
    [
      "duplicate terminal",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_TERMINAL, 1, 100],
        [PDF_LIB_RSS_TERMINAL, 2, 100],
      ),
    ],
    [
      "frame after terminal",
      frames(
        [PDF_LIB_RSS_READY, 0, 100],
        [PDF_LIB_RSS_TERMINAL, 1, 100],
        [PDF_LIB_RSS_SAMPLE, 2, 100],
      ),
    ],
  ])("rejects %s", (_label, bytes) => {
    const subject = parser();
    expect(() => subject.add(bytes)).toThrow();
  });

  it("rejects partial terminal data, zero RSS, and a high sample", () => {
    const partial = parser();
    const valid = frames(
      [PDF_LIB_RSS_READY, 0, 100],
      [PDF_LIB_RSS_TERMINAL, 1, 100],
    );
    partial.add(valid.subarray(0, valid.length - 1));
    expect(() => partial.finish()).toThrow(/partial/);

    const zero = parser();
    expect(() => zero.add(frames([PDF_LIB_RSS_READY, 0, 0]))).toThrow(
      /positive/,
    );

    const high = parser(150);
    expect(() => high.add(frames(
      [PDF_LIB_RSS_READY, 0, 100],
      [PDF_LIB_RSS_SAMPLE, 1, 151],
    ))).toThrow(expect.objectContaining({ code: "PDF_LIB_RSS_LIMIT" }));
  });

  it("keeps source and share monitor, parent, and worker modules byte-identical", async () => {
    for (const filename of [
      "pdf-lib-rss-monitor.js",
      "pdf-lib-subprocess.js",
      "pdf-lib-worker.js",
    ]) {
      const [source, share] = await Promise.all([
        fs.readFile(path.join(REPO_ROOT, "server", filename)),
        fs.readFile(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "server", filename)),
      ]);
      expect(share.equals(source), filename).toBe(true);
    }
  });
});
