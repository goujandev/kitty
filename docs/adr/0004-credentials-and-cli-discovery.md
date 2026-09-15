# ADR-0004: Credentials, CLI discovery and usage reporting

Status: proposed

## Context

kitty holds no model credentials. If `claude` and `codex` are installed and
logged in, kitty works. That is the entire auth story for inference, and it is
why the prototype needs no API keys.

Three adjacent problems remain: finding the CLI binaries, knowing whether each
is logged in, and showing subscription usage.

On Windows the two credential stores that matter are plain files:

```
%USERPROFILE%\.claude\.credentials.json   accessToken, refreshToken, expiresAt,
                                          refreshTokenExpiresAt, scopes,
                                          subscriptionType, rateLimitTier
%USERPROFILE%\.codex\auth.json            auth_mode, OPENAI_API_KEY,
                                          tokens{id_token, access_token,
                                          refresh_token, account_id},
                                          last_refresh
```

Both were confirmed present and in that shape on the development machine.
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` relocate them and must be honoured.

MonoCode's approach to usage is the one thing in that codebase worth
deliberately not copying. For the Claude usage meter it reads that credentials
file, performs the OAuth refresh-token grant itself against the vendor's token
endpoint using the vendor's hard-coded OAuth client id, sends
`User-Agent: claude-code/2.1.0`, and writes the rotated credentials back over
the vendor's own store. Its Codex path does the opposite and is the good
example: it spawns the Codex app-server and asks it for rate limits, touching
no credential file at all.

## Decision

### Never write another tool's credential store

No writes to vendor credential files. No refresh-token grants. No vendor user
agents or client ids.

The reasons are practical before they are anything else. Rotating a refresh
token in a file that a running vendor process also owns can log the user out of
their real tool or corrupt the store, and refresh tokens typically rotate, so
the vendor's copy becomes stale the moment we use ours. Impersonating a vendor
client id and user agent is also the behaviour most likely to draw a response
from a provider. Upstream MonoCode has an open pull request titled "stop
rotating Claude's OAuth token", so this is recognized there too.

### Usage: ask the CLI first, read-only file second, nothing third

**Confirmed better than expected (2026-09-15).** Claude Code's stream-json
output emits a `rate_limit_event` in-band on every turn, carrying
`unifiedWindows.five_hour` and `seven_day` utilisation and reset times. Codex
answers `account/rateLimits/read` over its app-server. So both vendors hand us
the usage data directly, and kitty never needs to read a credential file to
show it, let alone refresh a token. `MonoCode` impersonates Anthropic's OAuth
client to fetch the same numbers it could have read out of the stream.

1. If the CLI can report usage over its own protocol, use that. This is free,
   correct, and needs no credential access.
2. Otherwise read the credential file read-only, purely to display status and
   expiry. Never refresh, never write.
3. If the token is expired, show which command refreshes it rather than doing
   it. "Your Claude Code session expired, run `claude` to refresh" is a better
   outcome than a silent rotation.

### CLI discovery

A `BinarySpec` per manifest lists candidate locations in order, honours the
relevant environment overrides, and falls back to `PATH`. Candidates include
`%APPDATA%\npm`, where a globally npm-installed CLI lands, and the `.cmd` and
`.ps1` shims npm generates alongside the real executable.

Windows hands a GUI process the environment that existed when it launched, so
a CLI installed while kitty is running is invisible until the environment is
re-read. We re-read the user and machine environment on demand and expose a
rescan action, rather than telling the user to restart the app.

Identity is confirmed structurally: a version subcommand with parseable output,
or a known install path. Not by running `--help` and string-matching its prose,
which MonoCode does in three near-identical functions, making a CLI's identity
depend on its help copy.

Discovery results are cached with the binary's path, size and mtime, so a
launch does not re-probe every CLI.

### Availability is a first-class state

Each harness resolves to `Available { version }`, `NotFound`,
`NotLoggedIn { hint }`, or `VersionUnsupported { found, required }`. The model
picker shows unavailable harnesses with the reason and the exact command that
fixes it, rather than hiding them.

### Our own secrets

If kitty later stores a token for a non-model integration, it goes through the
Windows Credential Manager via DPAPI, not into a plaintext file. MonoCode
writes its GitLab and Linear tokens as plaintext in its app data directory; we
will not.

## Consequences

- We expected to show usage less precisely than a client that refreshes the
  token, and accepted that. It turned out not to be a trade at all: both CLIs
  report usage themselves, so kitty gets the same numbers without touching a
  credential file. The restraint cost nothing.
- The user must log in with the vendor CLI once. That is already true of
  MonoCode and is the premise of the product.
- If a provider blocks third-party clients, kitty is unaffected, because
  inference goes through the vendor's own binary.
