import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Builds the React UI into a single self-contained index.html.
 * vite-plugin-singlefile inlines all JS and CSS — required by Figma,
 * which loads the plugin UI from a single HTML string.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false, // plugin/main.js is written separately by esbuild
    target: "es6",
    rollupOptions: {
      input: "index.html",
      output: {
        format: "iife", // no <script type="module"> — required for Figma plugin iframe
        inlineDynamicImports: true,
      },
    },
  },
});
