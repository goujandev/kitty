import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import ts from 'typescript';

const source = readFileSync(new URL('../src/stores/localPreferences.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const read = path => readFileSync(new URL('../' + path, import.meta.url));

function pngSize(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes[24], 8, 'icons must use 8-bit channels');
  assert.equal(bytes[25], 6, 'icons must retain RGBA transparency');
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'PNG chunk is complete');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.ok(pixels[0] <= 4, 'a recognized PNG scanline filter is present');
  // The first pixel has zero left/up predictors for every PNG filter.
  assert.ok(pixels[4] <= 1, 'the top-left corner remains transparent within one resampling alpha level');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('package, window, CSP and Windows installer use Pantheon with the existing app identity', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.productName, 'Pantheon');
  assert.equal(config.app.windows[0].title, 'Pantheon');
  assert.equal(config.identifier, 'dev.kitty.desktop');
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.nsis.template, 'windows/installer.nsi');
  assert.equal(config.bundle.windows.nsis.installerIcon, 'icons/icon.ico');
  assert.equal(config.bundle.windows.nsis.uninstallerIcon, 'icons/icon.ico');
  assert.match(config.app.security.csp, /http:\/\/pantheon\.localhost/);
  assert.doesNotMatch(config.app.security.csp, /kitty\.localhost/);
  assert.equal(JSON.parse(read('package.json')).name, 'pantheon');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'pantheon');
  assert.equal(lock.packages[''].name, 'pantheon');
  assert.match(read('index.html').toString(), /href="\/pantheon-icon\.png"/);
});

test('approved app source and all native PNG icon sizes retain transparent corners', () => {
  const sourceSize = pngSize(read('src-tauri/icon-source.png'));
  assert.equal(sourceSize[0], sourceSize[1], 'the canonical app icon is square');
  assert.ok(sourceSize[0] >= 512, 'the canonical source preserves high resolution');
  const icons = {
    '32x32.png': 32, '64x64.png': 64, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512,
    'Square30x30Logo.png': 30, 'Square44x44Logo.png': 44, 'Square71x71Logo.png': 71,
    'Square89x89Logo.png': 89, 'Square107x107Logo.png': 107, 'Square142x142Logo.png': 142,
    'Square150x150Logo.png': 150, 'Square284x284Logo.png': 284, 'Square310x310Logo.png': 310,
    'StoreLogo.png': 50,
  };
  for (const [name, size] of Object.entries(icons)) assert.deepEqual(pngSize(read('src-tauri/icons/' + name)), [size, size], name);
  assert.deepEqual(read('src/assets/pantheon-icon.png'), read('src-tauri/icons/128x128@2x.png'), 'frontend and Windows share the approved mark');
  assert.deepEqual(read('public/pantheon-icon.png'), read('src-tauri/icons/128x128.png'), 'browser favicon shares the approved mark');
});

test('Windows ICO includes crisp taskbar sizes and the canonical 256px image', () => {
  const bytes = read('src-tauri/icons/icon.ico');
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1, 'Windows icon format');
  const sizes = [];
  const count = bytes.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const position = 6 + i * 16;
    const size = bytes[position] || 256;
    assert.equal(bytes[position + 1] || 256, size);
    const length = bytes.readUInt32LE(position + 8);
    const offset = bytes.readUInt32LE(position + 12);
    assert.ok(offset >= 6 + count * 16 && offset + length <= bytes.length, 'ICO payload stays within the file');
    const image = bytes.subarray(offset, offset + length);
    assert.deepEqual(pngSize(image), [size, size]);
    if (size === 256) assert.deepEqual(image, read('src/assets/pantheon-icon.png'));
    sizes.push(size);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 256]);
});

test('Windows upgrade registration retains the deployed keys while displaying Pantheon', () => {
  const template = read('src-tauri/windows/installer.nsi').toString();
  assert.ok(template.includes('!define LEGACYPRODUCTNAME "Kitty"'));
  assert.ok(template.includes('!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACYPRODUCTNAME}"'));
  assert.ok(template.includes('!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"'));
  assert.ok(template.includes('!define PRODUCTNAME "{{product_name}}"'));
  assert.ok(template.includes('WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"'));
  const init = template.split('Function .onInit')[1].split('FunctionEnd')[0];
  assert.ok(init.includes('ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"'), 'capture the old binary before the old uninstaller removes its registration');
  assert.match(template, /\$OldMainBinaryName == ""[\s\S]*?ReadRegStr \$OldMainBinaryName[\s\S]*?\$\{EndIf\}/);
  const previousRunningCheck = template.indexOf('CheckIfAppIsRunning "kitty.exe"');
  const currentRunningCheck = template.indexOf('CheckIfAppIsRunning "${MAINBINARYNAME}.exe"');
  assert.ok(previousRunningCheck >= 0 && currentRunningCheck > previousRunningCheck, 'detect the previous running executable before replacing its files');
  assert.ok(read('docs/licenses/Tauri-NSIS-MIT.txt').toString().includes('Permission is hereby granted'));
  assert.ok(read('src/views/Settings.tsx').toString().includes('<pre>{tauriNsisLicense}</pre>'), 'installer adaptation credit ships in the app');
});

