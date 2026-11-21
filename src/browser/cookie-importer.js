import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUPPORTED_BROWSERS = ["chrome", "brave", "edge", "arc", "chromium"];

export function getBrowserUserDataDir(browserName, {
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const norm = String(browserName || "").toLowerCase().trim();
  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    switch (norm) {
      case "chrome":
      case "google-chrome":
        return path.join(appSupport, "Google", "Chrome");
      case "brave":
      case "brave-browser":
        return path.join(appSupport, "BraveSoftware", "Brave-Browser");
      case "edge":
      case "microsoft-edge":
        return path.join(appSupport, "Microsoft Edge");
      case "arc":
        return path.join(appSupport, "Arc", "User Data");
      case "chromium":
        return path.join(appSupport, "Chromium");
      default:
        return null;
    }
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    switch (norm) {
      case "chrome":
      case "google-chrome":
        return path.join(localAppData, "Google", "Chrome", "User Data");
      case "brave":
      case "brave-browser":
        return path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
      case "edge":
      case "microsoft-edge":
        return path.join(localAppData, "Microsoft", "Edge", "User Data");
      case "chromium":
        return path.join(localAppData, "Chromium", "User Data");
      default:
        return null;
    }
  }

  // Linux / BSD / Unix default
  const configDir = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  switch (norm) {
    case "chrome":
    case "google-chrome":
      return path.join(configDir, "google-chrome");
    case "brave":
    case "brave-browser":
      return path.join(configDir, "BraveSoftware", "Brave-Browser");
    case "edge":
    case "microsoft-edge":
      return path.join(configDir, "microsoft-edge");
    case "chromium":
      return path.join(configDir, "chromium");
    default:
      return null;
  }
}

export async function findBrowserProfileDir(browserDataDir) {
  if (!browserDataDir || !existsSync(browserDataDir)) {
    return null;
  }

  // Check Default profile first
  const candidates = ["Default", "Profile 1", "Profile 2", "."];
  for (const candidate of candidates) {
    const profilePath = path.resolve(browserDataDir, candidate);
    const cookies1 = path.join(profilePath, "Cookies");
    const cookies2 = path.join(profilePath, "Network", "Cookies");
    if (existsSync(cookies1) || existsSync(cookies2)) {
      return profilePath;
    }
  }

  return null;
}

export async function detectAvailableBrowsers(options = {}) {
  const available = [];
  for (const browser of SUPPORTED_BROWSERS) {
    const dataDir = getBrowserUserDataDir(browser, options);
    const profileDir = await findBrowserProfileDir(dataDir);
    if (profileDir) {
      available.push({ browser, dataDir, profileDir });
    }
  }
  return available;
}

async function copyFileIfExists(src, dest) {
  try {
    if (!existsSync(src)) return false;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

async function copyDirIfExists(src, dest) {
  try {
    if (!existsSync(src)) return false;
    await fs.mkdir(dest, { recursive: true });
    await fs.cp(src, dest, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function importCookiesFromBrowser({
  sourceBrowser = "auto",
  destinationProfileDir,
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  if (!destinationProfileDir) {
    throw new Error("destinationProfileDir is required for cookie import");
  }

  const options = { platform, homeDir, env };
  let selectedBrowser = sourceBrowser;
  let sourceProfile = null;

  if (sourceBrowser === "auto" || !sourceBrowser || sourceBrowser === true) {
    const available = await detectAvailableBrowsers(options);
    if (available.length === 0) {
      throw new Error(
        `No desktop browser profiles with cookies found. Supported browsers: ${SUPPORTED_BROWSERS.join(", ")}`,
      );
    }
    selectedBrowser = available[0].browser;
    sourceProfile = available[0].profileDir;
  } else {
    const dataDir = getBrowserUserDataDir(sourceBrowser, options);
    if (!dataDir) {
      throw new Error(`Unsupported browser "${sourceBrowser}". Supported: ${SUPPORTED_BROWSERS.join(", ")}`);
    }
    sourceProfile = await findBrowserProfileDir(dataDir);
    if (!sourceProfile) {
      throw new Error(`No cookies found in ${sourceBrowser} profile directory (${dataDir}).`);
    }
  }

  // WTAgent Chrome profiles store their session in <profileDir>/Default
  const destDefault = path.join(destinationProfileDir, "Default");
  await fs.mkdir(destDefault, { recursive: true });

  const importedFiles = [];

  // 1. Root Cookies & Journal
  if (await copyFileIfExists(path.join(sourceProfile, "Cookies"), path.join(destDefault, "Cookies"))) {
    importedFiles.push("Cookies");
  }
  await copyFileIfExists(path.join(sourceProfile, "Cookies-journal"), path.join(destDefault, "Cookies-journal"));

  // 2. Network/Cookies & Journal & Persistent State
  if (await copyFileIfExists(path.join(sourceProfile, "Network", "Cookies"), path.join(destDefault, "Network", "Cookies"))) {
    importedFiles.push("Network/Cookies");
  }
  await copyFileIfExists(path.join(sourceProfile, "Network", "Cookies-journal"), path.join(destDefault, "Network", "Cookies-journal"));
  await copyFileIfExists(path.join(sourceProfile, "Network", "Network Persistent State"), path.join(destDefault, "Network", "Network Persistent State"));

  // 3. Local Storage and Session Storage
  if (await copyDirIfExists(path.join(sourceProfile, "Local Storage"), path.join(destDefault, "Local Storage"))) {
    importedFiles.push("Local Storage");
  }
  if (await copyDirIfExists(path.join(sourceProfile, "Session Storage"), path.join(destDefault, "Session Storage"))) {
    importedFiles.push("Session Storage");
  }

  return {
    success: true,
    browser: selectedBrowser,
    sourceProfile,
    destinationDefault: destDefault,
    importedFiles,
  };
}
