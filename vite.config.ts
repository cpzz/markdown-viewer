import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    sourcemap: true,
    /** Mermaid (and its diagram stack) often stays >500 kB minified even as its own async chunk. */
    chunkSizeWarningLimit: 1200,
  },
});