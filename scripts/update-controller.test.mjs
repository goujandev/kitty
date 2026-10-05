import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/stores/updateController.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { UpdateController } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(overrides = {}) {
 const calls = { check: 0, download: 0, install: 0, close: 0 };
 const update = {
  version: '0.1.2', body: 'Release notes',
  download: async callback => { calls.download++; callback({ event: 'Started', data: { contentLength: 100 } }); callback({ event: 'Progress', data: { chunkLength: 40 } }); callback({ event: 'Progress', data: { chunkLength: 60 } }); callback({ event: 'Finished' }); },
  install: async options => { calls.install++; assert.equal(options.restartAfterInstall, true); },
  close: async () => { calls.close++; },
 };
 const controller = new UpdateController({ supported: true, getVersion: async () => '0.1.1', check: async () => { calls.check++; return update; }, ...overrides });
 return { controller, calls, update };
}
test('available, progress, verified download, explicit restart and install', async () => {
 const { controller, calls } = setup();
 const snapshots = [];
 controller.subscribe(() => snapshots.push(controller.getSnapshot()));
 await controller.check();
 assert.equal(controller.getSnapshot().currentVersion, '0.1.1');
 assert.equal(controller.getSnapshot().version, '0.1.2');
 assert.equal(controller.getSnapshot().notes, 'Release notes');
 assert.equal(calls.download, 0);
 await controller.install(false);
 assert.equal(calls.install, 0);
 await controller.download();
 assert.ok(snapshots.some(s => s.phase === 'downloading' && s.downloaded === 40 && s.total === 100));
 assert.equal(controller.getSnapshot().phase, 'ready');
 assert.equal(calls.install, 0);
 await controller.install(false);
 assert.equal(calls.install, 1);
});
test('up to date and check timestamp', async () => {
 const { controller } = setup({ check: async () => null });
 await controller.check();
 assert.equal(controller.getSnapshot().phase, 'current');
 assert.ok(controller.getSnapshot().checkedAt);
});
test('offline check is visible and can be retried', async () => {
 let offline = true;
 const { controller } = setup({ check: async () => { if (offline) throw new Error('offline'); return null; } });
 await controller.check();
 assert.match(controller.getSnapshot().error, /offline/);
 assert.equal(controller.getSnapshot().phase, 'idle');
 offline = false;
 await controller.check();
 assert.equal(controller.getSnapshot().phase, 'current');
 assert.equal(controller.getSnapshot().error, null);
});
test('concurrent checks collapse to one request', async () => {
 const pending = deferred();
 let calls = 0;
 const { controller } = setup({ check: () => { calls++; return pending.promise; } });
 const first = controller.check();
 await Promise.resolve();
 await controller.check();
 assert.equal(calls, 1);
 pending.resolve(null);
 await first;
});
test('Finished alone cannot install an unverified download; signature rejection is retryable', async () => {
 const { controller, update, calls } = setup();
 const pending = deferred();
 update.download = async callback => { callback({ event: 'Finished' }); await pending.promise; throw new Error('invalid signature'); };
 await controller.check();
 const download = controller.download();
 await controller.install(false);
 await controller.check();
 assert.equal(calls.install, 0);
 assert.equal(calls.check, 1);
 assert.equal(controller.getSnapshot().phase, 'downloading');
 pending.resolve();
 await download;
 assert.equal(controller.getSnapshot().phase, 'available');
 assert.match(controller.getSnapshot().error, /invalid signature/);
 update.download = async () => {};
 await controller.download();
 assert.equal(controller.getSnapshot().phase, 'ready');
 assert.equal(controller.getSnapshot().error, null);
});
test('unknown content length gives indeterminate progress', async () => {
 const { controller, update } = setup();
 const pending = deferred();
 update.download = async callback => { callback({ event: 'Started', data: {} }); callback({ event: 'Progress', data: { chunkLength: 123 } }); await pending.promise; };
 await controller.check();
 const download = controller.download();
 assert.equal(controller.getSnapshot().total, null);
 assert.equal(controller.getSnapshot().downloaded, 123);
 pending.resolve();
 await download;
});
test('running turns block restart; installer failure can be retried', async () => {
 const { controller, update, calls } = setup();
 await controller.check();
 await controller.download();
 await controller.install(true);
 assert.equal(calls.install, 0);
 assert.match(controller.getSnapshot().error, /running conversations/);
 update.install = async () => { throw new Error('access denied'); };
 await controller.install(false);
 assert.equal(controller.getSnapshot().phase, 'ready');
 assert.match(controller.getSnapshot().error, /access denied/);
 update.install = async () => { calls.install++; };
 await controller.install(false);
 assert.equal(controller.getSnapshot().error, null);
 assert.equal(calls.install, 1);
});
test('rechecking releases the previous native resource', async () => {
 const { controller, calls } = setup();
 await controller.check(); await controller.check();
 assert.equal(calls.close, 1);
});
test('browser preview makes no native requests', async () => {
 const { controller, calls } = setup({ supported: false });
 await controller.check(); await controller.download(); await controller.install(false);
 assert.equal(controller.getSnapshot().phase, 'unavailable');
 assert.equal(calls.check, 0);
});
