// The Windows user environment: the CLAUDE_CONFIG_DIR value in HKCU\Environment, which every program started
// after the change (a terminal from the Start menu, Windows Terminal, VS Code, Git Bash) inherits. Written and read
// with reg.exe; no other program is needed.
//
// CLAUDE_RELOCATE_REG_KEY names another registry key to use instead of HKCU\Environment. The tests set it to a
// scratch key under HKCU\Software, so that running them never changes the real environment of the person running
// them. It is not a setting for people.
import { spawnSync } from "node:child_process";

export const NAME = "CLAUDE_CONFIG_DIR";
export const REAL_KEY = "HKCU\\Environment";

export const keyOf = (env = process.env) => (env.CLAUDE_RELOCATE_REG_KEY && env.CLAUDE_RELOCATE_REG_KEY.trim()) || REAL_KEY;
export const isRealKey = (env = process.env) => keyOf(env).toLowerCase() === REAL_KEY.toLowerCase();

const defaultRun = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 30000, ...opts });

// `reg query <key> /v <name>` prints
//
//   HKEY_CURRENT_USER\Environment
//       CLAUDE_CONFIG_DIR    REG_SZ    D:\Claude Data
//
// -> { exists, type, value }.
export function parseRegQuery(text, name = NAME) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_[A-Z_]+)(?:\s{2,}(.*?))?\s*$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return { exists: true, type: m[2], value: m[3] ?? "" };
  }
  return { exists: false, type: null, value: null };
}

// { ok, exists, type, value, error }
export function readUserEnv(env = process.env, run = defaultRun) {
  // reg prints in the console's code page, which turns é or 日本語 into other characters. A console set to UTF-8
  // (chcp 65001) makes it print them as they are.
  const r = run("cmd.exe", ["/d", "/s", "/c", `chcp 65001>nul & reg query "${keyOf(env)}" /v ${NAME}`], { windowsVerbatimArguments: true });
  if (r.error) return { ok: false, exists: false, value: null, error: `reg.exe could not run (${r.error.message})` };
  if (r.status !== 0) {
    // reg exits 1 both for "no such value" and for "no such key"; a value that is not there is not an error
    return { ok: true, exists: false, type: null, value: null, error: null };
  }
  return { ok: true, ...parseRegQuery(r.stdout), error: null };
}

// Sets the value (a string value, REG_SZ, which is not expanded, unless the value being put back had another type).
// { ok, error }
export function writeUserEnv(value, env = process.env, run = defaultRun, type = "REG_SZ") {
  const r = run("reg", ["add", keyOf(env), "/v", NAME, "/t", type, "/d", value, "/f"]);
  if (r.error) return { ok: false, error: `reg.exe could not run (${r.error.message})` };
  if (r.status !== 0) return { ok: false, error: `reg add failed (${(r.stderr || r.stdout || "").trim().slice(0, 160) || `exit ${r.status}`})` };
  broadcast(env, run);
  return { ok: true, error: null };
}

// Removes the value. A value that is not there counts as removed. { ok, error }
export function removeUserEnv(env = process.env, run = defaultRun) {
  const had = readUserEnv(env, run);
  if (!had.ok) return { ok: false, error: had.error };
  if (!had.exists) return { ok: true, error: null, existed: false };
  const r = run("reg", ["delete", keyOf(env), "/v", NAME, "/f"]);
  if (r.error) return { ok: false, error: `reg.exe could not run (${r.error.message})` };
  if (r.status !== 0) return { ok: false, error: `reg delete failed (${(r.stderr || r.stdout || "").trim().slice(0, 160) || `exit ${r.status}`})` };
  broadcast(env, run);
  return { ok: true, error: null, existed: true };
}

// Windows tells running programs about a changed user environment with a broadcast, and `setx` sends one. A plain
// registry write does not, so on versions of Windows where Explorer keeps its own copy until told, a terminal
// started from the Start menu would still see the old value. Writing and deleting a throwaway value with setx
// sends the broadcast. Only for the real key (a test's scratch key is not the environment), and never an error.
// On Windows 11 build 26300 a program started by Explorer saw a plain `reg add` and `reg delete` at once; the
// broadcast is for the other versions, which were not tried.
export function broadcast(env = process.env, run = defaultRun) {
  if (!isRealKey(env)) return false;
  try {
    run("setx", ["CLAUDE_RELOCATE_NOTIFY", "1"]);
    run("reg", ["delete", REAL_KEY, "/v", "CLAUDE_RELOCATE_NOTIFY", "/f"]);
    return true;
  } catch {
    return false;
  }
}