test('legacy shortcuts migrate only for this installation and before updater early returns', () => {
  const template = read('src-tauri/windows/installer.nsi').toString();
  for (const [name, paths] of [
    ['CreateOrUpdateStartMenuShortcut', [String.raw`$SMPROGRAMS`, String.raw`$SMPROGRAMS\$AppStartMenuFolder`]],
    ['CreateOrUpdateDesktopShortcut', [String.raw`$DESKTOP`]],
  ]) {
    const body = template.split('Function ' + name)[1].split('FunctionEnd')[0];
    const updaterReturn = body.indexOf('${If} $UpdateMode = 1');
    assert.ok(updaterReturn >= 0);
    for (const path of paths) {
      const oldLink = path + String.raw`\${LEGACYPRODUCTNAME}.lnk`;
      const newLink = path + String.raw`\${PRODUCTNAME}.lnk`;
      const match = body.indexOf('!insertmacro IsShortcutTarget "' + oldLink + '" "$INSTDIR\\$OldMainBinaryName"');
      assert.ok(match >= 0 && match < updaterReturn, 'only migrate a link targeting the registered previous executable');
      const block = body.slice(match, body.indexOf('${EndIf}', match));
      assert.ok(block.includes('Pop $0') && block.includes('${If} $0 = 1'), 'guard migration on a successful target match');
      const create = block.indexOf('CreateShortcut "' + newLink + '" "$INSTDIR\\${MAINBINARYNAME}.exe"');
      const identity = block.indexOf('!insertmacro SetLnkAppUserModelId "' + newLink + '"');
      const remove = block.indexOf('Delete "' + oldLink + '"');
      const done = block.indexOf('Return');
      assert.ok(create >= 0 && identity > create && remove > identity && done > remove, 'the new branded link and identity precede removal of the old link');
    }
  }
});
function preferences(values, writable = true) {
  const storage = new Map(Object.entries(values));
  const exports = {};
  runInNewContext(code, { exports, localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { if (!writable) throw Error('Storage unavailable'); storage.set(key, value); },
    removeItem: key => storage.delete(key),
  } });
  return { read: exports.readPreference, storage };
}

test('existing Pantheon preferences take precedence over legacy values', () => {
  const { read, storage } = preferences({ 'pantheon.tabs': 'new', 'kitty.tabs': 'old' });
  assert.equal(read('tabs'), 'new');
  assert.equal(storage.get('kitty.tabs'), 'old');
});

test('saved tabs, sidebar state, activity, timings and preview wallpaper migrate once', () => {
  for (const name of ['tabs', 'expandedProjects', 'projectUnread', 'turnTimings', 'preview.wallpaper']) {
    const { read, storage } = preferences({ ['kitty.' + name]: 'saved' });
    assert.equal(read(name), 'saved');
    assert.equal(storage.get('pantheon.' + name), 'saved');
    assert.equal(storage.has('kitty.' + name), false);
    storage.set('pantheon.' + name, 'changed');
    assert.equal(read(name), 'changed');
  }
});

test('the completed presentation migration carries over so theme and zoom are not reset', () => {
  const { read, storage } = preferences({ 'kitty:t3-reference-presentation': 'true' });
  assert.equal(read('t3-reference-presentation', ':'), 'true');
  assert.equal(storage.get('pantheon:t3-reference-presentation'), 'true');
});

test('a failed migration keeps the saved value available and does not delete it', () => {
  const { read, storage } = preferences({ 'kitty.tabs': 'saved' }, false);
  assert.equal(read('tabs'), 'saved');
  assert.equal(storage.get('kitty.tabs'), 'saved');
  assert.equal(storage.has('pantheon.tabs'), false);
});

test('absent preferences stay absent', () => {
  const { read, storage } = preferences({});
  assert.equal(read('tabs'), null);
  assert.equal(storage.size, 0);
});

test('loading appearance after the rename preserves saved theme, zoom and rail widths', async () => {
  const { read } = preferences({ 'kitty:t3-reference-presentation': 'true' });
  const appearanceSource = readFileSync(new URL('../src/stores/appearanceStore.ts', import.meta.url), 'utf8').replaceAll('import.meta.hot', 'false');
  const appearanceCode = ts.transpileModule(appearanceSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const writes = [];
  let zoom;
  const document = { documentElement: { dataset: {}, style: {} } };
  const ipc = {
    theme: async () => 'solarized-light', background: async () => 'saved-wallpaper',
    zoom: async () => 1.5, railWidths: async () => ({ projects: 300, chats: 310 }),
    setTheme: async value => writes.push(value), setZoom: async value => writes.push(value),
    setRailWidths: async value => writes.push(value),
  };
  const imports = {
    './localPreferences': { readPreference: read },
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '@tauri-apps/api/webview': { getCurrentWebview: () => ({ setZoom: async value => { zoom = value; } }) },
    '../ipc/commands': ipc,
  };
  runInNewContext(appearanceCode, { exports, require: name => imports[name], document,
    window: { matchMedia: () => ({ matches: true, addEventListener: () => {} }) },
  });
  await exports.loadAppearance();
  const appearance = exports.useAppearance();
  assert.equal(appearance.theme, 'solarized-light');
  assert.equal(appearance.zoom, 1.5);
  assert.equal(appearance.background, 'saved-wallpaper');
  assert.equal(appearance.rails.projects, 300);
  assert.equal(appearance.rails.chats, 310);
  assert.equal(document.documentElement.dataset.theme, 'solarized-light');
  assert.equal(zoom, 1.5);
  assert.deepEqual(writes, [], 'the completed presentation migration never overwrites saved appearance');
});
