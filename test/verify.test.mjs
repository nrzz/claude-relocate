import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeVersion, findOnPath } from "../src/verify.mjs";
import { applyBlock } from "../src/profiles.mjs";
import { writeUserEnv } from "../src/winenv.mjs";
import { IS_WIN, fakeClaudeOnPath, lexists, put, read, run, runJson, seedConfig, tmpDir, world } from "./helpers.mjs";

const LINUX = IS_WIN ? "linux" : process.platform;
const fresh = (name, opts = {}) => seedConfig(world(name, { shell: "", ...opts }));
const mv = (w, args, over) => runJson(["move", ...args, "--yes"], w, { sys: w.sys(over) });
const atDest = (w, dir = w.dest) => ({ ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: dir } });
const verify = (w, over) => runJson(["verify"], w, { sys: w.sys(over) });
const levels = (r) => Object.fromEntries(r.json.checks.map((c) => [c.id + (c.file ? `:${path.basename(c.file)}` : ""), c.level]));
const check = (r, id) => r.json.checks.find((c) => c.id === id);

test("after a move, verify finds the manifest and checks the folder, .claude.json, the sessions, the environment and the terminal", async () => {
  const w = fresh("vf1");
  await mv(w, ["--to", w.dest]);
  const r = await verify(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.ok, true);
  assert.deepEqual([r.json.schema, r.json.command, r.json.destination, r.json.found.via], [1, "verify", w.dest, "CLAUDE_CONFIG_DIR"]);
  const l = levels(r);
  assert.deepEqual([l.manifest, l.destination, l["claude-json"], l.sessions, l.terminal], ["info", "ok", "ok", "ok", "ok"]);
  assert.match(check(r, "manifest").message, /^Moved by claude-relocate on 2026-\d\d-\d\d: .* is now .* \(one folder\)\. Manifest: .*relocate-manifest\.json\.$/);
  if (IS_WIN) assert.equal(l.registry, "ok");
  assert.deepEqual(r.json.manifest.destination.configDir, w.dest);
});

test("the session list: how many sessions in how many projects, which projects, the newest, and how many the move carried", async () => {
  const w = fresh("vf2");
  await mv(w, ["--to", w.dest]);
  const r = await verify(atDest(w));
  const s = check(r, "sessions");
  assert.equal(s.level, "ok");
  assert.match(s.message, /^3 sessions in 2 projects under .*projects; the move carried 3; newest 2026-08-29\.$/);
  assert.deepEqual(s.lines, ["-work-shop  2 sessions, newest 2026-08-29", "-work-blog  1 session, newest 2026-08-22"]);
  assert.deepEqual(r.json.sessions.projects.map((p) => [p.name, p.sessions]), [["-work-shop", 2], ["-work-blog", 1]]);
  assert.deepEqual([r.json.sessions.sessions, r.json.sessions.exists, r.json.sessions.readable], [3, true, true]);
  const text = await run(["verify"], atDest(w), { sys: w.sys() });
  assert.match(text.out, /^ {2}ok {4}3 sessions in 2 projects under /m);
  assert.match(text.out, /^ {8}-work-shop {2}2 sessions, newest 2026-08-29$/m);
});

