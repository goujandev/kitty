# Kitty

A Windows desktop workspace for the coding agents you already use.

## Download and install

1. Open the [latest release](https://github.com/goujandev/kitty/releases/latest).
2. Download the Windows x64 file ending in `-setup.exe`.
3. Run the installer, then open **Kitty** from the Start menu.

The installer includes the app and an uninstaller, and installs for your Windows user account. It can install Microsoft Edge WebView2 if needed. You do not need Node.js, Rust, or Visual Studio to run the installed app.

Kitty uses your locally installed **Codex** or **Claude Code** CLI for agent conversations. Install and sign in to at least one of those agents, then open a project folder in Kitty. The agent settings show which agents are available.

## Workspace

- Projects and conversations in one collapsible, resizable sidebar.
- Conversation tabs with in-memory drafts retained while switching views.
- A searchable thread library and full-history search.
- Model and reasoning controls, streaming replies, tool activity, and approval requests.
- A thread details pane, light and dark themes, and appearance settings.

Kitty is a local agent workspace. Pull requests, cloud automations, and integrated editor or terminal services are not included.

## Develop

On Windows, install Node.js, Rust with the MSVC toolchain, and Microsoft C++ Build Tools with the Windows SDK. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
npm ci
npm start
```

To build the Windows installer:

```powershell
npm run bundle -- -- --locked
```

The installer is written to `target/release/bundle/nsis/`.

## Checks

```powershell
npm run check
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build
```
