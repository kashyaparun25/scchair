#!/usr/bin/env node
import {
  bootstrapEnvironment,
  fail,
  log,
  npmCommand,
  run,
} from "../scripts/bootstrap-deps.mjs";

const args = process.argv.slice(2);
const command = args[0] || "start";

function printHelp() {
  console.log(`
Second Chair — your private interview and meeting copilot

Usage:
  scchair                  Start the desktop app (default)
  scchair start            Same as above
  scchair web              Browser-only mode (no Electron shell)
  scchair doctor           Check Node, Python, and dependencies

Install (one time):
  curl -fsSL https://raw.githubusercontent.com/kashyaparun25/scchair/main/scripts/install.sh | bash

Add API keys in Settings (NVIDIA is the default provider). Keys stay on your machine.

Docs: https://github.com/kashyaparun25/scchair
`);
}

async function doctor() {
  await bootstrapEnvironment();
  log("Environment looks good. Run: scchair");
}

async function startWeb() {
  await bootstrapEnvironment();
  log("Starting browser mode...");
  const code = await run(npmCommand(), ["run", "dev"]);
  process.exit(code);
}

async function startDesktop() {
  await bootstrapEnvironment();
  log("Starting Second Chair...");
  const code = await run(npmCommand(), ["run", "dev:desktop"]);
  process.exit(code);
}

async function main() {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "doctor":
    case "check":
      await doctor();
      return;
    case "web":
      await startWeb();
      return;
    case "start":
    case "desktop":
      await startDesktop();
      return;
    default:
      fail(`Unknown command "${command}". Run: scchair help`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
