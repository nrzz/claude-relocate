import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homeDir, configInUse, shellInUse, xdgDirs } from "../src/env.mjs";
import { tmpDir } from "./helpers.mjs";

const abs = (...p) => path.resolve(path.sep, ...p);

test("the home folder is USERPROFILE on Windows and HOME elsewhere", () => {
  assert.equal(homeDir({ USERPROFILE: "C:\\Users\\me", HOME: "/h" }, "win32"), "C:\\Users\\me");
  assert.equal(homeDir({ HOME: "/h" }, "win32"), "/h");
  assert.equal(homeDir({ USERPROFILE: "C:\\Users\\me", HOME: "/home/me" }, "linux"), "/home/me");
  assert.equal(homeDir({ USERPROFILE: "x", HOME: "/h" }, "darwin"), "/h");
});

test("with CLAUDE_CONFIG_DIR set, the config folder is that folder and .claude.json is inside it", () => {
  const home = tmpDir();
  const cfg = path.join(home, "my config");
  const r = configInUse({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg }, { cwd: home });
  assert.equal(r.dir, cfg);
  assert.equal(r.source, "CLAUDE_CONFIG_DIR");
  assert.equal(r.claudeJson, path.join(cfg, ".claude.json"));
  assert.equal(r.claudeJsonInside, true);
});

test("without it, the config folder is ~/.claude and .claude.json sits next to the folder, not inside it", () => {
  const home = tmpDir();
  const r = configInUse({ HOME: home, USERPROFILE: home }, { cwd: home });
  assert.equal(r.dir, path.join(home, ".claude"));
  assert.equal(r.source, "default");
  assert.equal(r.claudeJson, path.join(home, ".claude.json"));
  assert.equal(r.claudeJsonInside, false);
});

test("an empty or blank CLAUDE_CONFIG_DIR counts as not set", () => {
  const home = tmpDir();
  for (const v of ["", "   "]) {
    const r = configInUse({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: v }, { cwd: home });
    assert.equal(r.source, "default", JSON.stringify(v));
  }
});

test("a relative CLAUDE_CONFIG_DIR is resolved against the working folder", () => {
  const home = tmpDir();
  const r = configInUse({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "rel/cfg" }, { cwd: home });
  assert.equal(r.dir, path.join(home, "rel", "cfg"));
});

test("CLAUDE_CONFIG_DIR naming ~/.claude itself still means .claude.json inside it (seen with the real binary)", () => {
  const home = tmpDir();
  const r = configInUse({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") }, { cwd: home });
  assert.equal(r.claudeJsonInside, true);
  assert.equal(r.claudeJson, path.join(home, ".claude", ".claude.json"));
});

test("XDG folders: the variables when they are absolute, the defaults otherwise, always with claude added", () => {
  const home = abs("home", "me");
  const d = xdgDirs({ HOME: home, USERPROFILE: home }, "linux");
  assert.equal(d.config, path.join(home, ".config", "claude"));
  assert.equal(d.state, path.join(home, ".local", "state", "claude"));
  assert.equal(d.cache, path.join(home, ".cache", "claude"));
  assert.deepEqual(d.fromEnv, { config: false, state: false, cache: false });
  const set = xdgDirs({ HOME: home, XDG_CONFIG_HOME: abs("x", "c"), XDG_STATE_HOME: abs("x", "s"), XDG_CACHE_HOME: abs("x", "k") }, "linux");
  assert.equal(set.config, path.join(abs("x", "c"), "claude"));
  assert.equal(set.state, path.join(abs("x", "s"), "claude"));
  assert.equal(set.cache, path.join(abs("x", "k"), "claude"));
  assert.deepEqual(set.fromEnv, { config: true, state: true, cache: true });
});

test("a relative XDG variable is ignored, as the XDG specification says", () => {
  const home = abs("home", "me");
  const d = xdgDirs({ HOME: home, XDG_CONFIG_HOME: "relative/path", XDG_STATE_HOME: "", XDG_CACHE_HOME: "." }, "linux");
  assert.equal(d.config, path.join(home, ".config", "claude"));
  assert.equal(d.state, path.join(home, ".local", "state", "claude"));
  assert.equal(d.cache, path.join(home, ".cache", "claude"));
});

test("shellInUse reads the last part of $SHELL and knows bash, zsh and fish", () => {
  assert.equal(shellInUse({ SHELL: "/bin/bash" }), "bash");
  assert.equal(shellInUse({ SHELL: "/usr/bin/zsh" }), "zsh");
  assert.equal(shellInUse({ SHELL: "/opt/homebrew/bin/fish" }), "fish");
  assert.equal(shellInUse({ SHELL: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" }), "bash");
  assert.equal(shellInUse({ SHELL: "/bin/sh" }), "");
  assert.equal(shellInUse({ SHELL: "/usr/bin/nu" }), "");
  assert.equal(shellInUse({}), "");
});
