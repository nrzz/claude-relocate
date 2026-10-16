import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findManifest } from "../src/undo.mjs";
import { readManifest } from "../src/manifest.mjs";
import { blockValue } from "../src/profiles.mjs";
import { readUserEnv, writeUserEnv } from "../src/winenv.mjs";
import { IS_WIN, diffTrees, everything, exdev, lexists, noFileLinks, put, read, run, runJson, seedConfig, secondDriveAt, tmpDir, tree, world } from "./helpers.mjs";

const LINUX = IS_WIN ? "linux" : process.platform;
const MANIFEST = "relocate-manifest.json";
const fresh = (name, opts = {}) => seedConfig(world(name, { shell: "", ...opts }));
const mv = (w, args, over) => runJson(["move", ...args, "--yes"], w, { sys: w.sys(over) });
const undo = (w, args = ["--yes"], over) => run(["undo", ...args], w, { sys: w.sys(over) });
const undoJson = (w, args = ["--yes"], over) => runJson(["undo", ...args], w, { sys: w.sys(over) });
// a terminal opened after the move: the variable names the new place
const atDest = (w, dir = w.dest) => ({ ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: dir } });
// the backups the profile edits leave next to a profile stay (a person may want them), so they are not part of "the same tree"
const withoutBackups = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !/\.bak-claude-relocate-/.test(k)));
const sameWorld = (a, b, ignore = []) => { const out = []; for (const k of Object.keys(a)) out.push(...diffTrees(withoutBackups(a[k]), withoutBackups(b[k] || {}), { ignore }).map((d) => `${k}/${d}`)); return out; };
const userEnv = (w) => readUserEnv(w.env);

test("undo after a rename puts the folder back exactly: every file, content and file time, and nothing else", async () => {
  const w = fresh("un1");
  const before = everything(w);
  assert.equal((await mv(w, ["--to", w.dest])).code, 0);
  assert.ok(!lexists(w.cfg));
  const r = await undoJson(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.deepEqual([r.json.ok, r.json.command, r.json.method, r.json.incomplete], [true, "undo", "rename", false]);
  assert.deepEqual(sameWorld(before, everything(w)), []);
  assert.ok(!lexists(w.dest), "the new place is gone, as it was not there before");
  if (IS_WIN) assert.equal(userEnv(w).exists, false, "the user environment is as it was");
});

test("undo prints what it did and what to do next", async () => {
  const w = fresh("un2");
  await mv(w, ["--to", w.dest, "--no-env"]);
  const r = await undo(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^claude-relocate 1\.0\.0 {2}undo$/m);
  assert.match(r.out, /^ {2}renamed .* to .*$/m);
  assert.match(r.out, /^Undone\. .* is back at .*$/m);
  assert.match(r.out, /^ {2}renamed, not copied: both are on the same drive$/m);
  assert.match(r.out, /Open a new terminal\. If this terminal has CLAUDE_CONFIG_DIR set, it still points at the old place: unset it here too\./);
  assert.equal(r.err, "");
});

test("undo changes what was added after the move too: a session written in the new place comes back with the rest", async () => {
  const w = fresh("un3");
  await mv(w, ["--to", w.dest]);
  put(path.join(w.dest, "projects", "-work-new", "99999999-eeee-4eee-8eee-999999999999.jsonl"), '{"type":"user"}\n');
  put(path.join(w.dest, "settings.json"), '{"changed":true}\n');
  assert.equal((await undoJson(atDest(w))).code, 0);
  assert.ok(lexists(path.join(w.cfg, "projects", "-work-new", "99999999-eeee-4eee-8eee-999999999999.jsonl")));
  assert.equal(read(w.cfg, "settings.json"), '{"changed":true}\n');
});

test("undo after a copy to another drive copies the folder back, checks it, and removes the copy", async () => {
  const w = fresh("un4");
  const before = everything(w);
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  const m = await mv(w, ["--to", w.dest], over);
  assert.equal(m.json.method, "copy");
  const r = await undoJson(atDest(w), ["--yes"], over);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.method, "copy");
  assert.deepEqual(sameWorld(before, everything(w)), []);
  assert.ok(!lexists(w.dest));
});

