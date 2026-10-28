// Running the real claude binary at zero cost, for the checks that need it (test/e2e-claude.test.mjs).
//
// A check runs only when E2E_CLAUDE names a Claude Code binary ("claude" on a CI machine after
// `npm install -g @anthropic-ai/claude-code`, or the full path to claude.exe). Otherwise it is skipped, and
// `npm test` needs nothing but Node. The binary runs in a throwaway folder with its own config folder and home,
// with an environment scrubbed of every CLAUDE_* and ANTHROPIC_* variable of the machine, and with
// ANTHROPIC_BASE_URL pointing at a tiny server on 127.0.0.1 that answers with fixed text. No request leaves the
// machine, no token is spent, no login is needed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../src/verify.mjs";
import { prependPath, runCli, tmpDir, world } from "./helpers.mjs";

export const CLAUDE = process.env.E2E_CLAUDE || "";
export const RECORD = fileURLToPath(new URL("./record-hook.mjs", import.meta.url));
const IS_WIN = process.platform === "win32";
const USAGE = { input_tokens: 1, output_tokens: 1 };
const shell = () => IS_WIN && !/\.exe$/i.test(CLAUDE);

// { ok, version, reason }: whether E2E_CLAUDE is set and runs.
let info;
export function claudeInfo() {
  if (info) return info;
  if (!CLAUDE) return (info = { ok: false, version: "", reason: "E2E_CLAUDE is not set (point it at a claude binary to run the checks against the real thing)" });
  const home = tmpDir("cr-e2e-probe-");
  const r = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", timeout: 60000, windowsHide: true, shell: shell(), env: baseEnv({ CLAUDE_CONFIG_DIR: path.join(home, ".claude"), HOME: home, USERPROFILE: home }) });
  const version = (r.stdout || "").trim();
  info = r.status === 0 && version ? { ok: true, version, reason: "" } : { ok: false, version: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${(r.error && r.error.message) || (r.stderr || "").trim().slice(0, 120)}` };
  return info;
}
export const skip = () => (claudeInfo().ok ? false : claudeInfo().reason);

// Git Bash on Windows, so the Bash tool exists; nothing on the other systems.
function bashEnv() {
  if (!IS_WIN) return {};
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(line), "..", "bin", "bash.exe"));
  candidates.push("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe");
  for (const c of candidates) if (c && fs.existsSync(c)) return { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_GIT_BASH_PATH: path.resolve(c).replace(/\\/g, "/") };
  return {};
}

// The machine's environment without anything that could steer Claude Code (an API key, a base URL, the app that
// launched this test), plus `extra`.
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...bashEnv(), ...extra };
}

// The user id Claude Code keeps in .claude.json and sends, as metadata.user_id.device_id, with every request. A
// folder that holds this value in its .claude.json and is read from can be told apart from one that is not.
export const USER_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// A throwaway world for the binary, built on world() so that the tool can be run in it too: a home folder, a
// config folder (base/cfg, or ~/.claude with `variable: false`, where .claude.json sits next to it), a project
// folder that Claude Code already trusts, and a folder to move to.
export function sandbox(label, { variable = true } = {}) {
  const w = world(`e2e-${label}`, { variable, shell: "" });
  const work = path.join(w.base, "work");
  fs.mkdirSync(w.cfg, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [] };
  fs.writeFileSync(w.claudeJson, JSON.stringify({ hasCompletedOnboarding: true, userID: USER_ID, projects: { [work]: trusted, [work.replace(/\\/g, "/")]: trusted } }));
  const sb = { ...w, root: w.base, work, log: path.join(w.base, "events.jsonl") };
  // our own command line, as a child process, in this world; `shimDir` goes first on PATH
  sb.cli = (args, extraEnv = {}, shimDir = null) => runCli(args, { cwd: work, env: shimDir ? prependPath({ ...w.env, ...extraEnv }, shimDir) : { ...w.env, ...extraEnv } });
  return sb;
}

// A folder with a `claude` command in it that runs the binary under test, to put first on PATH: the tool's verify
// finds claude on PATH, and E2E_CLAUDE may be a full path or a name that is already on PATH.
export function claudeShimDir() {
  const target = path.isAbsolute(CLAUDE) ? CLAUDE : findOnPath(CLAUDE, process.env) || CLAUDE;
  const dir = tmpDir("cr-e2e-bin-");
  if (IS_WIN) fs.writeFileSync(path.join(dir, "claude.cmd"), `@echo off\r\n"${path.normalize(target)}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec "${target}" "$@"\n`);
    fs.chmodSync(path.join(dir, "claude"), 0o755);
  }
  return dir;
}

const msgStart = (id, model) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }];

// SSE events for an assistant message that says `text`.
export function textMessage(id, model, text) {
  return [
    msgStart(id, model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

// The fake Messages API: every request is recorded in `requests` and answered with `reply`, a text or a function
// (request, number) -> text.
export function fakeApi(reply = "PROBE-DONE") {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); // so a character split across two chunks still decodes
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* an empty probe request */ }
      requests.push(j);
      const n = requests.length;
      const text = typeof reply === "function" ? reply(j, n) : reply;
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [ev, data] of textMessage(`msg_${n}`, j.model, text)) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve({ port: server.address().port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }); }));
}

// What a request carried, as one string, for "did the history arrive" checks.
export const messagesOf = (request) => JSON.stringify((request && request.messages) || []);
// The device id in a request's metadata: the userID of the .claude.json the binary read.
export const deviceIdOf = (request) => { try { return JSON.parse(request.metadata.user_id).device_id; } catch { return null; } };

function killTree(child) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

// Runs claude in the sandbox's project folder, with CLAUDE_CONFIG_DIR at `cfg` (default: the sandbox's own; null:
// not set, so the binary uses ~/.claude). Resolves { code, out, err, result } (result: the --output-format json
// document, when the output is one).
export function runClaude(sb, api, args, { cfg = sb.cfg, timeout = 120000, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = baseEnv({ HOME: sb.home, USERPROFILE: sb.home, ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, RELOCATE_LOG: sb.log, ...env });
    if (cfg) childEnv.CLAUDE_CONFIG_DIR = cfg;
    const quoted = [CLAUDE, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    const child = shell() ? spawn(quoted, [], { cwd: sb.work, env: childEnv, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(CLAUDE, args, { cwd: sb.work, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    let out = "";
    let err = "";
    child.on("error", (e) => { err += String(e); });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => killTree(child), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* not json */ }
      resolve({ code, out, err, result });
    });
  });
}

// A claude subcommand that never calls the API (--version, plugin list ...), with CLAUDE_CONFIG_DIR at `cfg`.
export function claudeCommand(sb, args, { cfg = sb.cfg, timeout = 100000, env: extra = {} } = {}) {
  const env = baseEnv({ HOME: sb.home, USERPROFILE: sb.home, ...extra });
  if (cfg) env.CLAUDE_CONFIG_DIR = cfg;
  const r = spawnSync(CLAUDE, args, { encoding: "utf8", timeout, windowsHide: true, shell: shell(), env });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// What the recording hook wrote: one object per run, with { label, input, env, cwd }.
export function readLog(sb) {
  if (!fs.existsSync(sb.log)) return [];
  return fs.readFileSync(sb.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// A settings.hooks object with the recording hook on every listed event (exec form: node runs the script directly).
export function recordingHooks(events) {
  const hooks = {};
  for (const ev of events) hooks[ev] = [{ hooks: [{ type: "command", command: process.execPath, args: [RECORD, ev] }] }];
  return hooks;
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}
