import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkVersions } from './check-release.mjs';
import { REPOSITORY, installerName, requiredGates, sha256, validateReceipt } from './release-artifact.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Receipts are produced only by checked CI');
assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
const sha = process.env.GITHUB_SHA;
assert.match(sha, /^[a-f0-9]{40}$/);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha);
execFileSync('git', ['diff', '--exit-code']);
execFileSync('git', ['diff', '--cached', '--exit-code']);
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = checkVersions(`v${config.version}`);
const filename = installerName(version);
const directory = 'target/release/bundle/nsis';
assert.ok(readdirSync(directory).includes(filename), 'Expected current Pantheon NSIS installer');
const bytes = readFileSync(join(directory, filename));
const receipt = {
  schema: 1, repository: REPOSITORY, sourceSha: sha, runId: process.env.GITHUB_RUN_ID,
  version, filename, size: bytes.length, sha256: sha256(bytes),
  publicKeySha256: sha256(Buffer.from(config.plugins.updater.pubkey.trim())),
  gates: requiredGates,
  installedSmoke: { status: process.env.PANTHEON_INSTALLED_SMOKE, baselineSha: process.env.PANTHEON_SMOKE_BASE_SHA || null },
};
validateReceipt(receipt, bytes, { sha, runId: process.env.GITHUB_RUN_ID, version, publicKey: config.plugins.updater.pubkey });
mkdirSync('target/release-ready', { recursive: true });
copyFileSync(join(directory, filename), join('target/release-ready', filename));
writeFileSync('target/release-ready/release-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(`Release-ready ${version}: ${filename}, ${receipt.sha256}, source ${sha}`);
