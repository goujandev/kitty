import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../src/dictationController.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const controllerUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const { DictationController, insertDictation, normalizeWaveform } = await import(controllerUrl);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const draft = { key: 'chat-a', text: 'Please fix this.', start: 7, end: 10 };

function setup(overrides = {}) {
  const calls = { start: [], finish: [], cancel: [], result: [] };
  let active = 'chat-a', allowed = true, serial = 0, now = 0;
  let status = { id: null, phase: 'idle', ready: false, progress: null, error: null, waveform: [] };
  const controller = new DictationController({
    id: () => `run-${++serial}`, now: () => now,
    current: origin => active === origin.key && allowed,
    start: async id => { calls.start.push(id); },
    finish: async id => { calls.finish.push(id); return 'update'; },
    cancel: async id => { calls.cancel.push(id); },
    status: async () => status,
    result: (...args) => calls.result.push(args),
    ...overrides,
  });
  return { controller, calls, select: key => { active = key; }, allow: value => { allowed = value; }, status: value => { status = value; }, time: value => { now = value; } };
}

test('native microphone and recognition errors expose their recovery instructions', async () => {
  const first = setup({ start: async () => { throw 'No microphone was found. Connect one and try again.'; } });
  await first.controller.start(draft);
  assert.equal(first.controller.getSnapshot().error, 'No microphone was found. Connect one and try again.');
  const second = setup({ finish: async () => { throw 'Recording reached two minutes. Start again with a shorter message.'; } });
  await second.controller.start(draft);
  await second.controller.finish(true);
  assert.equal(second.controller.getSnapshot().error, 'Recording reached two minutes. Start again with a shorter message.');
  assert.equal(second.calls.result.length, 0);
});

test('dictation replaces the captured selection and retains surrounding typed text', () => {
  assert.deepEqual(insertDictation(draft, ' update '), { text: 'Please update this.', caret: 13 });
  assert.deepEqual(insertDictation({ ...draft, text: 'Hello, world!', start: 5, end: 5 }, 'Kitty'), { text: 'Hello Kitty, world!', caret: 11 });
  assert.equal(insertDictation({ ...draft, text: 'Line one\n', start: 9, end: 9 }, 'Line two').text, 'Line one\nLine two');
});

test('finishing records first, then inserts a completed transcript for editing', async () => {
  const pending = deferred();
  const { controller, calls } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  assert.equal(controller.getSnapshot().phase, 'recording');
  const finishing = controller.finish();
  assert.equal(controller.getSnapshot().phase, 'transcribing');
  assert.equal(calls.result.length, 0);
  pending.resolve('update');
  await finishing;
  assert.deepEqual(calls.result, [[draft, 'Please update this.', 13, false]]);
  assert.equal(controller.getSnapshot().phase, 'idle');
});

test('Send during recording waits for final text and cannot queue a duplicate send', async () => {
  const pending = deferred();
  let finishes = 0;
  const { controller, calls } = setup({ finish: () => { finishes++; return pending.promise; } });
  await controller.start(draft);
  const finishing = controller.finish(true);
  await controller.finish(true);
  assert.equal(finishes, 1);
  assert.equal(calls.result.length, 0);
  pending.resolve('update');
  await finishing;
  assert.equal(calls.result[0][3], true);
  assert.equal(calls.result[0][1], 'Please update this.');
});

test('cancelling an in-flight transcription keeps the original draft and never sends', async () => {
  const pending = deferred();
  const { controller, calls } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  controller.cancel();
  pending.resolve('late speech');
  await finishing;
  assert.equal(calls.result.length, 0);
  assert.deepEqual(calls.cancel, ['run-1']);
  assert.equal(draft.text, 'Please fix this.');
});

test('cancel during preparation fences a late recorder start', async () => {
  const pending = deferred();
  const { controller, calls } = setup({ start: () => pending.promise });
  const starting = controller.start(draft);
  controller.cancel();
  pending.resolve();
  await starting;
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.deepEqual(calls.cancel, ['run-1', 'run-1']);
  assert.equal(calls.result.length, 0);
});

test('a late result cannot move to another chat, even without cleanup having run', async () => {
  const pending = deferred();
  const { controller, calls, select } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  select('chat-b');
  pending.resolve('wrong chat');
  await finishing;
  assert.equal(calls.result.length, 0);
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'idle');
});

