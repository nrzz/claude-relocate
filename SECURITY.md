# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-relocate/security/advisories/new](https://github.com/nrzz/claude-relocate/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool does, and does not do

It moves the Claude Code config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude` and the `~/.claude.json` next to it) and sets `CLAUDE_CONFIG_DIR` to match. It opens no network connection and has no telemetry or account.

- **Reads:** the names, sizes and file times of everything in the config folder, and the text of `settings.json` and `settings.local.json` (to find the hook and status line scripts that live in the folder, and the lines that spell its path). It does not parse a session, a credential file or `.claude.json`; a copy to another drive carries their bytes, as it carries every file.
- **Writes, only with `move --yes` or `undo --yes`:** the new folder and `relocate-manifest.json` in it; the blocks between `# claude-relocate start` and `# claude-relocate end` in the shell profiles that exist (bash, zsh, fish, PowerShell), each after a backup next to it; on Windows the `CLAUDE_CONFIG_DIR` value in the user environment (`HKCU\Environment`, through `reg.exe`); with `--link` a junction or symbolic link at the old place. Without `--yes` nothing is changed, and `--dry-run` lists the steps.
- **Starts programs:** `tasklist` or `ps` (is a claude process running), `cmd.exe` (to run `chcp` and `reg query` in a UTF-8 console), `reg` and `setx` (Windows), `df` or PowerShell for free space on a Node older than 18.15, and `claude --version` in `verify`. The Windows programs are started by their full path under `%SystemRoot%\System32`, not by a bare name, because Windows looks in the working folder first when it is given one (unless `NoDefaultCurrentDirectoryInExePath` is set) and a `reg.exe` from a download could be sitting there. `setx` is used only to make Windows announce a change of the user environment: the tool sets a throwaway variable, `CLAUDE_RELOCATE_NOTIFY`, and removes it again.
- **Credentials:** the file Claude Code keeps them in (`.credentials.json`) moves with the folder like any other file, with its permissions. The macOS keychain entry is neither read nor moved.
- **Deletes:** a copy to another drive removes the original only after the copy has been compared with it, file by file; a rename deletes nothing. A link is removed as a link, never followed. A profile this tool created is deleted again by `undo` only if nothing else is in it. A profile that is not UTF-8 text is not touched.

`undo` trusts the manifest it finds: it moves the folder the manifest names back to the place the manifest names, and edits the profile files the manifest lists. It refuses a manifest that does not name this tool and this schema, but anyone who can write to your home folder can plant one, so run `undo --dry-run` first and read the steps, and do not run `undo` on a manifest from a move you did not make.
