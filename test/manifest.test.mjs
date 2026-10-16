import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_NAME, SCHEMA, check, manifestFile, newManifest, readManifest, writeManifest } from "../src/manifest.mjs";
import { VERSION } from "../src/version.mjs";
import { lexists, put, tmpDir } from "./helpers.mjs";

const abs = (...p) => path.resolve(path.sep, ...p);

// The smallest manifest that `check` accepts.
const valid = (over = {}) => newManifest({
  date: "2026-10-16T08:00:00.000Z", platform: process.platform, mode: "single", method: "rename",
  origin: { configDir: abs("home", ".claude"), claudeJson: abs("home", ".claude.json"), claudeJsonInside: false },
  destination: { configDir: abs("data", "claude"), claudeJson: abs("data", "claude", ".claude.json"), existedBefore: false },
  parts: [], profiles: [], registry: null, links: [], ...over,
});

test("a new manifest names the tool, the schema and the version", () => {
  const m = valid();
  assert.equal(m.tool, "claude-relocate");
  assert.equal(m.schema, SCHEMA);
  assert.equal(m.version, VERSION);
  assert.equal(MANIFEST_NAME, "relocate-manifest.json");
  assert.equal(manifestFile(abs("x")), path.join(abs("x"), "relocate-manifest.json"));
});

test("writeManifest and readManifest round-trip, with the file written as pretty JSON and a final line break", () => {
  const dir = tmpDir();
  const m = valid({ profiles: [{ file: path.join(dir, ".bashrc"), shell: "bash", syntax: "posix", action: "append", previous: null, sepAdded: false, created: false, mkdirs: [], backup: null }] });
  writeManifest(dir, m);
  const text = fs.readFileSync(manifestFile(dir), "utf8");
  assert.ok(text.startsWith('{\n  "schema": 1,'));
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(readManifest(manifestFile(dir)), { ok: true, manifest: m });
  assert.deepEqual(fs.readdirSync(dir), [MANIFEST_NAME], "no temporary file is left");
});

test("writeManifest replaces an existing manifest in one step", () => {
  const dir = tmpDir();
  writeManifest(dir, valid({ method: "rename" }));
  writeManifest(dir, valid({ method: "copy" }));
  assert.equal(readManifest(manifestFile(dir)).manifest.method, "copy");
  assert.deepEqual(fs.readdirSync(dir), [MANIFEST_NAME]);
});

test("readManifest accepts a byte-order mark, and says why a file is not usable", () => {
  const dir = tmpDir();
  const file = manifestFile(dir);
  assert.match(readManifest(file).error, /^cannot be read \(ENOENT\)/);
  put(file, `﻿${JSON.stringify(valid())}`);
  assert.equal(readManifest(file).ok, true);
  put(file, "{ not json");
  assert.equal(readManifest(file).error, "is not a JSON object");
  put(file, "[1]");
  assert.equal(readManifest(file).error, "is not a JSON object");
  put(file, "null");
  assert.equal(readManifest(file).error, "is not a JSON object");
});

test("check names the first thing wrong with a manifest", () => {
  assert.equal(check(valid()), "");
  assert.equal(check({ ...valid(), tool: "something-else" }), "was not written by claude-relocate");
  assert.match(check({ ...valid(), schema: 2 }), /^has schema 2; this version reads schema 1$/);
  assert.match(check({ ...valid(), schema: undefined }), /^has schema undefined/);
  assert.equal(check({ ...valid(), origin: undefined }), "has no origin");
  assert.equal(check({ ...valid(), destination: "x" }), "has no destination");
  assert.match(check(valid({ origin: { configDir: "relative/path" } })), /^has an origin\.configDir that is not an absolute path$/);
  assert.match(check(valid({ destination: { configDir: 5 } })), /^has a destination\.configDir that is not an absolute path$/);
  assert.equal(check(valid({ mode: "weird" })), 'has the mode "weird"');
  assert.match(check(valid({ parts: "x" })), /a list \(parts, profiles or links\)/);
  assert.match(check(valid({ profiles: null })), /a list/);
  assert.match(check(valid({ links: {} })), /a list/);
  assert.equal(check(valid({ mode: "xdg-split" })), "", "the other mode is fine");
});

test("readManifest turns a check failure into an error message", () => {
  const dir = tmpDir();
  put(manifestFile(dir), JSON.stringify({ ...valid(), tool: "other" }));
  assert.deepEqual(readManifest(manifestFile(dir)), { ok: false, error: "was not written by claude-relocate" });
  assert.ok(lexists(manifestFile(dir)), "reading never deletes");
});
