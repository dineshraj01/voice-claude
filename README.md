# Voice Claude

Talk to Claude Code with your voice and hear its replies read aloud. No dependencies beyond Node and the `claude` CLI.

## Run

```sh
node ~/Documents/voice-claude/server.js
```

A Chrome tab opens at http://localhost:4317. Allow the microphone the first time.

The server restarts itself whenever `server.js` changes, using Node's built-in `--watch`. Edits to `public/index.html`
only need a browser reload. A restart stops any Claude turn that's in progress. Set `NO_WATCH=1` to turn auto-restart off.

## Home page

Lists every Claude Code session on this Mac (from `~/.claude/projects`), grouped by directory, newest first.

- **Click a session** to open it. You see the earlier conversation and can continue it by voice.
  It's the same session as in the terminal, so `claude --resume` shows what you said here too.
- **Remove** takes a session off the home page. The session itself is not deleted.
  **Show removed** lets you put it back. The list of removed sessions is saved in `state.json`.
- **New session** (or **+ New here** on a directory) starts a fresh conversation in any folder.
  An optional folder argument to `server.js` sets the default folder for new sessions.

- **Talk:** press the big button, `Space`, or your AirPods. Press again to send.
- **Interrupt:** press while Claude is working or talking, and it starts listening again.
- **Esc** stops the voice.
- Settings (top right) let you pick the voice, set the speed, and turn tool announcements on or off.

## Config (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_PERMISSION_MODE` | `auto` | Default permission mode. Change it per message with the picker in the top bar: Auto, Accept edits, Ask first, Plan only |
| `CLAUDE_MODEL` | Claude Code default | Passed to `--model` |
| `PORT` | `4317` | Local port |
| `NO_OPEN` | unset | Set to `1` if you don't want a browser tab opened |
| `NO_WATCH` | unset | Set to `1` to turn off auto-restart on code changes |

## Files and images

- **Drag files** anywhere onto a conversation, or **paste** (⌘V) an image. They show in a tray above the text box until you send.
- **Images** (pasted or dropped) go straight to Claude. No copy is saved.
- **Other files** are copied to a temporary folder (`$TMPDIR/voice-claude-uploads`), and Claude is given each copy's path.
  Copies are deleted after a day. The browser never sees the original file's location.
- Folders can't be dropped; say the folder's path instead.

## When Claude needs you

Every turn runs in **auto** mode. When Claude still needs a decision, it asks you out loud and shows a card:

- **Permission requests** ("Claude wants to run a command"): tap **Allow**, **Always allow** or **Deny**, or press the mic
  and say *yes*, *no* or *always*. Anything else you say, like "no, run the tests first", is passed to Claude as an instruction.
  **Always allow** saves a rule to that project's `.claude/settings.local.json`.
- **Questions** (Claude's multiple-choice questions): tap an option, or say it: "SQLite", "the second one", "the last one".
  If what you say doesn't match an option, it's sent as your own answer.

While Claude is waiting, the mic button turns amber, and pressing it answers the question instead of interrupting.

## Notes

- **More natural voice:** System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, then
  download a *Premium* voice (Ava, Zoe, Evan…). Reload the page and pick it under Settings.
- **AirPods button:** click the page once so it can take over media controls. The stem press then toggles the mic,
  and nothing else should be playing media at the same time. When the AirPods mic is on, macOS drops their audio to
  call quality. It switches back to full quality as soon as you stop talking.
- Speech recognition uses Chrome's built-in engine, which sends audio to Google. Safari also works.
- Avoid talking to a session here while the same session is open in a terminal, because both would write to it at once.
- The server listens on 127.0.0.1 only and rejects requests from other websites.
