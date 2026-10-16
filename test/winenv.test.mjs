import test from "node:test";
import assert from "node:assert/strict";
import { REAL_KEY, broadcast, isRealKey, keyOf, parseRegQuery, readUserEnv, removeUserEnv, writeUserEnv } from "../src/winenv.mjs";
import { IS_WIN, world } from "./helpers.mjs";

test("parseRegQuery reads the value, its type and a value with spaces; nothing for another name", () => {
  const text = "\r\nHKEY_CURRENT_USER\\Environment\r\n    CLAUDE_CONFIG_DIR    REG_SZ    D:\\Claude Data\\cfg\r\n\r\n";
  assert.deepEqual(parseRegQuery(text), { exists: true, type: "REG_SZ", value: "D:\\Claude Data\\cfg" });
  assert.deepEqual(parseRegQuery(text, "OTHER"), { exists: false, type: null, value: null });
  assert.deepEqual(parseRegQuery("    claude_config_dir    REG_EXPAND_SZ    %USERPROFILE%\\x\r\n"), { exists: true, type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\x" });
  assert.deepEqual(parseRegQuery("    CLAUDE_CONFIG_DIR    REG_SZ    \r\n"), { exists: true, type: "REG_SZ", value: "" });
  assert.deepEqual(parseRegQuery(""), { exists: false, type: null, value: null });
});

test("the key is HKCU\\Environment unless the scratch key of a test is named, and only the real one is broadcast to", () => {
  assert.equal(keyOf({}), REAL_KEY);
  assert.equal(keyOf({ CLAUDE_RELOCATE_REG_KEY: " HKCU\\Software\\x " }), "HKCU\\Software\\x");
  assert.equal(isRealKey({}), true);
  assert.equal(isRealKey({ CLAUDE_RELOCATE_REG_KEY: "hkcu\\environment" }), true);
  assert.equal(isRealKey({ CLAUDE_RELOCATE_REG_KEY: "HKCU\\Software\\x" }), false);
  const calls = [];
  assert.equal(broadcast({ CLAUDE_RELOCATE_REG_KEY: "HKCU\\Software\\x" }, (...a) => { calls.push(a); return { status: 0 }; }), false);
  assert.deepEqual(calls, [], "a scratch key never causes a setx");
  assert.equal(broadcast({}, (...a) => { calls.push(a); return { status: 0 }; }), true);
  assert.deepEqual(calls.map((c) => [c[0], c[1][0]]), [["setx", "CLAUDE_RELOCATE_NOTIFY"], ["reg", "delete"]]);
});

test("the tests' own environment points at a scratch key, never at the real one", () => {
  assert.notEqual(keyOf(process.env), REAL_KEY);
  assert.match(keyOf(process.env), /claude-relocate-test/);
  assert.match(keyOf(world("k").env), /claude-relocate-test/);
});

test("readUserEnv, writeUserEnv and removeUserEnv with the reg program: set, change, read back exactly, remove (Windows)", { skip: !IS_WIN && "the registry is Windows only" }, () => {
  const w = world("reg1");
  const read = () => readUserEnv(w.env);
  assert.deepEqual(read(), { ok: true, exists: false, type: null, value: null, error: null }, "a key that is not there has no value");
  const values = ["D:\\Claude", "D:\\Claude Data\\my config", "C:\\Users\\me\\100% done", "D:\\it's\\here", "D:\\Café\\日本語", "D:\\a&b^c(d)!e$f", "D:\\x\\"];
  for (const v of values) {
    assert.equal(writeUserEnv(v, w.env).ok, true, v);
    const r = read();
    assert.equal(r.exists, true);
    assert.equal(r.type, "REG_SZ");
    assert.equal(r.value, v, `read back ${v}`);
  }
  assert.deepEqual(removeUserEnv(w.env), { ok: true, error: null, existed: true });
  assert.equal(read().exists, false);
  assert.deepEqual(removeUserEnv(w.env), { ok: true, error: null, existed: false }, "removing what is not there is fine");
});

test("writeUserEnv can put back a value with the type it had", { skip: !IS_WIN && "the registry is Windows only" }, () => {
  const w = world("reg2");
  assert.equal(writeUserEnv("%USERPROFILE%\\claude", w.env, undefined, "REG_EXPAND_SZ").ok, true);
  const r = readUserEnv(w.env);
  assert.equal(r.type, "REG_EXPAND_SZ");
  assert.equal(r.value, "%USERPROFILE%\\claude");
});

test("a failing reg program is reported, with its message, and nothing is claimed", () => {
  const failing = () => ({ status: 1, stdout: "", stderr: "ERROR: Access is denied." });
  assert.match(writeUserEnv("x", { CLAUDE_RELOCATE_REG_KEY: "HKCU\\Software\\x" }, failing).error, /reg add failed \(ERROR: Access is denied\./);
  const missing = () => ({ error: new Error("spawn reg ENOENT"), status: null });
  assert.match(writeUserEnv("x", {}, missing).error, /reg\.exe could not run/);
  assert.equal(readUserEnv({}, missing).ok, false);
  const seq = [{ status: 0, stdout: "    CLAUDE_CONFIG_DIR    REG_SZ    x\r\n" }, { status: 1, stdout: "", stderr: "denied" }];
  assert.match(removeUserEnv({ CLAUDE_RELOCATE_REG_KEY: "HKCU\\Software\\x" }, () => seq.shift()).error, /reg delete failed \(denied\)/);
});
