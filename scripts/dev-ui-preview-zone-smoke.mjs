import path from "node:path";
import { createAgentBrowserSessionRunner, evalJson, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4176);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-preview-zone-smoke-${Date.now()}`;
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

    const signState = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      hasInspect: !!document.querySelector("#sign-panel-inspect-btn"),
      zoneCount: document.querySelectorAll(".sig-zone").length,
      signPanelVisible: getComputedStyle(document.querySelector("#sign-panel")).display !== "none"
    }))()`);
    if (!signState.hasInspect || !signState.signPanelVisible) {
      throw new Error("Sign mode did not expose the inspect-region control.");
    }

    await evalJson(runAgentBrowser, `(() => {
      document.querySelector("#sign-panel-inspect-btn").click();
      return JSON.stringify({ clicked: true });
    })()`);
    await runAgentBrowser(["batch", "mouse move 250 200", "mouse down", "mouse move 360 270", "mouse up"]);
    await runAgentBrowser(["wait", "1200"]);

    const previewState = await evalJson(runAgentBrowser, `(() => {
      const modal = document.querySelector("#region-preview-modal");
      return JSON.stringify({
        modalOpen: !!modal && getComputedStyle(modal).display !== "none",
        hasCreate: !!document.querySelector("#region-preview-create-zone")
      });
    })()`);
    if (!previewState.modalOpen || !previewState.hasCreate) {
      throw new Error("Preview modal did not expose a create-zone action.");
    }

    await evalJson(runAgentBrowser, `(() => {
      document.querySelector("#region-preview-create-zone").click();
      return JSON.stringify({ clicked: true });
    })()`);
    await runAgentBrowser(["wait", "800"]);

    const modalState = await evalJson(runAgentBrowser, `(() => {
      const modal = document.querySelector("#sign-modal");
      const title = document.querySelector("#sign-modal-title")?.textContent || "";
      const panelText = document.querySelector("#sign-panel-list")?.textContent || "";
      return JSON.stringify({
        signModalOpen: !!modal && getComputedStyle(modal).display !== "none",
        title,
        hasCancel: !!document.querySelector("#sign-modal-cancel"),
        hasCustomZone: panelText.includes("Custom")
      });
    })()`);
    if (!modalState.signModalOpen || !modalState.hasCancel) {
      throw new Error("Creating a zone from preview did not open the sign modal.");
    }
    const openedKnownMode =
      modalState.title.includes("Confirm signature") ||
      modalState.title.includes("Insert date") ||
      modalState.title.includes("Confirm initials");
    if (!openedKnownMode) {
      throw new Error("The preview-to-zone handoff did not open a recognized signing modal.");
    }
    if (!modalState.hasCustomZone) {
      throw new Error("The sign panel did not show the new custom zone after creating it from preview.");
    }

    console.log(`\n[dev-ui-preview-zone-smoke] OK: preview-to-zone handoff responded at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-preview-zone-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