test('agent busy or disabled before completion prevents automatic send', async () => {
  const pending = deferred();
  const { controller, calls, allow } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  allow(false);
  pending.resolve('update');
  await finishing;
  assert.equal(calls.result.length, 0);
});

test('empty speech and native failure leave the typed draft intact and can be retried', async () => {
  let response = '   ';
  const { controller, calls } = setup({ finish: async () => { if (response === 'fail') throw new Error('native'); return response; } });
  await controller.start(draft);
  await controller.finish(true);
  assert.match(controller.getSnapshot().error, /Didn't catch/);
  response = 'fail';
  await controller.start(draft);
  await controller.finish(true);
  assert.match(controller.getSnapshot().error, /Couldn't transcribe/);
  assert.equal(calls.result.length, 0);
  response = 'update';
  await controller.start(draft);
  await controller.finish();
  assert.equal(calls.result.length, 1);
  assert.equal(calls.result[0][3], false);
});

test('preparation displays owned progress, and ignores other requests', async () => {
  const pending = deferred();
  const { controller, status } = setup({ start: () => pending.promise });
  const starting = controller.start(draft);
  status({ id: 'run-1', phase: 'preparing', ready: false, progress: .4, error: null });
  await controller.poll();
  assert.equal(controller.getSnapshot().progress, .4);
  status({ id: 'other', phase: 'error', error: 'wrong request' });
  await controller.poll();
  assert.equal(controller.getSnapshot().error, null);
  pending.resolve();
  await starting;
});

test('owned native error cancels the run and discards an already pending successful result', async () => {
  const pending = deferred();
  const { controller, calls, status } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  status({ id: 'run-1', phase: 'error', error: 'Microphone disconnected. Try again.' });
  await controller.poll();
  pending.resolve('late text');
  await finishing;
  assert.equal(calls.result.length, 0);
  assert.match(controller.getSnapshot().error, /Microphone disconnected/);
});

test('hung transcription times out, cancels native work, and cannot send late speech', async () => {
  const pending = deferred();
  const { controller, calls, time } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  time(3 * 60_000 + 1);
  await controller.poll();
  assert.match(controller.getSnapshot().error, /took too long/);
  pending.resolve('late');
  await finishing;
  assert.equal(calls.result.length, 0);
  assert.deepEqual(calls.cancel, ['run-1']);
});

test('cancelled old result cannot displace a new recording in the same chat', async () => {
  const pending = deferred();
  const { controller, calls } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  const finishing = controller.finish(true);
  controller.cancel();
  await controller.start(draft);
  pending.resolve('old');
  await finishing;
  assert.equal(controller.getSnapshot().id, 'run-2');
  assert.equal(controller.getSnapshot().phase, 'recording');
  assert.equal(calls.result.length, 0);
  controller.cancel();
});

test('microphone history is finite, bounded and ordered oldest to newest', () => {
  assert.deepEqual(normalizeWaveform([-.3, .25, 2, NaN, Infinity]), [0, .25, 1, 0, 0]);
  const levels = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.deepEqual(normalizeWaveform(levels), levels.slice(-80));
  assert.deepEqual(normalizeWaveform(undefined), []);
});

test('only the owned recording updates volume and finishing immediately clears it', async () => {
  const pending = deferred();
  const { controller, status } = setup({ finish: () => pending.promise });
  await controller.start(draft);
  status({ id: 'other', phase: 'recording', waveform: [1] });
  await controller.poll();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  status({ id: 'run-1', phase: 'recording', waveform: [.1, .8] });
  await controller.poll();
  assert.deepEqual(controller.getSnapshot().waveform, [.1, .8]);
  const finishing = controller.finish();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  await controller.poll();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  pending.resolve('update');
  await finishing;
});

test('cancellation, new recordings and native errors clear microphone history', async () => {
  const { controller, status } = setup();
  await controller.start(draft);
  status({ id: 'run-1', phase: 'recording', waveform: [.6] });
  await controller.poll();
  controller.cancel();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  await controller.start(draft);
  assert.deepEqual(controller.getSnapshot().waveform, []);
  await controller.poll();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  status({ id: 'run-2', phase: 'recording', waveform: [.4] });
  await controller.poll();
  status({ id: 'run-2', phase: 'error', error: 'Microphone disconnected.' });
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'error');
  assert.deepEqual(controller.getSnapshot().waveform, []);
});

test('in-flight volume replies cannot restore bars after finishing or restarting', async () => {
  const volume = deferred(), transcript = deferred();
  const { controller } = setup({ status: () => volume.promise, finish: () => transcript.promise });
  await controller.start(draft);
  const polling = controller.poll();
  const finishing = controller.finish();
  volume.resolve({ id: 'run-1', phase: 'recording', waveform: [1] });
  await polling;
  assert.deepEqual(controller.getSnapshot().waveform, []);
  controller.cancel();
  await controller.start(draft);
  await controller.poll();
  assert.deepEqual(controller.getSnapshot().waveform, []);
  transcript.resolve('late');
  await finishing;
  assert.equal(controller.getSnapshot().id, 'run-2');
});

const waveformSource = readFileSync(new URL('../src/views/DictationWaveform.tsx', import.meta.url), 'utf8')
  .replace('"../dictationController"', JSON.stringify(controllerUrl));
const waveformCode = ts.transpileModule(waveformSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const waveformUrl = 'data:text/javascript;base64,' + Buffer.from(waveformCode).toString('base64');
const { DictationWaveform } = await import(waveformUrl);

test('waveform uses bounded centered bars, quiet dots and latest volume on the right', () => {
  const html = renderToStaticMarkup(createElement(DictationWaveform, { levels: [0, .5, 1] }));
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /preserveAspectRatio="none"/);
  const bars = [...html.matchAll(/<rect\b[^>]*>/g)].map(match => match[0]);
  assert.equal(bars.length, 80);
  assert.match(bars.at(-3), /height="2.5"/);
  assert.match(bars.at(-2), /height="15.25"/);
  assert.match(bars.at(-1), /height="28"/);
  assert.match(bars.at(-1), /y="2"/);
  const excessive = renderToStaticMarkup(createElement(DictationWaveform, { levels: Array(200).fill(Infinity) }));
  assert.equal([...excessive.matchAll(/<rect\b/g)].length, 80);
  assert.doesNotMatch(excessive, /NaN|Infinity/);
});

const composerSource = readFileSync(new URL('../src/views/Composer.tsx', import.meta.url), 'utf8')
  .replace('import { Icon } from "./Icon";', 'const Icon = () => null;')
  .replace('import { dictationCancel, dictationFinish, dictationStart, dictationStatus } from "../ipc/commands";', 'const dictationCancel = async () => {}; const dictationFinish = async () => ""; const dictationStart = async () => {}; const dictationStatus = async () => ({id:null, phase:"idle", ready:false, progress:null, error:null});')
  .replace('"../dictationController"', JSON.stringify('data:text/javascript;base64,' + Buffer.from(code).toString('base64')))
  .replace('"./DictationWaveform"', JSON.stringify(waveformUrl))
  .replace('import "../dictation.css";', '')
  .replace('"react"', JSON.stringify(import.meta.resolve('react')));
const composerCode = ts.transpileModule(composerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const { Composer } = await import('data:text/javascript;base64,' + Buffer.from(composerCode).toString('base64'));
const renderComposer = props => renderToStaticMarkup(createElement(Composer, { storageKey: 'render-draft', busy: false, disabled: false, onSend: () => {}, onCancel: () => {}, ...props }));
const button = (html, label) => [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`aria-label="${label}"`));

test('microphone appears immediately before Send and stays available in an empty draft', () => {
  const html = renderComposer({});
  assert.match(button(html, 'Dictate'), /dictation-mic/);
  assert.doesNotMatch(button(html, 'Dictate'), /disabled/);
  assert.match(button(html, 'Send'), /disabled/);
  assert.match(html, /aria-label="Dictate"[^]*?<\/button><button[^]*?aria-label="Send"/);
});

test('agent busy and unavailable composers disable dictation while preserving Stop', () => {
  const busy = renderComposer({ busy: true });
  assert.match(button(busy, 'Dictate'), /disabled/);
  assert.ok(button(busy, 'Stop'));
  assert.equal(button(busy, 'Send'), undefined);
  const unavailable = renderComposer({ disabled: true });
  assert.match(button(unavailable, 'Dictate'), /disabled/);
  assert.match(button(unavailable, 'Send'), /disabled/);
  assert.match(unavailable, /<textarea[^>]*disabled/);
});
