# Demo screencast — recording script

A ~25-second recording that shows the plugin working through chat. Replace the
"Demo screencast coming soon" line in README.md with the resulting GIF/MP4.

## Tools to record

- **Terminal + opencode TUI** — simplest; record with `OBS`, `peek`, `kooha`, or `asciinema` (→ gif).
- **vhs** (Charm, `brew install vhs`) — declarative terminal GIFs from a `.tape` file (best for crisp, reproducible demos).

## Script (what to show)

Open opencode in a project, then type these in the chat, one by one:

1. **"show pinned sessions"** → `sm_list` returns "No pinned sessions." (clean starting point)
2. **"pin this session"** → `Pinned: <title> (ses_...)`
3. **"show pinned sessions"** → now the table shows it + the `opencode -s ses_…` resume line
4. **"back up this session"** → `Backed up: <title>` + restore hint
5. **"show settings"** → settings table (autoCleanup, pinned count = 1)

Keep each step on screen ~3s. Total ~25s. Trim to the essential.

## After recording

- Save as `demo/demo.gif` (or host on Imgur/GitHub and link the URL).
- In README.md, replace:
  ```
  > 🎬 **Demo screencast coming soon** — ...
  ```
  with:
  ```
  ![Demo: pin, back up, restore a session through chat](demo/demo.gif)
  ```
- Commit + republish (bump patch) so the npm-page README shows the GIF.
