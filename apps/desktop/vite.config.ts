import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Workbench build (ADR-0013). Port 1420 is fixed so the Tauri dev config can point at it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // The Tauri CLI watches the Host. Watching src-tauri/target (thousands of folders after a
    // cargo build) blocked the dev server for 20 to 45 s on every cold start.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2023",
  },
});