test("undo with the variable not set: .claude.json goes back next to the folder, and the folder's own old one gets its name back", async () => {
  const w = fresh("un5", { variable: false });
  put(path.join(w.cfg, ".claude.json"), '{"old":true}', Date.parse("2026-01-01T00:00:00Z"));
  const before = everything(w);
  assert.equal((await mv(w, ["--to", w.dest])).code, 0);
  assert.ok(!lexists(w.claudeJson));
  const r = await undoJson(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(sameWorld(before, everything(w)), []);
  assert.equal(read(w.cfg, ".claude.json"), '{"old":true}');
});

test("undo of a move with --link removes the links first, then puts the folder and the file back", async () => {
  const w = fresh("un6", { variable: false });
  const before = everything(w);
  const m = await mv(w, ["--to", w.dest, "--link"]);
  assert.equal(m.code, m.json.incomplete ? 1 : 0, m.all);
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink());
  // the variable names the old place, which is now a link: the manifest is found through it
  const r = await undoJson(w);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.found.via, "the default folder", "the old place is the default one, and it leads to the manifest");
  assert.ok(!fs.lstatSync(w.cfg).isSymbolicLink(), "a real folder again");
  assert.deepEqual(sameWorld(before, everything(w)), []);
});

test("undo of a move with --link, the variable set: the junction or link at the old place goes, the folder returns", async () => {
  const w = fresh("un7");
  const before = everything(w);
  assert.equal((await mv(w, ["--to", w.dest, "--link"])).code, 0);
  const r = await undoJson(w);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(sameWorld(before, everything(w)), []);
  assert.ok(!lexists(w.dest));
});

test("undo with a ~/.claude.json that was linked puts the real file back, not the link", { skip: noFileLinks() }, async () => {
  const w = fresh("un8", { variable: false });
  const live = read(w.claudeJson);
  assert.equal((await mv(w, ["--to", w.dest, "--link"])).code, 0);
  assert.ok(fs.lstatSync(w.claudeJson).isSymbolicLink());
  assert.equal((await undoJson(w)).code, 0);
  assert.ok(fs.lstatSync(w.claudeJson).isFile() && !fs.lstatSync(w.claudeJson).isSymbolicLink());
  assert.equal(read(w.claudeJson), live);
});

test("undo takes the block out of every profile, byte for byte, deletes the profile and folders the move created, and keeps backups", async () => {
  const w = fresh("un9", { shell: "/usr/bin/fish" });
  const crlf = put(path.join(w.home, ".profile"), "# login\r\numask 022\r\n");
  const noEol = put(path.join(w.home, ".zshrc"), "alias z=y");
  const bashrc = put(path.join(w.home, ".bashrc"), "alias a=b\nexport PATH=$PATH:/x\n");
  const originals = Object.fromEntries([crlf, noEol, bashrc].map((f) => [f, fs.readFileSync(f, "utf8")]));
  const fishFile = path.join(w.xdg.config, "..", "fish", "config.fish");
  assert.ok(!lexists(fishFile));
  const before = everything(w);
  const over = { platform: LINUX };
  assert.equal((await mv(w, ["--to", w.dest], over)).code, 0);
  assert.ok(lexists(fishFile), "the move created the fish profile for the shell in use... only if none existed");
  const r = await undoJson(atDest(w), ["--yes"], over);
  assert.equal(r.code, 0, r.all);
  for (const [f, text] of Object.entries(originals)) assert.equal(fs.readFileSync(f, "utf8"), text, path.basename(f));
  assert.ok(!lexists(fishFile), "a profile the move made is deleted again");
  // (a profile that was edited and edited back has a new file time: the text is what counts, and was compared above)
  const profiles = [".bashrc", ".profile", ".zshrc", "home/.bashrc", "home/.profile", "home/.zshrc"];
  assert.deepEqual(sameWorld(before, everything(w), profiles), []);
  const backups = fs.readdirSync(w.home).filter((n) => /\.bak-claude-relocate-/.test(n));
  assert.ok(backups.length >= 6, `a backup before the edit and one before the removal, for each of the three files: ${backups.length}`);
});

