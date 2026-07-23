import path from "node:path";
import { createAgentBrowserSessionRunner, evalJson, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4186);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-name-zone-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best effort cleanup.
  }
}

async function main() {
  await withDevUiServer(port, async () => {
    await runAgentBrowser(["open", `${origin}/?pdf_path=${encodeURIComponent(examplePdfPath)}`]);
    await runAgentBrowser(["wait", "1500"]);
    await evalJson(runAgentBrowser, `(() => {
      window.__nameZoneOriginalFetch = window.fetch;
      window.__nameZoneCalls = [];
      window.fetch = async (...args) => {
        const options = args[1] || {};
        let payload = null;
        try { payload = JSON.parse(options.body || "null"); } catch {}
        if (payload?.name) {
          window.__nameZoneCalls.push({
            name: payload.name,
            arguments: payload.arguments || {}
          });
        }
        if (payload?.name === "detect_signature_zones") {
          return new Response(JSON.stringify({
            content: [{ type: "text", text: "Found one name zone" }],
            structuredContent: {
              detection_status: "complete",
              warnings: [],
              zones: [{
                type: "name",
                label: "Print Name:",
                page: 1,
                x: 100,
                y: 500,
                width: 180,
                height: 20,
                confidence: 0.8,
                source: "text-heuristic"
              }]
            }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (payload?.name === "apply_text") {
          return new Response(JSON.stringify({
            content: [{ type: "text", text: "Name inserted" }],
            structuredContent: {
              pdf_path: ${JSON.stringify(examplePdfPath)},
              backup_path: null
            }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return window.__nameZoneOriginalFetch(...args);
      };
      return JSON.stringify({ installed: true });
    })()`);

    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "500"]);
    await runAgentBrowser(["click", ".sign-panel-item-type[data-type=name]"]);
    await runAgentBrowser(["wait", "200"]);

    const modal = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      title: document.querySelector("#sign-modal-title")?.textContent,
      savedRowDisplay: getComputedStyle(document.querySelector("#sign-modal-existing-row")).display
    }))()`);
    assert(modal.title === "Insert printed name", `Unexpected name modal title: ${modal.title}.`);
    assert(modal.savedRowDisplay === "none", "Name flow exposed the saved-signature selector.");

    await runAgentBrowser(["fill", "#sign-modal-name", "Ada Example"]);
    await runAgentBrowser(["click", "#sign-modal-confirm"]);
    await runAgentBrowser(["wait", "800"]);

    const calls = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      calls: window.__nameZoneCalls,
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      legend: document.querySelector(".sign-panel-legend")?.textContent,
      appliedStatus: document.querySelector(".sign-panel-item-status")?.textContent
    }))()`);
    const applyTextCalls = calls.calls.filter(call => call.name === "apply_text");
    assert(applyTextCalls.length === 1, `Expected one apply_text call, got ${applyTextCalls.length}.`);
    assert(JSON.stringify(applyTextCalls[0].arguments) === JSON.stringify({
      pdf_path: examplePdfPath,
      output_path: examplePdfPath,
      page: 1,
      x: 100,
      y: 500,
      width: 180,
      height: 20,
      text: "Ada Example",
    }), `apply_text received unexpected arguments: ${JSON.stringify(applyTextCalls[0].arguments)}.`);
    assert(calls.calls.filter(call => call.name === "create_signature").length === 0, "Name flow called create_signature.");
    assert(calls.calls.filter(call => call.name === "apply_signature").length === 0, "Name flow called apply_signature.");
    assert(!calls.modalOpen, "Name modal did not close after apply_text succeeded.");
    assert(calls.legend.includes("Name"), "Sign mode did not expose a visible name legend.");
    assert(calls.appliedStatus === "✓ Ada Example", `Unexpected applied name status: ${calls.appliedStatus}.`);

    console.log(`\n[dev-ui-name-zone-smoke] OK: name zones use apply_text at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-name-zone-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
