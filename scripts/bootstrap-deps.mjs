import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function log(message) {
  console.log(`[scchair] ${message}`);
}

export function warn(message) {
  console.warn(`[scchair] ${message}`);
}

export function fail(message, code = 1) {
  console.error(`[scchair] ${message}`);
  process.exit(code);
}

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export function runCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim() }));
  });
}

export function assertNodeVersion() {
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major < 20) {
    fail(
      `Node.js 20 or newer is required (found ${process.version}). Install from https://nodejs.org`,
    );
  }
}

export async function detectPython() {
  const candidates = process.platform === "win32"
    ? [["py", "-3"], ["python"], ["python3"]]
    : [["python3"], ["python"]];

  for (const args of candidates) {
    const cmd = args[0];
    const { code, stdout } = await runCapture(cmd, [...args.slice(1), "--version"]);
    if (code === 0 && stdout.includes("Python")) {
      return { command: cmd, version: stdout };
    }
  }
  return null;
}

export async function ensureNpmDependencies() {
  const nodeModules = path.join(root, "node_modules");
  const lockfile = path.join(root, "package-lock.json");
  const stampPath = path.join(root, ".scchair-install-stamp");
  const stampSource = fs.existsSync(lockfile) ? fs.readFileSync(lockfile, "utf8").slice(0, 4096) : "";

  if (fs.existsSync(nodeModules) && fs.existsSync(stampPath)) {
    const previous = fs.readFileSync(stampPath, "utf8");
    if (previous === stampSource) return;
  }

  log("Installing dependencies (first run can take a few minutes)...");
  const code = await run(npmCommand(), ["install", "--no-fund", "--no-audit"], {
    env: { ...process.env, npm_config_build_from_source: "true" },
  });
  if (code !== 0) fail("Dependency install failed. Try running from the project folder: npm install");

  fs.writeFileSync(stampPath, stampSource);
  log("Dependencies ready.");
}

export function ensureEnvFile() {
  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");
  if (fs.existsSync(envPath) || !fs.existsSync(examplePath)) return;
  fs.copyFileSync(examplePath, envPath);
  log("Created .env from .env.example. API keys can also be added in Settings after launch.");
}

export function ensureDataDir() {
  const dataDir = process.env.SECOND_CHAIR_DATA_DIR
    || process.env.INTERVIEW_COPILOT_DATA_DIR
    || path.join(root, ".local-data");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SECOND_CHAIR_DATA_DIR = dataDir;
}

export async function bootstrapEnvironment({ requirePython = false } = {}) {
  assertNodeVersion();
  ensureEnvFile();
  ensureDataDir();
  await ensureNpmDependencies();

  const python = await detectPython();
  if (python) {
    log(`Python detected (${python.version}). NVIDIA Riva live captions are supported.`);
  } else if (requirePython) {
    fail([
      "Python 3 is required for NVIDIA live captions.",
      "macOS: brew install python3",
      "Windows: https://www.python.org/downloads/",
    ].join("\n"));
  } else {
    warn("Python 3 not found. OpenAI/Gemini/Claude stacks still work; NVIDIA live captions need Python 3.");
    warn("  macOS: brew install python3");
    warn("  Windows: https://www.python.org/downloads/");
  }

  return { root, python };
}
