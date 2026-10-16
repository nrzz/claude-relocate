// Free space and drives: how much room there is where a folder will go, and whether two folders are on the
// same drive (so a rename is enough and nothing needs copying).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nearestExisting } from "./util.mjs";

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });

// `df -Pk <path>` -> free bytes (the 4th column of the last line, in KB), or null.
export function parseDf(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cells = lines[lines.length - 1].trim().split(/\s+/);
  const kb = Number(cells[3]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

// Free bytes where `p` is (or would be created): the nearest folder that exists, asked with statfs, or with df
// (Linux, macOS) or PowerShell (Windows) on a Node that has no fs.statfsSync (before 18.15). null when unknown.
export function freeBytes(p, { statfs = fs.statfsSync, run = defaultRun, platform = process.platform } = {}) {
  const at = nearestExisting(p);
  try {
    if (typeof statfs === "function") {
      const s = statfs(at);
      return Number(s.bavail) * Number(s.bsize);
    }
    if (platform === "win32") {
      const root = path.parse(path.resolve(at)).root;
      if (!/^[A-Za-z]:\\$/.test(root)) return null;
      const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `([System.IO.DriveInfo]'${root[0]}').AvailableFreeSpace`]);
      const n = Number(String(r.stdout || "").trim());
      return r.status === 0 && Number.isFinite(n) ? n : null;
    }
    const r = run("df", ["-Pk", at]);
    return r.status === 0 ? parseDf(r.stdout) : null;
  } catch {
    return null;
  }
}

// An identifier of the drive `p` is on (or would be on), or "" when unknown. Two folders with the same
// identifier are on one drive, where a rename moves a folder without copying it.
export function driveOf(p) {
  try {
    return String(fs.statSync(nearestExisting(p), { bigint: true }).dev);
  } catch {
    return "";
  }
}
