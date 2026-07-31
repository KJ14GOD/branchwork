import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The contracts and session-client packages are linked TypeScript source,
  // not built artifacts.
  optimizeDeps: {
    exclude: ["@novus/contracts", "@novus/session-client"],
  },
  server: {
    // 5273 is the host renderer; the guest sits beside it on the next port.
    // Loopback only, like everything else: until the session service exists,
    // a "guest" is a second browser on the host machine.
    //
    // host is pinned to the IPv4 loopback address rather than left as Vite's
    // default "localhost". Every link this app prints uses 127.0.0.1, and
    // Vite's own DNS resolution of "localhost" can bind [::1] only — a
    // browser hitting 127.0.0.1 then gets connection refused with no error
    // on either side to explain why.
    host: "127.0.0.1",
    port: 5274,
    strictPort: true,
  },
});
