import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  downloadPdfFromUrl,
  sanitizePdfFilename,
  findUniquePath,
  isPrivateHost,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;

beforeAll(async () => {
  TMP_DIR = await createTestTempDirectory(REPO_ROOT, "fetch");
});

afterAll(async () => {
  await removeTestTempDirectory(TMP_DIR);
});

// Build a fake fetch that returns a given body + headers + status.
function makeFakeFetch({ body, contentType = "application/pdf", status = 200, statusText = "OK" }) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        const n = name.toLowerCase();
        if (n === "content-type") return contentType;
        if (n === "content-length") return body ? String(body.length) : null;
        return null;
      },
    },
    arrayBuffer: async () => body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0),
  });
}

describe("sanitizePdfFilename", () => {
  it("appends .pdf if missing", () => {
    expect(sanitizePdfFilename("report")).toBe("report.pdf");
  });
  it("keeps existing .pdf", () => {
    expect(sanitizePdfFilename("report.pdf")).toBe("report.pdf");
  });
  it("strips path components", () => {
    expect(sanitizePdfFilename("../../etc/passwd")).toBe("passwd.pdf");
  });
  it("replaces illegal chars", () => {
    expect(sanitizePdfFilename("a<b>c:d|e.pdf")).toBe("a_b_c_d_e.pdf");
  });
  it("handles empty input", () => {
    expect(sanitizePdfFilename("")).toBe("download.pdf");
    expect(sanitizePdfFilename(null)).toBe("download.pdf");
  });
  it("strips leading dots", () => {
    expect(sanitizePdfFilename("...hidden.pdf")).toBe("hidden.pdf");
  });
});

describe("isPrivateHost", () => {
  it("flags loopback", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.10.20.30")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
  });
  it("flags RFC1918 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
  });
  it("flags AWS metadata link-local", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });
  it("does NOT flag 172.15 or 172.32 (outside RFC1918)", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
  it("does NOT flag public addresses", () => {
    expect(isPrivateHost("up.sandyspringsga.gov")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
  });
  it("flags .local and .localhost suffixes", () => {
    expect(isPrivateHost("printer.local")).toBe(true);
    expect(isPrivateHost("web.localhost")).toBe(true);
  });
});

describe("findUniquePath", () => {
  it("returns target unchanged when file doesn't exist", async () => {
    const target = path.join(TMP_DIR, "brand-new.pdf");
    expect(await findUniquePath(target)).toBe(target);
  });
  it("appends (2) when file exists", async () => {
    const target = path.join(TMP_DIR, "exists.pdf");
    await fs.writeFile(target, "x");
    const unique = await findUniquePath(target);
    expect(unique).toBe(path.join(TMP_DIR, "exists (2).pdf"));
  });
  it("appends (3) when (2) also exists", async () => {
    const target = path.join(TMP_DIR, "twice.pdf");
    await fs.writeFile(target, "x");
    await fs.writeFile(path.join(TMP_DIR, "twice (2).pdf"), "x");
    const unique = await findUniquePath(target);
    expect(unique).toBe(path.join(TMP_DIR, "twice (3).pdf"));
  });
});

