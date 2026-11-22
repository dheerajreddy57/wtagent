import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectProjectMap,
  formatProjectMap,
} from "../src/protocol/environment-map.js";

test("detectProjectMap returns null for invalid or missing paths", () => {
  assert.equal(detectProjectMap(null), null);
  assert.equal(detectProjectMap(""), null);
  assert.equal(detectProjectMap("/nonexistent-path-for-test-xyz-123"), null);
});

test("detectProjectMap detects Node.js ESM and npm scripts in a temp dir", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtagent-env-test-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "sample-pkg",
        type: "module",
        scripts: {
          test: "node --test",
          check: "node --check",
        },
      }),
    );
    fs.mkdirSync(path.join(tempDir, "src"));
    fs.writeFileSync(path.join(tempDir, "src", "index.js"), "console.log(1);");
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const map = detectProjectMap(tempDir);
    assert.ok(map);
    assert.equal(map.stack, "Node.js (ESM)");
    assert.equal(map.packageManager, "npm");
    assert.equal(map.verification, "npm test && npm run check");
    assert.ok(map.structure.includes("src/"));
    assert.ok(map.structure.includes("package.json"));

    const formatted = formatProjectMap(map);
    assert.match(formatted, /### Project Environment Map/);
    assert.match(formatted, /Node\.js \(ESM\), npm/);
    assert.match(formatted, /`npm test && npm run check`/);
    assert.match(formatted, /src\//);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detectProjectMap detects Python project structure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtagent-py-test-"));
  try {
    fs.writeFileSync(path.join(tempDir, "pyproject.toml"), "[tool.poetry]");
    fs.writeFileSync(path.join(tempDir, "requirements.txt"), "pytest\n");

    const map = detectProjectMap(tempDir);
    assert.ok(map);
    assert.equal(map.stack, "Python");
    assert.equal(map.verification, "pytest");

    const formatted = formatProjectMap(map);
    assert.match(formatted, /Python/);
    assert.match(formatted, /pytest/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detectProjectMap detects Git context on the actual repository", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const map = detectProjectMap(repoRoot);
  assert.ok(map);
  assert.ok(map.stack.includes("Node.js"));
  assert.ok(map.git);
  assert.ok(typeof map.git.branch === "string" && map.git.branch.length > 0);
  assert.ok(typeof map.git.commit === "string" && map.git.commit.length > 0);
  assert.ok(map.structure.includes("src/"));
  assert.ok(map.structure.includes("package.json"));

  const formatted = formatProjectMap(map);
  assert.match(formatted, /Git Context/);
  assert.match(formatted, /Runtime & Stack/);
});
