import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { configDefaults } from "vitest/config";
import { NODE_TEST_FILES } from "./scripts/node-test-files.mjs";
import { SOURCE_IDENTITY_TEST_FILES } from "./scripts/test-suite-classification.mjs";
import { createMcpBridgePlugin } from "./ui/dev/bridge-plugin.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ command, mode }) => ({
  plugins: command === "serve" && mode !== "test" && process.env.VITEST !== "true"
    ? [createMcpBridgePlugin()]
    : [viteSingleFile()],
  resolve: {
    alias: command === "serve" && mode !== "test" && process.env.VITEST !== "true"
      ? {
          "@modelcontextprotocol/ext-apps": path.resolve(__dirname, "ui/dev/mock-ext-apps.ts"),
        }
      : {},
  },
  root: "ui",
  test: {
    root: ".",
    exclude: [
      ...configDefaults.exclude,
      ...NODE_TEST_FILES,
    ],
    projects: [
      {
        extends: true,
        test: {
          name: "ordinary",
          root: ".",
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
            ...SOURCE_IDENTITY_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "source-identity",
          root: ".",
          include: SOURCE_IDENTITY_TEST_FILES,
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
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
