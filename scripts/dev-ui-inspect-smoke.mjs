import path from "node:path";
import { createAgentBrowserSessionRunner, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4175);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-inspect-smoke-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best effort cleanup.
  }
}

async function main() {
  await withDevUiServer(port, async () => {
    const encodedPdfPath = encodeURIComponent(examplePdfPath);
    await runAgentBrowser(["open", `${origin}/?pdf_path=${encodedPdfPath}`]);
    await runAgentBrowser(["wait", "1500"]);
    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "1000"]);

    const signSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!signSnapshot.includes("🔍 Inspect region")) {
      throw new Error("Sign mode did not expose the inspect-region control.");
    }

    await runAgentBrowser(["click", "#sign-panel-inspect-btn"]);
    await runAgentBrowser(["batch", "mouse move 250 200", "mouse down", "mouse move 360 270", "mouse up"]);
    await runAgentBrowser(["wait", "1200"]);

    const previewSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!previewSnapshot.includes("Copy coordinates") || !previewSnapshot.includes("Done")) {
      throw new Error("Inspect-region drag did not open the preview modal.");
    }
    if (!previewSnapshot.includes("Create")) {
      throw new Error("Inspect-region preview did not expose any create-zone action.");
    }

    console.log(`\n[dev-ui-inspect-smoke] OK: inspect-region preview responded at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-inspect-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
