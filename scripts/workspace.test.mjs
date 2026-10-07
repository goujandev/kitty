// The direct-chat workspace: one typed command surface, and no trace of the
// removed agent-team workflow in the product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

function files(dir, pattern) {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => join(entry.parentPath ?? entry.path, entry.name));
}

test('every command the frontend invokes is registered by the host, and nothing else is', () => {
  const invoked = new Set([...read('src/ipc/commands.ts').matchAll(/invoke<[^>]*>\("([a-z_]+)"/g)].map(match => match[1]));
  const handler = read('src-tauri/src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  const registered = new Set(handler.split(',').map(name => name.trim().split('::').pop()).filter(Boolean));
  assert.ok(invoked.has('send_turn') && invoked.has('create_session'), 'the direct-chat commands are typed');
  assert.deepEqual([...invoked].filter(name => !registered.has(name)), [], 'invoked but not registered');
  assert.deepEqual([...registered].filter(name => !invoked.has(name)), [], 'registered but never invoked');
});

test('the product carries no agent-team vocabulary', () => {
  const sources = [
    ...files('src', /\.(ts|tsx|css)$/),
    ...files('src-tauri/src', /\.rs$/),
    ...files('crates', /\.rs$/).filter(path => !/[\\/]store[\\/]src[\\/]migrations\.rs$/.test(path) && !/[\\/]target[\\/]/.test(path)),
  ];
  assert.ok(sources.length > 50, 'the scan must cover the source tree');
  const forbidden = /\b(boss|team ?lead|orchestrat\w*|delegat\w*|pantheon-(delegate|assignment|progress)|worker pane|subordinate)\b/i;
  const hits = sources.flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/)
    .map((line, index) => forbidden.test(line) ? `${path.slice(root.length)}:${index + 1}: ${line.trim()}` : null)
    .filter(Boolean));
  assert.deepEqual(hits, []);
});
