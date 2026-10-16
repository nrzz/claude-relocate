// Is a claude process running? Moving the folder under a running Claude Code (or the Claude desktop app, whose
// Code sessions use the same folder) can corrupt the session it is writing, so `move` and `undo` refuse, and
// `plan` warns.
//
// Windows: `tasklist /FO CSV /NH`, looking for the image name claude.exe. The desktop app and the Claude Code
// binary both have that name. A Claude Code started as `node cli.js` (an old npm install) shows as node.exe and
// is not found.
// Linux and macOS: `ps -A -o pid=,comm=` for a process called claude, and `ps -A -o pid=,args=` for a node
// process running @anthropic-ai/claude-code/....
import { spawn } from "./spawn.mjs";

export const isClaudeName = (name) => /^claude(\.exe)?$/i.test(String(name).trim());

// One line of CSV: "claude.exe","12640","Console","1","3,32,976 K"
function csvCells(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { cells.push(cur); cur = ""; } else cur += c;
  }
  cells.push(cur);
  return cells;
}

// tasklist output -> [{ pid, name }]. Lines that are not CSV rows (the "INFO: No tasks" sentence, in whatever
// language) are skipped.
export function parseTasklist(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('"')) continue;
    const cells = csvCells(line);
    const pid = Number(cells[1]);
    if (cells[0] && Number.isInteger(pid) && pid >= 0) out.push({ pid, name: cells[0] });
  }
  return out;
}

// `ps -A -o pid=,comm=` -> [{ pid, name }] with the last part of the command path as the name.
export function parsePsComm(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), name: m[2].replace(/\\/g, "/").split("/").pop() });
  }
  return out;
}

// `ps -A -o pid=,args=` -> [{ pid, args }]
export function parsePsArgs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

const NODE_CLAUDE = /[\\/]@anthropic-ai[\\/]claude-code[\\/]/;

const defaultRun = (cmd, args) => spawn(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });

// { ok: true, processes: [{ pid, name }] } or { ok: false, error }. `run(cmd, args)` returns what spawnSync does.
export function listClaudeProcesses({ platform = process.platform, run = defaultRun, self = process.pid } = {}) {
  try {
    if (platform === "win32") {
      const r = run("tasklist", ["/FO", "CSV", "/NH"]);
      if (r.error || r.status !== 0) return { ok: false, error: `tasklist failed (${(r.error && r.error.message) || (r.stderr || "").trim().slice(0, 120) || `exit ${r.status}`})` };
      const processes = parseTasklist(r.stdout).filter((p) => isClaudeName(p.name) && p.pid !== self);
      return { ok: true, processes: processes.sort((a, b) => a.pid - b.pid) };
    }
    const comm = run("ps", ["-A", "-o", "pid=,comm="]);
    if (comm.error || comm.status !== 0) return { ok: false, error: `ps failed (${(comm.error && comm.error.message) || (comm.stderr || "").trim().slice(0, 120) || `exit ${comm.status}`})` };
    const found = new Map();
    for (const p of parsePsComm(comm.stdout)) if (isClaudeName(p.name) && p.pid !== self) found.set(p.pid, { pid: p.pid, name: p.name });
    const args = run("ps", ["-A", "-o", "pid=,args="]);
    if (!args.error && args.status === 0) {
      for (const p of parsePsArgs(args.stdout)) if (NODE_CLAUDE.test(p.args) && p.pid !== self && !found.has(p.pid)) found.set(p.pid, { pid: p.pid, name: "node (Claude Code)" });
    }
    return { ok: true, processes: [...found.values()].sort((a, b) => a.pid - b.pid) };
  } catch (e) {
    return { ok: false, error: `could not list processes (${e && e.message ? e.message : e})` };
  }
}