test("a profile with lines added after the move keeps them: only the block is cut", async () => {
  const w = fresh("un10");
  const bashrc = put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest], over);
  fs.appendFileSync(bashrc, "alias later=1\n");
  const r = await undoJson(atDest(w), ["--yes"], over);
  assert.equal(r.code, 0, r.all);
  assert.equal(read(bashrc), "alias a=b\nalias later=1\n");
});

test("undo puts back a user-environment value that was there before the move, with its type, and removes one that was not (Windows)", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("un11");
  assert.equal(writeUserEnv("%USERPROFILE%\\old-claude", w.env, undefined, "REG_EXPAND_SZ").ok, true);
  assert.equal((await mv(w, ["--to", w.dest])).code, 0);
  assert.equal(userEnv(w).value, w.dest);
  const r = await undoJson(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(r.json.registry, { ok: true, restored: "%USERPROFILE%\\old-claude" });
  assert.deepEqual([userEnv(w).type, userEnv(w).value], ["REG_EXPAND_SZ", "%USERPROFILE%\\old-claude"]);
  const x = fresh("un11b");
  await mv(x, ["--to", x.dest]);
  assert.equal(userEnv(x).exists, true);
  assert.equal((await undoJson(atDest(x))).code, 0);
  assert.equal(userEnv(x).exists, false);
});

test("undo of --xdg off Windows moves the parts home, takes the links out, removes the XDG folders it made, and leaves the exact tree", async () => {
  const w = fresh("un12", { platform: LINUX });
  const before = everything(w);
  const over = { platform: LINUX };
  assert.equal((await mv(w, ["--xdg"], over)).code, 0);
  assert.ok(lexists(w.xdg.state) && lexists(w.xdg.cache));
  const r = await undoJson(atDest(w, w.xdg.config), ["--yes"], over);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(sameWorld(before, everything(w)), []);
  assert.ok(!lexists(path.join(w.base, "xdg")), "the folders the move made on the way are gone");
});

test("undo of --xdg keeps XDG folders that were there before, and what else is in them", async () => {
  const w = fresh("un13", { platform: LINUX });
  put(path.join(w.xdg.state, "other-app", "keep.txt"), "mine");
  put(path.join(w.xdg.cache, "other-app", "keep.txt"), "mine");
  const over = { platform: LINUX };
  assert.equal((await mv(w, ["--xdg"], over)).code, 0);
  assert.equal((await undoJson(atDest(w, w.xdg.config), ["--yes"], over)).code, 0);
  assert.equal(read(w.xdg.state, "other-app", "keep.txt"), "mine");
  assert.equal(read(w.xdg.cache, "other-app", "keep.txt"), "mine");
  assert.ok(!lexists(w.xdg.state + path.sep + "projects") && !lexists(w.xdg.cache + path.sep + "plugins"));
});

test("two moves are undone by two undos, each to the place before it", async () => {
  const w = fresh("un14");
  const before = everything(w);
  const second = path.join(w.base, "second");
  assert.equal((await mv(w, ["--to", w.dest])).code, 0);
  assert.equal((await mv(atDest(w), ["--to", second])).code, 0);
  assert.ok(lexists(path.join(second, MANIFEST)) && !lexists(w.dest));
  const a = await undoJson(atDest(w, second));
  assert.equal(a.code, 0, a.all);
  assert.ok(lexists(w.dest) && !lexists(second));
  assert.equal(readManifest(path.join(w.dest, MANIFEST)).manifest.origin.configDir, w.cfg, "the first move's manifest is back");
  const b = await undoJson(atDest(w));
  assert.equal(b.code, 0, b.all);
  assert.deepEqual(sameWorld(before, everything(w)), []);
});

