# Roadmap

What could come next. None of it is promised; all of it is open to contributors. Comment on an issue or start a [discussion](https://github.com/nrzz/claude-relocate/discussions) before a large change.

- **`plan` and `status` show the free space of the drive the config folder is on** ([good first issue #1](https://github.com/nrzz/claude-relocate/issues/1)). The full-drive complaint that makes people move the folder is easier to see next to the numbers.
- **PowerShell profiles in a redirected Documents folder.** `move` looks for `profile.ps1` under `~/Documents`; with Documents redirected to OneDrive the file is elsewhere. Ask the registry where Documents is. The Windows user environment already covers every shell, so this only matters for people who also keep the variable in their profile.
- **More shells.** nushell, xonsh and csh/tcsh get no block today (the plan says so and names the value to set by hand). Each needs a way to quote a path, a way to read it back, and the profile file to look for.
- **Move only part of the folder.** `move --only sessions` or `--only plugin-cache`, leaving the rest in place, for the person whose C: drive is full of `projects/` and little else. `--xdg` already knows which parts are state and which are cache.
- **macOS and Linux checks beyond CI.** CI runs the whole suite and the real-binary checks there, but the author's machine is Windows. A report from macOS on how the login (keychain) and the desktop app react to a moved folder would settle what the README now lists as not verified.
