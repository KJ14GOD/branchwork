import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";

/**
 * Lets `node --test` load `.tsx`, so components can be tested at all.
 *
 * Node 24 runs TypeScript by stripping types, which is not a transform: it
 * erases annotations and leaves the rest of the syntax alone. JSX is syntax,
 * not an annotation, so a `.tsx` file reaches the parser as `Unexpected token
 * '<'`. That is why every UI test in this repo up to now asserted on schemas
 * instead of on what the screen draws — and why an empty tool panel and a file
 * deletion whose diff rendered nowhere both shipped. Neither was reachable by
 * any test that existed.
 *
 * `registerHooks` is the synchronous, in-thread hook API. The async
 * `register()` loader runs on a separate thread and cannot see this process's
 * module state, which matters because the tests below render React and assert
 * on the result in the same tick.
 *
 * Type errors are still `tsc`'s job. esbuild is here to make the file parse,
 * not to check it, and the gate runs `pnpm typecheck` separately.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) {
      return nextLoad(url, context);
    }

    const source = readFileSync(fileURLToPath(url), "utf8");
    const { code } = transformSync(source, {
      loader: "tsx",
      format: "esm",
      target: "node24",
      // The automatic runtime means a component file needs no React import to
      // render, matching how Vite builds the app. Testing against a different
      // JSX runtime than the app ships would be testing something else.
      jsx: "automatic",
      sourcefile: url,
    });

    return { format: "module", shortCircuit: true, source: code };
  },
});
