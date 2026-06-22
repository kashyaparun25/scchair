import { spawn } from "node:child_process";
import { npmCommand, prepareSpawn, spawnOptions } from "./runtime-env.mjs";

const builderArgs = process.argv.slice(2);
const npm = npmCommand();

function run(command, args, options = {}) {
  const prepared = prepareSpawn(command, args);
  return new Promise((resolve) => {
    const child = spawn(prepared.command, prepared.args, spawnOptions({
      stdio: "inherit",
      ...options,
    }));
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ code: 1, signal });
        return;
      }
      resolve({ code: code ?? 0, signal: null });
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolve({ code: 1, signal: null });
    });
  });
}

function isCurrentPlatformBuild(args) {
  return args.includes("--dir") || args.includes("--mac") || args.includes("--linux");
}

async function runOrThrow(label, command, args) {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code}.`);
  }
}

let exitCode = 0;

try {
  await runOrThrow("build", npm, ["run", "build"]);
  if (isCurrentPlatformBuild(builderArgs)) {
    await runOrThrow("native Electron rebuild", npm, ["run", "rebuild:native:electron"]);
  }
  await runOrThrow("electron-builder", "electron-builder", builderArgs);
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  const restore = await run(npm, ["run", "rebuild:native:node"]);
  if (restore.code !== 0) {
    exitCode = restore.code;
  }
}

process.exit(exitCode);
