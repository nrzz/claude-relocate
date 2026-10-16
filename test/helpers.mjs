// Shared test helpers: throwaway worlds (a home folder, a Claude config folder, shell profiles, a scratch
// registry key), ways to run the CLI, and a snapshot of a whole tree for "everything is as it was" checks.
//
// SAFETY: nothing here reads or writes the real Claude folder, the real shell profiles or the real Windows user
// environment. Importing this file points HOME, USERPROFILE, CLAUDE_CONFIG_DIR, APPDATA, LOCALAPPDATA, the XDG_*
// variables and the registry key of this process at throwaway places, so even a test that forgets to pass its own
// environment cannot reach them. Every child process gets a world's environment, and runCli refuses to run with a
// config folder or home outside the OS temp folder.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { makeSys } from "../src/sys.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-relocate.mjs");
export const IS_WIN = process.platform === "win32";
export const DAY = 86400000;

const made = [];
export function tmpDir(prefix = "cr-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// One scratch registry key per test process, removed at exit (Windows only).
const KEY_ROOT = `HKCU\\Software\\claude-relocate-test\\${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
let keyCount = 0;
export const newKey = () => `${KEY_ROOT}\\w${++keyCount}\\Environment`;

process.on("exit", () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ } }
  if (IS_WIN) { try { spawnSync("reg", ["delete", KEY_ROOT, "/f"], { windowsHide: true }); } catch { /* best effort */ } }
});

// The guard: an empty home, config folder, XDG folders and registry key for this process.
const guard = tmpDir("cr-guard-");
Object.assign(process.env, {
  HOME: guard, USERPROFILE: guard,
  CLAUDE_CONFIG_DIR: path.join(guard, ".claude"),
  APPDATA: path.join(guard, "AppData", "Roaming"), LOCALAPPDATA: path.join(guard, "AppData", "Local"),
  XDG_CONFIG_HOME: path.join(guard, ".config"), XDG_STATE_HOME: path.join(guard, ".local", "state"), XDG_CACHE_HOME: path.join(guard, ".cache"),
  SHELL: "/bin/bash", NO_COLOR: "1",
  CLAUDE_RELOCATE_REG_KEY: newKey(),
});
delete process.env.FORCE_COLOR;
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());

// ---------------------------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------------------------

// A throwaway world. base/home is the home folder; the config folder is base/cfg when the variable is set
// (the default here) and base/home/.claude when it is not; base/dest is a good place to move to.
//   variable   whether CLAUDE_CONFIG_DIR is set (so .claude.json is inside the config folder)
//   shell      $SHELL ("/bin/bash", "/bin/zsh", "/usr/bin/fish" or "" for none)
export function world(name = "w", { variable = true, shell = "/bin/bash", platform } = {}) {
  const base = tmpDir(`cr-${name}-`);
  const home = path.join(base, "home");
  const cfg = variable ? path.join(base, "cfg") : path.join(home, ".claude");
  fs.mkdirSync(home, { recursive: true });
  const regKey = newKey();
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(base, "AppData", "Roaming"), LOCALAPPDATA: path.join(base, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"), XDG_STATE_HOME: path.join(base, "xdg", "state"), XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
    SHELL: shell, NO_COLOR: "1", CLAUDE_RELOCATE_REG_KEY: regKey,
  };
  if (variable) env.CLAUDE_CONFIG_DIR = cfg; else delete env.CLAUDE_CONFIG_DIR;
  if (!shell) delete env.SHELL;
  const w = {
    base, home, cfg, env, regKey, variable,
    claudeJson: variable ? path.join(cfg, ".claude.json") : path.join(home, ".claude.json"),
    dest: path.join(base, "dest"),
    xdg: { config: path.join(base, "xdg", "config", "claude"), state: path.join(base, "xdg", "state", "claude"), cache: path.join(base, "xdg", "cache", "claude") },
    put(file, text = "x", mtimeMs) { return put(path.isAbsolute(file) ? file : path.join(base, file), text, mtimeMs); },
  };
  w.sys = (over = {}) => makeSys({ processes: () => ({ ok: true, processes: [] }), platform: platform || process.platform, ...over });
  return w;
}

export function put(file, text = "x", mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

// The ids of the sessions seeded by seedConfig.
export const SESSION_A = "11111111-aaaa-4aaa-8aaa-111111111111";
export const SESSION_B = "22222222-bbbb-4bbb-8bbb-222222222222";

// A config folder that looks like a used one: settings, a skill, hooks, two projects with sessions of different ages,
// plugins (installed list, marketplaces, cache), file history, caches, history, and a .claude.json. File times are
// fixed and different, so a move that loses them is noticed.
export function seedConfig(w, { claudeJson = true } = {}) {
  const t = Date.parse("2026-09-01T10:00:00Z");
  const c = w.cfg;
  put(path.join(c, "settings.json"), `${JSON.stringify({ cleanupPeriodDays: 30, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: [path.join(c, "tool", "run.mjs"), "go"] }] }] } }, null, 2)}\n`, t);
  put(path.join(c, "CLAUDE.md"), "# my notes\n", t + 1000);
  put(path.join(c, "keybindings.json"), "{}\n", t + 2000);
  put(path.join(c, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody\n", t + 3000);
  put(path.join(c, "agents", "helper.md"), "agent\n", t + 4000);
  put(path.join(c, "commands", "go.md"), "command\n", t + 5000);
  put(path.join(c, "hooks", "pre.sh"), "#!/bin/sh\nexit 0\n", t + 6000);
  put(path.join(c, "statusline.sh"), "#!/bin/sh\necho hi\n", t + 7000);
  put(path.join(c, "tool", "run.mjs"), "console.log(1)\n", t + 8000);
  put(path.join(c, "projects", "-work-shop", `${SESSION_A}.jsonl`), `${'{"type":"user","message":"hello"}\n'.repeat(300)}`, t - 25 * DAY);
  put(path.join(c, "projects", "-work-shop", `${SESSION_B}.jsonl`), `${'{"type":"user","message":"again"}\n'.repeat(50)}`, t - 3 * DAY);
  put(path.join(c, "projects", "-work-shop", SESSION_A, "tool-results", "toolu_01.txt"), "result\n", t - 24 * DAY);
  put(path.join(c, "projects", "-work-blog", "33333333-cccc-4ccc-8ccc-333333333333.jsonl"), '{"type":"user"}\n', t - 10 * DAY);
  put(path.join(c, "plugins", "installed_plugins.json"), `${JSON.stringify({ version: 2, plugins: {} })}\n`, t + 9000);
  put(path.join(c, "plugins", "known_marketplaces.json"), "{}\n", t + 9100);
  put(path.join(c, "plugins", "marketplaces", "m", "README.md"), "market\n", t + 9200);
  put(path.join(c, "plugins", "cache", "m", "p", "1.0.0", "x.txt"), "x".repeat(4000), t + 9300);
  put(path.join(c, "file-history", SESSION_A, "abc@v1"), "snapshot\n".repeat(20), t - 24 * DAY);
  put(path.join(c, "session-env", SESSION_A, "env.sh"), "export A=1\n", t - 24 * DAY);
  put(path.join(c, "todos", `${SESSION_A}-agent-${SESSION_A}.json`), "[]\n", t - 24 * DAY);
  put(path.join(c, "shell-snapshots", "snapshot-bash-1.sh"), "s\n", t - 2 * DAY);
  put(path.join(c, "backups", ".claude.json.backup.1700000000000"), "{}\n", t - 5 * DAY);
  put(path.join(c, "debug", `${SESSION_A}.txt`), "debug\n", t - 24 * DAY);
  put(path.join(c, "statsig", "cache.json"), "{}\n", t + 10000);
  put(path.join(c, "usage-data", "facets", `${SESSION_A}.json`), "{}\n", t + 10100);
  put(path.join(c, "uploads", SESSION_A, "shot.png"), "png", t - 24 * DAY);
  put(path.join(c, "tasks", SESSION_A, "1.json"), "{}\n", t - 24 * DAY);
  put(path.join(c, "history.jsonl"), '{"display":"hi"}\n', t + 11000);
  put(path.join(c, "ide", "1234.lock"), "{}\n", t + 11100);
  if (claudeJson) put(w.claudeJson, `${JSON.stringify({ hasCompletedOnboarding: true, userID: "u", numStartups: 41, projects: {} }, null, 2)}\n`, t + 12000);
  return w;
}

// ---------------------------------------------------------------------------------------------
// Running the tool
// ---------------------------------------------------------------------------------------------

// Runs main() in this process with the world's environment and captures what it prints.
export async function run(args, w, { cwd, sys, env = {} } = {}) {
  let out = "";
  let err = "";
  const code = await main(args, { stdout: { write: (s) => { out += s; }, isTTY: false }, stderr: { write: (s) => { err += s; } }, env: { ...w.env, ...env }, cwd: cwd || w.base, sys: sys || w.sys() });
  return { code, out, err, all: out + err };
}

// The same, parsing the --json output.
export async function runJson(args, w, opts) {
  const r = await run([...args, "--json"], w, opts);
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* the test will show r */ }
  return { ...r, json };
}

// Runs the real CLI in a child process. `env` is the child's whole environment (a world's `env`; a world without
// the variable must not get the guard's back). Refuses unless it points at temporary folders.
export function runCli(args, { cwd, env, input } = {}) {
  const e = { ...(env || process.env) };
  const home = IS_WIN ? e.USERPROFILE || e.HOME : e.HOME;
  const cfg = e.CLAUDE_CONFIG_DIR || path.join(home || "", ".claude");
  if (!underTmp(cfg) || !underTmp(home || "")) throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  if (e.CLAUDE_RELOCATE_REG_KEY === undefined || !/claude-relocate-test/.test(e.CLAUDE_RELOCATE_REG_KEY)) throw new Error("runCli needs the scratch registry key of a world()");
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

// ---------------------------------------------------------------------------------------------
// Looking at trees
// ---------------------------------------------------------------------------------------------

// Every entry below `root`: { "rel/path": { t, size, sha, mtime, target } }. Links are not followed. The root's
// own entry is left out, and so are the times of folders (they change whenever an entry is added or removed).
export function tree(root, { times = true } = {}) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = { t: "l", target: fs.readlinkSync(p) };
      else if (st.isDirectory()) { out[r] = { t: "d" }; walk(p, r); }
      else out[r] = { t: "f", size: st.size, sha: crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"), ...(times ? { mtime: Math.round(st.mtimeMs) } : {}) };
    }
  };
  walk(root, "");
  return out;
}

// A name for a world's whole state: the home folder (profiles and their backups included), the config folder
// wherever it is, and the destination. For "dry-run changes nothing" and "undo puts it all back".
export function everything(w, extra = []) {
  const out = {};
  for (const [label, dir] of [["home", w.home], ["base", w.base], ...extra.map((d, i) => [`extra${i}`, d])]) {
    if (fs.existsSync(dir)) out[label] = tree(dir);
  }
  return out;
}

// The differences between two trees (see `tree`) as readable lines, or [] when they are the same. File times may
// differ by `toleranceMs` (a copy sets them again from a floating-point number of seconds); `ignore` names paths
// (or path prefixes ending in "/") to leave out of both.
export function diffTrees(a, b, { ignore = [], toleranceMs = 2 } = {}) {
  const skip = (p) => ignore.some((i) => (i.endsWith("/") ? p === i.slice(0, -1) || p.startsWith(i) : p === i));
  const out = [];
  for (const k of Object.keys(a)) {
    if (skip(k)) continue;
    const x = a[k];
    const y = b[k];
    if (!y) { out.push(`${k}: missing`); continue; }
    if (x.t !== y.t) { out.push(`${k}: ${x.t} became ${y.t}`); continue; }
    if (x.t === "l" && x.target !== y.target) out.push(`${k}: link ${x.target} became ${y.target}`);
    if (x.t === "f") {
      if (x.sha !== y.sha) out.push(`${k}: content differs`);
      else if (x.mtime !== undefined && y.mtime !== undefined && Math.abs(x.mtime - y.mtime) > toleranceMs) out.push(`${k}: file time ${x.mtime} became ${y.mtime}`);
    }
  }
  for (const k of Object.keys(b)) if (!skip(k) && !a[k]) out.push(`${k}: extra`);
  return out;
}

// Can this machine make a symbolic link to a file? (Windows: only with Developer Mode on, or as an administrator.)
// Tried once, in a temporary folder. Returns the reason to skip, or false.
let fileLinkReason;
export function noFileLinks() {
  if (fileLinkReason !== undefined) return fileLinkReason;
  const dir = tmpDir("cr-flink-");
  try {
    fs.writeFileSync(path.join(dir, "target"), "x");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    fileLinkReason = false;
  } catch (e) {
    fileLinkReason = `file links are not allowed here (${e.code}; on Windows they need Developer Mode or an administrator)`;
  }
  return fileLinkReason;
}

// The environment with `dir` first on PATH, whatever the case of the variable's name (Windows has "Path").
export function prependPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] || ""}` };
}

