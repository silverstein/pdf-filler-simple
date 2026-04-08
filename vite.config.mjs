import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
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
});
