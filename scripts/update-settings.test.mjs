import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const storeUrl = moduleUrl('export const updates = {}; export const useUpdates = () => globalThis.pantheonTestUpdates;');
const chatUrl = moduleUrl('export const useChat = () => ({running: globalThis.pantheonTestRunning});');
let source = readFileSync(new URL('../src/views/UpdateSettings.tsx', import.meta.url), 'utf8');
source = source.replace('../stores/updateStore', storeUrl).replace('../stores/chatStore', chatUrl);
let code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
code = code.replace('react/jsx-runtime', pathToFileURL(require.resolve('react/jsx-runtime')).href);
const { UpdateSettings } = await import(moduleUrl(code));
const render = (state = {}, running = {}) => {
 globalThis.pantheonTestUpdates = { phase: 'current', currentVersion: '0.1.1', version: '0.1.2', notes: null, downloaded: 0, total: null, checkedAt: null, error: null, ...state };
 globalThis.pantheonTestRunning = running;
 return renderToStaticMarkup(createElement(UpdateSettings));
};
test('Settings shows installed and available versions with an explicit download button', () => {
 const html = render({ phase: 'available' });
 assert.match(html, /Pantheon 0.1.1/);
 assert.match(html, /Pantheon 0.1.2 is available/);
 assert.match(html, />Check for updates<\/button>/);
 assert.match(html, />Download update<\/button>/);
 assert.doesNotMatch(html, />Restart and install<\/button>/);
});
test('known and unknown download lengths use accessible progress', () => {
 const known = render({ phase: 'downloading', downloaded: 50, total: 100 });
 assert.match(known, /aria-label="Update download progress" max="100" value="50"/);
 assert.match(known, /50%/);
 assert.match(known, /disabled=""/);
 const unknown = render({ phase: 'downloading', downloaded: 50 });
 assert.match(unknown, /<progress aria-label="Update download progress" max="100"><\/progress>/);
});
test('ready update prompts restart and blocks it during a running turn', () => {
 const idle = render({ phase: 'ready' });
 assert.match(idle, /Restart to install this update/);
 assert.match(idle, /unsent drafts/);
 assert.match(idle, /class="button">Restart and install<\/button>/);
 const running = render({ phase: 'ready' }, { session: 'project' });
 assert.match(running, /disabled="">Restart and install<\/button>/);
});
test('errors are announced and release notes are rendered as text', () => {
 const html = render({ error: 'Network failed', notes: '<script>bad()</script>' });
 assert.match(html, /role="alert">Network failed/);
 assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
 assert.doesNotMatch(html, /<script>/);
});
test('browser preview disables native update controls', () => {
 const html = render({ phase: 'unavailable', currentVersion: null });
 assert.match(html, /installed Windows app/);
 assert.match(html, /disabled="">Check for updates/);
});
