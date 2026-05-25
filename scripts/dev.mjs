import { spawn } from "node:child_process";
import net from "node:net";
import { npmCommand, prepareSpawn, spawnOptions } from "./runtime-env.mjs";

const host = "127.0.0.1";
const preferredApiPort = Number(process.env.API_PORT || 5180);
const preferredUiPort = Number(process.env.UI_PORT || 5174);
const children = new Map();
let shuttingDown = false;

const npm = npmCommand();

function url(port, path = "") {
  return `http://${host}:${port}${path}`;
}

async function canFetch(target) {
  try {
    const response = await fetch(target);
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${startPort} to ${startPort + 49}.`);
}

function start(name, command, args, env = {}) {
  const prepared = prepareSpawn(command, args);
  const child = spawn(prepared.command, prepared.args, spawnOptions({
    env: { ...process.env, ...env },
    stdio: ["inherit", "pipe", "pipe"]
  }));

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      console.error(`[${name}] exited with ${signal || code}`);
      shutdown(code || 1);
    }
  });

  children.set(name, child);
  return child;
}

async function waitFor(target, label, timeoutMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await canFetch(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label} at ${target}.`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) child.kill("SIGINT");
  setTimeout(() => process.exit(exitCode), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const existingApiReady = await canFetch(url(preferredApiPort, "/api/bootstrap"));
const existingUiReady = await canFetch(url(preferredUiPort));

if (existingApiReady && existingUiReady) {
  console.log(`Second Chair is already running: ${url(preferredUiPort)}`);
  console.log("Press Ctrl+C in the terminal that owns it to stop the existing server.");
  process.exit(0);
}

const apiPort = existingApiReady ? preferredApiPort : await findFreePort(preferredApiPort);
const uiPort = existingUiReady ? await findFreePort(preferredUiPort + 1) : await findFreePort(preferredUiPort);
const apiUrl = url(apiPort);
const uiUrl = url(uiPort);

if (!existingApiReady) {
  start("api", npm, ["run", "dev:api"], { API_PORT: String(apiPort) });
}

start("ui", npm, ["run", "dev:ui", "--", "--port", String(uiPort)], {
  SECOND_CHAIR_API_URL: apiUrl,
  INTERVIEW_COPILOT_API_URL: apiUrl,
});

await Promise.all([
  waitFor(`${apiUrl}/api/bootstrap`, "local API"),
  waitFor(uiUrl, "Vite UI")
]);

console.log(`Second Chair UI: ${uiUrl}`);
console.log(`Second Chair API: ${apiUrl}`);
