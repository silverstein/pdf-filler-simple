import path from "node:path";
import { createAgentBrowserSessionRunner, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4174);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-sign-smoke-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best effort — not worth failing the smoke run during cleanup.
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
    if (!signSnapshot.includes("✎ Draw signature") || !signSnapshot.includes("🔍 Inspect region")) {
      throw new Error("Sign mode did not expose the expected sign panel controls.");
    }
    if (!signSnapshot.includes("Preview")) {
      throw new Error("Sign mode did not expose any zone preview affordances.");
    }

    await runAgentBrowser(["click", ".sign-panel-item"]);
    await runAgentBrowser(["wait", "800"]);
    const modalSnapshot = await runAgentBrowser(["snapshot", "-i"]);
    if (!modalSnapshot.includes("Cancel")) {
      throw new Error("Clicking a sign-panel row did not open a modal.");
    }
    const openedKnownMode =
      modalSnapshot.includes("Sign") ||
      modalSnapshot.includes("Insert date") ||
      modalSnapshot.includes("Stamp initials");
    if (!openedKnownMode) {
      throw new Error("The sign-panel interaction did not open a recognized signing modal.");
    }

    console.log(`\n[dev-ui-sign-smoke] OK: sign mode and modal flow responded at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-sign-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
