#!/usr/bin/env node
// claude-relocate: move Claude Code's config folder, sessions and .claude.json somewhere else, safely.
// All the work lives in src/cli.mjs; run `claude-relocate --help` for the commands.
import { main } from "../src/cli.mjs";

// `claude-relocate plan | head` closes the pipe early: that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
