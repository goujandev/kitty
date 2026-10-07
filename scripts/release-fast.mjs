import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkManifest, checkVersions } from './check-release.mjs';
import { REPOSITORY, RELEASE_LOCATION, installerName, requireNewerVersion, sha256, validateArtifact, validateReceipt, validateRun, verifyUpdaterSignature } from './release-artifact.mjs';

const started = Date.now();
function command(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
const gh = args => command('gh', args);
const api = endpoint => JSON.parse(gh(['api', `repos/${REPOSITORY}/${endpoint}`]));
function optionalApi(endpoint) {
  try { return api(endpoint); } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return null;
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    inspect: { type: 'boolean', default: false }, 'run-id': { type: 'string' },
    'notes-file': { type: 'string' }, key: { type: 'string' },
  } });
  if (!values.inspect) {
    assert.ok(values['notes-file'], 'Pass --notes-file PATH to publish; --inspect is read-only');
    assert.ok(readFileSync(values['notes-file'], 'utf8').trim(), 'Release notes are empty');
  }
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Commit tracked changes before using a prepared installer');
  const untrackedInputs = command('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'src-tauri', 'crates', 'scripts', '.github']);
  assert.equal(untrackedInputs, '', 'Commit untracked source/build inputs before releasing');
  assert.match(command('git', ['remote', 'get-url', 'origin']), /github\.com[:/]goujandev\/(?:kitty|pantheon)(?:\.git)?$/);
  const sha = command('git', ['rev-parse', 'HEAD']);
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const version = checkVersions(`v${config.version}`);
  const tag = `v${version}`;
  const filename = installerName(version);
  if (!values.inspect) requireNewerVersion(version, api('releases/latest').tag_name);
  let runId = values['run-id'];
  if (!runId) {
    const runs = api(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=30`).workflow_runs;
    const ready = runs.find(run => run.status === 'completed' && run.conclusion === 'success');
    assert.ok(ready, `No ready installer for ${sha.slice(0, 8)}. ${runs[0] ? `CI is ${runs[0].status}/${runs[0].conclusion || 'pending'}: ${runs[0].html_url}` : 'Push this commit to main first.'} This command does not start another build.`);
    runId = String(ready.id);
  }
  assert.match(runId, /^\d+$/, 'Invalid run ID');
  const run = api(`actions/runs/${runId}`);
  validateRun(run, sha);
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts;
  const artifact = artifacts.find(item => item.name === `pantheon-windows-${sha}`);
  assert.ok(artifact, 'CI did not prepare an installer. Run the current CI workflow for this commit.');
  validateArtifact(artifact, sha);
  mkdirSync('target/fast-release', { recursive: true });
  const directory = mkdtempSync(resolve('target/fast-release', `${sha.slice(0, 8)}-`));
  console.log(`Downloading checked installer from ${run.html_url}`);
  gh(['run', 'download', runId, '--repo', REPOSITORY, '--name', artifact.name, '--dir', directory]);
  assert.deepEqual(readdirSync(directory).sort(), [filename, 'release-receipt.json'].sort(), 'Unexpected files in release artifact');
  const installer = join(directory, filename);
  const bytes = readFileSync(installer);
  const receipt = JSON.parse(readFileSync(join(directory, 'release-receipt.json'), 'utf8'));
  validateReceipt(receipt, bytes, { sha, runId, version, publicKey: config.plugins.updater.pubkey });
  console.log(`Verified ${filename}: ${bytes.length} bytes, SHA256 ${receipt.sha256}`);
  if (values.inspect) {
    console.log(`Ready; inspection took ${((Date.now() - started) / 1000).toFixed(1)}s. No signing or publication performed.`);
    return;
  }
  let release = optionalApi(`releases/tags/${tag}`);
  assert.ok(!release || release.draft, `${tag} is already published. Bump and commit versions BEFORE preparing the next installer.`);
  assert.ok(!release || !release.prerelease, 'Existing draft is a prerelease; review it before publishing a stable update');
  const existingTag = optionalApi(`git/ref/tags/${tag}`);
  if (existingTag) assert.equal(api(`commits/${tag}`).sha, sha, 'Existing release tag points to another source commit');
  const expectedNames = [filename, `${filename}.sig`, 'latest.json'];
  if (release) assert.ok(release.assets.every(asset => expectedNames.includes(asset.name)), 'Draft has unexpected assets; review it before retrying');
  const key = resolve(values.key || join(homedir(), '.tauri', 'kitty-updater.key'));
  assert.ok(existsSync(key), 'Existing local updater key is unavailable; pass --key PATH');
  // Only the signer reads this local file. Never print its contents or send it to GitHub.
  command(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--private-key-path', key, '--password', '', installer]);
  const signature = readFileSync(`${installer}.sig`, 'utf8').trim();
  verifyUpdaterSignature(bytes, config.plugins.updater.pubkey, signature);
  const modified = Buffer.from(bytes);
  modified[0] ^= 1;
  assert.throws(() => verifyUpdaterSignature(modified, config.plugins.updater.pubkey, signature), 'Tampered installer must be rejected');
  const manifest = {
    version, notes: readFileSync(values['notes-file'], 'utf8').trim(), pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `https://github.com/${RELEASE_LOCATION}/releases/download/${tag}/${filename}` } },
  };
  checkManifest(manifest, version, signature, filename, tag);
  const feedPath = join(directory, 'latest.json');
  writeFileSync(feedPath, JSON.stringify(manifest, null, 2) + '\n');
  if (!existingTag) gh(['api', `repos/${REPOSITORY}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
  if (!release) {
    gh(['release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--draft', '--title', `Pantheon ${version}`, '--notes-file', resolve(values['notes-file'])]);
  } else {
    gh(['release', 'edit', tag, '--repo', REPOSITORY, '--title', `Pantheon ${version}`, '--notes-file', resolve(values['notes-file'])]);
  }
  gh(['release', 'upload', tag, installer, `${installer}.sig`, feedPath, '--repo', REPOSITORY, '--clobber']);
  release = api(`releases/tags/${tag}`);
  assert.equal(release.draft, true);
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), expectedNames.sort());
  for (const name of expectedNames) {
    const asset = release.assets.find(item => item.name === name);
    const localBytes = readFileSync(join(directory, name));
    assert.equal(asset.size, localBytes.length, `Uploaded ${name} size mismatch`);
    assert.equal(asset.digest, `sha256:${sha256(localBytes)}`, `Uploaded ${name} hash mismatch`);
  }
  gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
  const publicRelease = api('releases/latest');
  assert.equal(publicRelease.tag_name, tag);
  assert.equal(publicRelease.draft, false);
  assert.equal(publicRelease.prerelease, false);
  const response = await fetch(`https://github.com/${RELEASE_LOCATION}/releases/latest/download/latest.json`, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'Anonymous public update feed unavailable');
  checkManifest(await response.json(), version, signature, filename, tag);
  console.log(`Published ${publicRelease.html_url} in ${((Date.now() - started) / 1000).toFixed(1)}s. No rebuild or repeated CI.`);
}

main().catch(error => {
  console.error(`Fast release stopped: ${error.message}`);
  // gh failures carry helpful public API errors. Signer output may contain key
  // metadata, so it is deliberately never echoed.
  if (error.path === 'gh' && error.stderr) console.error(String(error.stderr).trim());
  process.exitCode = 1;
});
