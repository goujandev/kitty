import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/stores/sidebarModel.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { checkName, nearbyAfterRemoval, placeMenu, splitChats, typeahead } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('removing a chat selects the one that takes its place, else the one above', () => {
  assert.equal(nearbyAfterRemoval(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nearbyAfterRemoval(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(nearbyAfterRemoval(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(nearbyAfterRemoval(['a'], 'a'), null, 'nothing left means the empty state');
  assert.equal(nearbyAfterRemoval([], 'a'), null);
});

test('archived chats are kept apart from the list, each in saved order', () => {
  const rows = [{ id: '1', archivedAt: null }, { id: '2', archivedAt: 5 }, { id: '3', archivedAt: null }];
  const { open, archived } = splitChats(rows);
  assert.deepEqual(open.map(row => row.id), ['1', '3']);
  assert.deepEqual(archived.map(row => row.id), ['2']);
});

test('names are tidied, and an empty one is refused with a reason', () => {
  assert.deepEqual(checkName('  Build   notes\n', 'chat'), { ok: true, value: 'Build notes' });
  assert.deepEqual(checkName(' \t ', 'chat'), { ok: false, message: "A chat name can't be empty" });
  assert.deepEqual(checkName('', 'project'), { ok: false, message: "A project name can't be empty" });
  assert.equal(checkName('x'.repeat(300), 'project').value.length, 120);
});

test('a menu opens under its button and stays inside the window', () => {
  const viewport = { width: 400, height: 300 };
  const menu = { width: 180, height: 120 };
  // Room below: hangs from the button, right edges aligned.
  assert.deepEqual(placeMenu(menu, viewport, { left: 200, top: 20, width: 24, height: 24 }), { left: 44, top: 48 });
  // No room below: opens above.
  assert.deepEqual(placeMenu(menu, viewport, { left: 200, top: 250, width: 24, height: 24 }), { left: 44, top: 126 });
  // A button near the left edge cannot push it off-screen.
  assert.equal(placeMenu(menu, viewport, { left: 0, top: 20, width: 24, height: 24 }).left, 8);
  // A right-click near the bottom-right corner is clamped back in.
  assert.deepEqual(placeMenu(menu, viewport, { x: 390, y: 290 }), { left: 212, top: 170 });
});

test('typing a letter moves to the next item starting with it', () => {
  const labels = ['Rename', 'Archive', 'Delete…'];
  assert.equal(typeahead(labels, 0, 'd'), 2);
  assert.equal(typeahead(labels, 2, 'r'), 0);
  assert.equal(typeahead(labels, 1, 'z'), 1, 'no match leaves the selection');
});