test("the session list: no sessions yet is information; sessions gone after the move is a warning; a projects folder that is missing or does not resolve is a failure", async () => {
  const empty = fresh("vf3a");
  fs.rmSync(path.join(empty.cfg, "projects"), { recursive: true });
  await mv(empty, ["--to", empty.dest]);
  const a = await verify(atDest(empty));
  assert.deepEqual([check(a, "sessions").level, a.code], ["info", 0]);
  assert.match(check(a, "sessions").message, /projects does not exist yet; Claude Code creates it with the first session\.$/);

  const w = fresh("vf3b");
  await mv(w, ["--to", w.dest]);
  fs.rmSync(path.join(w.dest, "projects", "-work-shop"), { recursive: true });
  fs.rmSync(path.join(w.dest, "projects", "-work-blog"), { recursive: true });
  const b = await verify(atDest(w));
  assert.deepEqual([check(b, "sessions").level, b.code], ["warn", 0], "a warning does not fail the run");
  assert.match(check(b, "sessions").message, /holds no sessions; the move carried 3 sessions \(Claude Code's cleanup deletes old ones\)\.$/);

  fs.rmSync(path.join(w.dest, "projects"), { recursive: true });
  const c = await verify(atDest(w));
  assert.deepEqual([check(c, "sessions").level, c.code], ["fail", 1]);
  assert.match(check(c, "sessions").message, /projects is missing; the move carried 3 sessions\.$/);

  const gone = tmpDir();
  fs.symlinkSync(gone, path.join(w.dest, "projects"), IS_WIN ? "junction" : "dir");
  fs.rmSync(gone, { recursive: true });
  const d = await verify(atDest(w));
  assert.deepEqual([check(d, "sessions").level, d.code], ["fail", 1]);
  assert.match(check(d, "sessions").message, /projects cannot be read \(a link that does not resolve\)\.$/);
});

test("verify fails when the destination folder or the moved .claude.json is gone", async () => {
  const w = fresh("vf4");
  await mv(w, ["--to", w.dest]);
  fs.rmSync(path.join(w.dest, ".claude.json"));
  const a = await verify(atDest(w));
  assert.deepEqual([check(a, "claude-json").level, a.code], ["fail", 1]);
  assert.match(check(a, "claude-json").message, /\.claude\.json is missing; it was moved there\.$/);
  fs.renameSync(w.dest, `${w.dest}-gone`);
  const b = await verify(atDest(w));
  assert.equal(b.code, 1);
  assert.equal(check(b, "manifest").level, "info", "the manifest went with the folder; nothing says it was ever moved");
  assert.deepEqual([check(b, "destination").level, check(b, "destination").message.endsWith("is not a folder.")], ["fail", true]);
});

test("verify reads the profile blocks the move wrote: right value is ok; no block, a different value, or a second setting is not", async () => {
  const w = fresh("vf5", { shell: "/bin/bash" });
  const bashrc = put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest], over);
  const ok = await verify(atDest(w), over);
  assert.equal(ok.code, 0, ok.all);
  assert.equal(levels(ok)["profile:.bashrc"], "ok");
  assert.match(check(ok, "profile").message, /\.bashrc sets CLAUDE_CONFIG_DIR=/);

  fs.writeFileSync(bashrc, applyBlock("alias a=b\n", "posix", path.join(w.base, "elsewhere")).text);
  const different = await verify(atDest(w), over);
  assert.equal(different.code, 1);
  assert.match(check(different, "profile").message, /\.bashrc sets CLAUDE_CONFIG_DIR=.*elsewhere, not .*dest\.$/);

  fs.writeFileSync(bashrc, "alias a=b\n");
  const none = await verify(atDest(w), over);
  assert.equal(none.code, 1);
  assert.match(check(none, "profile").message, /\.bashrc has no claude-relocate block \(it was added by the move\)\.$/);

  fs.writeFileSync(bashrc, `export CLAUDE_CONFIG_DIR=/somewhere/else\n${applyBlock("", "posix", w.dest).text}`);
  const two = await verify(atDest(w), over);
  assert.equal(two.code, 0, "a warning is not a failure");
  const warn = two.json.checks.find((c) => c.id === "profile-other");
  assert.equal(warn.level, "warn");
  assert.match(warn.message, /\.bashrc line 1 also sets CLAUDE_CONFIG_DIR \(export CLAUDE_CONFIG_DIR=\/somewhere\/else\); the later line wins\.$/);
});

test("verify says when the move wrote CLAUDE_CONFIG_DIR into no profile", async () => {
  const w = fresh("vf6", { shell: "/usr/bin/nu" });
  await mv(w, ["--to", w.dest, "--no-env"], { platform: LINUX });
  const r = await verify(atDest(w), { platform: LINUX });
  assert.equal(r.code, 0, r.all);
  assert.match(check(r, "profile").message, /^The move wrote CLAUDE_CONFIG_DIR into no profile \(--no-env, or no profile for your shell\)\. Set CLAUDE_CONFIG_DIR yourself\.$/);
});

test("verify checks the user environment on Windows: the value must be the destination", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("vf7");
  await mv(w, ["--to", w.dest]);
  assert.equal(levels(await verify(atDest(w))).registry, "ok");
  assert.equal(writeUserEnv(path.join(w.base, "other"), w.env).ok, true);
  const wrong = await verify(atDest(w));
  assert.equal(wrong.code, 1);
  assert.match(check(wrong, "registry").message, /^The Windows user environment sets CLAUDE_CONFIG_DIR=.*other, not .*dest\.$/);
  const { removeUserEnv } = await import("../src/winenv.mjs");
  removeUserEnv(w.env);
  const gone = await verify(atDest(w));
  assert.match(check(gone, "registry").message, /^The Windows user environment has no CLAUDE_CONFIG_DIR \(the move set it\)\.$/);
  const blind = await verify(atDest(w), { run: (cmd, args, o) => (cmd === "cmd.exe" ? { error: new Error("no cmd"), status: null } : w.sys().run(cmd, args, o)) });
  assert.match(check(blind, "registry").message, /^The Windows user environment cannot be read \(reg\.exe could not run \(no cmd\)\)\.$/);
});