test("undo without --yes shows the steps and changes nothing; --dry-run says so and exits 0", async () => {
  const w = fresh("un15");
  await mv(w, ["--to", w.dest]);
  const before = everything(w);
  const a = await undo(atDest(w), []);
  assert.equal(a.code, 1);
  assert.match(a.err, /^This will:\n {2}1\. Move .* back to .* \(renamed, not copied: same drive\)\./);
  assert.match(a.err, /Nothing was changed\. Run it again with --yes to do this\.\n$/);
  const j = await undoJson(atDest(w), []);
  assert.deepEqual([j.code, j.json.ok, j.json.needsYes], [1, false, true]);
  const d = await undo(atDest(w), ["--dry-run"]);
  assert.equal(d.code, 0, d.all);
  assert.match(d.out, /^With --dry-run, this is what would happen:$/m);
  assert.deepEqual(everything(w), before);
});

test("undo with no manifest has nothing to undo, says where it looked, and changes nothing", async () => {
  const w = fresh("un16");
  const before = everything(w);
  const r = await undo(w);
  assert.equal(r.code, 1);
  assert.match(r.err, /^✗ Not undone\.\n {2}- No relocate-manifest\.json found, so there is nothing to undo\. Looked at: .*relocate-manifest\.json\. A move writes it into the new folder\./);
  const j = await undoJson(w);
  assert.equal(j.json.problems[0].code, "no-manifest");
  assert.deepEqual(everything(w), before);
});

test("undo of a manifest that cannot be used says why, and still looks elsewhere", async () => {
  const w = fresh("un17");
  put(path.join(w.cfg, MANIFEST), "{ nope");
  const r = await undoJson(w);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /Found but not usable: .*relocate-manifest\.json is not a JSON object\./);
});

test("undo is refused while Claude Code is running, unless --ignore-running", async () => {
  const w = fresh("un18");
  await mv(w, ["--to", w.dest]);
  const before = everything(w);
  const busy = { processes: () => ({ ok: true, processes: [{ pid: 9, name: "claude" }] }) };
  const r = await undoJson(atDest(w), ["--yes"], busy);
  assert.equal(r.code, 1);
  assert.equal(r.json.problems[0].code, "claude-running");
  assert.deepEqual(everything(w), before);
  assert.equal((await undoJson(atDest(w), ["--yes", "--ignore-running"], busy)).code, 0);
});

test("undo is refused when something is in the old place now: a folder with files, a file, a link elsewhere", async () => {
  const w = fresh("un19");
  await mv(w, ["--to", w.dest]);
  put(path.join(w.cfg, "created-later.txt"), "x");
  const a = await undoJson(atDest(w));
  assert.deepEqual([a.code, a.json.problems[0].code], [1, "origin-in-use"]);
  assert.match(a.json.error, /exists and is not empty \(something created it after the move\)\. Move it away, then run this again\.$/);
  fs.rmSync(w.cfg, { recursive: true });
  put(w.cfg, "a file");
  const b = await undoJson(atDest(w));
  assert.deepEqual([b.code, b.json.problems[0].code], [1, "origin-in-use"]);
  assert.match(b.json.error, / is a file\. Move it away/);
  fs.rmSync(w.cfg);
  fs.symlinkSync(tmpDir(), w.cfg, IS_WIN ? "junction" : "dir");
  const c = await undoJson(atDest(w));
  assert.deepEqual([c.code, c.json.problems[0].code], [1, "origin-in-use"]);
  assert.match(c.json.error, /is a link to somewhere other than /);
  fs.rmSync(w.cfg);
  fs.mkdirSync(w.cfg);
  assert.equal((await undoJson(atDest(w))).code, 0, "an empty folder in the way is replaced");
});

test("undo is refused when ~/.claude.json was created again after the move", async () => {
  const w = fresh("un20", { variable: false });
  await mv(w, ["--to", w.dest]);
  put(w.claudeJson, '{"fresh":true}');
  const r = await undoJson(atDest(w));
  assert.deepEqual([r.code, r.json.problems[0].code], [1, "claude-json-in-use"]);
  assert.ok(lexists(path.join(w.dest, ".claude.json")), "nothing was touched");
});

