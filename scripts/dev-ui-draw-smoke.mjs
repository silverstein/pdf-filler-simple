import path from "node:path";
import { createAgentBrowserSessionRunner, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4177);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-draw-smoke-${Date.now()}`;
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
    await runAgentBrowser(["wait", "800"]);
    await runAgentBrowser(["click", "#sign-panel-draw-btn"]);
    await runAgentBrowser(["wait", "600"]);

    const modalSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!modalSnapshot.includes("Save signature")) {
      throw new Error("Draw-signature modal did not open.");
    }

    await runAgentBrowser(["batch", "mouse move 240 170", "mouse down", "mouse move 320 190", "mouse up"]);
    await runAgentBrowser(["fill", "#draw-name-input", `smoke-${Date.now()}`]);
    await runAgentBrowser(["fill", "#draw-legal-name-input", "Smoke Test User"]);
    await runAgentBrowser(["wait", "300"]);
    await runAgentBrowser(["click", "#draw-modal-save"]);
    await runAgentBrowser(["wait", "1000"]);

    const afterSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (afterSnapshot.includes("Save signature") && afterSnapshot.includes("Undo")) {
      throw new Error("Draw-signature modal appears to still be open after save.");
    }
    if (!afterSnapshot.includes("✎ Draw signature")) {
      throw new Error("Viewer did not return to sign mode after saving the drawn signature.");
    }

    console.log(`\n[dev-ui-draw-smoke] OK: draw-signature flow responded at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-draw-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
