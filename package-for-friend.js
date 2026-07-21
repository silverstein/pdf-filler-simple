#!/usr/bin/env node

import { execSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";

const SOURCE_DIR = "pdf-toolkit-mcp-share";
const OUTPUT_FILE = "pdf-toolkit-mcp.zip";

async function syncSharePackage() {
  const rootPackage = JSON.parse(await fs.readFile("package.json", "utf8"));
  const sharePackagePath = path.join(SOURCE_DIR, "package.json");
  const shareServerDir = path.join(SOURCE_DIR, "server");
  const shareUiDir = path.join(SOURCE_DIR, "dist-ui");

  await fs.mkdir(shareServerDir, { recursive: true });
  await fs.mkdir(shareUiDir, { recursive: true });

  try {
    await fs.access(path.join("dist-ui", "index.html"));
  } catch {
    throw new Error("dist-ui/index.html is missing. Run `npm run build:ui` before packaging the share bundle.");
  }

  await Promise.all([
    fs.copyFile(path.join("server", "index.js"), path.join(shareServerDir, "index.js")),
    fs.copyFile(path.join("server", "helpers.js"), path.join(shareServerDir, "helpers.js")),
    fs.copyFile(path.join("server", "resource-uri.js"), path.join(shareServerDir, "resource-uri.js")),
    fs.copyFile(path.join("server", "stderr-suppression.js"), path.join(shareServerDir, "stderr-suppression.js")),
    fs.copyFile(path.join("dist-ui", "index.html"), path.join(shareUiDir, "index.html")),
  ]);

  const sharePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    description: "PDF Tools MCP server for Cursor and other stdio MCP hosts",
    type: "module",
    main: "server/index.js",
    license: rootPackage.license,
    dependencies: {
      "@modelcontextprotocol/sdk": rootPackage.dependencies["@modelcontextprotocol/sdk"],
      "@napi-rs/canvas": rootPackage.dependencies["@napi-rs/canvas"],
      "pdf-lib": rootPackage.dependencies["pdf-lib"],
      "pdfjs-dist": rootPackage.dependencies["pdfjs-dist"],
    },
  };

  await fs.writeFile(sharePackagePath, `${JSON.stringify(sharePackage, null, 2)}\n`);
}

async function createPackage() {
  console.log("📦 Creating shareable package for Cursor...\n");

  try {
    await fs.access(SOURCE_DIR);
  } catch {
    console.error(`❌ Error: Directory '${SOURCE_DIR}' not found!`);
    console.error("Make sure you run this from the project root directory.");
    process.exit(1);
  }

  try {
    await fs.unlink(OUTPUT_FILE);
    console.log("🗑️  Removed existing zip file");
  } catch {
    // File doesn't exist, that's fine.
  }

  try {
    console.log("🔄 Syncing share package runtime files...");
    await syncSharePackage();

    console.log(`📁 Zipping ${SOURCE_DIR} directory...`);
    execSync(`zip -r ${OUTPUT_FILE} ${SOURCE_DIR}`, { stdio: "inherit" });

    const stats = await fs.stat(OUTPUT_FILE);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log("\n✅ Package created successfully!");
    console.log(`📦 File: ${OUTPUT_FILE} (${fileSizeInMB} MB)`);
    console.log("\n📤 Share this zip file with your friends!");
    console.log("📝 They just need to:");
    console.log("   1. Unzip the file");
    console.log("   2. Run the install script");
    console.log("   3. Restart Cursor");
  } catch (error) {
    console.error("❌ Error creating zip file:", error.message);
    console.error("\nMake sure `zip` is installed and the UI has been built.");
    process.exit(1);
  }
}

createPackage().catch(error => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
