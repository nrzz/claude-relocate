// The parts of the machine the commands touch other than files: the platform, the clock, running commands, the
// process list, free space, which drive a path is on, renames and file copies. Tests replace single functions to force a case (a rename
// across drives, a copy that stops half way, a drive that is full) without needing the machine to be that way.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { listClaudeProcesses } from "./procs.mjs";
import { driveOf, freeBytes } from "./space.mjs";

export function makeSys(over = {}) {
  const sys = {
    platform: process.platform,
    now: () => Date.now(),
    rename: (from, to) => fs.renameSync(from, to),
    copyFile: (...args) => fs.copyFileSync(...args),
    statfs: typeof fs.statfsSync === "function" ? (p) => fs.statfsSync(p) : null,
    run: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 120000, ...opts }),
    ...over,
  };
  if (!sys.processes) sys.processes = () => listClaudeProcesses({ platform: sys.platform, run: sys.run });
  if (!sys.free) sys.free = (p) => freeBytes(p, { statfs: sys.statfs, run: sys.run, platform: sys.platform });
  if (!sys.drive) sys.drive = (p) => driveOf(p);
  return sys;
}
