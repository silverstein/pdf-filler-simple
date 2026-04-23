import path from "node:path";
import { withDevUiServer } from "./dev-ui-smoke-helpers.mjs";

const port = Number(process.env.PDF_TOOLS_DEV_UI_PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const examplePdfPath = path.join(repoRoot, "example-fw9.pdf");

async function main() {
  await withDevUiServer(port, async () => {
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
  });
}

main().catch((error) => {
  console.error(`\n[dev-ui-smoke] FAILED: ${error.message}`);
  process.exit(1);
});
