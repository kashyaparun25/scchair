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

function prepareSpawn(command, args = []) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const prepared = prepareSpawn(command, args);
    const child = spawn(prepared.command, prepared.args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const prepared = prepareSpawn(command, args);
    const child = spawn(prepared.command, prepared.args, {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
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
    ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
    : [{ command: "python3", args: [] }, { command: "python", args: [] }];

  for (const candidate of candidates) {
    const { code, stdout } = await runCapture(candidate.command, [...candidate.args, "--version"]);
    if (code === 0 && stdout.includes("Python")) {
      return { command: candidate.command, args: candidate.args, version: stdout };
    }
  }
  return null;
}

async function pythonCanImport(python, moduleName) {
  const { code } = await runCapture(python.command, [
    ...python.args,
    "-c",
    `import ${moduleName}`,
  ], { shell: false });
  if (code === 0) return true;

  const pipShow = await runCapture(python.command, [
    ...python.args,
    "-m",
    "pip",
    "show",
    "nvidia-riva-client",
  ], { shell: false });
  return pipShow.code === 0 && pipShow.stdout.includes("Name: nvidia-riva-client");
}

async function ensureNvidiaRivaClient(python) {
  if (await pythonCanImport(python, "riva.client")) {
    log("NVIDIA Riva Python client OK");
    return;
  }

  log("Installing NVIDIA Riva Python client...");
  const pipBase = [python.command, ...python.args, "-m", "pip", "install", "-U", "nvidia-riva-client"];
  let code = await run(pipBase[0], pipBase.slice(1));
  if (code !== 0) {
    code = await run(pipBase[0], [...pipBase.slice(1, -1), "--user", "nvidia-riva-client"]);
  }
  if (code !== 0 || !(await pythonCanImport(python, "riva.client"))) {
    warn("Could not auto-install nvidia-riva-client.");
    warn(`Run: ${python.command} ${python.args.join(" ")} -m pip install -U nvidia-riva-client`);
    return;
  }
  log("NVIDIA Riva Python client ready");
}

async function ensureElectronBinary() {
  const electronDir = path.join(root, "node_modules", "electron");
  const electronPathTxt = path.join(electronDir, "path.txt");
  if (fs.existsSync(electronPathTxt)) return true;

  warn("Electron binary is missing; repairing Electron install...");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const electronVersion = String(packageJson.devDependencies?.electron || "latest").replace(/^[~^]/, "");
  let code = await run(npmCommand(), [
    "rebuild",
    "electron",
    "--fetch-retries=5",
    "--fetch-retry-mintimeout=20000",
    "--fetch-retry-maxtimeout=120000",
  ]);

  if (!fs.existsSync(electronPathTxt) && fs.existsSync(path.join(electronDir, "install.js"))) {
    log("Running Electron binary downloader...");
    code = await run(process.execPath, [path.join(electronDir, "install.js")], {
      env: { ...process.env, force_no_cache: "true" },
    });
  }

  if (!fs.existsSync(electronPathTxt)) {
    warn("Electron binary still missing; reinstalling Electron package...");
    code = await run(npmCommand(), [
      "install",
      `electron@${electronVersion}`,
      "--save-dev",
      "--force",
      "--no-fund",
      "--no-audit",
      "--fetch-retries=5",
      "--fetch-retry-mintimeout=20000",
      "--fetch-retry-maxtimeout=120000",
    ]);
  }

  if (!fs.existsSync(electronPathTxt) && fs.existsSync(path.join(electronDir, "install.js"))) {
    log("Running Electron binary downloader after reinstall...");
    code = await run(process.execPath, [path.join(electronDir, "install.js")], {
      env: { ...process.env, force_no_cache: "true" },
    });
  }

  if (!fs.existsSync(electronPathTxt)) {
    fail(`Electron repair failed. Check your network connection and run: npm install electron@${electronVersion} --save-dev --force`);
  }

  log("Electron binary ready.");
  return true;
}

export async function ensureNpmDependencies() {
  const nodeModules = path.join(root, "node_modules");
  const lockfile = path.join(root, "package-lock.json");
  const stampPath = path.join(root, ".scchair-install-stamp");
  const stampSource = fs.existsSync(lockfile) ? fs.readFileSync(lockfile, "utf8").slice(0, 4096) : "";

  if (fs.existsSync(nodeModules) && fs.existsSync(stampPath)) {
    const previous = fs.readFileSync(stampPath, "utf8");
    if (previous === stampSource && await ensureElectronBinary()) return;
  }

  log("Installing dependencies (first run can take a few minutes)...");
  const code = await run(npmCommand(), ["install", "--no-fund", "--no-audit"], {
    env: { ...process.env, npm_config_build_from_source: "true" },
  });
  if (code !== 0) fail("Dependency install failed. Try running from the project folder: npm install");
  await ensureElectronBinary();

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
    log(`Python detected (${python.version}).`);
    await ensureNvidiaRivaClient(python);
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
