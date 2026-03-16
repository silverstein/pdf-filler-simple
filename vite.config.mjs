import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  root: "ui",
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [viteSingleFile()],
  },
});
