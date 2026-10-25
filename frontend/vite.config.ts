import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    env: {
      VITE_SUPABASE_URL: "https://api.example.test",
      VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
      VITE_APP_ORIGIN: "https://app.example.test",
    },
  },
});
