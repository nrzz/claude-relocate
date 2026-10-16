// Checks against the real Claude Code binary, run only when E2E_CLAUDE points at one (see claude-sandbox.mjs).
// The tool moves a config folder; the binary is then started with CLAUDE_CONFIG_DIR at the new place and has to
// behave as it did at the old one:
//   1. `claude --version` runs; a `claude -p` run writes its transcript under <new>/projects; a session written
//      before the move is resumed with its whole history; settings.json is honoured (a SessionStart hook and an env
//      value from it); .claude.json is read from there (its userID comes back as metadata.user_id.device_id);
//      `verify` finds the session list and the version; `undo` gives the old place back, with the sessions
//      written in between.
//   2. --link: a program that ignores the variable still finds everything, through the link at the old place, and a
//      hook that spells the old path keeps working. Without --link that hook stops, as `plan` warns.
//   3. A plugin installed before the move (by the binary itself, from a local marketplace) loads after it.
//   4. The split of --xdg: sessions written and resumed through the linked projects/ folder, a plugin loaded
//      through the linked plugins/cache folder. (Off Windows with symbolic links. On Windows --xdg does not split;
//      the check there runs the same split with junctions, only to see what the binary does with links.)
// Everything runs against a fake API on 127.0.0.1: no token is spent and nothing leaves the machine. The tool runs
// with --ignore-running because the machine running the tests may have a Claude Code of its own open; the config
// folders here are throwaway ones, not the one that process uses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listSessions } from "../src/inventory.mjs";
import { IS_WIN, lexists, noFileLinks, run } from "./helpers.mjs";
import { CLAUDE, RECORD, USER_ID, claudeCommand, claudeInfo, claudeShimDir, deviceIdOf, fakeApi, messagesOf, readLog, recordingHooks, runClaude, sandbox, skip, writeJson } from "./claude-sandbox.mjs";

const ID1 = "5e5510a7-0000-4000-8000-0000000000a1";
const ID2 = "5e5510a7-0000-4000-8000-0000000000a2";
const LINUX = IS_WIN ? "linux" : process.platform;
const TIMEOUT = 600000;