test("verify checks the links --link left: they must be links, and must lead to the new folder", async () => {
  const w = fresh("vf8");
  await mv(w, ["--to", w.dest, "--link"]);
  const ok = await verify(w);
  assert.equal(ok.code, 0, ok.all);
  const link = check(ok, "link");
  assert.equal(link.level, "ok");
  assert.match(link.message, /-> .* resolves\.$/);
  fs.rmSync(w.cfg);
  fs.mkdirSync(w.cfg);
  const notALink = await verify(atDest(w));
  assert.equal(notALink.code, 1);
  assert.match(check(notALink, "link").message, /is not a link any more \(it should point to /);
  fs.rmdirSync(w.cfg);
  const other = tmpDir();
  fs.symlinkSync(other, w.cfg, IS_WIN ? "junction" : "dir");
  const wrong = await verify(atDest(w));
  assert.equal(wrong.code, 1);
  assert.match(check(wrong, "link").message, /does not resolve to /);
});

test("verify runs claude --version with CLAUDE_CONFIG_DIR at the destination, using the first claude on PATH", async () => {
  const w = fresh("vf9");
  await mv(w, ["--to", w.dest]);
  const bin = fakeClaudeOnPath("9.9.9 (Claude Code)");
  const env = { ...atDest(w).env, PATH: `${bin}${path.delimiter}${w.env.PATH}` };
  const seen = [];
  const real = w.sys();
  const sys = { run: (cmd, args, opts) => { if (/claude/i.test(cmd)) seen.push({ cmd, args, env: opts && opts.env }); return real.run(cmd, args, opts); } };
  const r = await runJson(["verify"], { ...w, env }, { sys: w.sys(sys) });
  assert.equal(r.code, 0, r.all);
  assert.equal(check(r, "claude").level, "ok");
  assert.match(check(r, "claude").message, /^claude --version with CLAUDE_CONFIG_DIR=.*dest: 9\.9\.9 \(Claude Code\) \(.*claude(\.cmd)?\)\.$/i);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.CLAUDE_CONFIG_DIR, w.dest);
  assert.equal(seen[0].env.DISABLE_AUTOUPDATER, "1");
});

