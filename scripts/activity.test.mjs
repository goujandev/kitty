import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/views/activity.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { groupActivity, formatElapsed } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const block = (seq, kind, text = '') => ({ seq, kind, text, meta: null, createdAt: 1000 });

test('completed work groups commentary, reasoning and tools while preserving the final answer', () => {
  const input = [block(0, 'user'), block(1, 'assistant', 'Checking'), block(2, 'tool'), block(3, 'reasoning'), block(4, 'assistant', 'Answer'), block(5, 'tool')];
  const rows = groupActivity(input, false, { 0: { startedAt: 1000, endedAt: 126000, outcome: 'worked' } });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].activity.blocks.map(b => b.seq), [1, 2, 3, 5]);
  assert.equal(rows[2], input[4]);
  assert.equal(rows[1].activity.active, false);
  assert.equal(rows[1].activity.timing.endedAt, 126000);
  assert.equal(input.length, 6);
});

test('only the newest turn is active and has a work row before any output arrives', () => {
  const rows = groupActivity([block(0, 'user'), block(1, 'assistant'), block(2, 'user')], true, {});
  const groups = rows.filter(b => b.activity);
  assert.deepEqual(groups.map(b => b.activity.active), [false, true]);
  assert.equal(groups[1].activity.blocks.length, 0);
  assert.equal(new Set(rows.map(b => b.seq)).size, rows.length);
});

test('work without a final answer remains accessible, including failed tools', () => {
  const tool = { ...block(1, 'tool'), meta: '{"status":"failed"}' };
  const rows = groupActivity([block(0, 'user'), tool], false, { 0: { startedAt: 1000, endedAt: 2000, outcome: 'failed' } });
  assert.equal(rows[1].activity.blocks[0], tool);
  assert.equal(rows[1].activity.timing.outcome, 'failed');
});

test('elapsed display handles seconds, minutes and clock adjustments', () => {
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(59000), '59s');
  assert.equal(formatElapsed(125000), '2m 05s');
  assert.equal(formatElapsed(-1000), '0s');
});
