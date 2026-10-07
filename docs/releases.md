# Signed Windows updates

Pantheon uses Tauri 2's signed updater with the existing per-user NSIS installer,
introduced in v0.1.1. The approved reaching-hands logo in
`src-tauri/icon-source.png` supplies application icons. NSIS explicitly uses
`icons/icon.ico` for installer and uninstaller. Keep `dev.kitty.desktop` and
`currentUser` install mode unchanged to retain existing users' app data.

## Branding and upgrade continuity

The visible product, window title, executable, shortcuts and release titles are
Pantheon. Rust packages and frontend IPC use `pantheon` names. The canonical
logo is the latest approved monochrome reaching-hands raster; generate Windows
icons with `npm run tauri -- icon src-tauri/icon-source.png --output target/pantheon-icons`
and copy the existing Windows PNG/ICO filenames into `src-tauri/icons`. The
256-pixel PNG supplies the frontend mark; the 128-pixel PNG supplies the favicon.

`src-tauri/windows/installer.nsi` is based on Tauri CLI 2.11.4's
[official template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
under MIT (notice in `docs/licenses/Tauri-NSIS-MIT.txt`). It preserves deployed
uninstall/install-location registration keys while displaying Pantheon. It
captures the previous executable name before a manual upgrade's uninstall removes
the registry, then migrates matching Start menu/desktop shortcuts before the
updater's shortcut-creation skip. It checks both executable names for running
processes. Keep these local adaptations when updating the upstream template;
run `npm run test:branding` and repeat the installed upgrade smoke test.

The legacy application identifier, database filename `kitty.db`, historical SQL
migration strings, storage-key read fallbacks, and Windows registration keys are
intentional compatibility exceptions. They do not supply visible product text.
Never rename a live SQLite database or omit its WAL. New preference writes use
`pantheon` keys; existing values migrate without resetting wallpaper, theme, zoom,
tabs or sidebar state. Existing pins may need re-pinning if Windows caches an old
shortcut/icon; check this in an installed upgrade rather than assuming success.

The remote repository and update endpoint remain the existing public release
location. Do not rewrite their URLs until a remote rename/redirect is verified.
The signing key keeps its real filename and public key. The rebrand alone is not
a release: increment versions and complete the gates below before distribution.

## One-time setup

The signing key is at C:\Users\gouja\.tauri\kitty-updater.key, outside the repository. Its matching public key is committed in src-tauri/tauri.conf.json. The generated key has an empty password. Back it up securely and retain it for every release; replacing the public key breaks updates for already-installed clients. Never commit the private key.

In the [existing GitHub repository](https://github.com/goujandev/kitty), configure
Settings > Secrets and variables > Actions:

- TAURI_SIGNING_PRIVATE_KEY: the complete contents of kitty-updater.key.
- TAURI_SIGNING_PRIVATE_KEY_PASSWORD: optional; leave unset for the generated key's empty password.

The repository and release assets must be public: clients have no GitHub credentials. The workflow has contents: write permission via GITHUB_TOKEN. Updater signatures are separate from Windows Authenticode signing.

If the repository has no signing secret, the Release workflow builds the installer
on its disposable Windows runner and uploads it as an Actions artifact after the
checks and installed rebrand smoke pass. Download that exact artifact and sign it
locally with `npm run tauri -- signer sign --private-key-path <existing-key-path>`.
Keep the private key on its authorized machine. Upload the installer, generated
`.exe.sig` and matching `latest.json` to a draft. Dispatch Release with `verify_only`
enabled to validate that draft's manifest, installer signature and tamper rejection
against the committed public key, then publish it as latest after the run succeeds.
No signing-secret upload is required for this path.

## Publishing

1. Increase version consistently in package.json, package-lock.json (also packages[""].version), Cargo.toml workspace.package.version, and src-tauri/tauri.conf.json. Run cargo check to refresh Cargo.lock and commit it. Stable SemVer only.
2. Commit and push a tag matching the version, starting with v0.1.1. The Release workflow builds Windows x64 and creates a draft release. The manual trigger accepts an existing tag for retrying a failed draft build.
3. Confirm the draft contains the -setup.exe, its .exe.sig, and latest.json. The workflow checks the manifest version, versioned asset URL, windows-x86_64 entry, and embedded installer signature. It also cryptographically verifies the built installer against the app public key and confirms a modified installer is rejected. Do not rename generated assets.
4. Complete the installed-app smoke test, then publish the draft as a normal release and mark it latest. Drafts and prereleases do not enter /releases/latest/download/latest.json. Every newer stable release must include its signed installer and manifest.

Users of versions without the updater manually install v0.1.1 once. Subsequent releases can be downloaded and installed under Settings > Updates. App-data identity is unchanged, retaining projects and saved conversations.

## Local build

As of v0.2.3, the installer includes local dictation's pinned speech model and CPU
runtime. The Tauri pre-build command runs `scripts/prepare-dictation-pack.ps1`:
it verifies archive hashes, stages allowlisted resources plus licences, and
reuses cached downloads under `target/dictation-pack-downloads`. Generated
`src-tauri/resources/dictation` files stay out of Git. A fresh build machine needs
network access for preparation; installed dictation works without a first-use
download. All release checks must use this same resource configuration.
The script also finds the installed Visual Studio release x64 redistributables,
validates the four required VC++ DLLs' Microsoft signatures and architecture,
and stages them in ignored `src-tauri/resources/vc-runtime`. Tauri installs these
beside Pantheon.exe, with their redistribution notice. Build machines need the C++
redistributable component; end users need no separate VC++ installation.

Custom wallpapers and derived colours are application features, not bundled
personal assets. Releases retain `dev.kitty.desktop` and its existing app-data
folder, preserving saved wallpaper, theme, zoom, chats and attachments. Never
package a local database, wallpaper copy, provider credentials or preview files.

Workspace cleanup removes obsolete generated prototypes and build caches only
after release verification. Keep the current signed installer, signature and
manifest, required speech resources/licences, source fixtures and development
dependencies. Removed Cargo caches are regenerated by the next native build.

On the machine holding the key, in PowerShell:

    $env:TAURI_SIGNING_PRIVATE_KEY = 'C:\Users\gouja\.tauri\kitty-updater.key'
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    npm run bundle -- --ci -- --locked

Output: target/release/bundle/nsis. Developers without the key can build without bundling using npm run tauri -- build --no-bundle. Never distribute an updater-enabled client with a different public key.

## Installed Windows smoke test

Use a disposable Windows account or VM and two increasing signed versions using the committed public key. A local uncommitted Tauri configuration may override plugins.updater.endpoints to a controlled HTTPS feed or staging GitHub repository. Never disable signature verification or change the production endpoint for distribution.

- Manually install the older build; launch and open Settings > Updates. Check starts automatically, the installed version appears, and the workspace has no update banner.
- Serve a matching version: confirm up-to-date status. Serve the newer signed build and click Check for updates: confirm version and notes.
- Download, close and reopen Settings: progress persists. Disconnect networking: a retryable error appears. Serve a mismatched signature: verification rejects the update and installation is unavailable.
- Download a valid update. Run an agent turn: Restart and install is disabled. After it finishes, click Restart and install. Pantheon exits, passive NSIS progress appears, and the newer Pantheon relaunches. Confirm saved projects and history persist.
- Check again: up to date. Launch offline: normal app operation continues and the check error stays in Settings. Retry online.

npm run test:updates checks Settings rendering and exercises the controller with simulated Tauri events: progress, duplicate requests, signature/download rejection, unknown lengths, restart gating, retries and release contracts. A signed installer build verifies native packaging. These tests do not replace the two-version installed Windows smoke test.

The Release workflow also runs `scripts/installed-rebrand-smoke.ps1` on a guarded,
disposable GitHub-hosted Windows runner. It installs verified v0.2.4, launches its
window, seeds synthetic history/appearance, performs the new installer `/UPDATE`,
checks old/new executable and shortcut migration, runtime resources and branded
startup, then verifies the original database and wallpaper. This covers installed
rebrand continuity. Interactive updater download/restart controls, live providers,
dictation hardware and existing taskbar pin caches remain separate manual checks.

References: https://v2.tauri.app/plugin/updater/ and https://github.com/tauri-apps/tauri-action.
