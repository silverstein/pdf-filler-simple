import path from "node:path";
import { createAgentBrowserSessionRunner, evalJson, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4187);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-operation-mode-race-${Date.now()}`;
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

async function createCustomZone(yFraction) {
  const drag = await evalJson(runAgentBrowser, `(() => {
    const rect = document.querySelector("#zone-layer").getBoundingClientRect();
    return JSON.stringify({
      start: {
        x: Math.round(rect.left + rect.width * 0.2),
        y: Math.round(rect.top + rect.height * ${yFraction})
      },
      end: {
        x: Math.round(rect.left + rect.width * 0.42),
        y: Math.round(rect.top + rect.height * (${yFraction} + 0.08))
      }
    });
  })()`);
  await runAgentBrowser(["mouse", "move", String(drag.start.x), String(drag.start.y)]);
  await runAgentBrowser(["mouse", "down"]);
  await runAgentBrowser(["mouse", "move", String(drag.end.x), String(drag.end.y)]);
  await runAgentBrowser(["mouse", "up"]);
  await runAgentBrowser(["wait", "250"]);
}

async function assertLockedAndAttemptModeChange(nextMode) {
  return evalJson(runAgentBrowser, `(() => {
    const type = document.querySelector("#sign-modal-type");
    const beforeZone = document.querySelector("#sign-modal-zone")?.textContent || "";
    const locked = [
      "#sign-modal-type",
      "#sign-modal-name",
      "#sign-modal-existing",
      "#sign-modal-date",
      "#sign-modal-cancel",
      "#sign-modal-close",
      "#sign-modal-confirm"
    ].every(selector => document.querySelector(selector)?.disabled === true);
    type.value = ${JSON.stringify(nextMode)};
    type.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({
      locked,
      beforeZone,
      afterZone: document.querySelector("#sign-modal-zone")?.textContent || "",
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none"
    });
  })()`);
}

async function main() {
  await withDevUiServer(port, async () => {
    await runAgentBrowser(["open", `${origin}/?pdf_path=${encodeURIComponent(examplePdfPath)}`]);
    await runAgentBrowser(["wait", "1200"]);
    await evalJson(runAgentBrowser, `(() => {
      window.__operationModeOriginalFetch = window.fetch;
      window.__operationModeCalls = [];
      window.__operationModePending = null;
      window.__operationModeRelease = null;
      window.__operationModeDelayTool = null;

      const responseFor = payload => {
        if (payload.name === "detect_signature_zones") {
          return {
            content: [{ type: "text", text: "No automatic zones" }],
            structuredContent: { detection_status: "complete", warnings: [], zones: [] }
          };
        }
        if (payload.name === "list_signatures") {
          return {
            content: [{ type: "text", text: "No saved signatures" }],
            structuredContent: { signatures: [] }
          };
        }
        if (payload.name === "create_signature") {
          return {
            content: [{ type: "text", text: "Signature created" }],
            structuredContent: { name: "__pdf-tools-quick-typed__" }
          };
        }
        if (payload.name === "apply_signature") {
          return {
            content: [{ type: "text", text: "Signature applied" }],
            structuredContent: {
              pdf_path: ${JSON.stringify(examplePdfPath)},
              backup_path: null
            }
          };
        }
        if (payload.name === "apply_text") {
          return {
            content: [{ type: "text", text: "Text applied" }],
            structuredContent: {
              pdf_path: ${JSON.stringify(examplePdfPath)},
              backup_path: null
            }
          };
        }
        return null;
      };

      window.fetch = async (...args) => {
        const options = args[1] || {};
        let payload = null;
        try { payload = JSON.parse(options.body || "null"); } catch {}
        if (!payload?.name) return window.__operationModeOriginalFetch(...args);

        window.__operationModeCalls.push({
          name: payload.name,
          arguments: payload.arguments || {}
        });
        const body = responseFor(payload);
        if (!body) return window.__operationModeOriginalFetch(...args);

        if (payload.name === window.__operationModeDelayTool) {
          window.__operationModePending = payload.name;
          return new Promise(resolve => {
            window.__operationModeRelease = () => {
              window.__operationModePending = null;
              window.__operationModeRelease = null;
              resolve(new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" }
              }));
            };
          });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      return JSON.stringify({ installed: true });
    })()`);

    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "300"]);

    // Signature invocation stays on the signature route after a name mutation attempt.
    await createCustomZone(0.2);
    await runAgentBrowser(["fill", "#sign-modal-name", "Route Lock User"]);
    await evalJson(runAgentBrowser, `(() => {
      window.__operationModeDelayTool = "create_signature";
      return JSON.stringify({ ready: true });
    })()`);
    await runAgentBrowser(["click", "#sign-modal-confirm"]);
    await runAgentBrowser(["wait", "150"]);
    const signatureMutation = await assertLockedAndAttemptModeChange("name");
    assert(signatureMutation.locked, "Signature operation did not lock every modal control.");
    assert(signatureMutation.beforeZone === signatureMutation.afterZone, "Signature zone routing changed while the operation was in flight.");
    assert(signatureMutation.modalOpen, "Signature modal closed while the operation was in flight.");
    await evalJson(runAgentBrowser, `(() => {
      if (window.__operationModePending !== "create_signature" || !window.__operationModeRelease) {
        throw new Error("create_signature was not awaiting release");
      }
      window.__operationModeRelease();
      return JSON.stringify({ released: true });
    })()`);
    await runAgentBrowser(["wait", "1000"]);

    const signatureCalls = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      calls: window.__operationModeCalls,
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      appliedTypes: Array.from(document.querySelectorAll(".sign-panel-item-type"))
        .map(element => element.dataset.type)
    }))()`);
    assert(signatureCalls.calls.filter(call => call.name === "create_signature").length === 1, "Signature route did not create exactly one typed signature.");
    assert(signatureCalls.calls.filter(call => call.name === "apply_signature").length === 1, "Signature route did not execute exactly one apply_signature.");
    assert(signatureCalls.calls.filter(call => call.name === "apply_text").length === 0, "Signature route reached apply_text after the name mutation attempt.");
    assert(signatureCalls.calls.find(call => call.name === "apply_signature")?.arguments.signing_mode === "signature", "Signature route changed signing_mode.");
    assert(signatureCalls.appliedTypes.includes("signature"), "Signature zone persisted as a different type after the name mutation attempt.");
    assert(!signatureCalls.appliedTypes.includes("name"), "Signature zone crossed into the name type after invocation.");
    assert(!signatureCalls.modalOpen, "Signature modal remained open after success.");

    // Name invocation stays on the text route after a signature mutation attempt.
    await evalJson(runAgentBrowser, `(() => {
      window.__operationModeCalls = [];
      window.__operationModeDelayTool = "apply_text";
      return JSON.stringify({ reset: true });
    })()`);
    await createCustomZone(0.36);
    await evalJson(runAgentBrowser, `(() => {
      const type = document.querySelector("#sign-modal-type");
      type.value = "name";
      type.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify({ selected: type.value });
    })()`);
    await runAgentBrowser(["fill", "#sign-modal-name", "Printed Route Name"]);
    await runAgentBrowser(["click", "#sign-modal-confirm"]);
    await runAgentBrowser(["wait", "150"]);
    const nameMutation = await assertLockedAndAttemptModeChange("signature");
    assert(nameMutation.locked, "Name operation did not lock every modal control.");
    assert(nameMutation.beforeZone === nameMutation.afterZone, "Name zone routing changed while the operation was in flight.");
    assert(nameMutation.modalOpen, "Name modal closed while the operation was in flight.");
    await evalJson(runAgentBrowser, `(() => {
      if (window.__operationModePending !== "apply_text" || !window.__operationModeRelease) {
        throw new Error("apply_text was not awaiting release");
      }
      window.__operationModeRelease();
      return JSON.stringify({ released: true });
    })()`);
    await runAgentBrowser(["wait", "1000"]);

    const nameCalls = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      calls: window.__operationModeCalls,
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      appliedTypes: Array.from(document.querySelectorAll(".sign-panel-item-type"))
        .map(element => element.dataset.type),
      appliedStatuses: Array.from(document.querySelectorAll(".sign-panel-item-status"))
        .map(element => element.textContent)
    }))()`);
    assert(nameCalls.calls.filter(call => call.name === "apply_text").length === 1, "Name route did not execute exactly one apply_text.");
    assert(nameCalls.calls.filter(call => call.name === "create_signature").length === 0, "Name route reached create_signature after the signature mutation attempt.");
    assert(nameCalls.calls.filter(call => call.name === "apply_signature").length === 0, "Name route reached apply_signature after the signature mutation attempt.");
    assert(nameCalls.appliedTypes.includes("name"), "Name zone persisted as a different type after the signature mutation attempt.");
    assert(nameCalls.appliedStatuses.includes("✓ Printed Route Name"), "Name zone lost its apply_text result after the signature mutation attempt.");
    assert(!nameCalls.modalOpen, "Name modal remained open after success.");

    console.log(`\n[dev-ui-operation-mode-race-smoke] OK: in-flight modal routing stayed immutable at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-operation-mode-race-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