export const exdev = () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };

// A sys.drive that puts everything below `dir` on a second drive and everything else on the first.
export function secondDriveAt(dir) {
  const lower = (p) => path.resolve(p).toLowerCase();
  const root = lower(dir);
  return (p) => { const q = lower(p); return q === root || q.startsWith(root + path.sep) ? "drive-2" : "drive-1"; };
}

export const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
export const exists = (...p) => fs.existsSync(path.join(...p));
export const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const mtimeOf = (p) => Math.round(fs.statSync(p).mtimeMs);

// ---------------------------------------------------------------------------------------------
// Fake claude: a program named claude on PATH, and a long-running process named claude
// ---------------------------------------------------------------------------------------------

// Writes a `claude` command into a new folder that prints a version and the CLAUDE_CONFIG_DIR it was given.
// Returns the folder (to put on PATH).
export function fakeClaudeOnPath(version = "9.9.9 (Claude Code)") {
  const dir = tmpDir("cr-bin-");
  if (IS_WIN) fs.writeFileSync(path.join(dir, "claude.cmd"), `@echo off\r\necho ${version}\r\necho CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR% 1>&2\r\n`);
  else {
    fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\necho "${version}"\necho "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >&2\n`);
    fs.chmodSync(path.join(dir, "claude"), 0o755);
  }
  return dir;
}

