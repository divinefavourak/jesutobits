import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The project's own config. Jesutobits must never modify it (Spike S2 checks its hash).
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
