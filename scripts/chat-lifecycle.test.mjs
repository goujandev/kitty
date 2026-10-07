import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the real store's IPC listener, with native IPC and browser storage
// replaced. Each test owns a fresh module so conversations cannot leak between
// tests. The tracker and wire helpers are real production modules too.
async function setup() {
  let receive;
  let now = 10_000;
  const storage = new Map();
  const project = { id: 'project', name: 'Project', root: 'C:/project' };
  const session = { id: 'chat', projectId: project.id, harness: 'codex', title: 'Chat', archivedAt: null };
  const ipc = {
    onTranscript: async callback => { receive = callback; return () => {}; },
    onSessionTitle: async () => () => {},
    listProjects: async () => [project],
    listSessions: async () => [session],
    sessionBlocks: async () => [{ seq: 0, kind: 'user', text: 'Request', meta: null, createdAt: 1000 }],
    getApprovalMode: async () => 'auto',
    startSession: async () => {},
    setApprovalMode: async () => {},
    sendTurn: async () => 1,
    listModels: async () => ({ models: [] }),
    favouriteModels: async () => [],
  };
  const noop = () => {};
  const environment = {
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { visibilityState: 'visible', hasFocus: () => true, addEventListener: noop, removeEventListener: noop },
    window: { addEventListener: noop, removeEventListener: noop },
  };
  function load(path, imports = {}) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('import.meta.hot', 'false');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    runInNewContext(code, { ...environment, exports, require: name => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    } });
    return exports;
  }
  const store = load('../src/stores/chatStore.ts', {
    react: { useSyncExternalStore: noop },
    '../ipc/bindings': load('../src/ipc/bindings.ts'),
    '../ipc/commands': ipc,
    './projectActivity': load('../src/stores/projectActivity.ts'),
    './projectStore': { setChats: noop, setExpanded: noop, refresh: async () => {} },
    './noticeStore': { showNotice: noop },
    './sidebarModel': {},
    '../views/focus': { focusComposer: noop },
    './tabStore': {},
    './harnessStore': { readyHarnesses: () => [] },
  });
  const stop = await store.listen();
  await store.openSessionAnywhere(project.id, session.id);
  assert.equal(store.snapshot().error, null);
  return {
    store, stop,
    advance: milliseconds => { now += milliseconds; },
    emit: events => receive({ sessionId: session.id, events }),
  };
}

const start = { kind: 'turnStarted' };
const failed = { kind: 'failed', errorKind: 'process', message: 'Failed to complete the operation' };
const end = { kind: 'turnEnded', stop: { kind: 'endTurn' } };

test('a failed event and clean end in one native batch retain the failed outcome', async () => {
  const { store, emit, advance, stop } = await setup();
  await store.send('Request');
  emit([start]);
  advance(1000);
  emit([failed, end]);
  assert.equal(store.snapshot().busy, false);
  assert.equal(store.snapshot().timings[1].outcome, 'failed');
  assert.equal(store.snapshot().error, failed.message);
  stop();
});

test('successful completion is worked and autonomous continuation becomes busy again', async () => {
  const { store, emit, advance, stop } = await setup();
  await store.send('Request');
  emit([start]);
  advance(1000);
  emit([end]);
  assert.equal(store.snapshot().busy, false);
  assert.equal(store.snapshot().timings[1].outcome, 'worked');
  emit([start]);
  assert.equal(store.snapshot().busy, true);
  assert.equal(store.snapshot().timings[1].endedAt, undefined);
  assert.equal(store.snapshot().timings[1].priorMs, 1000);
  advance(2000);
  emit([failed, end]);
  assert.equal(store.snapshot().busy, false);
  assert.equal(store.snapshot().timings[1].outcome, 'failed');
  assert.equal(store.snapshot().timings[1].priorMs, 1000);
  stop();
});