describe("downloadPdfFromUrl", () => {
  let examplePdfBuffer;

  beforeAll(async () => {
    examplePdfBuffer = await fs.readFile(EXAMPLE_PDF);
  });

  it("downloads a valid PDF and returns metadata", async () => {
    const result = await downloadPdfFromUrl("https://example.com/fw9.pdf", {
      destinationDir: TMP_DIR,
      filename: "happy-path.pdf",
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toBe(path.join(TMP_DIR, "happy-path.pdf"));
    expect(result.bytes).toBe(examplePdfBuffer.length);
    expect(result.contentType).toBe("application/pdf");
    expect(result.sourceUrl).toBe("https://example.com/fw9.pdf");

    const saved = await fs.readFile(result.path);
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("derives filename from URL when not provided", async () => {
    const result = await downloadPdfFromUrl("https://example.com/path/to/Business%20License.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(path.basename(result.path)).toBe("Business License.pdf");
  });

  it("appends (2) when file exists and overwrite=false", async () => {
    const first = await downloadPdfFromUrl("https://example.com/dup.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    const second = await downloadPdfFromUrl("https://example.com/dup.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(first.path).not.toBe(second.path);
    expect(second.path).toMatch(/dup \(2\)\.pdf$/);
  });

  it("overwrites when overwrite=true", async () => {
    const p = path.join(TMP_DIR, "overwrite.pdf");
    await fs.writeFile(p, "not a pdf");
    const result = await downloadPdfFromUrl("https://example.com/overwrite.pdf", {
      destinationDir: TMP_DIR,
      overwrite: true,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toBe(p);
    const saved = await fs.readFile(p);
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(
      downloadPdfFromUrl("file:///etc/passwd", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/http and https/);
    await expect(
      downloadPdfFromUrl("data:application/pdf;base64,JVBERi0x", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/http and https/);
  });

  it("rejects private hosts by default", async () => {
    await expect(
      downloadPdfFromUrl("http://localhost:8080/x.pdf", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/private\/loopback/);
    await expect(
      downloadPdfFromUrl("http://169.254.169.254/metadata", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/private\/loopback/);
  });

  it("allows private hosts when opted in", async () => {
    const result = await downloadPdfFromUrl("http://192.168.1.50/internal.pdf", {
      destinationDir: TMP_DIR,
      allowPrivateHosts: true,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("rejects HTML response (non-PDF content)", async () => {
    const html = Buffer.from("<!doctype html><html><body>Not found</body></html>");
    await expect(
      downloadPdfFromUrl("https://example.com/fake.pdf", {
        destinationDir: TMP_DIR,
        fetchFn: makeFakeFetch({ body: html, contentType: "text/html" }),
      })
    ).rejects.toThrow(/did not return a PDF/);
  });

  it("rejects HTTP error status", async () => {
    await expect(
      downloadPdfFromUrl("https://example.com/missing.pdf", {
        destinationDir: TMP_DIR,
        fetchFn: makeFakeFetch({ body: Buffer.from(""), status: 404, statusText: "Not Found" }),
      })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects oversize PDF via content-length", async () => {
    // Fake fetch advertises a 200MB content-length
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          const n = name.toLowerCase();
          if (n === "content-type") return "application/pdf";
          if (n === "content-length") return String(200 * 1024 * 1024);
          return null;
        },
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadPdfFromUrl("https://example.com/huge.pdf", {
        destinationDir: TMP_DIR,
        maxSizeMb: 100,
        fetchFn,
      })
    ).rejects.toThrow(/exceeds 100 MB/);
  });

  it("rejects invalid URL", async () => {
    await expect(
      downloadPdfFromUrl("not a url", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/Invalid URL/);
  });

  it("reports network error clearly", async () => {
    const fetchFn = async () => { throw new Error("ECONNREFUSED"); };
    await expect(
      downloadPdfFromUrl("https://example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/Could not reach example\.com: ECONNREFUSED/);
  });

  it("preserves .pdf extension when URL has no filename", async () => {
    const result = await downloadPdfFromUrl("https://example.com/", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toMatch(/\.pdf$/);
  });
});

// ─── Redirect-based SSRF (v0.8.0 blocker fix) ────────────────────────────────

function makeRedirectFetch(redirects) {
  // redirects: array of { from, to } objects; final call returns the body.
  // Example: [{ from: "https://public.com/x.pdf", to: "http://169.254.169.254/..." }]
  let callIndex = 0;
  return async (url) => {
    const hop = redirects[callIndex];
    callIndex++;
    if (hop && hop.from === url) {
      return {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: {
          get(name) {
            if (name.toLowerCase() === "location") return hop.to;
            return null;
          },
        },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    // Final non-redirect response — return a valid PDF body
    const body = redirects._body;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "application/pdf";
          if (name.toLowerCase() === "content-length") return String(body.length);
          return null;
        },
      },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

describe("downloadPdfFromUrl — redirect SSRF protection", () => {
  let examplePdfBuffer;

  beforeAll(async () => {
    examplePdfBuffer = await fs.readFile(EXAMPLE_PDF);
  });

  it("rejects redirect to AWS metadata endpoint (169.254.169.254)", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://169.254.169.254/latest/meta-data/" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "169\.254\.169\.254"/);
  });

  it("rejects redirect to localhost", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://localhost:8080/secret.pdf" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "localhost"/);
  });

  it("rejects redirect to RFC1918 internal network", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://10.0.0.1/intranet.pdf" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "10\.0\.0\.1"/);
  });

  it("follows a public-to-public redirect successfully", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://short.example.com/fw9", to: "https://www.irs.gov/pub/irs-pdf/fw9.pdf" }],
      { _body: examplePdfBuffer }
    ));
    const result = await downloadPdfFromUrl("https://short.example.com/fw9", {
      destinationDir: TMP_DIR,
      filename: "redirected.pdf",
      overwrite: true,
      fetchFn,
    });
    expect(result.bytes).toBe(examplePdfBuffer.length);
    expect(result.redirectHops).toBe(1);
    expect(result.finalUrl).toBe("https://www.irs.gov/pub/irs-pdf/fw9.pdf");
  });

  it("rejects redirect loop exceeding maxRedirects", async () => {
    const manyHops = Array.from({ length: 10 }, (_, i) => ({
      from: `https://hop${i}.example.com/`,
      to: `https://hop${i + 1}.example.com/`,
    }));
    const fetchFn = makeRedirectFetch(Object.assign(manyHops, { _body: examplePdfBuffer }));
    await expect(
      downloadPdfFromUrl("https://hop0.example.com/", {
        destinationDir: TMP_DIR,
        fetchFn,
        maxRedirects: 5,
      })
    ).rejects.toThrow(/Too many redirects/);
  });

  it("resolves relative Location headers against the current URL", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://example.com/old/x.pdf", to: "/new/x.pdf" }],
      { _body: examplePdfBuffer }
    ));
    const result = await downloadPdfFromUrl("https://example.com/old/x.pdf", {
      destinationDir: TMP_DIR,
      filename: "relative.pdf",
      overwrite: true,
      fetchFn,
    });
    expect(result.finalUrl).toBe("https://example.com/new/x.pdf");
  });

  it("does NOT write a file when redirect is rejected", async () => {
    const before = await fs.readdir(TMP_DIR).catch(() => []);
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://127.0.0.1/" }],
      { _body: Buffer.from("") }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow();
    const after = await fs.readdir(TMP_DIR).catch(() => []);
    expect(after.length).toBe(before.length);
  });
});
