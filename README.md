# Kitty

A Windows desktop workspace for the coding agents you already use.

## Download and install

1. Open the [latest release](https://github.com/goujandev/kitty/releases/latest).
2. Download the Windows x64 file ending in `-setup.exe`.
3. Run the installer, then open **Kitty** from the Start menu.

The installer includes the app and an uninstaller, and installs for your Windows user account. It can install Microsoft Edge WebView2 if needed. You do not need Node.js, Rust, or Visual Studio to run the installed app.

Kitty uses your locally installed **Codex** or **Claude Code** CLI for agent conversations. Install and sign in to at least one of those agents, then open a project folder in Kitty. The agent settings show which agents are available.

## Updates

Kitty checks for updates at launch. Open **Settings > Updates** to check manually, download a new version, and restart to install it. Earlier versions need one manual installation of v0.1.1 or newer; later releases update through the app.

## Workspace

Kitty is a project-based chat for coding agents you already pay for. It talks to
your locally installed, signed-in **Codex** or **Claude Code** CLI, so your existing
ChatGPT or Claude subscription is what does the work. Kitty never copies, changes
or refreshes either tool's sign-in; the CLI stays in charge of authentication,
sessions and models.

1. **New project** (Ctrl+O) adds a folder and opens a new chat in it. Adding a
   folder that is already a project selects it instead of duplicating it.
2. **New chat** (Ctrl+N) opens an unsaved draft in the current project with the
   cursor in the message box. It is saved only when you send the first message.
3. Choose Codex or Claude Code and an available model and reasoning level from
   the message box.
4. Send messages straight to that agent.

Chats you open stay open as **tabs** in the title bar, per project, so you can switch between them with the sidebar closed (Ctrl+B hides it entirely). Ctrl+Tab and Ctrl+Shift+Tab move between tabs; Ctrl+W closes one, which never deletes the chat. Each chat in the sidebar shows its provider and model.

After a chat's first message, its own agent (Claude Code or Codex) is asked once, in a short throwaway call that is not saved to either tool's history, for a two-to-four-word title such as "Redesign UI". This uses a small amount of that subscription. Until the title arrives, or if the call fails, the chat is named from its first line, and a name you choose is never replaced.

Projects in the sidebar expand to show their chats. Each project and chat has a
"⋯" menu, also opened by right-click or Shift+F10:
- **Rename** (F2, or double-click). A chat can also be renamed by clicking its
  title in the title bar. A project's name is only its label in Kitty; the folder
  on disk is never renamed or moved.
- **Archive** (chats) hides a chat under the project's **Archived** list and keeps
  its history. **Restore**, or sending a message, brings it back.
- **Delete** (chats) permanently removes Kitty's copy of the conversation after a
  confirmation. Project files are not touched, and Codex or Claude Code keep
  their own session records.
- **Remove from Kitty** (projects) deletes Kitty's record and stored chats for
  the project after a confirmation. The folder and its files always stay on disk.

- Streaming replies, grouped tool activity, permission requests, Stop, errors and
  a clear Working / Done / Failed state, both in the chat and as project badges in
  the sidebar for conversations running in the background.
- Permissions per conversation: Auto-approve all (default), Auto-approve edits,
  or Ask me.
- Conversations and their history are saved and reopen where you left off;
  search covers every saved conversation.
- A chat details pane and appearance settings with System, Light, Dark, Nord,
  Catppuccin Mocha, and Solarized Light themes. The interface is adapted from
  T3 Code; see [provenance](docs/T3-UI-PROVENANCE.md).

Kitty is a local agent workspace. Pull requests, cloud automations, and integrated editor or terminal services are not included.

If Codex's saved conversation is missing, Kitty automatically starts fresh agent
context and quietly keeps your visible chat history. It never replays old requests.
Other startup failures remain visible; **Start fresh agent context** is still
available for manual recovery when appropriate.

## Local dictation

Press the microphone beside Send to record. Kitty shows activity and keeps the
recognized words hidden until you finish. The microphone becomes a Stop button;
press Stop to put the
finished text into the message box for editing, or press Send while recording
to finish transcription and send directly. The X beside the waveform or Escape discards the
recording and keeps your original draft. Changing chats also cancels dictation.

The Windows installer includes the speech model and runtime. First use prepares
these installed files locally; dictation requires no separate download, account
or API key. Kitty uses Handy's English Moonshine Small recognition stack, with
no LLM cleanup, and supports English recordings up to two minutes.
The microphone closes after recording and the model unloads after recognition.
See [implementation and validation](docs/DICTATION.md) for limits and attribution.

During recording, a live volume waveform fills the space between the model
controls and Stop. It shows incoming audio without displaying words. These controls
use the existing footer, keeping the prompt box the same height.

## Develop

On Windows, install Node.js, Rust 1.88 or later with the MSVC toolchain, and Microsoft C++ Build Tools with the Windows SDK. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
npm ci
npm start
```

For quick visual work, `npm run dev` opens the real interface in an ordinary browser at http://localhost:1420. A development-only pretend host supplies sample projects, chats and streamed replies, and edits appear immediately. To preview your own wallpaper there, copy it to `preview-local/background.jpg` (gitignored) or choose one in Settings › Appearance. The pretend host is never included in builds.

Windows builds prepare the pinned speech pack with
`scripts/prepare-dictation-pack.ps1`. The script verifies archive hashes, includes
licensing notices and creates ignored resources for the installer. Build machines
need network access once; the verified archives are then cached under `target`.

To build the Windows installer:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE '.tauri/kitty-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npm run bundle -- --ci -- --locked
```

The installer is written to `target/release/bundle/nsis/`. See [release setup and verification](docs/releases.md) for signing secrets, publishing, and the installed-app smoke test.

## Checks

```powershell
npm run check
npm run test:updates
npm run test:activity
npm run test:workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build
```
