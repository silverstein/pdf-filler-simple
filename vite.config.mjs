import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createMcpBridgePlugin } from "./ui/dev/bridge-plugin.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ command }) => ({
  plugins: command === "serve"
    ? [createMcpBridgePlugin()]
    : [viteSingleFile()],
  resolve: {
    alias: command === "serve"
      ? {
          "@modelcontextprotocol/ext-apps": path.resolve(__dirname, "ui/dev/mock-ext-apps.ts"),
        }
      : {},
  },
  root: "ui",
  test: {
    root: ".",
  },
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
    target: "esnext",
    codeSplitting: false,
  },
  worker: {
    format: "es",
    plugins: () => [viteSingleFile()],
  },
}));
