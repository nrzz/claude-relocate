import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyBlock } from "../src/profiles.mjs";
import { IS_WIN, everything, put, run, runJson, seedConfig, tmpDir, world } from "./helpers.mjs";

const LINUX = IS_WIN ? "linux" : process.platform;
const fresh = (name, opts = {}) => seedConfig(world(name, { shell: "", ...opts }));
const mv = (w, args, over) => runJson(["move", ...args, "--yes"], w, { sys: w.sys(over) });
const atDest = (w, dir = w.dest) => ({ ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: dir } });
const status = (w, over) => runJson(["status"], w, { sys: w.sys(over) });

test("status before any move: where the config folder and .claude.json are, that nothing was moved, and what a new terminal gets", async () => {
  const w = fresh("st1");
  const r = await status(w);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(Object.keys(r.json).sort(), ["claudeJson", "command", "configDir", "links", "moved", "newTerminals", "ok", "platform", "profiles", "schema", "shell", "thisTerminal", "tool", "version", "windowsEnvironment"]);
  assert.deepEqual([r.json.schema, r.json.command, r.json.ok, r.json.moved, r.json.links, r.json.profiles], [1, "status", true, null, [], []]);
  assert.deepEqual(r.json.thisTerminal, { variable: w.cfg, configDir: w.cfg, source: "CLAUDE_CONFIG_DIR" });
  assert.deepEqual([r.json.configDir.path, r.json.configDir.exists, r.json.configDir.isLink], [w.cfg, true, false]);
  assert.deepEqual([r.json.claudeJson.path, r.json.claudeJson.exists, r.json.claudeJson.inside, r.json.claudeJson.size > 0], [w.claudeJson, true, true, true]);
  assert.equal(r.json.windowsEnvironment === null, !IS_WIN);
  if (IS_WIN) assert.deepEqual([r.json.windowsEnvironment.key, r.json.windowsEnvironment.ok, r.json.windowsEnvironment.value], [w.regKey, true, null]);
});

test("status text for a folder that was never moved", async () => {
  const w = fresh("st2", { variable: false });
  const r = await run(["status"], w, { sys: w.sys() });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^claude-relocate 1\.1\.0 {2}status$/m);
  assert.match(r.out, /^config folder {3}.*\.claude {2}\(the default: CLAUDE_CONFIG_DIR is not set in this terminal\)$/m);
  assert.match(r.out, /^\.claude\.json {4}.*\.claude\.json {2}\(\d+ B; next to the config folder\)$/m);
  assert.match(r.out, /^moved {11}no relocate-manifest\.json found: not moved by claude-relocate, or it is gone$/m);
  assert.match(r.out, /^This terminal: CLAUDE_CONFIG_DIR is not set\.$/m);
});

test("status: free space of origin drive in text and json, and leaves it out when null", async () => {
  const w = fresh("st-free");
  const freeVal = 12.3 * 1073741824;
  const withFree = await run(["status"], w, { sys: w.sys({ free: () => freeVal }) });
  assert.equal(withFree.code, 0);
  assert.match(withFree.out, /^free space {6}12\.3 GB on the drive of the config folder$/m);
  const jFree = await status(w, { free: () => freeVal });
  assert.equal(jFree.json.configDir.freeBytes, freeVal);

  const withoutFree = await run(["status"], w, { sys: w.sys({ free: () => null }) });
  assert.equal(withoutFree.code, 0);
  assert.ok(!withoutFree.out.includes("free space"));
  const jNoFree = await status(w, { free: () => null });
  assert.equal(jNoFree.json.configDir.freeBytes, null);
});

test("status after a move says from where to where, when and how, and where the manifest is", async () => {
  const w = fresh("st3");
  await mv(w, ["--to", w.dest]);
  const r = await status(atDest(w));
  assert.equal(r.code, 0, r.all);
  const m = r.json.moved;
  assert.deepEqual([m.from, m.to, m.mode, m.method, m.manifest, m.via], [w.cfg, w.dest, "single", "rename", path.join(w.dest, "relocate-manifest.json"), "CLAUDE_CONFIG_DIR"]);
  assert.match(m.date, /^2026-\d\d-\d\dT/);
  const text = await run(["status"], atDest(w), { sys: w.sys() });
  assert.match(text.out, /^moved {11}.* to .* on 2026-\d\d-\d\d \(one folder, by rename\)$/m);
  assert.match(text.out, /^ {16}manifest: .*relocate-manifest\.json$/m);
  assert.match(text.out, /^This terminal: CLAUDE_CONFIG_DIR=.*dest\.$/m);
});

