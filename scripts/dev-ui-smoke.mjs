import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");
const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForServer(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(`Dev server did not become ready at ${url}: ${lastError?.message || "unknown error"}`);
}

async function main() {
  const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(`${origin}/`);

    const viewerResponse = await fetch(`${origin}/?pdf_path=${encodeURIComponent(examplePdfPath)}`);
    const viewerHtml = await viewerResponse.text();
    if (!viewerResponse.ok) {
      throw new Error(`Viewer HTML request failed with HTTP ${viewerResponse.status}`);
    }
    if (!viewerHtml.includes("PDF Tools Viewer")) {
      throw new Error("Viewer HTML did not include the expected title.");
    }
    if (!viewerHtml.includes("/@vite/client")) {
      throw new Error("Viewer HTML did not look like a Vite dev page.");
    }

    const toolResponse = await fetch(`${origin}/__dev__/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "display_pdf",
        arguments: { pdf_path: examplePdfPath },
      }),
    });
    const toolResult = await toolResponse.json();
    if (!toolResponse.ok) {
      throw new Error(`Dev tool bridge returned HTTP ${toolResponse.status}: ${JSON.stringify(toolResult)}`);
    }
    if (toolResult.isError) {
      throw new Error(`Dev tool bridge returned an MCP error: ${JSON.stringify(toolResult)}`);
    }
    if (!toolResult.structuredContent?.pdfPath && !toolResult._meta?.pdfPath) {
      throw new Error("display_pdf result did not include viewer load metadata.");
    }

    console.log(`\n[dev-ui-smoke] OK: viewer and MCP bridge responded at ${origin}`);
  } finally {
    child.kill("SIGINT");
    const exited = await Promise.race([
      waitForExit(child),
      delay(5_000).then(() => null),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(`\n[dev-ui-smoke] FAILED: ${error.message}`);
  process.exit(1);
});
