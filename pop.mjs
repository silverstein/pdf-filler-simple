import path from "node:path"; import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const REPO = process.cwd();
const files = process.argv.slice(2);
const t = new StdioClientTransport({ command: process.execPath, args:[path.join(REPO,"server/index.js")],
  cwd: REPO, env:{ ALLOWED_DIRECTORIES:[REPO,"/Users/silverbook/Sites/pdf-tools-extraction-sidecars"].join(path.delimiter) }, stderr:"ignore" });
const c = new Client({name:"pop",version:"1.0.0"}); await c.connect(t);
let docsHit = 0, pagesHit = 0, docsTried = 0;
for (const f of files) {
  try {
    const r = await c.callTool({ name:"convert_pdf_to_markdown",
      arguments:{ pdf_path: f, start_page: 1, end_page: 3 } }, undefined, {timeout:120000});
    const sc = r.structuredContent ?? {}; docsTried += 1;
    const u = sc.pages_with_unread_visual_content ?? [];
    if (u.length) { docsHit += 1; pagesHit += u.length;
      console.log(`HIT ${path.basename(f)}: ${JSON.stringify(u).slice(0,120)}`); }
  } catch {}
}
console.log(`\ntried=${docsTried} docs_with_unread_visual=${docsHit} pages=${pagesHit}`);
await c.close();
