import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { driveOf } from "../src/space.mjs";
import { freeBytes, parseDf } from "../src/space.mjs";
import { IS_WIN, otherDriveDir, tmpDir } from "./helpers.mjs";

test("parseDf reads the free kilobytes of the last line and returns bytes", () => {
  const out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1        245117620 111234512 121785360      48% /\n";
  assert.equal(parseDf(out), 121785360 * 1024);
  assert.equal(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n"), null);
  assert.equal(parseDf(""), null);
  assert.equal(parseDf("a\nb c d notanumber e f\n"), null);
});

test("freeBytes asks statfs about the nearest folder that exists, also for a path that is not there yet", () => {
  const dir = tmpDir();
  const asked = [];
  const statfs = (p) => { asked.push(p); return { bavail: 10, bsize: 4096 }; };
  assert.equal(freeBytes(path.join(dir, "a", "b", "c"), { statfs }), 40960);
  assert.equal(asked[0], dir);
});

test("freeBytes is a positive number on the real machine", () => {
  const n = freeBytes(os.tmpdir());
  assert.equal(typeof n, "number");
  assert.ok(n > 0);
  assert.ok(Number.isFinite(n));
});

test("without fs.statfsSync (Node before 18.15) it falls back to df, or to PowerShell on Windows", () => {
  const n = freeBytes(os.tmpdir(), { statfs: null });
  assert.equal(typeof n, "number", "the fallback gave a number");
  assert.ok(n > 0);
  const direct = freeBytes(os.tmpdir());
  // two reads of the same drive, a moment apart, agree to within a gigabyte
  assert.ok(Math.abs(n - direct) < 1024 ** 3, `${n} vs ${direct}`);
});

test("freeBytes is null, not a guess, when nothing can answer", () => {
  assert.equal(freeBytes(os.tmpdir(), { statfs: () => { throw new Error("no"); } }), null);
  assert.equal(freeBytes(os.tmpdir(), { statfs: null, run: () => ({ status: 1, stdout: "" }) }), null);
});

test("driveOf: a folder and a folder that is not there yet inside it are on the same drive", () => {
  const dir = tmpDir();
  assert.ok(driveOf(dir));
  assert.equal(driveOf(path.join(dir, "not", "there")), driveOf(dir));
  fs.mkdirSync(path.join(dir, "sub"));
  assert.equal(driveOf(path.join(dir, "sub")), driveOf(dir));
});

test("driveOf tells two drives apart (needs a second drive: the repository's on Windows, /dev/shm on Linux)", (t) => {
  const other = otherDriveDir();
  if (!other) { t.skip("this machine has no second writable drive"); return; }
  assert.notEqual(driveOf(other), driveOf(os.tmpdir()));
  assert.ok(IS_WIN || fs.existsSync(other));
});
