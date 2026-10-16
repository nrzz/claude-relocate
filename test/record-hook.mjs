// A hook for the real-binary checks: appends what Claude Code gave it (the event, the CLAUDE_* environment and the
// RELOCATE_* values, the working folder, the JSON on stdin) as one line to the file named by RELOCATE_LOG.
import fs from "node:fs";

// `node --test` also runs every file under test/: without RELOCATE_LOG this is not a hook run, so do nothing
// (reading stdin would block).
if (!process.env.RELOCATE_LOG) process.exit(0);

const label = process.argv[2] || "";
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
let input = null;
try { input = JSON.parse(raw); } catch { input = { unparsed: raw }; }
const env = {};
for (const [k, v] of Object.entries(process.env)) if (/^(CLAUDE|RELOCATE_)/.test(k) && k !== "RELOCATE_LOG") env[k] = v;
fs.appendFileSync(process.env.RELOCATE_LOG, `${JSON.stringify({ label, at: Date.now(), cwd: process.cwd(), env, input })}\n`);
