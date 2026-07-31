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
            rollupOptions: {
              output: { entryFileNames: "[name].mjs" },
              // node-pty resolves its own native binary at runtime by walking
              // relative paths from its own file on disk. Bundled inline by
              // Rollup, that walk starts from dist-electron instead of
              // node_modules/node-pty and the binary is never found — the
              // exact error this fixes. External keeps it a plain runtime
              // require, resolved by Node's own module resolution, the way
              // node-pty already expects to be loaded.
              external: ["node-pty"],
            },
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
  // The contracts and session-client packages are linked TypeScript source,
  // not built artifacts.
  optimizeDeps: {
    exclude: ["@novus/contracts", "@novus/session-client"],
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
