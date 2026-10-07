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
The repository now resolves to `goujandev/pantheon` (verified via GitHub's API);
release tooling uses that canonical identity. The existing `goujandev/kitty`
download/feed URLs redirect correctly and remain stable for installed clients.
The signing key keeps its real filename and public key. The rebrand alone is not
a release: increment versions and complete the gates below before distribution.

## Fast publication

The Windows installer is built **before publication**, in the normal CI run for
each push to `main`. CI keeps the existing TypeScript, contract, frontend tests,
Rust formatting/lints/tests and generated-file checks, then packages a complete
NSIS installer. It uploads `pantheon-windows-<source SHA>` with a receipt binding
the installer filename, size and SHA-256 to the exact source, version, repository,
public key and completed gates. Pull requests run checks without producing a
publishable artifact. Publication requires the whole CI run to finish successfully.

CI shares a `windows` Rust cache, including workspace crates, and caches pinned
speech archives. Resource preparation and frontend building happen once; the
packaging-only configuration disables the repeated Tauri pre-build hook and
defers updater signing to the machine holding the existing key. It does not
change the production public key, endpoint or bundled resources.

For a release, prepare the next version **while implementing the change**, before
pushing the source that CI builds. A finished artifact for a published version
can be inspected but cannot be republished. A version bump after CI requires a
new CI build because it changes the executable and installer bytes.

When the exact source is ready and the user has requested publication, run:

```powershell
npm run release:fast -- --notes-file <release-notes-file>
```

The command selects a successful CI run for local `HEAD`, downloads only its
release-ready artifact, checks its receipt and hash, signs locally, verifies
the signature and tamper rejection against the committed public key, and
publishes the installer, signature and matching `latest.json`. It does not
rebuild, rerun tests or dispatch a native verifier workflow. A ready artifact
removes native compilation from the publication wait; remaining time depends
on artifact download and release upload speeds. It is not an instant-build
promise for source that has not passed CI yet.

Use `npm run release:fast -- --inspect` to check readiness without signing or
publishing. Add `--run-id <successful-CI-run-id>` to select a particular run;
the exact-source and version checks still apply. The optional **Release readiness**
workflow does the same read-only inspection of current `main`. Tags do not start
another build or publish automatically. Artifacts are retained for 14 days;
missing or expired artifacts require a new successful CI run.

## One-time setup

The signing key is at C:\Users\gouja\.tauri\kitty-updater.key, outside the repository. Its matching public key is committed in src-tauri/tauri.conf.json. The generated key has an empty password. Back it up securely and retain it for every release; replacing the public key breaks updates for already-installed clients. Never commit the private key.

Keep the private key on its authorized machine. The fast path uses local signing
and does not need a GitHub signing secret. Authenticate the GitHub CLI on that
machine with access to Actions artifacts and release publication in the
[existing repository](https://github.com/goujandev/kitty). Neither CI nor the
readiness workflow can publish: their repository permissions are read-only.

The repository and release assets must be public: clients have no GitHub
credentials. Updater signatures are separate from Windows Authenticode signing.

## Publishing

1. Increase version consistently in package.json, package-lock.json (also packages[""].version), Cargo.toml workspace.package.version, and src-tauri/tauri.conf.json. Refresh the workspace package versions in Cargo.lock and commit them. Stable SemVer only; `node scripts/check-release.mjs v<version>` verifies consistency.
2. Commit and push the prepared source to `main`. Let that one CI run complete checks, installer build and required installed smoke while development finishes. Do not create a release tag to start another build.
3. Once publication is requested, use `npm run release:fast -- --notes-file <release-notes-file>`. The exact-source receipt, newer stable version, installer hash, signature and manifest gates must pass. Do not rename generated assets.
4. The command publishes the versioned assets as a normal latest release. Drafts and prereleases do not enter /releases/latest/download/latest.json. Every newer stable release must include its signed installer and manifest. Interactive or hardware-dependent smoke requirements below remain applicable when their behavior changes.

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

CI runs `scripts/installed-rebrand-smoke.ps1` on a guarded,
disposable GitHub-hosted Windows runner. It installs verified v0.2.4, launches its
window, seeds synthetic history/appearance, performs the new installer `/UPDATE`,
checks old/new executable and shortcut migration, runtime resources and branded
startup, then verifies the original database and wallpaper. This covers installed
rebrand continuity. Interactive updater download/restart controls, live providers,
dictation hardware and existing taskbar pin caches remain separate manual checks.

CI reruns the installed test for installer, configuration, branding resources,
native startup/runtime, storage/schema/preferences, resource preparation or
dependency changes. It can inherit coverage only when those paths are unchanged
from the preceding push and that exact baseline has a successful CI run with an
unexpired release-ready artifact. Missing baseline evidence runs the test again.
The receipt records whether smoke ran or was inherited and the baseline SHA.
All frontend and native gates still run on every CI source.

References: https://v2.tauri.app/plugin/updater/ and https://github.com/tauri-apps/tauri-action.
