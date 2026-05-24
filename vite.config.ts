import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.SECOND_CHAIR_API_URL
  || process.env.INTERVIEW_COPILOT_API_URL
  || "http://127.0.0.1:5180";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": apiProxyTarget,
      "/ws": {
        target: apiProxyTarget,
        ws: true,
      },
    }
  }
});
