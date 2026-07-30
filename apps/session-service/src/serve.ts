import { randomBytes } from "node:crypto";

import { fixedTokens, startRelay } from "./relay.ts";

/**
 * The relay, as something you can start.
 *
 * It existed, it was tested, and there was no way to run it — which made
 * "a teammate elsewhere can watch" true of the code and false of the product.
 * This is the entry point that closes that.
 *
 * Tokens are minted when the environment does not pin them, and printed here on
 * the operator's own terminal. That is the one place they are already trusted:
 * whoever started the relay is the person who decides who gets an invite.
 *
 * One session per process, deliberately. A relay token authorises exactly one
 * session, so serving several would mean a token registry, a way to add and
 * revoke entries while running, and somewhere to keep them — none of which V1
 * asks for. A second session is a second process until it does.
 */

const port = Number(process.env.NOVUS_RELAY_PORT ?? 4400);
const host = process.env.NOVUS_RELAY_HOST ?? "127.0.0.1";

const mint = (): string => randomBytes(32).toString("base64url");

const sessionKey = process.env.NOVUS_RELAY_SESSION?.trim() || "novus-session";

// NOVUS_RELAY_TOKEN is accepted as the publish token so one variable in .env
// serves both sides of the same connection: the worker sends it, the relay
// expects it. Three names that all had to agree — and silently failed a
// handshake when they did not — was a worse thing to ask of anybody than a
// slightly overloaded one.
const publishToken =
  process.env.NOVUS_RELAY_PUBLISH_TOKEN?.trim() ||
  process.env.NOVUS_RELAY_TOKEN?.trim() ||
  mint();
const watchToken = process.env.NOVUS_RELAY_WATCH_TOKEN?.trim() || mint();

const pinned = Boolean(
  process.env.NOVUS_RELAY_PUBLISH_TOKEN?.trim() ||
    process.env.NOVUS_RELAY_TOKEN?.trim(),
);

let relay;

try {
  relay = await startRelay({
    port,
    host,
    authorize: fixedTokens(sessionKey, publishToken, watchToken),
  });
} catch (error) {
  // A port already taken is the common one, and Node's own message for it says
  // nothing about what to do.
  console.error(
    `Could not start the relay on ${host}:${port} — ${(error as Error).message}`,
  );
  console.error("Set NOVUS_RELAY_PORT to use a different port.");
  process.exit(1);
}

const guestPort = Number(process.env.NOVUS_GUEST_PORT ?? 5274);
const guestScheme = host === "127.0.0.1" || host === "localhost" ? "ws" : "wss";
const relayUrl = `${guestScheme}://${host}:${port}`;

console.log(`novus relay · ${relay.url}`);
console.log(`session ${sessionKey}`);
console.log("");
console.log("Point the worker at it:");
console.log("");

if (pinned) {
  // The token is already in the environment the worker will read, so repeating
  // it on the command line would only be a way to get it wrong.
  console.log(`  NOVUS_RELAY_URL=${relayUrl} pnpm --filter @novus/desktop dev`);
  console.log("");
  console.log("  (NOVUS_RELAY_TOKEN comes from .env — both sides already agree)");
} else {
  console.log(`  NOVUS_RELAY_URL=${relayUrl} \\`);
  console.log(`  NOVUS_RELAY_TOKEN=${publishToken} \\`);
  console.log("  pnpm --filter @novus/desktop dev");
  console.log("");
  console.log("  Put NOVUS_RELAY_TOKEN in .env to stop it changing every start.");
}
console.log("");
console.log("Send a teammate this, once the guest is running:");
console.log("");
console.log(
  `  http://127.0.0.1:${guestPort}/?relay=${encodeURIComponent(relayUrl)}&token=${watchToken}`,
);
console.log("");

if (guestScheme === "ws") {
  console.log(
    "Loopback only. A guest off this machine needs the relay behind wss:// —",
  );
  console.log(
    "the client refuses a plaintext connection to anywhere but this machine.",
  );
  console.log("");
}

console.log("ready — press ctrl+c to stop");

const shutdown = () => {
  void relay.close().then(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
