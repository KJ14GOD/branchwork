import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The contracts package is linked TypeScript source, not a built artifact.
  optimizeDeps: {
    exclude: ["@novus/contracts"],
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
