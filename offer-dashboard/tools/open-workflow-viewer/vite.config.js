import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    lib: { entry: "entry.js", name: "OpenWorkflowViewerBundle", formats: ["iife"], fileName: () => "diagram-editor.iife.js" },
    cssCodeSplit: false,
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 20000,
    rollupOptions: { output: { assetFileNames: "diagram-editor.[ext]" } },
  },
});
