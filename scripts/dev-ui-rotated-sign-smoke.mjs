import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { createAgentBrowserSessionRunner, evalJson, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4176);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
let tmpDir;
const session = `pdf-tools-rotated-sign-smoke-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);

const cases = [
  {
    degrees: 90,
    expected: { left: [257, 267], top: [120, 140], tall: true },
  },
  {
    degrees: 180,
    expected: { left: [226, 246], top: [257, 267], tall: false },
  },
  {
    degrees: 270,
    expected: { left: [508, 518], top: [226, 246], tall: true },
  },
];

async function createRotatedFixture(rotationDegrees) {
  const rotatedPdfPath = path.join(tmpDir, `rotated-w9-ui-smoke-${rotationDegrees}.pdf`);
  const sourceBytes = await fs.readFile(path.join(repoRoot, "example-fw9.pdf"));
  const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  doc.getPage(0).setRotation(degrees(rotationDegrees));
  await fs.writeFile(rotatedPdfPath, await doc.save());
  return rotatedPdfPath;
}

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best effort; cleanup should not mask the actual smoke result.
  }
}

async function main() {
  tmpDir = await fs.mkdtemp(path.join(repoRoot, ".test-tmp-rotated-ui-"));
  await withDevUiServer(port, async () => {
    for (const testCase of cases) {
      const rotatedPdfPath = await createRotatedFixture(testCase.degrees);
      await runAgentBrowser(["open", `${origin}/?pdf_path=${encodeURIComponent(rotatedPdfPath)}`]);
      await runAgentBrowser(["wait", "1500"]);
      await runAgentBrowser(["click", "#mode-sign-btn"]);
      await runAgentBrowser(["wait", "1200"]);

      const result = await evalJson(runAgentBrowser, `(() => {
        const zone = document.querySelector(".sig-zone[data-type=signature]");
        if (!zone) return JSON.stringify({ ok: false, reason: "no signature zone" });
        const label = zone.querySelector(".sig-zone-label");
        const zr = zone.getBoundingClientRect();
        const lr = label ? label.getBoundingClientRect() : null;
        const layer = document.querySelector("#zone-layer");
        const layerRect = layer.getBoundingClientRect();
        const transform = label ? getComputedStyle(label).transform : "";
        return JSON.stringify({
          ok: true,
          zone: { width: zr.width, height: zr.height },
          relative: { left: zr.left - layerRect.left, top: zr.top - layerRect.top },
          label: lr ? { width: lr.width, height: lr.height } : null,
          transform,
        });
      })()`);
      if (!result?.ok) {
        throw new Error(`No signature zone found for rotation ${testCase.degrees}.`);
      }
      const shapeIsTall = result.zone.height > result.zone.width * 4;
      if (shapeIsTall !== testCase.expected.tall) {
        throw new Error(`Unexpected shape for rotation ${testCase.degrees}: ${JSON.stringify(result.zone)}`);
      }
      const [minLeft, maxLeft] = testCase.expected.left;
      const [minTop, maxTop] = testCase.expected.top;
      if (result.relative.left < minLeft || result.relative.left > maxLeft ||
          result.relative.top < minTop || result.relative.top > maxTop) {
        throw new Error(
          `Unexpected position for rotation ${testCase.degrees}: ${JSON.stringify(result.relative)}`
        );
      }
      if (!result.transform || result.transform === "none") {
        throw new Error(`Expected rotated label transform for rotation ${testCase.degrees}, got ${result.transform}`);
      }

      console.log(`[dev-ui-rotated-sign-smoke] ${testCase.degrees}° OK: ${JSON.stringify(result)}`);
    }
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-rotated-sign-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
