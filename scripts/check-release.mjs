import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function checkVersions(tag) {
 const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
 const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
 const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
 assert.equal(config.version, lock.version, 'npm lockfile version must match');
 assert.equal(config.version, lock.packages[''].version, 'npm root package lock version must match');
 const cargo = readFileSync('Cargo.toml', 'utf8').match(/\[workspace.package\][\s\S]*?version = "([^"]+)"/)[1];
 assert.equal(config.version, packageJson.version, 'Tauri and npm versions must match');
 assert.equal(config.version, cargo, 'Tauri and Cargo versions must match');
 assert.equal(tag, 'v' + config.version, 'Release tag must match the app version');
 assert.match(config.version, /^\d+\.\d+\.\d+$/, 'Only stable versions enter the update feed');
 assert.equal(config.bundle.createUpdaterArtifacts, true);
 assert.equal(config.plugins.updater.endpoints[0], 'https://github.com/goujandev/kitty/releases/latest/download/latest.json');
 assert.match(Buffer.from(config.plugins.updater.pubkey, 'base64').toString(), /minisign public key/);
 return config.version;
}
export function checkManifest(manifest, version, signature, filename, tag) {
 assert.equal(manifest.version.replace(/^v/, ''), version);
 const platform = manifest.platforms['windows-x86_64'];
 assert.ok(platform, 'Missing Windows x64 update');
 const url = new URL(platform.url);
 assert.equal(url.origin, 'https://github.com');
 assert.equal(decodeURIComponent(url.pathname), '/goujandev/kitty/releases/download/' + tag + '/' + filename);
 assert.equal(platform.signature.trim(), signature.trim(), 'Manifest signature differs from the built installer signature');
 assert.ok(signature.trim().length > 40, 'Empty or invalid signature');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const tag = process.argv[2];
 const version = checkVersions(tag);
 if (process.argv[3]) {
  const directory = 'target/release/bundle/nsis';
  const installers = readdirSync(directory).filter(file => file.endsWith('_x64-setup.exe') && file.includes('_' + version + '_'));
  assert.equal(installers.length, 1, 'Expected one NSIS installer');
  const filename = installers[0];
  const signature = readFileSync(join(directory, filename + '.sig'), 'utf8');
  checkManifest(JSON.parse(readFileSync(process.argv[3], 'utf8')), version, signature, filename, tag);
 }
 console.log('Release configuration and updater assets verified.');
}
