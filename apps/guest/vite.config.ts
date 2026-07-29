import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The contracts package is linked TypeScript source, not a built artifact.
  optimizeDeps: {
    exclude: ["@novus/contracts"],
  },
  server: {
    // 5273 is the host renderer; the guest sits beside it on the next port.
    // Loopback only, like everything else: until the session service exists,
    // a "guest" is a second browser on the host machine.
    port: 5274,
    strictPort: true,
  },
});
