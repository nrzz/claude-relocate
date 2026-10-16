import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { programPath, spawn } from "../src/spawn.mjs";
import { IS_WIN, tmpDir } from "./helpers.mjs";

const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);
const HERE = path.dirname(fileURLToPath(import.meta.url));

test("programPath gives the full path of the four programs that ship with Windows, and leaves every other name as it is", () => {
  const env = { SystemRoot: win("C:", "Windows") };
  const on = { platform: "win32", env, exists: () => true };
  assert.equal(programPath("reg", on), win("C:", "Windows", "System32", "reg.exe"));
  assert.equal(programPath("tasklist", on), win("C:", "Windows", "System32", "tasklist.exe"));
  assert.equal(programPath("setx", on), win("C:", "Windows", "System32", "setx.exe"));
  assert.equal(programPath("powershell", on), win("C:", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.equal(programPath("REG", on), win("C:", "Windows", "System32", "reg.exe"), "the case of the name does not matter on Windows");
  for (const other of ["claude", "git", "df", "ps", "pwsh", win("D:", "tools", "reg.exe")]) assert.equal(programPath(other, on), other);
  assert.equal(programPath("reg", { platform: "linux", env, exists: () => true }), "reg", "only on Windows");
  assert.equal(programPath("reg", { platform: "darwin", env, exists: () => true }), "reg");
});

test("programPath finds the Windows folder in SystemRoot, else windir, else C:/Windows, and keeps the plain name if the program is not there", () => {
  assert.equal(programPath("reg", { platform: "win32", env: { windir: win("E:", "WIN") }, exists: () => true }), win("E:", "WIN", "System32", "reg.exe"));
  assert.equal(programPath("reg", { platform: "win32", env: {}, exists: () => true }), win("C:", "Windows", "System32", "reg.exe"));
  assert.equal(programPath("reg", { platform: "win32", env: { SystemRoot: win("C:", "Windows") }, exists: () => false }), "reg");
});

test("spawn starts the real program: reg and tasklist on Windows, any program elsewhere, and returns what spawnSync returns", () => {
  const r = spawn(process.execPath, ["-e", "process.stdout.write('hi')"], { encoding: "utf8", windowsHide: true });
  assert.deepEqual([r.status, r.stdout], [0, "hi"]);
  if (IS_WIN) {
    const reg = spawn("reg", ["/?"], { encoding: "utf8", windowsHide: true });
    assert.equal(reg.status, 0);
    assert.match(reg.stdout, /REG/i);
    const list = spawn("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    assert.equal(list.status, 0);
    assert.match(list.stdout, /^"/);
  }
});

test("a reg.exe or tasklist.exe in the working folder is not started (Windows looks in the working folder first unless NoDefaultCurrentDirectoryInExePath is set)", { skip: !IS_WIN && "this is how Windows starts programs" }, (t) => {
  const dir = tmpDir("cr-spawn-");
  const system32 = path.join(process.env.SystemRoot || process.env.windir || "", "System32");
  for (const name of ["reg.exe", "tasklist.exe"]) fs.copyFileSync(path.join(system32, "hostname.exe"), path.join(dir, name)); // a harmless stand-in: with these arguments it prints nothing
  const env = { ...process.env };
  delete env.NoDefaultCurrentDirectoryInExePath;
  const url = pathToFileURL(path.join(HERE, "..", "src", "spawn.mjs")).href;
  const script = [
    `import { spawn } from ${JSON.stringify(url)};`,
    'import { spawnSync } from "node:child_process";',
    'const args = ["/FO", "CSV", "/NH"];',
    'const plain = spawnSync("tasklist", args, { encoding: "utf8", windowsHide: true });',
    'const ours = spawn("tasklist", args, { encoding: "utf8", windowsHide: true });',
    "console.log(JSON.stringify({ plain: plain.stdout || '', ours: ours.stdout || '' }));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  if (out.plain.startsWith('"')) { t.skip("this Node does not look in the working folder first, so a plain name is safe here"); return; }
  assert.equal(out.plain, "", "a plain name started the stand-in in the working folder");
  assert.match(out.ours, /^"/, "spawn started the real tasklist, not the file in the working folder");
});