let nodeAsClaude;
// A running process whose image is called claude (a copy of the node program, kept alive for a minute), so that the
// process check can be tried for real. Returns { pid, stop() }.
export function startFakeClaude() {
  if (!nodeAsClaude) {
    const dir = tmpDir("cr-proc-");
    nodeAsClaude = path.join(dir, IS_WIN ? "claude.exe" : "claude");
    fs.copyFileSync(process.execPath, nodeAsClaude);
    fs.chmodSync(nodeAsClaude, 0o755);
  }
  const child = spawn(nodeAsClaude, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  return { pid: child.pid, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

// A second temporary folder on another drive than the OS temp folder, if this machine has one that is writable
// (the repository's drive on Windows, /dev/shm on Linux). Returns a folder or null.
export function otherDriveDir() {
  const dev = (p) => { try { return String(fs.statSync(p, { bigint: true }).dev); } catch { return ""; } };
  const here = dev(os.tmpdir());
  for (const base of [ROOT, "/dev/shm", process.cwd()]) {
    if (!fs.existsSync(base) || dev(base) === here || !dev(base)) continue;
    try {
      const dir = fs.mkdtempSync(path.join(base, ".cr-other-"));
      made.push(fs.realpathSync(dir));
      return fs.realpathSync(dir);
    } catch { /* not writable */ }
  }
  return null;
}