test("verify says when claude is not on PATH, and fails when claude --version does", async () => {
  const w = fresh("vf10");
  await mv(w, ["--to", w.dest]);
  const none = { ...atDest(w).env, PATH: tmpDir() };
  const a = await runJson(["verify"], { ...w, env: none }, { sys: w.sys() });
  assert.deepEqual([check(a, "claude").level, a.code], ["skip", 0]);
  assert.equal(check(a, "claude").message, "claude is not on PATH, so `claude --version` was not run.");
  const bin = tmpDir();
  if (IS_WIN) fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\necho boom 1>&2\r\nexit /b 3\r\n");
  else { fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho boom >&2\nexit 3\n"); fs.chmodSync(path.join(bin, "claude"), 0o755); }
  const failing = { ...atDest(w).env, PATH: `${bin}${path.delimiter}${w.env.PATH}` };
  const b = await runJson(["verify"], { ...w, env: failing }, { sys: w.sys() });
  assert.deepEqual([check(b, "claude").level, b.code], ["fail", 1]);
  assert.match(check(b, "claude").message, /^claude --version failed \(boom\) \(.*claude(\.cmd)?\)\.$/i);
});

test("findOnPath: the first match on PATH; a directory is not a program; on Windows the extensions of PATHEXT are tried in order", () => {
  const a = tmpDir();
  const b = tmpDir();
  fs.mkdirSync(path.join(a, "claude"));
  assert.equal(findOnPath("claude", { PATH: `${a}${path.delimiter}${b}` }, process.platform), null, "a folder called claude is not claude");
  if (IS_WIN) {
    fs.writeFileSync(path.join(b, "claude.cmd"), "");
    fs.writeFileSync(path.join(a, "claude.EXE"), "");
    assert.equal(findOnPath("claude", { PATH: `${a}${path.delimiter}${b}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32").toLowerCase(), path.join(a, "claude.exe").toLowerCase());
    assert.equal(findOnPath("claude", { Path: b, PathExt: ".CMD" }, "win32").toLowerCase(), path.join(b, "claude.cmd").toLowerCase(), "the variable names may have any case");
    assert.equal(findOnPath("claude", { PATH: b, PATHEXT: ".EXE" }, "win32"), null);
  } else {
    fs.writeFileSync(path.join(b, "claude"), "#!/bin/sh\n");
    assert.equal(findOnPath("claude", { PATH: `${a}${path.delimiter}${b}` }, process.platform), null, "not executable");
    fs.chmodSync(path.join(b, "claude"), 0o755);
    assert.equal(findOnPath("claude", { PATH: `${a}${path.delimiter}${b}` }, process.platform), path.join(b, "claude"));
  }
  assert.equal(findOnPath("claude", {}, process.platform), null);
});

test("claudeVersion reports a program that cannot be started, and reads only the first line", () => {
  const w = fresh("vf11");
  const bin = tmpDir();
  const file = path.join(bin, IS_WIN ? "claude.exe" : "claude");
  fs.writeFileSync(file, "");
  if (!IS_WIN) fs.chmodSync(file, 0o755);
  const env = { ...w.env, PATH: bin };
  const sys = w.sys({ run: () => ({ error: new Error("spawn EACCES"), status: null }) });
  const bad = claudeVersion(env, w.dest, sys);
  assert.deepEqual([bad.ok, bad.found], [false, true]);
  assert.match(bad.error, /^claude --version failed \(spawn EACCES\)$/);
  const good = claudeVersion(env, w.dest, w.sys({ run: () => ({ status: 0, stdout: "2.1.295 (Claude Code)\nsecond line\n" }) }));
  assert.deepEqual([good.ok, good.output], [true, "2.1.295 (Claude Code)"]);
});

test("verify with no manifest checks the config folder Claude Code uses now, and says so", async () => {
  const w = fresh("vf12");
  const r = await verify(w);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.manifest, null);
  assert.equal(r.json.found, null);
  assert.match(check(r, "manifest").message, /^No relocate-manifest\.json found \(looked at .*\), so this checks the config folder Claude Code uses now: .* \(from CLAUDE_CONFIG_DIR\)\.$/);
  assert.equal(check(r, "destination").level, "ok");
  const none = fresh("vf12b");
  fs.rmSync(none.cfg, { recursive: true });
  const bad = await verify(none);
  assert.deepEqual([bad.code, check(bad, "destination").level], [1, "fail"]);
});

test("verify text ends with whether every check passed, and says terminals opened before the move keep the old environment", async () => {
  const w = fresh("vf13");
  await mv(w, ["--to", w.dest]);
  const ok = await run(["verify"], atDest(w), { sys: w.sys() });
  assert.match(ok.out, /^claude-relocate 1\.0\.0 {2}verify$/m);
  assert.match(ok.out, /^Every check passed\.$/m);
  assert.match(ok.out, /Terminals that were open before the move keep the old environment\.$/m);
  fs.rmSync(path.join(w.dest, ".claude.json"));
  const bad = await run(["verify"], atDest(w), { sys: w.sys() });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^ {2}FAIL {2}/m);
  assert.match(bad.out, /^✗ 1 check failed\.$/m);
});

test("the terminal check: ok when this terminal already names the destination, information when it does not", async () => {
  // a profile block (and on Windows the user environment) lets verify find the manifest from a terminal that still names the old place
  const w = fresh("vf14", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest], over);
  const old = await verify(w, over);
  assert.equal(old.json.found.via, `the block in ${path.join(w.home, ".bashrc")}`);
  assert.equal(check(old, "terminal").level, "info");
  assert.match(check(old, "terminal").message, /^This terminal has CLAUDE_CONFIG_DIR=.*cfg: it started before the move, or the variable is set some other way\.$/);
  const unset = { ...w, env: { ...w.env } };
  delete unset.env.CLAUDE_CONFIG_DIR;
  const none = await verify(unset, over);
  assert.match(check(none, "terminal").message, /^This terminal does not have CLAUDE_CONFIG_DIR set: /);
  assert.equal(check(await verify(atDest(w), over), "terminal").level, "ok");
});

test("verify after --xdg off Windows checks every link of the split", async () => {
  const w = fresh("vf15", { platform: LINUX });
  const over = { platform: LINUX };
  await mv(w, ["--xdg"], over);
  const r = await verify(atDest(w, w.xdg.config), over);
  assert.equal(r.code, 0, r.all);
  const links = r.json.checks.filter((c) => c.id === "link");
  assert.equal(links.length, 12);
  assert.ok(links.every((c) => c.level === "ok"));
  assert.match(check(r, "manifest").message, /\(split into config, state and cache folders\)/);
  assert.equal(check(r, "sessions").level, "ok", "the sessions are listed through the link");
  fs.rmSync(path.join(w.xdg.state, "todos"), { recursive: true });
  const broken = await verify(atDest(w, w.xdg.config), over);
  assert.equal(broken.code, 1);
  assert.ok(broken.json.checks.some((c) => c.id === "link" && c.level === "fail" && /todos does not resolve to /.test(c.message)));
});

test("verify changes nothing", async () => {
  const w = fresh("vf16", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest, "--link"], over);
  const { everything } = await import("./helpers.mjs");
  const before = everything(w);
  await verify(atDest(w), over);
  await verify(w, over);
  assert.deepEqual(everything(w), before);
  assert.ok(lexists(path.join(w.dest, "relocate-manifest.json")));
  assert.equal(read(w.home, ".bashrc").includes("claude-relocate start"), true);
});

test("verify warns when something has made the old place again: a program that ignores CLAUDE_CONFIG_DIR is writing there", async () => {
  const w = fresh("vf17", { variable: false });
  await mv(w, ["--to", w.dest]);
  const quiet = await verify(atDest(w));
  assert.equal(quiet.json.checks.some((c) => c.id === "old-place"), false, "nothing at the old place: nothing to say");
  fs.mkdirSync(w.cfg);
  assert.equal((await verify(atDest(w))).json.checks.some((c) => c.id === "old-place"), false, "an empty folder is not a sign of anything");
  put(path.join(w.cfg, "projects", "-p", "a.jsonl"), "{}\n");
  put(path.join(w.cfg, "settings.json"), "{}\n");
  put(w.claudeJson, '{"fresh":true}');
  const r = await verify(atDest(w));
  assert.equal(r.code, 0, "a warning does not fail verify");
  const c = check(r, "old-place");
  assert.equal(c.level, "warn");
  assert.match(c.message, /exists again and holds 2 items, and .*\.claude\.json was made again next to it; Claude Code now uses .*dest\. A program that ignores CLAUDE_CONFIG_DIR may be writing there/);
  assert.match(c.message, /undo refuses while they are there; move --link makes such programs use the new folder\.$/);
});

test("with --link the old place is a link, and verify has nothing to say about it", async () => {
  const w = fresh("vf18", { variable: false });
  await mv(w, ["--to", w.dest, "--link"]);
  const r = await verify(atDest(w));
  assert.equal(r.json.checks.some((c) => c.id === "old-place"), false);
});

test("verify says what a leftover old place is when the manifest knows: files the move could not remove, or a folder it kept because it changed (not a program writing there)", async () => {
  const w = fresh("vf19", { variable: false });
  await mv(w, ["--to", w.dest]);
  put(path.join(w.cfg, "projects", "-p", "a.jsonl"), "{}\n");
  const file = path.join(w.dest, "relocate-manifest.json");
  const original = read(file);
  const cases = [
    [{ leftBehind: 1 }, /still holds 1 item \(the move could not remove 1 item of it\); Claude Code now uses .*dest\. Delete what is left by hand once you do not need it; undo refuses while it is there\.$/],
    [{ originalKept: true }, /still holds 1 item \(the move kept it because it changed after the copy was checked\); Claude Code now uses .*dest\. Copy what you need from it into the new folder, then delete it; undo refuses while it is there\.$/],
  ];
  for (const [fields, expected] of cases) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...fields }, null, 2));
    const c = check(await verify(atDest(w)), "old-place");
    assert.equal(c.level, "warn");
    assert.match(c.message, expected);
  }
  // a ~/.claude.json the move could not remove
  put(w.claudeJson, '{"left":true}');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), jsonLeft: true }, null, 2));
  assert.match(check(await verify(atDest(w)), "old-place").message, /is still there: the move could not remove it; Claude Code now uses .*dest\. Delete what is left by hand once you do not need it; undo refuses while they are there\.$/);
  fs.rmSync(w.claudeJson);
  fs.writeFileSync(file, original);
  assert.match(check(await verify(atDest(w)), "old-place").message, /exists again and holds 1 item; Claude Code now uses .*A program that ignores CLAUDE_CONFIG_DIR may be writing there/, "without that knowledge it is the old message");
});
