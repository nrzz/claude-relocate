// Where Claude Code keeps its files, as Claude Code 2.1.295 and 2.1.299 were seen to read and write them on Windows
// and 2.1.301 on Linux and macOS (README, "What was verified"; test/e2e-claude.test.mjs asserts it, and CI runs it
// on Linux and macOS against the newest release every week):
//
//   CLAUDE_CONFIG_DIR set      the config folder is that folder, and .claude.json is inside it:
//                              <CLAUDE_CONFIG_DIR>/.claude.json. ~/.claude.json is not touched. This holds when the
//                              variable names ~/.claude itself.
//   CLAUDE_CONFIG_DIR not set  the config folder is ~/.claude, and .claude.json is NOT inside it but next to it:
//                              ~/.claude.json. ~/.claude/.claude.json is not touched.
//   XDG_CONFIG_HOME and the other two   not read when CLAUDE_CONFIG_DIR is not set, even when
//                              $XDG_CONFIG_HOME/claude exists. That is why `move --xdg` sets CLAUDE_CONFIG_DIR.
//
// The home folder is USERPROFILE on Windows and HOME elsewhere, as for Node's os.homedir().
import os from "node:os";
import path from "node:path";

export function homeDir(env = process.env, platform = process.platform) {
  const fromEnv = platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME;
  return fromEnv || os.homedir();
}

// { dir, source, claudeJson, claudeJsonInside }: the config folder in use and where its .claude.json is.
export function configInUse(env = process.env, { cwd = process.cwd(), platform = process.platform } = {}) {
  const home = homeDir(env, platform);
  const variable = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : "";
  if (variable) {
    const dir = path.resolve(cwd, variable);
    return { dir, source: "CLAUDE_CONFIG_DIR", home, claudeJson: path.join(dir, ".claude.json"), claudeJsonInside: true };
  }
  return { dir: path.join(home, ".claude"), source: "default", home, claudeJson: path.join(home, ".claude.json"), claudeJsonInside: false };
}

const absolute = (v) => (v && path.isAbsolute(v) ? path.resolve(v) : "");

// The three XDG folders for Claude Code: $XDG_CONFIG_HOME/claude, $XDG_STATE_HOME/claude, $XDG_CACHE_HOME/claude.
// A variable that is not an absolute path is ignored, as the XDG specification says.
export function xdgDirs(env = process.env, platform = process.platform) {
  const home = homeDir(env, platform);
  const pick = (name, fallback) => {
    const v = absolute(env[name]);
    return { base: v || path.join(home, ...fallback), fromEnv: !!v };
  };
  const config = pick("XDG_CONFIG_HOME", [".config"]);
  const state = pick("XDG_STATE_HOME", [".local", "state"]);
  const cache = pick("XDG_CACHE_HOME", [".cache"]);
  return {
    config: path.join(config.base, "claude"),
    state: path.join(state.base, "claude"),
    cache: path.join(cache.base, "claude"),
    fromEnv: { config: config.fromEnv, state: state.fromEnv, cache: cache.fromEnv },
  };
}

// The shell the person uses, from $SHELL: "bash", "zsh", "fish" or "" when it is another one (or none).
export function shellInUse(env = process.env) {
  const base = String(env.SHELL || "").replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.exe$/, "");
  return ["bash", "zsh", "fish"].includes(base) ? base : "";
}