// the first transcript of session `id` below a config folder's projects/, or null
function transcript(configDir, id) {
  const list = listSessions(configDir);
  for (const p of list.projects) {
    const file = path.join(configDir, "projects", p.name, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
// the requests that asked the model something (not a title or a quota probe), in order
const asked = (api, text) => api.requests.filter((r) => r.stream !== false && messagesOf(r).includes(text));
const lastAsked = (api, text) => asked(api, text).at(-1);

// A plugin with a SessionStart hook that records itself, in a marketplace that is a git repository. The binary
// clones it into <config>/plugins/marketplaces and installs the plugin into <config>/plugins/cache, exactly as
// it does for a marketplace on GitHub; git's insteadOf turns the made-up address into this folder, so that
// nothing is fetched from the network.
function marketplaceRepo(sb) {
  const mkt = path.join(sb.base, "mkt");
  const demo = path.join(mkt, "plugins", "demo");
  writeJson(path.join(mkt, ".claude-plugin", "marketplace.json"), { name: "local-test", owner: { name: "test" }, plugins: [{ name: "demo", description: "demo plugin", source: "./plugins/demo" }] });
  writeJson(path.join(demo, ".claude-plugin", "plugin.json"), { name: "demo", version: "1.0.0", description: "demo plugin" });
  writeJson(path.join(demo, "hooks", "hooks.json"), { hooks: recordingHooks(["SessionStart"]) });
  fs.mkdirSync(path.join(demo, "skills", "hello"), { recursive: true });
  fs.writeFileSync(path.join(demo, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: say hello\ndisable-model-invocation: true\n---\nSay hello.\n");
  const gitconfig = path.join(sb.base, "gitconfig");
  fs.writeFileSync(gitconfig, "");
  const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: mkt, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "marketplace");
  const posix = mkt.split(path.sep).join("/");
  fs.writeFileSync(gitconfig, `[url "file://${posix.startsWith("/") ? "" : "/"}${posix}"]\n\tinsteadOf = https://example.test/mkt.git\n`);
  return { url: "https://example.test/mkt.git", env };
}
function installDemoPlugin(sb) {
  const repo = marketplaceRepo(sb);
  const added = claudeCommand(sb, ["plugin", "marketplace", "add", repo.url], { env: repo.env });
  assert.equal(added.code, 0, added.out + added.err);
  const installed = claudeCommand(sb, ["plugin", "install", "demo@local-test"], { env: repo.env });
  assert.equal(installed.code, 0, installed.out + installed.err);
  return repo;
}

test("the real claude runs from the folder the tool moved the config to, and undo gives the old place back", { skip: skip(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("move");
  fs.writeFileSync(path.join(sb.home, ".bashrc"), "alias a=b\n"); // a profile for the move to write into (a world's, not yours)
  writeJson(path.join(sb.cfg, "settings.json"), { env: { RELOCATE_SETTING: "from-settings" }, hooks: recordingHooks(["SessionStart"]) });
  const api = await fakeApi((r, n) => `ANSWER-${n}`);
  try {
    // 1. a real session, written at the old place by the real binary
    const first = await runClaude(sb, api, ["-p", "PROMPT-ONE remember the word kumquat", "--session-id", ID1, "--output-format", "json"]);
    assert.equal(first.code, 0, first.err);
    assert.equal(first.result.session_id, ID1);
    assert.ok(transcript(sb.cfg, ID1), "the transcript is under the old projects/");
    assert.equal(readLog(sb).length, 1, "the SessionStart hook of the old settings.json fired");
    assert.equal(readLog(sb)[0].env.RELOCATE_SETTING, "from-settings");
    const askedOld = lastAsked(api, "PROMPT-ONE");
    assert.equal(deviceIdOf(askedOld), USER_ID, "the old .claude.json is the one the binary read");

    // what the tool sees in a folder the binary wrote
    const plan = JSON.parse(sb.cli(["plan", "--json", "--to", sb.dest]).out);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.kinds.find((k) => k.kind === "sessions").entries, ["projects"]);
    assert.ok(plan.total.files >= 4 && plan.entries.some((e) => e.name === ".claude.json" && e.kind === "claudeJson"));

    // 2. the tool moves it, writing the profile and (on Windows) the user environment of the world
    const moved = sb.cli(["move", "--to", sb.dest, "--yes", "--ignore-running"]);
    assert.equal(moved.code, 0, moved.all);
    assert.ok(!lexists(sb.cfg) && lexists(path.join(sb.dest, "settings.json")));

    // 3. with CLAUDE_CONFIG_DIR at the new place
    const version = claudeCommand(sb, ["--version"], { cfg: sb.dest });
    assert.equal(version.code, 0, version.err);
    assert.match(version.out, /^\d+\.\d+\.\d+/);
    const resumed = await runClaude(sb, api, ["-p", "PROMPT-TWO what was the word?", "--resume", ID1, "--output-format", "json"], { cfg: sb.dest });
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumed.result.session_id, ID1, "the same session continues");
    const sent = messagesOf(lastAsked(api, "PROMPT-TWO"));
    assert.ok(sent.includes("PROMPT-ONE remember the word kumquat") && sent.includes("ANSWER-1"), "the whole history of the session written before the move arrived");
    assert.equal(deviceIdOf(lastAsked(api, "PROMPT-TWO")), USER_ID, ".claude.json was read from the new place");
    const second = await runClaude(sb, api, ["-p", "PROMPT-THREE hi", "--session-id", ID2, "--output-format", "json"], { cfg: sb.dest });
    assert.equal(second.code, 0, second.err);
    assert.ok(transcript(sb.dest, ID2), "a new session's transcript is written under the new projects/");
    assert.ok(!lexists(sb.cfg), "nothing was made at the old place");
    assert.ok(!lexists(path.join(sb.home, ".claude")) && !lexists(path.join(sb.home, ".claude.json")), "and nothing in the home folder");
    const log = readLog(sb);
    assert.deepEqual(log.map((l) => l.env.CLAUDE_CONFIG_DIR), [sb.cfg, sb.dest, sb.dest], "the hook of settings.json fires from the new place, and sees the variable");
    assert.ok(log.every((l) => l.env.RELOCATE_SETTING === "from-settings"), "and the env block of settings.json is applied");

    // 4. verify, with the binary under test as the claude on PATH
    const shim = claudeShimDir();
    const v = sb.cli(["verify", "--json"], { CLAUDE_CONFIG_DIR: sb.dest }, shim);
    const verified = JSON.parse(v.out);
    assert.equal(v.code, 0, v.out + v.err);
    const check = (id) => verified.checks.find((c) => c.id === id);
    assert.equal(check("claude").level, "ok");
    assert.match(check("claude").message, /^claude --version with CLAUDE_CONFIG_DIR=.*: \d+\.\d+\.\d+/);
    assert.equal(check("sessions").level, "ok");
    assert.ok(verified.sessions.sessions >= 2, "the session list holds the carried session and the new one");
    assert.equal(check("profile").level, "ok");
    if (IS_WIN) assert.equal(check("registry").level, "ok");
    assert.equal(check("claude-json").level, "ok");

    // 5. undo: the old place again, with what was written in between
    const undone = sb.cli(["undo", "--yes", "--ignore-running"], { CLAUDE_CONFIG_DIR: sb.dest });
    assert.equal(undone.code, 0, undone.all);
    assert.ok(!lexists(sb.dest) && lexists(path.join(sb.cfg, "settings.json")));
    assert.ok(transcript(sb.cfg, ID1) && transcript(sb.cfg, ID2));
    const again = await runClaude(sb, api, ["-p", "PROMPT-FOUR and again", "--resume", ID2, "--output-format", "json"]);
    assert.equal(again.code, 0, again.err);
    assert.ok(messagesOf(lastAsked(api, "PROMPT-FOUR")).includes("PROMPT-THREE hi"), "the session written at the new place came back with the folder");
    assert.equal(deviceIdOf(lastAsked(api, "PROMPT-FOUR")), USER_ID);
    assert.equal(readLog(sb).at(-1).env.CLAUDE_CONFIG_DIR, sb.cfg);
    assert.ok(!lexists(sb.dest));
  } finally { await api.close(); }
});

test("with --link a program that ignores the variable still finds everything, and a hook that spells the old path keeps working", { skip: skip() || noFileLinks(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("link", { variable: false }); // the default folder: ~/.claude, with .claude.json next to it
  const script = path.join(sb.cfg, "tool", "mark.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'import fs from "node:fs";\nfs.appendFileSync(process.env.RELOCATE_LOG, `${JSON.stringify({ label: "script", configDir: process.env.CLAUDE_CONFIG_DIR || null, from: process.argv[1] })}\\n`);\n');
  writeJson(path.join(sb.cfg, "settings.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] } });
  const api = await fakeApi((r, n) => `ANSWER-${n}`);
  try {
    const first = await runClaude(sb, api, ["-p", "PROMPT-ONE remember the word kumquat", "--session-id", ID1, "--output-format", "json"], { cfg: null });
    assert.equal(first.code, 0, first.err);
    assert.ok(transcript(sb.cfg, ID1), "with the variable unset the binary used ~/.claude");
    assert.equal(deviceIdOf(lastAsked(api, "PROMPT-ONE")), USER_ID, "and ~/.claude.json, next to the folder, is the file it read");
    assert.deepEqual(readLog(sb).map((l) => l.label), ["script"]);

    const plan = JSON.parse(sb.cli(["plan", "--json", "--to", sb.dest]).out);
    assert.equal(plan.references.length, 1, "plan found the hook that spells the old path");
    assert.match(plan.warnings.join(" "), /They stop working after a move unless you use --link or change them\./);

    const moved = sb.cli(["move", "--to", sb.dest, "--yes", "--link", "--no-env", "--ignore-running"]);
    assert.equal(moved.code, 0, moved.all);
    assert.ok(fs.lstatSync(sb.cfg).isSymbolicLink() && fs.lstatSync(sb.claudeJson).isSymbolicLink(), "links at ~/.claude and ~/.claude.json");

    // a program that does not look at the variable: the binary with the default folder
    const resumed = await runClaude(sb, api, ["-p", "PROMPT-TWO what was the word?", "--resume", ID1, "--output-format", "json"], { cfg: null });
    assert.equal(resumed.code, 0, resumed.err);
    assert.ok(messagesOf(lastAsked(api, "PROMPT-TWO")).includes("PROMPT-ONE remember the word kumquat"), "the session is found through the link");
    assert.equal(deviceIdOf(lastAsked(api, "PROMPT-TWO")), USER_ID, ".claude.json is read through the link");
    assert.deepEqual(readLog(sb).map((l) => l.label), ["script", "script"], "the hook at the old path ran through the link");
    const second = await runClaude(sb, api, ["-p", "PROMPT-THREE hi", "--session-id", ID2, "--output-format", "json"], { cfg: null });
    assert.equal(second.code, 0, second.err);
    assert.ok(transcript(sb.dest, ID2), "new sessions land in the new folder, behind the link");
    assert.ok(fs.lstatSync(sb.cfg).isSymbolicLink(), "the link is still a link");

    const undone = sb.cli(["undo", "--yes", "--ignore-running"]);
    assert.equal(undone.code, 0, undone.all);
    assert.ok(!fs.lstatSync(sb.cfg).isSymbolicLink() && !fs.lstatSync(sb.claudeJson).isSymbolicLink() && transcript(sb.cfg, ID2));
  } finally { await api.close(); }
});

test("without --link a hook that spells the old path stops, as plan said it would; the rest keeps working", { skip: skip(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("nolink");
  const script = path.join(sb.cfg, "tool", "mark.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'import fs from "node:fs";\nfs.appendFileSync(process.env.RELOCATE_LOG, `${JSON.stringify({ label: "script" })}\\n`);\n');
  writeJson(path.join(sb.cfg, "settings.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }, { hooks: [{ type: "command", command: process.execPath, args: [RECORD, "elsewhere"] }] }] } });
  const api = await fakeApi();
  try {
    const before = await runClaude(sb, api, ["-p", "PROMPT-ONE", "--output-format", "json"]);
    assert.equal(before.code, 0, before.err);
    assert.deepEqual(readLog(sb).map((l) => l.label).sort(), ["elsewhere", "script"]);
    fs.rmSync(sb.log);
    const plan = JSON.parse(sb.cli(["plan", "--json", "--to", sb.dest]).out);
    assert.equal(plan.references.length, 1);
    assert.equal(sb.cli(["move", "--to", sb.dest, "--yes", "--no-env", "--ignore-running"]).code, 0);
    const after = await runClaude(sb, api, ["-p", "PROMPT-TWO", "--output-format", "json"], { cfg: sb.dest });
    assert.equal(after.code, 0, "a hook that cannot run does not stop the session");
    assert.deepEqual(readLog(sb).map((l) => l.label), ["elsewhere"], "the hook that spelled the old path did not run; the one that did not, did");
  } finally { await api.close(); }
});

test("a plugin installed before the move (by the binary, from a marketplace it cloned) loads from the new place after it", { skip: skip(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("plugin");
  const repo = installDemoPlugin(sb);
  const installedFile = path.join(sb.cfg, "plugins", "installed_plugins.json");
  const installedBefore = fs.readFileSync(installedFile, "utf8");
  assert.ok(JSON.parse(installedBefore).plugins["demo@local-test"][0].installPath.toLowerCase().startsWith(sb.cfg.toLowerCase()), "the binary wrote the absolute path of the cache folder into installed_plugins.json");
  const marketplaces = fs.readFileSync(path.join(sb.cfg, "plugins", "known_marketplaces.json"), "utf8");
  assert.ok(JSON.parse(marketplaces)["local-test"].installLocation.toLowerCase().startsWith(sb.cfg.toLowerCase()), "and the clone of the marketplace");
  const api = await fakeApi();
  try {
    const before = await runClaude(sb, api, ["-p", "PROMPT-ONE", "--output-format", "json"], { env: repo.env });
    assert.equal(before.code, 0, before.err);
    const hookBefore = readLog(sb).find((l) => l.label === "SessionStart");
    assert.ok(hookBefore.env.CLAUDE_PLUGIN_ROOT.toLowerCase().startsWith(sb.cfg.toLowerCase()), "the plugin loads from the config folder's cache");
    fs.rmSync(sb.log);
    const plan = JSON.parse(sb.cli(["plan", "--json", "--to", sb.dest]).out);
    assert.ok(plan.kinds.find((k) => k.kind === "pluginCache").bytes > 0, "plan sizes the plugin cache by itself");
    assert.equal(sb.cli(["move", "--to", sb.dest, "--yes", "--no-env", "--ignore-running"]).code, 0);
    assert.equal(fs.readFileSync(path.join(sb.dest, "plugins", "installed_plugins.json"), "utf8"), installedBefore, "the tool leaves the plugin files as the binary wrote them");
    assert.equal(fs.readFileSync(path.join(sb.dest, "plugins", "known_marketplaces.json"), "utf8"), marketplaces);
    const list = claudeCommand(sb, ["plugin", "list"], { cfg: sb.dest, env: repo.env });
    assert.match(list.out, /demo@local-test[\s\S]*Status: .* enabled/);
    const after = await runClaude(sb, api, ["-p", "PROMPT-TWO", "--output-format", "json"], { cfg: sb.dest, env: repo.env });
    assert.equal(after.code, 0, after.err);
    const hookAfter = readLog(sb).find((l) => l.label === "SessionStart");
    assert.ok(hookAfter, "the plugin's SessionStart hook fired after the move");
    assert.ok(hookAfter.env.CLAUDE_PLUGIN_ROOT.toLowerCase().startsWith(sb.dest.toLowerCase()), `from the new cache folder: ${hookAfter.env.CLAUDE_PLUGIN_ROOT}`);
  } finally { await api.close(); }
});

test("the split of --xdg: sessions are written and resumed through the linked projects/ folder, and a plugin loads through the linked plugins/cache", { skip: skip(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("xdg");
  const repo = installDemoPlugin(sb);
  writeJson(path.join(sb.cfg, "settings.json"), { ...JSON.parse(fs.readFileSync(path.join(sb.cfg, "settings.json"), "utf8")), hooks: recordingHooks(["SessionStart"]) });
  const api = await fakeApi((r, n) => `ANSWER-${n}`);
  const env = repo.env;
  try {
    const first = await runClaude(sb, api, ["-p", "PROMPT-ONE remember the word kumquat", "--session-id", ID1, "--output-format", "json"], { env });
    assert.equal(first.code, 0, first.err);
    fs.rmSync(sb.log);
    // in this process, so that off Windows nothing is faked and on Windows the split can be tried with junctions
    const m = await run(["move", "--xdg", "--yes", "--no-env"], sb, { sys: sb.sys({ platform: LINUX }) });
    assert.equal(m.code, 0, m.all);
    const config = sb.xdg.config;
    for (const part of ["projects", path.join("plugins", "cache")]) assert.ok(fs.lstatSync(path.join(config, part)).isSymbolicLink(), `${part} is a link in the new config folder`);
    assert.ok(lexists(path.join(sb.xdg.state, "projects")) && lexists(path.join(sb.xdg.cache, "plugins", "cache")));

    const resumed = await runClaude(sb, api, ["-p", "PROMPT-TWO what was the word?", "--resume", ID1, "--output-format", "json"], { cfg: config, env });
    assert.equal(resumed.code, 0, resumed.err);
    assert.ok(messagesOf(lastAsked(api, "PROMPT-TWO")).includes("PROMPT-ONE remember the word kumquat"), "the session is resumed through the link");
    const second = await runClaude(sb, api, ["-p", "PROMPT-THREE hi", "--session-id", ID2, "--output-format", "json"], { cfg: config, env });
    assert.equal(second.code, 0, second.err);
    assert.ok(fs.readdirSync(path.join(sb.xdg.state, "projects")).some((p) => fs.existsSync(path.join(sb.xdg.state, "projects", p, `${ID2}.jsonl`))), "a new transcript is written into the state folder");
    const hooks = readLog(sb).filter((l) => l.label === "SessionStart");
    const plugin = hooks.find((l) => l.env.CLAUDE_PLUGIN_ROOT);
    assert.ok(plugin, "the plugin's hook fired");
    assert.ok(fs.existsSync(path.join(plugin.env.CLAUDE_PLUGIN_ROOT, "hooks", "hooks.json")), "from a folder that exists, behind the link");

    const undone = await run(["undo", "--yes"], { ...sb, env: { ...sb.env, CLAUDE_CONFIG_DIR: config } }, { sys: sb.sys({ platform: LINUX }) });
    assert.equal(undone.code, 0, undone.all);
    assert.ok(!lexists(config) && !fs.lstatSync(path.join(sb.cfg, "projects")).isSymbolicLink());
    const again = await runClaude(sb, api, ["-p", "PROMPT-FOUR", "--resume", ID2, "--output-format", "json"], { env });
    assert.equal(again.code, 0, again.err);
    assert.ok(messagesOf(lastAsked(api, "PROMPT-FOUR")).includes("PROMPT-THREE hi"));
  } finally { await api.close(); }
});

test("which .claude.json the binary reads: the one inside CLAUDE_CONFIG_DIR when the variable is set, even to ~/.claude itself; the one next to ~/.claude when it is not", { skip: skip(), timeout: TIMEOUT }, async () => {
  // the premise of the whole tool: a move that sets the variable has to carry .claude.json into the folder
  for (const [setVariable, expected] of [[true, "inside"], [false, "outside"]]) {
    const sb = sandbox("which-json", { variable: false }); // the default folder ~/.claude, with ~/.claude.json next to it
    const decoy = "f".repeat(64);
    fs.writeFileSync(path.join(sb.cfg, ".claude.json"), fs.readFileSync(sb.claudeJson, "utf8").replace(USER_ID, decoy)); // another userID inside
    const api = await fakeApi();
    try {
      const r = await runClaude(sb, api, ["-p", "hello", "--output-format", "json"], { cfg: setVariable ? sb.cfg : null });
      assert.equal(r.code, 0, r.err);
      const id = deviceIdOf(asked(api, "hello")[0]);
      assert.equal(id, expected === "inside" ? decoy : USER_ID, `with the variable ${setVariable ? "set to ~/.claude" : "unset"} the file ${expected} the folder was read`);
    } finally { await api.close(); }
  }
});

test("what the binary does with XDG_CONFIG_HOME, XDG_STATE_HOME and XDG_CACHE_HOME when CLAUDE_CONFIG_DIR is not set (asserted on Windows, reported elsewhere)", { skip: skip(), timeout: TIMEOUT }, async () => {
  const sb = sandbox("xdgvars", { variable: false });
  fs.rmSync(sb.cfg, { recursive: true, force: true }); // no ~/.claude: the case in which Claude Code might look elsewhere
  const xdg = { config: path.join(sb.base, "xdg-config"), state: path.join(sb.base, "xdg-state"), cache: path.join(sb.base, "xdg-cache") };
  writeJson(path.join(xdg.config, "claude", "settings.json"), { env: { RELOCATE_SETTING: "from-xdg-settings" }, hooks: recordingHooks(["SessionStart"]) });
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "hello", "--output-format", "json"], { cfg: null, env: { XDG_CONFIG_HOME: xdg.config, XDG_STATE_HOME: xdg.state, XDG_CACHE_HOME: xdg.cache } });
    assert.equal(r.code, 0, r.err);
    const read = readLog(sb).some((l) => l.env.RELOCATE_SETTING === "from-xdg-settings");
    const result = { platform: process.platform, readXdgConfigSettings: read, wroteHomeDotClaude: lexists(path.join(sb.home, ".claude", "projects")), wroteXdgState: lexists(xdg.state), wroteXdgCache: lexists(xdg.cache) };
    console.log(`note: with CLAUDE_CONFIG_DIR unset and the XDG variables set, ${claudeInfo().version} did: ${JSON.stringify(result)}`);
    if (process.platform === "win32") assert.deepEqual(result, { platform: "win32", readXdgConfigSettings: false, wroteHomeDotClaude: true, wroteXdgState: false, wroteXdgCache: false }, "on Windows the XDG variables are ignored");
  } finally { await api.close(); }
});

test("the binary under test is reported, so that a log says which Claude Code these checks ran against", { skip: skip() }, () => {
  const info = claudeInfo();
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  console.log(`note: the real-binary checks ran against ${info.version} (${CLAUDE}) on ${process.platform}`);
});
