import test from "node:test";
import assert from "node:assert/strict";
import { isClaudeName, listClaudeProcesses, parsePsArgs, parsePsComm, parseTasklist } from "../src/procs.mjs";
import { spawnSync } from "node:child_process";
import { IS_WIN, startFakeClaude } from "./helpers.mjs";

// What tasklist /FO CSV /NH printed on the machine the tool was written on (Windows 11), cut down.
const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"claude.exe","12640","Console","1","3,32,976 K"',
  '"Claude.exe","16556","Console","1","5,112 K"',
  '"node.exe","777","Console","1","40,000 K"',
  '"claude-relocate.exe","778","Console","1","1 K"',
  '"weird ""quoted"" name.exe","9","Console","1","1 K"',
  "",
].join("\r\n");

test("isClaudeName: claude and claude.exe in any case, nothing that only starts with claude", () => {
  for (const n of ["claude", "claude.exe", "Claude.exe", "CLAUDE.EXE", " claude "]) assert.ok(isClaudeName(n), n);
  for (const n of ["claudette", "claude-relocate", "claude.exe.bak", "claude-code", "node", "", "myclaude"]) assert.ok(!isClaudeName(n), n);
});

test("parseTasklist reads CSV rows, quotes and thousands separators, and skips the sentence it prints for no match", () => {
  const rows = parseTasklist(TASKLIST);
  assert.deepEqual(rows.map((r) => r.pid), [0, 12640, 16556, 777, 778, 9]);
  assert.equal(rows[1].name, "claude.exe");
  assert.equal(rows[5].name, 'weird "quoted" name.exe');
  assert.deepEqual(parseTasklist("INFO: No tasks are running which match the specified criteria.\r\n"), []);
  assert.deepEqual(parseTasklist("INFO: Es werden keine Tasks ausgeführt, die den angegebenen Kriterien entsprechen.\n"), []);
  assert.deepEqual(parseTasklist(""), []);
});

test("parsePsComm: Linux shows the process name, macOS the path of the program", () => {
  const linux = "    1 systemd\n 4242 claude\n 4243 node\n";
  const mac = "  501 /usr/sbin/cfprefsd\n 9001 /Users/me/.local/bin/claude\n 9002 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n";
  assert.deepEqual(parsePsComm(linux).map((p) => [p.pid, p.name]), [[1, "systemd"], [4242, "claude"], [4243, "node"]]);
  assert.deepEqual(parsePsComm(mac).map((p) => [p.pid, p.name]), [[501, "cfprefsd"], [9001, "claude"], [9002, "Electron"]]);
});

test("parsePsArgs keeps the whole command line", () => {
  const rows = parsePsArgs("  10 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume\n  11 /bin/zsh -l\n");
  assert.deepEqual(rows, [{ pid: 10, args: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume" }, { pid: 11, args: "/bin/zsh -l" }]);
});

const result = (stdout, status = 0) => ({ stdout, stderr: "", status });

test("on Windows only claude.exe is a claude process (tasklist)", () => {
  const r = listClaudeProcesses({ platform: "win32", run: (cmd, args) => { assert.equal(cmd, "tasklist"); assert.deepEqual(args, ["/FO", "CSV", "/NH"]); return result(TASKLIST); } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.processes.map((p) => p.pid), [12640, 16556]);
});

test("on Linux and macOS a process called claude, and node running @anthropic-ai/claude-code, are claude processes (ps)", () => {
  const run = (cmd, args) => {
    assert.equal(cmd, "ps");
    return args.join(" ") === "-A -o pid=,comm=" ? result(" 4242 claude\n 4243 node\n 4244 vim\n") : result(" 4242 /home/me/.local/bin/claude\n 4243 node /home/me/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js\n 4244 vim claude\n 4245 npm install -g @anthropic-ai/claude-code\n");
  };
  const r = listClaudeProcesses({ platform: "linux", run });
  assert.equal(r.ok, true);
  assert.deepEqual(r.processes.map((p) => [p.pid, p.name]), [[4242, "claude"], [4243, "node (Claude Code)"]]);
});

test("the process asking is never counted, and a failing tasklist or ps is reported, not ignored", () => {
  const self = process.pid;
  const rows = `"claude.exe","${self}","Console","1","1 K"\r\n"claude.exe","5","Console","1","1 K"\r\n`;
  assert.deepEqual(listClaudeProcesses({ platform: "win32", run: () => result(rows) }).processes.map((p) => p.pid), [5]);
  const bad = listClaudeProcesses({ platform: "win32", run: () => ({ status: 1, stdout: "", stderr: "Access denied" }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /tasklist failed/);
  const missing = listClaudeProcesses({ platform: "linux", run: () => ({ error: new Error("spawn ps ENOENT"), status: null, stdout: "" }) });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ps failed/);
  const thrown = listClaudeProcesses({ platform: "linux", run: () => { throw new Error("boom"); } });
  assert.equal(thrown.ok, false);
});

test("the real tasklist or ps finds a running program called claude", () => {
  const p = startFakeClaude();
  try {
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const r = listClaudeProcesses();
      assert.equal(r.ok, true, r.error);
      found = r.processes.some((x) => x.pid === p.pid);
      if (!found) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    const seen = IS_WIN ? "" : spawnSync("ps", ["-p", String(p.pid), "-o", "pid=,comm=,args="], { encoding: "utf8" }).stdout;
    assert.ok(found, `the process called claude was listed (ps says: ${JSON.stringify(seen)})`);
  } finally { p.stop(); }
});
