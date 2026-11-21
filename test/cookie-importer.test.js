import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectAvailableBrowsers,
  findBrowserProfileDir,
  getBrowserUserDataDir,
  importCookiesFromBrowser,
  SUPPORTED_BROWSERS,
} from "../src/browser/cookie-importer.js";

test("supported browsers list includes major desktop browsers", () => {
  assert.ok(SUPPORTED_BROWSERS.includes("chrome"));
  assert.ok(SUPPORTED_BROWSERS.includes("brave"));
  assert.ok(SUPPORTED_BROWSERS.includes("edge"));
  assert.ok(SUPPORTED_BROWSERS.includes("arc"));
  assert.ok(SUPPORTED_BROWSERS.includes("chromium"));
});

test("resolves browser user data directories per platform", () => {
  const home = "/fake/home";

  // macOS
  assert.equal(
    getBrowserUserDataDir("chrome", { platform: "darwin", homeDir: home }),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
  );
  assert.equal(
    getBrowserUserDataDir("brave", { platform: "darwin", homeDir: home }),
    path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
  );
  assert.equal(
    getBrowserUserDataDir("arc", { platform: "darwin", homeDir: home }),
    path.join(home, "Library", "Application Support", "Arc", "User Data"),
  );

  // Linux
  assert.equal(
    getBrowserUserDataDir("chrome", { platform: "linux", homeDir: home, env: {} }),
    path.join(home, ".config", "google-chrome"),
  );

  // Windows
  assert.equal(
    getBrowserUserDataDir("edge", { platform: "win32", homeDir: home, env: { LOCALAPPDATA: "C:\\Users\\Fake\\AppData\\Local" } }),
    path.join("C:\\Users\\Fake\\AppData\\Local", "Microsoft", "Edge", "User Data"),
  );
});

test("finds browser profile dir with Cookies file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "browser-profile-test-"));
  try {
    const defaultProfile = path.join(tmp, "Default");
    await fs.mkdir(path.join(defaultProfile, "Network"), { recursive: true });
    await fs.writeFile(path.join(defaultProfile, "Network", "Cookies"), "mock-cookies-data");

    const found = await findBrowserProfileDir(tmp);
    assert.equal(found, defaultProfile);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("imports cookies, storage, and persistent state into destination profile", async () => {
  const tmpSource = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-src-"));
  const tmpDest = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-dest-"));

  try {
    const srcDefault = path.join(tmpSource, "Library", "Application Support", "Google", "Chrome", "Default");
    await fs.mkdir(path.join(srcDefault, "Network"), { recursive: true });
    await fs.mkdir(path.join(srcDefault, "Local Storage", "leveldb"), { recursive: true });

    await fs.writeFile(path.join(srcDefault, "Cookies"), "sqlite-cookies-root");
    await fs.writeFile(path.join(srcDefault, "Network", "Cookies"), "sqlite-cookies-network");
    await fs.writeFile(path.join(srcDefault, "Local Storage", "leveldb", "000001.log"), "storage-log");

    const result = await importCookiesFromBrowser({
      sourceBrowser: "chrome",
      destinationProfileDir: tmpDest,
      platform: "darwin",
      homeDir: tmpSource,
    });

    assert.equal(result.success, true);
    assert.equal(result.browser, "chrome");

    const destDefault = path.join(tmpDest, "Default");
    const copiedRootCookies = await fs.readFile(path.join(destDefault, "Cookies"), "utf8");
    const copiedNetCookies = await fs.readFile(path.join(destDefault, "Network", "Cookies"), "utf8");
    const copiedStorage = await fs.readFile(path.join(destDefault, "Local Storage", "leveldb", "000001.log"), "utf8");

    assert.equal(copiedRootCookies, "sqlite-cookies-root");
    assert.equal(copiedNetCookies, "sqlite-cookies-network");
    assert.equal(copiedStorage, "storage-log");
  } finally {
    await fs.rm(tmpSource, { recursive: true, force: true });
    await fs.rm(tmpDest, { recursive: true, force: true });
  }
});

test("auto-detects first available browser when sourceBrowser is auto", async () => {
  const tmpSource = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-auto-"));
  const tmpDest = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-dest-"));

  try {
    const braveDefault = path.join(tmpSource, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "Default");
    await fs.mkdir(braveDefault, { recursive: true });
    await fs.writeFile(path.join(braveDefault, "Cookies"), "brave-cookies");

    const result = await importCookiesFromBrowser({
      sourceBrowser: "auto",
      destinationProfileDir: tmpDest,
      platform: "darwin",
      homeDir: tmpSource,
    });

    assert.equal(result.success, true);
    assert.equal(result.browser, "brave");
  } finally {
    await fs.rm(tmpSource, { recursive: true, force: true });
    await fs.rm(tmpDest, { recursive: true, force: true });
  }
});

test("throws informative error when no browsers found or invalid browser name", async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "empty-home-"));
  const tmpDest = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-dest-"));

  try {
    await assert.rejects(
      importCookiesFromBrowser({
        sourceBrowser: "auto",
        destinationProfileDir: tmpDest,
        platform: "darwin",
        homeDir: emptyHome,
      }),
      /No desktop browser profiles with cookies found/,
    );

    await assert.rejects(
      importCookiesFromBrowser({
        sourceBrowser: "nonexistent-browser",
        destinationProfileDir: tmpDest,
        platform: "darwin",
        homeDir: emptyHome,
      }),
      /Unsupported browser "nonexistent-browser"/,
    );
  } finally {
    await fs.rm(emptyHome, { recursive: true, force: true });
    await fs.rm(tmpDest, { recursive: true, force: true });
  }
});
