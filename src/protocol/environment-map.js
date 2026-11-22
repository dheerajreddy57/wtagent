import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function detectProjectMap(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    return null;
  }

  // 1. Stack & Package Manager
  let stack = null;
  let packageManager = null;
  let testCommand = null;
  let checkCommand = null;

  const pkgJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, "utf8");
      const pkg = JSON.parse(raw);
      const isEsm = pkg.type === "module";

      if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
        packageManager = "pnpm";
      } else if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) {
        packageManager = "yarn";
      } else if (
        fs.existsSync(path.join(projectRoot, "bun.lockb"))
        || fs.existsSync(path.join(projectRoot, "bun.lock"))
      ) {
        packageManager = "bun";
      } else {
        packageManager = "npm";
      }

      stack = `Node.js (${isEsm ? "ESM" : "CommonJS"})`;

      if (pkg.scripts) {
        if (pkg.scripts.test) {
          testCommand = packageManager === "npm" ? "npm test" : `${packageManager} test`;
        }
        if (pkg.scripts.check) {
          checkCommand = packageManager === "npm" ? "npm run check" : `${packageManager} run check`;
        } else if (pkg.scripts.lint) {
          checkCommand = packageManager === "npm" ? "npm run lint" : `${packageManager} run lint`;
        }
      }
    } catch {
      stack = "Node.js (unparsed package.json)";
    }
  } else if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml"))
    || fs.existsSync(path.join(projectRoot, "requirements.txt"))
    || fs.existsSync(path.join(projectRoot, "setup.py"))
  ) {
    stack = "Python";
    if (fs.existsSync(path.join(projectRoot, "pyproject.toml"))) {
      testCommand = "pytest";
    }
  } else if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    stack = "Rust (Cargo)";
    testCommand = "cargo test";
    checkCommand = "cargo check";
  } else if (fs.existsSync(path.join(projectRoot, "go.mod"))) {
    stack = "Go";
    testCommand = "go test ./...";
  }

  // 2. Git Information
  let git = null;
  try {
    const branch = execFileSync(
      "git",
      ["branch", "--show-current"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim() || "HEAD";

    const commit = execFileSync(
      "git",
      ["rev-parse", "--short", "HEAD"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    const statusRaw = execFileSync(
      "git",
      ["status", "--porcelain"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    let status = "clean";
    if (statusRaw) {
      const lines = statusRaw.split("\n").filter(Boolean);
      const untracked = lines.filter((l) => l.startsWith("??")).length;
      const modified = lines.filter((l) => !l.startsWith("??")).length;
      const parts = [];
      if (modified > 0) parts.push(`${modified} modified`);
      if (untracked > 0) parts.push(`${untracked} untracked`);
      status = parts.join(", ") || `${lines.length} changed`;
    }

    git = { branch, commit, status };
  } catch {
    // Not a git repository or git unavailable
  }

  // 3. Top-level Structure
  let structure = [];
  try {
    const ignored = new Set([
      "node_modules",
      ".git",
      ".DS_Store",
      "dist",
      "build",
      ".next",
      ".turbo",
      "coverage",
      ".nyc_output",
      "__pycache__",
      ".venv",
      "venv",
      ".pytest_cache",
    ]);
    const dirents = fs.readdirSync(projectRoot, { withFileTypes: true });
    structure = dirents
      .filter((d) => !ignored.has(d.name))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort((a, b) => {
        const aDir = a.endsWith("/");
        const bDir = b.endsWith("/");
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, 20);
  } catch {
    // readdir error
  }

  const verification = [testCommand, checkCommand].filter(Boolean).join(" && ") || null;

  return {
    stack,
    packageManager,
    git,
    structure,
    verification,
  };
}

export function formatProjectMap(map) {
  if (!map) return "";
  const lines = ["### Project Environment Map"];
  if (map.stack) {
    const pm = map.packageManager ? `, ${map.packageManager}` : "";
    lines.push(`- **Runtime & Stack**: ${map.stack}${pm}`);
  }
  if (map.git) {
    const commit = map.git.commit ? ` at \`${map.git.commit}\`` : "";
    lines.push(`- **Git Context**: branch \`${map.git.branch}\`${commit} (${map.git.status})`);
  }
  if (map.structure && map.structure.length > 0) {
    lines.push(`- **Top-level Structure**: ${map.structure.join(", ")}`);
  }
  if (map.verification) {
    lines.push(`- **Suggested Verification**: \`${map.verification}\``);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
