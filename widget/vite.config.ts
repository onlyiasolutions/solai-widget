import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      name: "SolAIWidget",
      formats: ["iife"],
      fileName: () => "solai-widget.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
  server: {
    port: 5173,
    cors: true,
    proxy: { "/api": "http://localhost:3000" },
  },
});
