# Signed Windows updates

Kitty v0.1.1 introduces Tauri 2's signed updater with the existing per-user NSIS installer. The approved black-and-white logo in src-tauri/icon-source.svg supplies application icons. NSIS explicitly uses icons/icon.ico for installer and uninstaller. Keep dev.kitty.desktop and currentUser install mode unchanged so updates replace the same installation and retain user data.

## One-time setup

The signing key is at C:\Users\gouja\.tauri\kitty-updater.key, outside the repository. Its matching public key is committed in src-tauri/tauri.conf.json. The generated key has an empty password. Back it up securely and retain it for every release; replacing the public key breaks updates for already-installed clients. Never commit the private key.

In goujandev/kitty, configure Settings > Secrets and variables > Actions:

- TAURI_SIGNING_PRIVATE_KEY: the complete contents of kitty-updater.key.
- TAURI_SIGNING_PRIVATE_KEY_PASSWORD: optional; leave unset for the generated key's empty password.

The repository and release assets must be public: clients have no GitHub credentials. The workflow has contents: write permission via GITHUB_TOKEN. Updater signatures are separate from Windows Authenticode signing.

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
beside Kitty.exe, with their redistribution notice. Build machines need the C++
redistributable component; end users need no separate VC++ installation.

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
- Download a valid update. Run an agent turn: Restart and install is disabled. After it finishes, click Restart and install. Kitty exits, passive NSIS progress appears, and the newer Kitty relaunches. Confirm saved projects and history persist.
- Check again: up to date. Launch offline: normal app operation continues and the check error stays in Settings. Retry online.

npm run test:updates checks Settings rendering and exercises the controller with simulated Tauri events: progress, duplicate requests, signature/download rejection, unknown lengths, restart gating, retries and release contracts. A signed installer build verifies native packaging. These tests do not replace the two-version installed Windows smoke test.

References: https://v2.tauri.app/plugin/updater/ and https://github.com/tauri-apps/tauri-action.
