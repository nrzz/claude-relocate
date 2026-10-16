import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CACHE_PARTS, STATE_PARTS } from "../src/inventory.mjs";
import { SPLIT_VERIFIED, splitParts, splitSupported } from "../src/xdg.mjs";
import { IS_WIN, put, seedConfig, tmpDir, world } from "./helpers.mjs";

const dirs = (w) => ({ config: w.xdg.config, state: w.xdg.state, cache: w.xdg.cache });

test("the split into state and cache folders is for Linux and macOS, never Windows", () => {
  assert.equal(SPLIT_VERIFIED, true);
  assert.equal(splitSupported("linux"), true);
  assert.equal(splitSupported("darwin"), true);
  assert.equal(splitSupported("win32"), false);
});

test("the state parts and the cache parts are named once each and do not overlap", () => {
  assert.deepEqual(STATE_PARTS.filter((p) => CACHE_PARTS.includes(p)), []);
  assert.ok(STATE_PARTS.includes("projects"), "the sessions go to the state folder");
  assert.ok(CACHE_PARTS.includes("plugins/cache"), "the plugin cache goes to the cache folder");
  for (const p of [...STATE_PARTS, ...CACHE_PARTS]) assert.ok(!p.startsWith("/") && !p.endsWith("/"), p);
});

test("splitParts lists the parts that exist, each with where it goes and where its link goes", () => {
  const w = seedConfig(world("xdg1"));
  const parts = splitParts(w.cfg, dirs(w));
  const byPath = Object.fromEntries(parts.map((p) => [p.path, p]));
  for (const name of ["projects", "file-history", "session-env", "uploads", "tasks", "todos", "shell-snapshots", "backups", "debug"]) {
    assert.equal(byPath[name].area, "state", name);
    assert.equal(byPath[name].from, path.join(w.cfg, name));
    assert.equal(byPath[name].to, path.join(w.xdg.state, name));
    assert.equal(byPath[name].link, path.join(w.xdg.config, name), "the link sits in the new config folder");
  }
  for (const name of ["statsig", "usage-data"]) assert.equal(byPath[name].area, "cache", name);
  assert.deepEqual([byPath["plugins/cache"].area, byPath["plugins/cache"].from, byPath["plugins/cache"].to, byPath["plugins/cache"].link], ["cache", path.join(w.cfg, "plugins", "cache"), path.join(w.xdg.cache, "plugins", "cache"), path.join(w.xdg.config, "plugins", "cache")]);
  assert.ok(!byPath["history.jsonl"] && !byPath.ide && !byPath["settings.json"] && !byPath.plugins, "nothing else is split off");
});

test("splitParts leaves out a part that is not there, and a part that is a link already", () => {
  const w = world("xdg2");
  put(path.join(w.cfg, "settings.json"), "{}");
  put(path.join(w.cfg, "projects", "-p", "a.jsonl"), "{}\n");
  assert.deepEqual(splitParts(w.cfg, dirs(w)).map((p) => p.path), ["projects"]);
  const elsewhere = tmpDir();
  fs.symlinkSync(elsewhere, path.join(w.cfg, "todos"), IS_WIN ? "junction" : "dir");
  assert.deepEqual(splitParts(w.cfg, dirs(w)).map((p) => p.path), ["projects"], "a link is moved as a link, with the rest");
});

test("splitParts takes plugins/cache only when plugins/ is a real folder with a real cache in it", () => {
  const a = world("xdg3");
  put(path.join(a.cfg, "plugins", "installed_plugins.json"), "{}");
  assert.deepEqual(splitParts(a.cfg, dirs(a)).map((p) => p.path), [], "plugins without a cache");
  const elsewhere = tmpDir();
  put(path.join(elsewhere, "m", "p", "f"), "x");
  fs.symlinkSync(elsewhere, path.join(a.cfg, "plugins", "cache"), IS_WIN ? "junction" : "dir");
  assert.deepEqual(splitParts(a.cfg, dirs(a)).map((p) => p.path), [], "a linked cache");
  const b = world("xdg4");
  fs.mkdirSync(b.cfg, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(b.cfg, "plugins"), IS_WIN ? "junction" : "dir");
  assert.deepEqual(splitParts(b.cfg, dirs(b)).map((p) => p.path), [], "plugins/ itself is a link");
});