test("status shows what each kind of new terminal will get: the user environment on Windows, then the profile of each shell", async () => {
  const w = fresh("st4", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  put(path.join(w.home, ".zshrc"), "alias z=y\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest], over);
  fs.writeFileSync(path.join(w.home, ".zshrc"), "alias z=y\n");
  const r = await status(atDest(w), over);
  const rows = Object.fromEntries(r.json.newTerminals.map((x) => [x.name, x]));
  assert.equal(rows.bash.value, w.dest);
  assert.equal(rows.bash.from, path.join(w.home, ".bashrc"));
  assert.equal(rows.zsh.value, null, "this profile lost its block");
  assert.equal(rows.zsh.from, ".zshrc (no claude-relocate block)");
  assert.equal(rows.fish, undefined, "a shell with no profile that is not the one in use is not listed");
  assert.equal(rows.windows, undefined, "off Windows there is no user environment to list");
  const text = await run(["status"], atDest(w), { sys: w.sys(over) });
  assert.match(text.out, /^A terminal started now will have:$/m);
  assert.match(text.out, /^ {2}bash {5}CLAUDE_CONFIG_DIR=.*dest {2}\(.*\.bashrc\)$/m);
  assert.match(text.out, /^ {2}zsh {6}CLAUDE_CONFIG_DIR not set {2}\(\.zshrc \(no claude-relocate block\)\)$/m);
});

test("the shell in use is listed even when it has no profile", async () => {
  const w = fresh("st5", { shell: "/usr/bin/fish" });
  const r = await status(w, { platform: LINUX });
  const fish = r.json.newTerminals.find((x) => x.name === "fish");
  assert.deepEqual([fish.value, fish.from], [null, "no profile file"]);
  assert.equal(r.json.shell, "fish");
});

test("status shows the links a move left, and whether they resolve", async () => {
  const w = fresh("st6");
  await mv(w, ["--to", w.dest, "--link"]);
  const ok = await status(w);
  assert.deepEqual(ok.json.links.map((l) => [l.purpose, l.isLink, l.resolves]), [["origin", true, true]]);
  assert.equal(ok.json.configDir.isLink, true);
  assert.equal(path.resolve(ok.json.configDir.resolvesTo).toLowerCase(), w.dest.toLowerCase());
  const text = await run(["status"], w, { sys: w.sys() });
  assert.match(text.out, /\(CLAUDE_CONFIG_DIR in this terminal; a link to .*dest\)$/m);
  assert.match(text.out, /^link {12}.* -> .* {2}\(resolves\)$/m);
  fs.renameSync(w.dest, `${w.dest}-away`);
  const broken = await status(w);
  assert.equal(broken.code, 0);
  assert.deepEqual([broken.json.configDir.exists, broken.json.configDir.isLink, broken.json.configDir.resolvesTo], [false, true, null]);
  assert.equal(broken.json.moved, null, "the manifest went with the folder the link leads to");
  const text2 = await run(["status"], w, { sys: w.sys() });
  assert.match(text2.out, /\(CLAUDE_CONFIG_DIR in this terminal; a link that leads nowhere\)$/m);
});

test("status after --xdg off Windows lists the split and its links", async () => {
  const w = fresh("st7", { platform: LINUX });
  const over = { platform: LINUX };
  await mv(w, ["--xdg"], over);
  const r = await status(atDest(w, w.xdg.config), over);
  assert.equal(r.json.moved.mode, "xdg-split");
  assert.equal(r.json.links.length, 12);
  assert.ok(r.json.links.every((l) => l.purpose === "xdg" && l.isLink && l.resolves));
  const text = await run(["status"], atDest(w, w.xdg.config), { sys: w.sys(over) });
  assert.match(text.out, /\(split into config, state and cache folders, by (rename|mixed)\)$/m);
});

test("status points out another line that sets CLAUDE_CONFIG_DIR in a profile", async () => {
  const w = fresh("st8", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), `export CLAUDE_CONFIG_DIR=/old/place\n${applyBlock("", "posix", w.dest).text}`);
  const r = await run(["status"], w, { sys: w.sys({ platform: LINUX }) });
  assert.match(r.out, /^note {2}.*\.bashrc line 1 also sets CLAUDE_CONFIG_DIR: export CLAUDE_CONFIG_DIR=\/old\/place$/m);
});

test("status with no config folder at all still answers, exit 0", async () => {
  const w = world("st9", { shell: "" });
  const r = await run(["status"], w, { sys: w.sys() });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /; it does not exist\)$/m);
  assert.match(r.out, /does not exist; inside the config folder\)$/m);
});

test("status changes nothing", async () => {
  const w = fresh("st10", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const over = { platform: LINUX };
  await mv(w, ["--to", w.dest, "--link"], over);
  const before = everything(w);
  await status(w, over);
  await status(atDest(w), over);
  assert.deepEqual(everything(w), before);
  void tmpDir;
});