test("undo is refused when the manifest's folder is not where it says, as after a move by hand", async () => {
  const w = fresh("un21");
  await mv(w, ["--to", w.dest]);
  const byHand = path.join(w.base, "by-hand");
  fs.renameSync(w.dest, byHand);
  const r = await undoJson(atDest(w, byHand));
  assert.deepEqual([r.code, r.json.problems[0].code], [1, "destination-missing"]);
  assert.match(r.json.error, /where the manifest says the config folder went, is not a folder any more\./);
});

test("undo to another drive with no room is refused before anything moves", async () => {
  const w = fresh("un22");
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  await mv(w, ["--to", w.dest], over);
  const before = everything(w);
  const r = await undoJson(atDest(w), ["--yes"], { ...over, free: () => 1000 });
  assert.deepEqual([r.code, r.json.problems[0].code], [1, "not-enough-space"]);
  assert.deepEqual(everything(w), before);
});

test("an undo that stops half way says so, leaves everything in the new place, and can be run again", async () => {
  const w = fresh("un23");
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  await mv(w, ["--to", w.dest, "--link"], over);
  const before = everything(w);
  let n = 0;
  const copyFile = (a, b, flags) => { if (++n === 5) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return fs.copyFileSync(a, b, flags); };
  const r = await undo(atDest(w), ["--yes"], { ...over, copyFile });
  assert.equal(r.code, 1);
  assert.match(r.err, /^✗ The undo stopped: EIO: i\/o error.* What has not been put back yet is still in .*, with its relocate-manifest\.json\. Fix the cause and run undo again\.$/m);
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink(), "the link at the old place is back, so nothing that follows it breaks");
  assert.deepEqual(everything(w), before, "the state is the one before the undo");
  const again = await undoJson(atDest(w), ["--yes"], over);
  assert.equal(again.code, 0, again.all);
  assert.ok(lexists(path.join(w.cfg, "settings.json")) && !fs.lstatSync(w.cfg).isSymbolicLink());
});

test("a second undo has nothing to undo", async () => {
  const w = fresh("un24");
  await mv(w, ["--to", w.dest]);
  assert.equal((await undoJson(atDest(w))).code, 0);
  const r = await undoJson(atDest(w));
  assert.deepEqual([r.code, r.json.problems[0].code], [1, "no-manifest"]);
});

test("undo finds the manifest through the block in a profile when the terminal still names the old, now missing, place", async () => {
  const w = fresh("un25", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest, "--no-env"], over);
  assert.equal((await undoJson(w, ["--yes"], over)).code, 1, "with --no-env there is no block and the old place is gone: nothing to find");
  const y = fresh("un25b", { shell: "/bin/bash" });
  put(path.join(y.home, ".bashrc"), "alias a=b\n");
  await mv(y, ["--to", y.dest], over);
  assert.ok(!lexists(y.cfg));
  const r = await undoJson(y, ["--yes"], over);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.found.via, `the block in ${path.join(y.home, ".bashrc")}`);
  assert.ok(lexists(path.join(y.cfg, "settings.json")));
  assert.equal(blockValue(read(y.home, ".bashrc"), "posix"), null);
});

test("undo finds the manifest through the Windows user environment when no profile names it", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("un26");
  await mv(w, ["--to", w.dest]);
  const found = findManifest(w.env, { cwd: w.base, sys: w.sys() });
  assert.equal(found.found, true);
  assert.equal(found.via, "the Windows user environment");
  const r = await undoJson(w);
  assert.equal(r.code, 0, r.all);
  assert.ok(lexists(path.join(w.cfg, "settings.json")));
});

test("findManifest lists every place it looked when there is none, without duplicates", () => {
  const w = fresh("un27", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const f = findManifest(w.env, { cwd: w.base, sys: w.sys({ platform: LINUX }) });
  assert.equal(f.found, false);
  assert.deepEqual(f.tried, [path.join(w.cfg, MANIFEST)]);
  assert.deepEqual(f.errors, []);
});

test("undo after a move whose environment step failed still takes out what was written", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("un28");
  const real = w.sys();
  const deaf = { run: (cmd, args, o) => (cmd === "reg" && args[0] === "add" ? { status: 1, stdout: "", stderr: "ERROR: Access is denied." } : real.run(cmd, args, o)) };
  const m = await mv(w, ["--to", w.dest], deaf);
  assert.equal(m.code, 1);
  assert.equal(userEnv(w).exists, false);
  const r = await undoJson(atDest(w));
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(r.json.registry, null, "the manifest recorded no registry change, so undo makes none");
});

