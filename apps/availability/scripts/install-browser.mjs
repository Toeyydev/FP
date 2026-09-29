#!/usr/bin/env node
// Download the browser that renders a certificate, at the build this puppeteer-core
// expects, into a directory inside the app.
//
// Run as its own build step rather than a postinstall hook. A package manager may skip
// lifecycle scripts — `npm ci --ignore-scripts`, a cached install, a different runner —
// and a renderer that quietly did not install is exactly the failure this replaces: a
// deployment that reported a browser it did not have.
//
// It fetches chrome-headless-shell only. Full Chrome is a few hundred megabytes more for
// a headless render that never needs a window.

import { access, constants, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { install, resolveBuildId, Browser } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = (process.env.PUPPETEER_CACHE_DIR || "").trim() || join(appDir, ".browser-cache");
const buildId = PUPPETEER_REVISIONS["chrome-headless-shell"];

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const main = async () => {
  if (!buildId || /latest|stable/i.test(buildId)) {
    console.error(`[browser] refusing to install a floating version (${buildId})`);
    process.exit(1);
  }
  console.log(`[browser] chrome-headless-shell ${buildId} (pinned by puppeteer-core)`);

  // Asked of the catalogue rather than assumed: a build id that is not downloadable
  // should fail here, in the build, and not at the first certificate somebody files.
  const resolved = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, `${process.platform}${process.arch === "arm64" ? "_arm" : ""}`.replace("darwin", "mac").replace("linux_arm", "linux").replace("win32", "win64"), buildId)
    .catch(() => buildId);
  if (resolved !== buildId) console.log(`[browser] catalogue resolved ${buildId} → ${resolved}`);

  const started = Date.now();
  const installed = await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const info = await stat(installed.executablePath);
  await access(installed.executablePath, constants.X_OK);
  console.log(`[browser] installed in ${seconds}s · executable ${mb(info.size)}`);
  // The path is printed at build time on purpose — a build log is not a health endpoint,
  // and a person debugging an image needs to see where it landed.
  console.log(`[browser] ${installed.executablePath}`);
};

main().catch((err) => {
  console.error(`[browser] install failed: ${String(err).slice(0, 300)}`);
  process.exit(1);
});
