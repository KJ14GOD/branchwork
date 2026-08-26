import { describe, expect, it } from "vitest";
import { _electron as electron } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The packaged application launches (D-222): the electron-builder output —
 * the exact bytes the dmg installs — opens a real window and lands on the
 * sign-in surface with no development environment behind it. Test hooks
 * refuse packaged builds by design (D-027), so this proves only the launch;
 * the signed-in product is every other spec's ground.
 *
 * Skipped when no packaged build exists — packaging is `pnpm package`'s
 * output, not a checkout's. This is evidence for the packaged path, and its
 * absence in a run means unpackaged, not passing.
 */

const desktopRoot = resolve(__dirname, "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const packagedBinary = join(desktopRoot, "release", "mac-arm64", "Novus.app", "Contents", "MacOS", "Novus");

describe.skipIf(!existsSync(packagedBinary))("the packaged app", () => {
  it("launches from the built bundle and lands on a real surface", async () => {
    mkdirSync(evidenceDir, { recursive: true });
    const app = await electron.launch({ executablePath: packagedBinary });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      // A packaged launch uses the machine's own userData: a fresh machine
      // lands signed out, a machine holding a real session lands in the
      // shell. Either is the product working; anything else is a launch
      // failure.
      const landed = page.locator('[data-testid="sign-in-button"], [data-testid="project-shell"]');
      await landed.first().waitFor({ timeout: 30_000 });
      // Packaged means packaged: the test-only hooks must be dead here.
      expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
      // Evidence only for the signed-out landing: a signed-in shell here is
      // somebody's real missions, and the evidence directory is the repo's.
      if ((await page.getByTestId("sign-in-button").count()) > 0) {
        await page.screenshot({ path: join(evidenceDir, "230-packaged-app-signed-out.png") });
      }
    } finally {
      await app.close();
    }
  }, 90_000);
});
