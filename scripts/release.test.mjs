import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest, checkVersions } from './check-release.mjs';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
test('versions and signing configuration agree', () => { assert.equal(checkVersions('v' + version), version); assert.throws(() => checkVersions('v9.0.0')); });
test('feed references the versioned NSIS asset and its signature', () => {
 const signature = 'a'.repeat(100);
 const filename = 'Kitty_' + version + '_x64-setup.exe';
 const manifest = { version, platforms: { 'windows-x86_64': { url: 'https://github.com/goujandev/kitty/releases/download/v' + version + '/' + filename, signature } } };
 checkManifest(manifest, version, signature, filename, 'v' + version);
 assert.throws(() => checkManifest(manifest, '9.0.0', signature, filename, 'v' + version));
 assert.throws(() => checkManifest(manifest, version, 'b'.repeat(100), filename, 'v' + version));
 manifest.platforms['windows-x86_64'].url = 'https://example.com/setup.exe';
 assert.throws(() => checkManifest(manifest, version, signature, filename, 'v' + version));
});
