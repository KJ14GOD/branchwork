import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron";

export default defineConfig({
  plugins: [
    react(),
    electron([
      // Electron only loads ESM main and preload from .mjs files, and the
      // workspace is type: module, so both entries emit .mjs.
      {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: { output: { entryFileNames: "[name].mjs" } },
          },
        },
      },
      {
        entry: "electron/preload.ts",
        onstart({ reload }) {
          // A preload change only needs the window reloaded, not a restart.
          reload();
        },
        vite: {
          build: {
            rollupOptions: { output: { entryFileNames: "[name].mjs" } },
          },
        },
      },
    ]),
  ],
  // The contracts package is linked TypeScript source, not a built artifact.
  optimizeDeps: {
    exclude: ["@novus/contracts"],
  },
  build: {
    // Loaded over file:// in the packaged app.
    assetsDir: "assets",
  },
  base: "./",
  server: {
    // Pinned to IPv4 loopback for the same reason as the guest app: Vite's
    // default "localhost" host can resolve to [::1] only, which refuses a
    // browser or Electron's loadURL hitting 127.0.0.1 with no visible error.
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
  },
});