test("undo json carries the steps, the manifest and what became of the profiles", async () => {
  const w = fresh("un29", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest], over);
  const r = await undoJson(atDest(w), ["--yes"], over);
  assert.deepEqual(Object.keys(r.json).sort(), ["command", "destination", "found", "incomplete", "manifest", "method", "ok", "origin", "profiles", "registry", "schema", "steps", "tool", "version", "warnings", "dryRun"].sort());
  assert.equal(r.json.profiles.length, 1);
  assert.deepEqual([r.json.profiles[0].removed, r.json.profiles[0].deleted], [true, false]);
  assert.equal(r.json.origin, w.cfg);
  assert.equal(r.json.destination, w.dest);
});

test("undo is refused while the working folder is inside the folder it would move back", async () => {
  const w = fresh("un30");
  await mv(w, ["--to", w.dest]);
  const before = everything(w);
  const r = await runJson(["undo", "--yes"], atDest(w), { cwd: path.join(w.dest, "projects"), sys: w.sys() });
  assert.equal(r.code, 1);
  assert.equal(r.json.problems[0].code, "working-folder-inside");
  assert.deepEqual(everything(w), before);
  assert.equal((await undoJson(atDest(w))).code, 0);
});

// Links into a dotfiles folder next to the config folder, with relative targets as GNU stow makes them, and one
// relative link that stays inside the folder.
function stowLike(w) {
  put(path.join(w.base, "dotfiles", "CLAUDE.md"), "from dotfiles\n");
  put(path.join(w.base, "dotfiles", "rules", "a.md"), "rule\n");
  fs.symlinkSync(path.join("..", "dotfiles", "CLAUDE.md"), path.join(w.cfg, "linked.md"), "file");
  fs.symlinkSync(path.join("..", "..", "dotfiles", "rules"), path.join(w.cfg, "skills", "rules"), "dir");
  fs.symlinkSync(path.join("..", "..", "..", "dotfiles", "CLAUDE.md"), path.join(w.cfg, "projects", "-work-shop", "linked.md"), "file");
  fs.symlinkSync(path.join("skills", "demo"), path.join(w.cfg, "inside"), "dir");
  // relative and inside the folder, but in a folder that the --xdg split moves to the state folder
  fs.symlinkSync(path.join("..", "..", "skills", "demo"), path.join(w.cfg, "projects", "-work-shop", "inside-link"), "dir");
}

for (const [n, name, over, split] of [[1, "by rename", {}, false], [2, "by copy to another drive", "copy", false], [3, "in the --xdg split", { platform: LINUX }, true]]) {
  test(`relative links that leave the folder are written as absolute links by the move and come back as the same relative text on undo, ${name} (found by review)`, { skip: noFileLinks() }, async () => {
    const w = fresh(`un21-${n}`, { platform: split ? LINUX : undefined });
    stowLike(w);
    const before = everything(w);
    const sysOver = over === "copy" ? { rename: exdev, drive: secondDriveAt(w.dest) } : over;
    const m = await mv(w, split ? ["--xdg"] : ["--to", w.dest], sysOver);
    assert.equal(m.code, 0, m.all);
    const dest = split ? w.xdg.config : w.dest;
    assert.ok(path.isAbsolute(fs.readlinkSync(path.join(dest, "linked.md"))), "after the move the link is absolute, so that it keeps working");
    assert.equal(read(dest, "linked.md"), "from dotfiles\n");
    assert.equal(read(dest, "projects", "-work-shop", "linked.md"), "from dotfiles\n", "also inside a folder that went to the state folder");
    assert.equal(fs.readlinkSync(path.join(dest, "inside")), path.join("skills", "demo"), "a relative link that stays inside is left as it is");
    const links = manifestOfFile(dest).relativeLinks.map((l) => l.path).sort();
    assert.deepEqual(links, ["linked.md", "projects/-work-shop/linked.md", ...(split ? ["projects/-work-shop/inside-link"] : []), "skills/rules"].sort(), "the links that had to be written as absolute links");
    assert.equal(fs.existsSync(path.join(dest, "projects", "-work-shop", "inside-link", "SKILL.md")), true, "and the one inside works");
    const u = await undoJson(atDest(w, dest), ["--yes"], sysOver);
    assert.equal(u.code, 0, u.all);
    assert.deepEqual(sameWorld(before, everything(w)), [], "the exact tree, link text included");
  });
}

