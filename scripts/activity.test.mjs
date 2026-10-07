import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/views/activity.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { groupActivity, formatElapsed, savedContextNote, summarizeSteps, workedFor } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('missing saved context is a quiet history note while real errors remain visible', () => {
  assert.match(savedContextNote('Agent error', 'no rollout found for thread id missing-thread'), /saved chat history is kept/);
  assert.equal(savedContextNote('Agent error', 'authentication failed'), null);
  assert.equal(savedContextNote('Agent error', 'no rollout found for thread id'), null);
  assert.equal(savedContextNote('Run check', 'no rollout found for thread id missing-thread'), null);
});
const block = (seq, kind, text = '') => ({ seq, kind, text, meta: null, createdAt: 1000 });

const shape = rows => rows.map(row => row.steps ? `steps(${row.steps.blocks.map(b => b.seq)})${row.steps.live ? '*' : ''}` : row.turnEnd ? 'end' : `${row.kind}${row.seq}`);

test('everything the agent says stays where it was said, with steps between', () => {
  const input = [block(0, 'user'), block(1, 'assistant', 'Checking'), block(2, 'tool'), block(3, 'reasoning'), block(4, 'assistant', 'Answer'), block(5, 'tool')];
  const rows = groupActivity(input, false, { 0: { startedAt: 1000, endedAt: 126000, outcome: 'worked' } });
  assert.deepEqual(shape(rows), ['user0', 'assistant1', 'steps(2,3)', 'assistant4', 'steps(5)', 'end']);
  assert.equal(rows[1], input[1], 'an earlier update is the same row, not moved into a history');
  assert.equal(rows.at(-1).turnEnd.timing.endedAt, 126000);
  assert.equal(input.length, 6);
});

test('a new message does not move or fold away the one before it while working', () => {
  const before = groupActivity([block(0, 'user'), block(1, 'assistant', 'First'), block(2, 'tool')], true, {});
  const after = groupActivity([block(0, 'user'), block(1, 'assistant', 'First'), block(2, 'tool'), block(3, 'assistant', 'Second')], true, {});
  assert.deepEqual(shape(before), ['user0', 'assistant1', 'steps(2)*']);
  assert.deepEqual(shape(after), ['user0', 'assistant1', 'steps(2)', 'assistant3']);
  assert.equal(before[2].seq, after[2].seq, 'a step group keeps its identity as the turn grows');
});

test('only a finished turn says how it went, and every row has its own key', () => {
  const rows = groupActivity([block(0, 'user'), block(1, 'assistant'), block(2, 'user'), block(3, 'tool')], true, {});
  assert.deepEqual(shape(rows), ['user0', 'assistant1', 'end', 'user2', 'steps(3)*']);
  assert.equal(new Set(rows.map(b => b.seq)).size, rows.length);
  assert.deepEqual(shape(groupActivity([block(0, 'user')], true, {})), ['user0']);
});

test('work without a final answer remains accessible, including failed tools', () => {
  const tool = { ...block(1, 'tool'), meta: '{"status":"failed"}' };
  const rows = groupActivity([block(0, 'user'), tool], false, { 0: { startedAt: 1000, endedAt: 2000, outcome: 'failed' } });
  assert.equal(rows[1].steps.blocks[0], tool);
  assert.equal(rows[2].turnEnd.timing.outcome, 'failed');
});

test('steps are summarised and time picked up again continues the count', () => {
  assert.equal(summarizeSteps([block(1, 'reasoning'), block(2, 'tool'), block(3, 'tool')]), 'Thought · 2 steps');
  assert.equal(summarizeSteps([block(2, 'tool')]), '1 step');
  assert.equal(workedFor({ startedAt: 10_000, endedAt: 25_000, priorMs: 60_000 }, 0), 75_000);
  assert.equal(workedFor({ startedAt: 10_000 }, 15_000), 5_000);
  assert.equal(workedFor(undefined, 15_000), null);
});

test('elapsed display handles seconds, minutes and clock adjustments', () => {
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(59000), '59s');
  assert.equal(formatElapsed(125000), '2m 05s');
  assert.equal(formatElapsed(-1000), '0s');
});
