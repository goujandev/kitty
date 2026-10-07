import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPOSITORY, requiredGates, requireNewerVersion, sha256, validateArtifact, validateReceipt, validateRun, verifyUpdaterSignature } from './release-artifact.mjs';

// Known-answer prehashed fixture from minisign-verify 0.2.5, not generated here.
const publicKey = Buffer.from('untrusted comment: fixture\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3').toString('base64');
const signatureText = 'untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==';
const signature = Buffer.from(signatureText).toString('base64');

test('upstream updater signature passes; changed installer and trusted comment fail', () => {
  verifyUpdaterSignature(Buffer.from('test'), publicKey, signature);
  assert.throws(() => verifyUpdaterSignature(Buffer.from('tesT'), publicKey, signature), /signature is invalid/);
  const changedComment = Buffer.from(signatureText.replace('1556193335', '1556193336')).toString('base64');
  assert.throws(() => verifyUpdaterSignature(Buffer.from('test'), publicKey, changedComment), /trusted comment/);
});

test('wrong key identity and malformed signature fail closed', () => {
  const lines = signatureText.split('\n');
  const inner = Buffer.from(lines[1], 'base64');
  inner[2] ^= 1;
  lines[1] = inner.toString('base64');
  assert.throws(() => verifyUpdaterSignature(Buffer.from('test'), publicKey, Buffer.from(lines.join('\n')).toString('base64')), /Signing key differs/);
  assert.throws(() => verifyUpdaterSignature(Buffer.from('test'), publicKey, 'garbage'));
});

const sha = 'a'.repeat(40);
test('publication requires a newer stable version, including numeric major/minor/patch ordering', () => {
  requireNewerVersion('0.2.7', 'v0.2.6');
  requireNewerVersion('0.10.0', 'v0.9.9');
  requireNewerVersion('1.0.0', 'v0.99.99');
  for (const candidate of ['0.2.6', '0.2.5', '0.1.99', '0.2.7-beta.1']) {
    assert.throws(() => requireNewerVersion(candidate, 'v0.2.6'));
  }
});
const run = { repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
test('only successful exact-commit main CI from this repository is accepted', () => {
  validateRun(run, sha);
  for (const patch of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' },
    { head_repository: { full_name: 'attacker/kitty' } }, { repository: { full_name: 'attacker/kitty' } },
    { path: '.github/workflows/release.yml' }, { status: 'in_progress' }, { conclusion: 'failure' },
  ]) assert.throws(() => validateRun({ ...run, ...patch }, sha));
});

test('artifact must be current and tied to the same SHA', () => {
  const artifact = { name: `pantheon-windows-${sha}`, expired: false, workflow_run: { head_sha: sha } };
  validateArtifact(artifact, sha);
  assert.throws(() => validateArtifact({ ...artifact, expired: true }, sha));
  assert.throws(() => validateArtifact({ ...artifact, name: 'pantheon-v0.2.6-windows' }, sha));
  assert.throws(() => validateArtifact({ ...artifact, workflow_run: { head_sha: 'b'.repeat(40) } }, sha));
});

test('receipt binds version, bytes, public key, run, source and completed gates', () => {
  const bytes = Buffer.from('installer');
  const context = { sha, runId: '123', version: '0.2.7', publicKey };
  const receipt = { schema: 1, repository: REPOSITORY, sourceSha: sha, runId: '123', version: '0.2.7', filename: 'Pantheon_0.2.7_x64-setup.exe', size: bytes.length, sha256: sha256(bytes), publicKeySha256: sha256(Buffer.from(publicKey)), gates: requiredGates, installedSmoke: { status: 'passed' } };
  validateReceipt(receipt, bytes, context);
  for (const patch of [
    { sourceSha: 'b'.repeat(40) }, { runId: '124' }, { version: '0.2.6' },
    { filename: '../installer.exe' }, { size: 1 }, { sha256: '0'.repeat(64) },
    { publicKeySha256: '0'.repeat(64) }, { gates: [] }, { installedSmoke: { status: 'missing' } },
    { installedSmoke: { status: 'unchanged', baselineSha: '0'.repeat(40) } },
  ]) assert.throws(() => validateReceipt({ ...receipt, ...patch }, bytes, context));
  assert.throws(() => validateReceipt(receipt, Buffer.from('tampered'), context));
  validateReceipt({ ...receipt, installedSmoke: { status: 'unchanged', baselineSha: 'b'.repeat(40) } }, bytes, context);
});