function manifestOfFile(dir) {
  const r = readManifest(path.join(dir, MANIFEST));
  assert.equal(r.ok, true, r.error);
  return r.manifest;
}

// A sys.drive that follows links the way the system does: a link names the drive of what it leads to.
function followingDrive(secondDir) {
  const second = secondDriveAt(secondDir);
  return (p) => {
    let q = path.resolve(p);
    for (;;) {
      try { q = fs.realpathSync.native(q); break; } catch { const up = path.dirname(q); if (up === q) break; q = up; }
    }
    return second(q);
  };
}

test("undo of a move --link to another drive plans a copy back and checks the room: the link names the new drive, the folder it sits in names the old one (found by review)", async () => {
  const w = fresh("un22");
  const before = everything(w);
  const over = { rename: exdev, drive: followingDrive(w.dest) };
  assert.equal((await mv(w, ["--to", w.dest, "--link"], over)).code, 0);
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink());
  const dry = await undoJson(atDest(w), ["--dry-run"], over);
  assert.equal(dry.code, 0, dry.all);
  assert.ok(dry.json.steps.some((s) => /copied and checked, then the copy in the new place is deleted: another drive/.test(s.text)), JSON.stringify(dry.json.steps));
  const tight = await undoJson(atDest(w), ["--yes"], { ...over, free: () => 1000 });
  assert.equal(tight.code, 1);
  assert.match(tight.json.error, /Not enough free space at/);
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink(), "and nothing was changed");
  const u = await undoJson(atDest(w), ["--yes"], over);
  assert.equal(u.code, 0, u.all);
  assert.equal(u.json.method, "copy");
  assert.deepEqual(sameWorld(before, everything(w)), []);
});

test("undo names an unfinished copy from an earlier undo, which a marker file shows, and does not call it something created after the move", async () => {
  const w = fresh("un23");
  assert.equal((await mv(w, ["--to", w.dest])).code, 0);
  put(path.join(w.cfg, "projects", "half.txt"), "a copy that was interrupted\n");
  put(path.join(w.cfg, ".claude-relocate-incomplete"), "claude-relocate is copying into this folder.\n");
  const r = await undoJson(atDest(w), ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /holds an unfinished copy from an earlier undo, marked by a \.claude-relocate-incomplete file; delete the folder\)\. Move it away, then run this again\.$/);
  assert.ok(lexists(path.join(w.dest, "settings.json")), "and everything is still in the new place");
});

test("undo puts the environment back even when a folder the move made cannot be looked into afterwards (found by review)", async () => {
  const w = seedConfig(world("un24", { shell: "/bin/bash" }));
  put(path.join(w.home, ".bashrc"), "# mine\n");
  const made = path.join(w.base, "new");
  const dest = path.join(made, "dest");
  assert.equal((await mv(w, ["--to", dest])).code, 0);
  assert.match(read(w.home, ".bashrc"), /claude-relocate start/);
  const real = fs.readdirSync;
  fs.readdirSync = (p, ...rest) => { if (path.resolve(String(p)) === made) throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" }); return real.call(fs, p, ...rest); };
  let u;
  try { u = await undoJson(atDest(w, dest), ["--yes"]); } finally { fs.readdirSync = real; }
  assert.equal(u.code, 0, u.all);
  assert.equal(read(w.home, ".bashrc"), "# mine\n", "the block is out of the profile");
  assert.ok(lexists(path.join(w.cfg, "settings.json")));
});
