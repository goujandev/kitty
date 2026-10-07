import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/stores/projectActivity.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ProjectActivityTracker, isActivityEvent } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const end = (kind = 'endTurn') => ({ kind: 'turnEnded', stop: { kind } });
const start = { kind: 'blockAppended', seq: 1, blockKind: 'user', text: 'Request' };
const approval = id => ({ kind: 'approvalRequested', id, approvalKind: 'command', title: 'Run a command', detail: null });
const resolve = id => ({ kind: 'approvalResolved', id, outcome: 'allow' });
const failed = { kind: 'failed', errorKind: 'process', message: 'the CLI exited' };

function tracker(saved) {
  const value = new ProjectActivityTracker(saved);
  value.register('chat', 'project');
  value.register('second-chat', 'project');
  value.register('elsewhere', 'other');
  return value;
}

test('a conversation working in the background finishes unread', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start]);
  assert.deepEqual(value.snapshot().project, { status: 'working', unread: false, runningCount: 1 });
  assert.deepEqual(value.running(), { chat: 'project' });
  value.transcript('chat', [end()]);
  assert.deepEqual(value.snapshot().project, { status: 'completed', unread: true, runningCount: 0 });
  assert.deepEqual(value.running(), {});
  value.view('project');
  assert.equal(value.snapshot().project, undefined);
});

test('finishing in the project being viewed leaves nothing unread', () => {
  const value = tracker();
  value.view('project');
  value.transcript('chat', [start, end()]);
  assert.equal(value.snapshot().project, undefined);
});

test('waiting for permission shows until every request is answered', () => {
  const value = tracker();
  value.transcript('chat', [start, approval('a'), approval('b')]);
  assert.equal(value.snapshot().project.status, 'approval');
  value.transcript('chat', [resolve('a')]);
  assert.equal(value.snapshot().project.status, 'approval');
  value.transcript('chat', [resolve('b')]);
  assert.equal(value.snapshot().project.status, 'working');
});

test('a failure is not turned green by the turn end that follows it', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start, failed, end()]);
  assert.deepEqual(value.snapshot().project, { status: 'failed', unread: true, runningCount: 0 });
});

test('an error during a turn is said at its end, not by ending it early', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start, failed]);
  assert.deepEqual(value.running(), { chat: 'project' });
  value.transcript('chat', [end()]);
  assert.deepEqual(value.snapshot().project, { status: 'failed', unread: true, runningCount: 0 });
  value.transcript('chat', [start, end()]);
  assert.equal(value.unread().project, 'failed', 'the worst unread result still wins');
});

test('a turn the agent starts by itself is working too', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start, end()]);
  value.transcript('chat', [{ kind: 'turnStarted' }]);
  assert.deepEqual(value.running(), { chat: 'project' });
  value.transcript('chat', [end()]);
  assert.deepEqual(value.running(), {});
});

test('an error outside any turn is the outcome', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [failed]);
  assert.deepEqual(value.snapshot().project, { status: 'failed', unread: true, runningCount: 0 });
});

test('several conversations in one project are counted and the worst unread result wins', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start]);
  value.transcript('second-chat', [start]);
  assert.equal(value.snapshot().project.runningCount, 2);
  value.transcript('chat', [end('cancelled')]);
  assert.equal(value.snapshot().project.status, 'working');
  value.transcript('second-chat', [end()]);
  assert.deepEqual(value.snapshot().project, { status: 'stopped', unread: true, runningCount: 0 });
});

test('only unread results survive a restart, never a running flag', () => {
  const value = tracker();
  value.view('other');
  value.transcript('chat', [start, end()]);
  value.transcript('elsewhere', [start]);
  const saved = JSON.parse(JSON.stringify(value.unread()));
  assert.deepEqual(saved, { project: 'completed' });
  const restored = tracker(saved);
  assert.deepEqual(restored.snapshot(), { project: { status: 'completed', unread: true, runningCount: 0 } });
  restored.forget('project');
  assert.deepEqual(restored.snapshot(), {});
});

test('only lifecycle events are activity', () => {
  assert.equal(isActivityEvent(start), true);
  assert.equal(isActivityEvent(end()), true);
  assert.equal(isActivityEvent({ kind: 'turnStarted' }), true);
  assert.equal(isActivityEvent({ kind: 'blockAppended', seq: 2, blockKind: 'assistant', text: 'Hi' }), false);
  assert.equal(isActivityEvent({ kind: 'status', text: 'Thinking' }), false);
});
