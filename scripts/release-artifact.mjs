import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const REPOSITORY = 'goujandev/pantheon';
// Installed clients still use this verified redirect. Keep their update URLs stable.
export const RELEASE_LOCATION = 'goujandev/kitty';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const installerName = version => `Pantheon_${version}_x64-setup.exe`;
export const requiredGates = ['frontend-checks', 'frontend-tests', 'rust-fmt', 'rust-clippy', 'rust-tests', 'frontend-build', 'nsis-build', 'source-clean'];

export function requireNewerVersion(version, previous) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(previous, /^v?\d+\.\d+\.\d+$/);
  const candidate = version.split('.').map(BigInt);
  const published = previous.replace(/^v/, '').split('.').map(BigInt);
  const different = candidate.findIndex((part, index) => part !== published[index]);
  assert.ok(different >= 0 && candidate[different] > published[different], 'Release must be newer than the public latest version; bump versions before CI');
}

// Match minisign-verify's prehashed updater format, including the authenticated
// trusted comment. The private key is never used by this verifier.
export function verifyUpdaterSignature(bytes, publicKeyBase64, signatureBase64) {
  const keyLines = Buffer.from(publicKeyBase64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const lines = Buffer.from(signatureBase64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  assert.equal(keyLines.length, 2, 'Invalid public key');
  assert.equal(lines.length, 4, 'Invalid updater signature');
  const key = Buffer.from(keyLines[1], 'base64');
  const signature = Buffer.from(lines[1], 'base64');
  const commentSignature = Buffer.from(lines[3], 'base64');
  assert.equal(key.length, 42);
  assert.equal(key.toString('ascii', 0, 2), 'Ed');
  assert.equal(signature.length, 74);
  assert.equal(signature.toString('ascii', 0, 2), 'ED', 'Updater requires a prehashed signature');
  assert.equal(commentSignature.length, 64);
  assert.deepEqual(key.subarray(2, 10), signature.subarray(2, 10), 'Signing key differs from installed updater key');
  assert.ok(lines[2].startsWith('trusted comment: '));
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const payload = createHash('blake2b512').update(bytes).digest();
  assert.ok(verify(null, payload, publicKey, signature.subarray(10)), 'Installer signature is invalid');
  assert.ok(verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]), publicKey, commentSignature), 'Signature trusted comment is invalid');
}

export function validateRun(run, sha) {
  assert.equal(run.repository.full_name, REPOSITORY, 'Foreign repository');
  assert.equal(run.head_repository.full_name, REPOSITORY, 'Foreign source repository');
  assert.equal(run.head_sha, sha, 'CI must match the exact current commit');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'push', 'Only main push builds can be released');
  assert.equal(run.path, '.github/workflows/ci.yml', 'Installer must come from CI');
  assert.equal(run.status, 'completed', 'CI is still running; publishing never waits or rebuilds');
  assert.equal(run.conclusion, 'success', 'CI must have passed');
}

export function validateArtifact(artifact, sha) {
  assert.equal(artifact.name, `pantheon-windows-${sha}`);
  assert.equal(artifact.expired, false, 'Prepared installer has expired; rebuild CI for this commit');
  assert.equal(artifact.workflow_run.head_sha, sha, 'Artifact source differs from CI');
}

export function validateReceipt(receipt, bytes, { sha, runId, version, publicKey }) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.repository, REPOSITORY);
  assert.equal(receipt.sourceSha, sha, 'Receipt source mismatch');
  assert.equal(String(receipt.runId), String(runId), 'Receipt CI run mismatch');
  assert.equal(receipt.version, version, 'Prepared installer version mismatch');
  assert.equal(receipt.filename, installerName(version), 'Unexpected installer filename');
  assert.equal(receipt.size, bytes.length, 'Installer size mismatch');
  assert.equal(receipt.sha256, sha256(bytes), 'Installer hash mismatch');
  assert.equal(receipt.publicKeySha256, sha256(Buffer.from(publicKey.trim())), 'Updater public key mismatch');
  assert.deepEqual(receipt.gates, requiredGates, 'Missing release checks');
  assert.ok(['passed', 'unchanged'].includes(receipt.installedSmoke.status), 'Installed smoke evidence missing');
  if (receipt.installedSmoke.status === 'unchanged') {
    assert.match(receipt.installedSmoke.baselineSha, /^[a-f0-9]{40}$/);
    assert.ok(!/^0+$/.test(receipt.installedSmoke.baselineSha));
  }
}
