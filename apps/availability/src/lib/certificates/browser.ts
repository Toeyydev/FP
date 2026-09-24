import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

// Finding the browser that renders a certificate, and refusing to guess about it.
//
// The first attempt at this asked apt for `chromium-browser` and told the health endpoint
// the renderer was ready because an environment variable was not empty. Neither half was
// true. Ubuntu's `chromium-browser` is a snap shim — the deb installs a stub and the real
// browser comes from snapd, which a container does not have, so the build logged
// "System doesn't have a working snapd, skipping" and carried on. And the variable it
// pointed at named a path nothing had created. The endpoint said `ready` about a browser
// that was not there.
//
// So the browser is downloaded, by build id, into a directory inside the project, and
// found by computing where that download put it. The version is not chosen here: it is
// the one THIS puppeteer-core expects, read from the package itself, so the two cannot
// drift apart in a later upgrade.

/** The build puppeteer-core is written against. Never "latest", never "stable". */
export const CHROME_BUILD_ID = PUPPETEER_REVISIONS["chrome-headless-shell"];

/** Where the build step puts it — inside the app, so it is copied into the runtime image. */
export const BROWSER_CACHE_DIR = ".browser-cache";

export function browserCacheDir(): string {
  const configured = (process.env.PUPPETEER_CACHE_DIR ?? "").trim();
  return configured || join(process.cwd(), BROWSER_CACHE_DIR);
}

/**
 * Where `@puppeteer/browsers` places a chrome-headless-shell download.
 *
 * Computed rather than searched: a search would find a browser somebody happened to have
 * installed, which is exactly the thing that made the last diagnosis wrong. If this path
 * does not exist, the answer is "not installed" — not "try somewhere else".
 */
export function expectedExecutablePath(cacheDir = browserCacheDir(), platform = process.platform, arch = process.arch): string {
  const dir = (p: string) => join(cacheDir, "chrome-headless-shell", `${p}-${CHROME_BUILD_ID}`);
  if (platform === "darwin") {
    const p = arch === "arm64" ? "mac_arm" : "mac";
    return join(dir(p), "chrome-headless-shell-" + (arch === "arm64" ? "mac-arm64" : "mac-x64"), "chrome-headless-shell");
  }
  if (platform === "win32") {
    return join(dir("win64"), "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  }
  return join(dir("linux"), "chrome-headless-shell-linux64", "chrome-headless-shell");
}

/**
 * An explicit override, for a machine where somebody wants to point this at their own
 * build. It is validated exactly like the managed one — naming a path has never been
 * enough to make it real. Production config sets none of these, and a repository test
 * refuses one that tries.
 */
const override = () => (process.env.CHROME_HEADLESS_SHELL_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROMIUM_PATH ?? "").trim();

export type ExecutableLookup =
  | { ok: true; path: string; source: "managed" | "override" }
  | { ok: false; code: "not-installed" | "not-a-file" | "not-executable"; source: "managed" | "override" };

/** Is there a file there, is it a file, and may this process run it? */
function inspect(path: string, source: "managed" | "override"): ExecutableLookup {
  let stat;
  try { stat = statSync(path); } catch { return { ok: false, code: "not-installed", source }; }
  if (!stat.isFile()) return { ok: false, code: "not-a-file", source };
  try { accessSync(path, constants.X_OK); } catch { return { ok: false, code: "not-executable", source }; }
  return { ok: true, path, source };
}

export function findExecutable(): ExecutableLookup {
  const explicit = override();
  if (explicit) return inspect(explicit, "override");
  return inspect(expectedExecutablePath(), "managed");
}
