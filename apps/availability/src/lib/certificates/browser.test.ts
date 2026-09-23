import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { CHROME_BUILD_ID, expectedExecutablePath, findExecutable } from "@/lib/certificates/browser";
import { cachedProbe, probeRenderer, resetProbe, rendererStatusForHealth } from "@/lib/certificates/probe";

// Finding the browser, and refusing to claim more than has been shown.
//
// The failure this replaces: apt installed Ubuntu's `chromium-browser`, which is a snap
// shim — the deb lays down a stub and expects snapd to fetch the real thing, which a
// container has not got. The build said "System doesn't have a working snapd, skipping"
// and carried on. An environment variable pointed at a path nothing had created, and the
// health endpoint reported `ready` because that variable was not empty.
//
// So: a version pinned by the package rather than by hand, a path computed rather than
// searched for, and a status that comes from having rendered something.
//
// All data invented — this repo is public.

afterEach(() => { vi.unstubAllEnvs(); resetProbe(); });

const fakeExecutable = (name = "chrome-headless-shell") => {
  const dir = mkdtempSync(join(tmpdir(), "fp-browser-"));
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, 0o755);
  return { dir, path };
};

describe("the version is the one this puppeteer expects", () => {
  it("is pinned to a real build, never latest or stable", () => {
    expect(CHROME_BUILD_ID).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(CHROME_BUILD_ID).not.toMatch(/latest|stable/i);
  });

  it("comes from puppeteer-core itself, so an upgrade cannot leave them disagreeing", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/browser.ts"), "utf8");
    expect(src).toContain("PUPPETEER_REVISIONS");
    // Not a number somebody typed.
    expect(src).not.toMatch(/CHROME_BUILD_ID\s*=\s*["'`]\d/);
  });

  it("the install script asks for the same build, and only the headless shell", () => {
    const script = readFileSync(join(process.cwd(), "scripts/install-browser.mjs"), "utf8");
    expect(script).toContain("PUPPETEER_REVISIONS");
    expect(script).toContain("CHROMEHEADLESSSHELL");
    expect(script).not.toMatch(/Browser\.CHROME\b/);   // not the full browser
    expect(script).toMatch(/latest|stable/i);          // …only to refuse one
  });
});

describe("where it looks, and what it accepts", () => {
  it("computes the path from the cache directory rather than searching the machine", () => {
    const p = expectedExecutablePath("/cache", "linux", "x64");
    expect(p).toBe(`/cache/chrome-headless-shell/linux-${CHROME_BUILD_ID}/chrome-headless-shell-linux64/chrome-headless-shell`);
    expect(expectedExecutablePath("/cache", "darwin", "arm64")).toContain("mac_arm-");
  });

  it("a path that names nothing is not installed, whatever the variable says", () => {
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", "/not/here/chrome-headless-shell");
    const f = findExecutable();
    expect(f.ok).toBe(false);
    expect(f.ok === false && f.code).toBe("not-installed");
  });

  it("a directory is not an executable", () => {
    const { dir } = fakeExecutable();
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", dir);
    expect(findExecutable().ok).toBe(false);
  });

  it("a file nobody may run is not an executable", () => {
    const { path } = fakeExecutable();
    chmodSync(path, 0o644);
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", path);
    const f = findExecutable();
    expect(f.ok).toBe(false);
    expect(f.ok === false && f.code).toBe("not-executable");
  });

  it("an override is still checked, and says it was an override", () => {
    const { path } = fakeExecutable();
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", path);
    const f = findExecutable();
    expect(f.ok).toBe(true);
    expect(f.ok && f.source).toBe("override");
  });
});

describe("what the probe concludes", () => {
  it("no executable at all is unavailable, and nothing is launched", async () => {
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", "/not/here/chrome-headless-shell");
    const p = await probeRenderer({ force: true });
    expect(p.status).toBe("unavailable");
    expect(p.code).toBe("not-installed");
  });

  it("an executable that cannot launch is misconfigured, not unavailable", async () => {
    // A file that is there, is a file, and may be run — and exits immediately, the way a
    // binary missing a shared library does.
    const { path } = fakeExecutable();
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", path);
    const p = await probeRenderer({ force: true, timeoutMs: 8_000 });
    expect(p.status).toBe("misconfigured");
    expect(["launch-failed", "timeout", "launch-enoent", "missing-libraries"]).toContain(p.code);
  }, 20_000);

  it("a probe that runs out of time says so, and is not called ready", async () => {
    const { path } = fakeExecutable();
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", path);
    const p = await probeRenderer({ force: true, timeoutMs: 1 });
    expect(p.status).toBe("misconfigured");
    expect(p.status).not.toBe("ready");
  }, 20_000);

  it("the answer is cached, so health does not start a browser every request", async () => {
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", "/not/here/chrome-headless-shell");
    const first = await probeRenderer({ force: true });
    const second = await probeRenderer();
    expect(second.at).toBe(first.at);                 // the same measurement, not a new one
    expect(cachedProbe()?.at).toBe(first.at);
  });

  it("health never claims ready before anything has rendered", () => {
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", "/not/here/chrome-headless-shell");
    const h = rendererStatusForHealth();
    expect(h.status).toBe("unavailable");
    expect(h.status).not.toBe("ready");
  });

  it("health reports a measurement once there is one", async () => {
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", "/not/here/chrome-headless-shell");
    await probeRenderer({ force: true });
    expect(rendererStatusForHealth()).toMatchObject({ status: "unavailable", code: "not-installed" });
  });

  it("nothing it reports could be a path, an environment or a stack", async () => {
    const { path } = fakeExecutable();
    vi.stubEnv("CHROME_HEADLESS_SHELL_PATH", path);
    const p = await probeRenderer({ force: true, timeoutMs: 5_000 });
    const asText = JSON.stringify(p);
    expect(asText).not.toContain(path);
    expect(asText).not.toContain("/");
    expect(p.code).toMatch(/^[a-z-]+$/);              // a word, nothing more
  }, 20_000);
});

describe("the probe touches nothing", () => {
  const src = () => readFileSync(join(process.cwd(), "src/lib/certificates/probe.ts"), "utf8");

  it("has no database, Drive or certificate anywhere in it", () => {
    const s = src();
    for (const forbidden of ["@/lib/db", "prisma", "google-drive", "certificates/drive", "expenseCertificate", "jobSheet"]) {
      expect(s, `the probe must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders a page with no real data on it", () => {
    const s = src();
    expect(s).toContain("renderer probe");
    // No job, no guide, no money.
    expect(s).not.toMatch(/FOLK-|G-0\d\d|฿/);
  });
});

describe("repository invariant — production config installs the browser it will use", () => {
  const nixpacks = () => readFileSync(join(process.cwd(), "nixpacks.toml"), "utf8");

  it("does not ask apt for chromium-browser, which is a snap shim", () => {
    const s = nixpacks();
    expect(s).not.toMatch(/"chromium-browser"|'chromium-browser'/);
    expect(s).not.toMatch(/nixPkgs\s*=.*chromium/);
  });

  it("names no browser path, in any config", () => {
    for (const f of ["nixpacks.toml", "railway.json", "railway.worker.json"]) {
      const p = join(process.cwd(), f);
      if (!statSync(p, { throwIfNoEntry: false })) continue;
      const s = readFileSync(p, "utf8");
      expect(s, `${f} must not hard-code a browser path`).not.toMatch(/\/nix\/.*chromium|CHROMIUM_PATH|PUPPETEER_EXECUTABLE_PATH/);
    }
  });

  it("does not stop Puppeteer's tooling downloading, since that is how the browser arrives", () => {
    expect(nixpacks()).not.toContain("PUPPETEER_SKIP_DOWNLOAD");
  });

  it("downloads the browser in a build step of its own, not in a lifecycle hook", () => {
    const s = nixpacks();
    expect(s).toContain("browser:install");
    expect(s).toMatch(/\[phases\.browser\]/);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["browser:install"]).toBeTruthy();
    expect(pkg.scripts.postinstall ?? "", "the browser must not arrive via postinstall").not.toContain("browser");
  });

  it("installs the libraries and Thai fonts that binary needs", () => {
    const s = nixpacks();
    for (const need of ["libnss3", "libgbm1", "fontconfig"]) expect(s, `missing ${need}`).toContain(need);
    expect(s).toMatch(/fonts-thai-tlwg|fonts-noto/);
  });

  it("nothing in the app falls back to a browser that happens to be on the machine", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (entry === "node_modules" || entry === ".next") continue;
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$|\.itest\.tsx?$/.test(p)) out.push(p);
      }
      return out;
    };
    // Comments are exempt: the module that explains why `chromium-browser` is the wrong
    // thing to install has to be able to name it.
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const bad = /google-chrome|\/Applications\/Google Chrome|chromium-browser|which\s+chrom/i;
    const offenders = walk(join(process.cwd(), "src")).filter((f) => bad.test(strip(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });

  it("the browser cache sits inside the app, so the build output carries it", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/certificates/browser.ts"), "utf8");
    expect(src).toContain(".browser-cache");
    expect(dirname(expectedExecutablePath("/app/.browser-cache", "linux", "x64"))).toContain("/app/.browser-cache/");
  });
});

describe("repository invariant — the image itself is smoke tested", () => {
  const smoke = () => readFileSync(join(process.cwd(), "scripts/image-smoke.sh"), "utf8");
  const ci = () => readFileSync(join(process.cwd(), "../../.github/workflows/ci.yml"), "utf8");

  it("CI builds an image and runs it, not just the checkout", () => {
    const y = ci();
    expect(y).toContain("image-smoke.sh");
    expect(y).toMatch(/nixpacks/i);
  });

  it("with the builder Railway uses, pinned — not whatever is current", () => {
    // A smoke test that builds the image with a different builder than production is
    // testing something production does not do. The first run of this step proved the
    // point: a newer CLI emitted a cache mount Railway's build never emits, and the
    // image failed to build for a reason that had nothing to do with the app.
    const y = ci();
    expect(y).toMatch(/NIXPACKS_VERSION:\s*"?\d+\.\d+\.\d+/);
    expect(y).not.toContain("nixpacks.com/install.sh");   // unpinned
  });

  it("the image is built from a clean export, not the runner's working directory", () => {
    // By the time this step runs the checkout holds a tsbuildinfo the typecheck left,
    // a .next, node_modules — and the .browser-cache an earlier step installed. Building
    // from there would COPY the runner's browser into the image, and the test would pass
    // while proving nothing about whether the image builds its own.
    const s = smoke();
    expect(s).toContain("git archive");
    expect(s).toContain(".browser-cache .next node_modules tsconfig.tsbuildinfo");
    expect(s).toMatch(/must build its own/);
  });

  it("the container gets nothing from the host", () => {
    const s = smoke();
    // A mount would let the runner's source, node_modules or browser stand in for the
    // image's, which is the whole thing this test is here to disprove.
    expect(s).not.toMatch(/docker run[^\n]*\s-v\s/);
    expect(s).not.toMatch(/--mount/);
    expect(s).toContain("CHROME_HEADLESS_SHELL_PATH=");
    expect(s).toContain("PUPPETEER_EXECUTABLE_PATH=");
    expect(s).toContain("CHROMIUM_PATH=");
  });

  it("it checks the build id, the cache directory and the bytes that come out", () => {
    const s = smoke();
    expect(s).toContain(".browser-cache");
    expect(s).toContain("PUPPETEER_REVISIONS");       // the id is read, not typed
    expect(s).not.toMatch(/EXPECTED_BUILD_ID=["']?\d+\./);
    expect(s).toContain("%PDF-");
    expect(s).toContain("%%EOF");
  });

  it("it reads the Thai back out, rather than trusting that a font was embedded", () => {
    // A page of boxes embeds a font too. The question is whether the WORDS are there.
    const s = smoke();
    expect(s).toContain("pdftotext");
    expect(s).toContain("ใบรับรองแทนใบเสร็จรับเงิน");
    // …with a fallback for a PDF that carries no ToUnicode map, which proves the same
    // thing the long way: a Thai face embedded, and ink where the words should be.
    expect(s).toContain("pdffonts");
    expect(s).toContain("pdftoppm");
    expect(s).toMatch(/noto\|garuda\|laksaman|garuda/);
    expect(s).toContain("blank band");                 // the control region
  });

  it("CI installs the tools that reading a PDF back needs", () => {
    expect(ci()).toContain("poppler-utils");
  });

  it("it reports the image size, the peak memory and any leftover process", () => {
    const s = smoke();
    expect(s).toContain("image size");
    expect(s).toContain("memory.peak");
    expect(s).toMatch(/left over from rendering/);
  });

  it("it takes a baseline before anything renders, and diffs against it", () => {
    // Counting processes by name would count the Node server and whatever the base
    // image runs. What matters is what RENDERING left behind.
    const s = smoke();
    expect(s).toContain("BASE_PIDS");
    expect(s).toContain("api/version");              // a route that renders nothing
    expect(s).toMatch(/report_new "immediately after the render"/);
    expect(s).toMatch(/after 5s/);
    expect(s).toMatch(/after 15s/);
    expect(s).toContain("stat=Z");                   // zombies told apart from the living
    expect(s).toContain("PID 1 is");
  });

  it("the image runs an init that reaps, and the test does not supply one for it", () => {
    // The four leftovers were zombies with ppid 1, and PID 1 was npm, which does not
    // wait on children it did not start. `docker run --init` would have hidden that,
    // and production does not run with it.
    // Comment lines are exempt — the script has to be able to say why `--init` is not
    // used without tripping the rule that forbids it.
    const commands = smoke().split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(commands.filter((l) => /docker run[^\n]*--init/.test(l))).toEqual([]);
    expect(smoke()).toContain("does not reap orphaned children");
    const nix = readFileSync(join(process.cwd(), "nixpacks.toml"), "utf8");
    expect(nix).toContain('"tini"');
    expect(nix).toMatch(/\[start\][\s\S]*tini --/);
    const railway = JSON.parse(readFileSync(join(process.cwd(), "railway.json"), "utf8"));
    expect(railway.deploy.startCommand, "Railway overrides the image CMD, so it needs tini too").toContain("tini --");
  });

  it("cleanup is checked on the paths that are not the happy one", () => {
    const s = smoke();
    expect(s).toMatch(/throw, timeout and three consecutive renders/);
    expect(s).toContain("after throw, timeout and three renders");
  });

  it("the size is reported as a delta against what production runs", () => {
    const delta = readFileSync(join(process.cwd(), "scripts/image-size-delta.sh"), "utf8");
    expect(delta).toMatch(/git .*archive/);          // both images from clean exports
    expect(delta).toContain("BASELINE_REF");
    expect(delta).toContain("delta_mb");
    expect(ci()).toContain("image-size-delta.sh");
  });
});
