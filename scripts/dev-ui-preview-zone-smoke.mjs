import path from "node:path";
import { createAgentBrowserSessionRunner, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

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

    await runAgentBrowser(["click", "#sign-panel-inspect-btn"]);
    await runAgentBrowser(["batch", "mouse move 250 200", "mouse down", "mouse move 360 270", "mouse up"]);
    await runAgentBrowser(["wait", "1200"]);

    const previewSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!previewSnapshot.includes("Create")) {
      throw new Error("Preview modal did not expose a create-zone action.");
    }

    await runAgentBrowser(["click", "#region-preview-create-zone"]);
    await runAgentBrowser(["wait", "800"]);

    const signSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!signSnapshot.includes("Cancel")) {
      throw new Error("Creating a zone from preview did not open the sign modal.");
    }
    const openedKnownMode =
      signSnapshot.includes("Sign") ||
      signSnapshot.includes("Insert date") ||
      signSnapshot.includes("Stamp initials");
    if (!openedKnownMode) {
      throw new Error("The preview-to-zone handoff did not open a recognized signing modal.");
    }
    if (!signSnapshot.includes("Preview Custom")) {
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
