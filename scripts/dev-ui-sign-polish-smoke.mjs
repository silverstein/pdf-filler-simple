import path from "node:path";
import { createAgentBrowserSessionRunner, evalJson, withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4182);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const session = `pdf-tools-sign-polish-${Date.now()}`;
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
      window.__signPolishOriginalFetch = window.fetch;
      window.fetch = async (...args) => {
        const options = args[1] || {};
        let payload = null;
        try { payload = JSON.parse(options.body || "null"); } catch {}
        if (payload?.name === "detect_signature_zones") {
          return new Response(JSON.stringify({
            isError: true,
            content: [{ type: "text", text: "simulated detector outage" }]
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return window.__signPolishOriginalFetch(...args);
      };
      return JSON.stringify({ installed: true });
    })()`);

    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "500"]);
    await runAgentBrowser(["click", "#sign-panel-inspect-btn"]);
    await runAgentBrowser(["click", "#sign-panel-inspect-btn"]);
    const failedState = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      status: document.querySelector("#sign-panel-status")?.textContent,
      isError: document.querySelector("#sign-panel-status")?.classList.contains("error")
    }))()`);
    assert(failedState.status === "Detection failed: simulated detector outage", "Detection error did not survive a later panel render.");
    assert(failedState.isError, "Detection error did not retain its error presentation.");

    await evalJson(runAgentBrowser, `(() => {
      window.fetch = async (...args) => {
        const options = args[1] || {};
        let payload = null;
        try { payload = JSON.parse(options.body || "null"); } catch {}
        if (payload?.name === "detect_signature_zones") {
          window.__signPolishDetectCalls = (window.__signPolishDetectCalls || 0) + 1;
        }
        return window.__signPolishOriginalFetch(...args);
      };
      window.__signPolishDetectCalls = 0;
      return JSON.stringify({ restored: true });
    })()`);
    await runAgentBrowser(["click", "#mode-view-btn"]);
    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "800"]);
    await runAgentBrowser(["click", "#mode-view-btn"]);
    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "300"]);

    const cacheState = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      calls: window.__signPolishDetectCalls,
      zones: document.querySelectorAll(".sign-panel-item").length,
      status: document.querySelector("#sign-panel-status")?.textContent
    }))()`);
    assert(cacheState.calls === 1, `Expected one detector call across two sign-mode entries, got ${cacheState.calls}.`);
    assert(cacheState.zones > 0, "Successful detector retry did not render signature zones.");
    assert(!cacheState.status.includes("simulated detector outage"), "Successful retry did not clear the prior detection error.");

    await runAgentBrowser(["focus", ".sign-panel-item"]);
    await evalJson(runAgentBrowser, `(() => {
      window.__signPolishOpenedZoneKey = document.activeElement?.dataset?.zoneKey || null;
      return JSON.stringify({ zoneKey: window.__signPolishOpenedZoneKey });
    })()`);
    await runAgentBrowser(["press", "Enter"]);
    await runAgentBrowser(["wait", "300"]);
    let modalState = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      open: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      viewerInert: document.querySelector("#viewer")?.hasAttribute("inert")
    }))()`);
    assert(modalState.open, "Enter did not activate a keyboard-focused sign-panel row.");
    assert(modalState.viewerInert, "Viewer was not inert while the confirm modal was open.");

    await runAgentBrowser(["focus", "#sign-modal-cancel"]);
    await runAgentBrowser(["press", "Tab"]);
    const confirmFocus = await evalJson(runAgentBrowser, `(() => JSON.stringify({ activeId: document.activeElement?.id }))()`);
    assert(confirmFocus.activeId === "sign-modal-close", `Confirm modal focus did not wrap, active element was ${confirmFocus.activeId}.`);

    await evalJson(runAgentBrowser, `(() => {
      const sourceRow = Array.from(document.querySelectorAll(".sign-panel-item"))
        .find(item => item.dataset.zoneKey === window.__signPolishOpenedZoneKey);
      sourceRow?.remove();
      return JSON.stringify({ removed: !sourceRow?.isConnected });
    })()`);
    await runAgentBrowser(["press", "Escape"]);
    const fallbackFocus = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      viewerInert: document.querySelector("#viewer")?.hasAttribute("inert"),
      activeId: document.activeElement?.id
    }))()`);
    assert(!fallbackFocus.modalOpen, "Escape did not close the confirm modal after its source row disappeared.");
    assert(!fallbackFocus.viewerInert, "Viewer remained inert after the confirm modal closed.");
    assert(fallbackFocus.activeId === "sign-panel-draw-btn", `Missing replacement row did not use the safe sign-mode fallback, active element was ${fallbackFocus.activeId}.`);

    await runAgentBrowser(["click", "#mode-view-btn"]);
    await runAgentBrowser(["click", "#mode-sign-btn"]);
    await runAgentBrowser(["wait", "300"]);
    await runAgentBrowser(["focus", ".sign-panel-item"]);
    const successfulZone = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      zoneKey: document.activeElement?.dataset?.zoneKey || null
    }))()`);
    await runAgentBrowser(["press", "Enter"]);
    await runAgentBrowser(["wait", "300"]);
    await runAgentBrowser(["fill", "#sign-modal-name", "Keyboard Test User"]);
    await evalJson(runAgentBrowser, `(() => {
      const passthroughFetch = window.fetch;
      window.fetch = async (...args) => {
        const options = args[1] || {};
        let payload = null;
        try { payload = JSON.parse(options.body || "null"); } catch {}
        if (payload?.name === "create_signature") {
          return new Response(JSON.stringify({
            isError: false,
            content: [{ type: "text", text: "mock signature created" }],
            structuredContent: { name: "__pdf-tools-quick-typed__" }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (payload?.name === "apply_signature") {
          return new Response(JSON.stringify({
            isError: false,
            content: [{ type: "text", text: "mock signature applied" }],
            structuredContent: { pdf_path: ${JSON.stringify(examplePdfPath)}, backup_path: null }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return passthroughFetch(...args);
      };
      return JSON.stringify({ mockedApply: true });
    })()`);
    await runAgentBrowser(["click", "#sign-modal-confirm"]);
    await runAgentBrowser(["wait", "1200"]);
    const restoredZoneFocus = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      modalOpen: getComputedStyle(document.querySelector("#sign-modal")).display !== "none",
      viewerInert: document.querySelector("#viewer")?.hasAttribute("inert"),
      activeClass: document.activeElement?.className || "",
      activeZoneKey: document.activeElement?.dataset?.zoneKey || null,
      applied: document.activeElement?.textContent?.includes("Signed") || false
    }))()`);
    assert(!restoredZoneFocus.modalOpen, "Successful mocked apply did not close the confirm modal.");
    assert(!restoredZoneFocus.viewerInert, "Viewer remained inert after successful mocked apply.");
    assert(restoredZoneFocus.activeClass.includes("sign-panel-item"), `Focus did not move to the replacement zone row, active class was ${restoredZoneFocus.activeClass}.`);
    assert(restoredZoneFocus.activeZoneKey === successfulZone.zoneKey, "Replacement focus used a different zone descriptor.");
    assert(restoredZoneFocus.applied, "Replacement focused row did not retain the applied state.");

    await evalJson(runAgentBrowser, `(() => {
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
      return JSON.stringify({ dpr: window.devicePixelRatio });
    })()`);
    await runAgentBrowser(["click", "#sign-panel-draw-btn"]);
    await runAgentBrowser(["wait", "300"]);
    const drawState = await evalJson(runAgentBrowser, `(() => {
      const canvas = document.querySelector("#draw-canvas");
      const rect = canvas.getBoundingClientRect();
      return JSON.stringify({
        width: canvas.width,
        height: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        viewerInert: document.querySelector("#viewer")?.hasAttribute("inert"),
        activeId: document.activeElement?.id,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      });
    })()`);
    assert(drawState.width === Math.round(drawState.cssWidth * 2), "Drawing canvas width is not DPR-aware.");
    assert(drawState.height === Math.round(drawState.cssHeight * 2), "Drawing canvas height is not DPR-aware.");
    assert(drawState.viewerInert, "Viewer was not inert while the draw modal was open.");
    assert(drawState.activeId === "draw-canvas", "Drawing canvas did not receive initial focus.");

    await runAgentBrowser(["focus", "#draw-modal-cancel"]);
    await runAgentBrowser(["press", "Tab"]);
    const drawFocus = await evalJson(runAgentBrowser, `(() => JSON.stringify({ activeId: document.activeElement?.id }))()`);
    assert(drawFocus.activeId === "draw-modal-close", `Draw modal focus did not wrap, active element was ${drawFocus.activeId}.`);

    const startX = Math.round(drawState.rect.left + drawState.cssWidth * 0.2);
    const startY = Math.round(drawState.rect.top + drawState.cssHeight * 0.5);
    const middleX = Math.round(drawState.rect.left + drawState.cssWidth * 0.45);
    const endX = Math.round(drawState.rect.left + drawState.cssWidth * 0.8);
    await evalJson(runAgentBrowser, `(() => {
      const canvas = document.querySelector("#draw-canvas");
      canvas.addEventListener("pointerdown", event => { window.__signPolishPointerId = event.pointerId; }, { once: true });
      return JSON.stringify({ ready: true });
    })()`);
    await runAgentBrowser(["mouse", "move", String(startX), String(startY)]);
    await runAgentBrowser(["mouse", "down"]);
    await runAgentBrowser(["mouse", "move", String(middleX), String(startY)]);
    await evalJson(runAgentBrowser, `(() => {
      const canvas = document.querySelector("#draw-canvas");
      window.__signPolishBeforeLeave = canvas.toDataURL("image/png");
      canvas.dispatchEvent(new PointerEvent("pointerleave", {
        pointerId: window.__signPolishPointerId,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1
      }));
      return JSON.stringify({ beforeLength: window.__signPolishBeforeLeave.length });
    })()`);
    await runAgentBrowser(["mouse", "move", String(endX), String(startY)]);
    await runAgentBrowser(["mouse", "up"]);
    const afterLeave = await evalJson(runAgentBrowser, `(() => {
      const canvas = document.querySelector("#draw-canvas");
      return JSON.stringify({
        continued: window.__signPolishBeforeLeave !== canvas.toDataURL("image/png"),
        viewerInert: document.querySelector("#viewer")?.hasAttribute("inert")
      });
    })()`);
    assert(afterLeave.continued, "Stroke stopped growing after pointerleave despite pointer capture.");

    await runAgentBrowser(["press", "Escape"]);
    modalState = await evalJson(runAgentBrowser, `(() => JSON.stringify({
      open: getComputedStyle(document.querySelector("#draw-modal")).display !== "none",
      viewerInert: document.querySelector("#viewer")?.hasAttribute("inert"),
      activeId: document.activeElement?.id
    }))()`);
    assert(!modalState.open, "Escape did not close the draw modal.");
    assert(!modalState.viewerInert, "Viewer remained inert after the final modal closed.");
    assert(modalState.activeId === "sign-panel-draw-btn", "Focus did not return to the draw-signature trigger.");

    console.log(`\n[dev-ui-sign-polish-smoke] OK: sign-mode polish verified at ${origin}`);
  });
}

main()
  .catch((error) => {
    console.error(`\n[dev-ui-sign-polish-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserSession();
  });
