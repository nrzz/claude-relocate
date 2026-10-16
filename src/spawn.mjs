// Starting programs. The few programs that ship with Windows (chcp, cmd, reg, tasklist, setx, powershell) are started by their
// full path under %SystemRoot%: a bare name is looked for in the working folder first (unless the environment says
// otherwise), and the folder a person is standing in can hold anything, such as a reg.exe that came with a download.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS = {
  chcp: ["System32", "chcp.com"],
  cmd: ["System32", "cmd.exe"],
  reg: ["System32", "reg.exe"],
  tasklist: ["System32", "tasklist.exe"],
  setx: ["System32", "setx.exe"],
  powershell: ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
};

// The program to start for `cmd`: its full path for the six above on Windows (named with or without .exe or .com, in
// any case), else `cmd` as it is. (cmd.exe itself looks in the working folder first for what it is asked to run, so a
// command line given to it names its programs by this path too.)
export function programPath(cmd, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const parts = platform === "win32" ? WINDOWS[String(cmd).toLowerCase().replace(/\.(exe|com)$/, "")] : undefined;
  if (!parts) return cmd;
  const root = env.SystemRoot || env.windir || `C:${String.fromCharCode(92)}Windows`;
  const full = path.win32.join(root, ...parts);
  return exists(full) ? full : cmd;
}

// spawnSync, with programPath.
export function spawn(cmd, args, options) {
  return spawnSync(programPath(cmd), args, options);
}
