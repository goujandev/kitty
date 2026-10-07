import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The store module touches React and localStorage only when used; the rules
// under test are plain functions, so a stub React is enough to import it.
const preferences = ts.transpileModule(readFileSync(new URL('../src/stores/localPreferences.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const preferencesUrl = 'data:text/javascript;base64,' + Buffer.from(preferences).toString('base64');
const source = readFileSync(new URL('../src/stores/tabStore.ts', import.meta.url), 'utf8')
  .replace('import { useSyncExternalStore } from "react";', 'const useSyncExternalStore = () => undefined;')
  .replace('"./localPreferences"', JSON.stringify(preferencesUrl));
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DRAFT, close, cycle, prune, reveal } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('opening a chat adds a tab beside the current one and selects it', () => {
  let tabs = { ids: [], active: null };
  tabs = reveal(tabs, 'a');
  tabs = reveal(tabs, 'b');
  assert.deepEqual(tabs, { ids: ['a', 'b'], active: 'b' });
  tabs = reveal({ ids: ['a', 'b', 'c'], active: 'a' }, 'd');
  assert.deepEqual(tabs, { ids: ['a', 'd', 'b', 'c'], active: 'd' });
  assert.deepEqual(reveal(tabs, 'c'), { ids: ['a', 'd', 'b', 'c'], active: 'c' }, 'an open chat is just selected');
});

test('sending in a new chat turns its tab into that chat', () => {
  const tabs = { ids: ['a', DRAFT], active: DRAFT };
  assert.deepEqual(reveal(tabs, 'new'), { ids: ['a', 'new'], active: 'new' });
});

test('closing the active tab selects its neighbour; closing others keeps the selection', () => {
  const tabs = { ids: ['a', 'b', 'c'], active: 'b' };
  assert.deepEqual(close(tabs, 'b'), { ids: ['a', 'c'], active: 'c' });
  assert.deepEqual(close({ ids: ['a', 'b'], active: 'b' }, 'b'), { ids: ['a'], active: 'a' });
  assert.deepEqual(close(tabs, 'a'), { ids: ['b', 'c'], active: 'b' });
  assert.deepEqual(close({ ids: ['a'], active: 'a' }, 'a'), { ids: [], active: null });
});

test('deleted or archived chats lose their tabs; the new chat tab stays', () => {
  const tabs = { ids: ['a', DRAFT, 'gone'], active: 'gone' };
  assert.deepEqual(prune(tabs, new Set(['a'])), { ids: ['a', DRAFT], active: 'a' });
  const same = { ids: ['a'], active: 'a' };
  assert.equal(prune(same, new Set(['a'])), same, 'unchanged tabs are not replaced');
});

test('Ctrl+Tab wraps around in both directions', () => {
  const tabs = { ids: ['a', 'b', 'c'], active: 'c' };
  assert.equal(cycle(tabs, 1), 'a');
  assert.equal(cycle(tabs, -1), 'b');
  assert.equal(cycle({ ids: [], active: null }, 1), null);
});
