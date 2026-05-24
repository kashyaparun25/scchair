import { spawn } from "node:child_process";
import net from "node:net";
import { runtimeEnv } from "../scripts/runtime-env.mjs";

const uiUrl = runtimeEnv("DEV_SERVER_URL", "http://127.0.0.1:5174");
const apiUrl = runtimeEnv("API_HEALTH_URL", "http://127.0.0.1:5180/api/bootstrap");
const children = new Map();
let shuttingDown = false;

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["inherit", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown && name !== "electron") {
      console.error(`[${name}] exited unexpectedly with ${signal || code}`);
      shutdown(1);
    }
    if (name === "electron") shutdown(code ?? 0);
  });

  children.set(name, child);
  return child;
}

async function waitForUrl(url, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError?.message || "no response"}`);
}

async function assertPortFree(url, label) {
  const parsed = new URL(url);
  const host = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });

    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`${label} port ${host}:${port} is already in use.`));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
}

async function isUrlReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    child.kill("SIGINT");
  }

  setTimeout(() => process.exit(exitCode), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const existingApiReady = await isUrlReady(apiUrl);
  const existingUiReady = await isUrlReady(uiUrl);

  if (existingApiReady && existingUiReady) {
    console.log(`Using existing dev services at ${uiUrl}`);
    start("electron", npm, ["run", "electron"], {
      SECOND_CHAIR_DEV_SERVER_URL: uiUrl,
      INTERVIEW_COPILOT_DEV_SERVER_URL: uiUrl,
    });
  } else {
  await Promise.all([
    assertPortFree(apiUrl, "Local API"),
    assertPortFree(uiUrl, "Vite UI")
  ]);

  start("api", npm, ["run", "dev:api"]);
  start("ui", npm, ["run", "dev:ui"]);

  await Promise.all([
    waitForUrl(apiUrl, "local API"),
    waitForUrl(uiUrl, "Vite UI")
  ]);
  start("electron", npm, ["run", "electron"], {
    SECOND_CHAIR_DEV_SERVER_URL: uiUrl,
    INTERVIEW_COPILOT_DEV_SERVER_URL: uiUrl,
  });
  }
} catch (error) {
  console.error(error.message);
  shutdown(1);
}
