import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const fileItem = file => ({kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({isDirectory: false, name: file.name})});
// Pasta arrastada: entradas como a API do WebKit (createReader/readEntries em lotes).
const dirEntry = (name, tree, prefix = '') => ({isDirectory: true, name, fullPath: `${prefix}/${name}`, createReader() {
 let done = false; return {readEntries: ok => { if (done) return ok([]); done = true; ok(Object.entries(tree).map(([n, v]) => v && typeof v === 'object' ? dirEntry(n, v, `${prefix}/${name}`) : {isDirectory: false, name: n, fullPath: `${prefix}/${name}/${n}`})); }};
}});
function drop(target, items) {
 const transfer = {types: ['Files'], items, files: items.map(i => i.getAsFile?.()).filter(Boolean), dropEffect: 'none'};
 for (const type of ['dragenter', 'dragover', 'drop']) {
  const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperty(event, 'dataTransfer', {value: transfer});
  target.dispatchEvent(event);
  if (type === 'dragover') { assert.equal(event.defaultPrevented, true, 'aceita o drop'); assert.equal(transfer.dropEffect, 'copy'); assert.ok($('.agent-input').classList.contains('agent-drop')); }
  if (type === 'drop') assert.equal(event.defaultPrevented, true);
 }
}

test('arquivos e pastas do sistema arrastados para o chat viram anexos; arquivo do projeto vira @file', async () => {
 const w = dom();
 const api = fakeApi({files: ['src/User.php', 'README.md']});
 const statuses = [];
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: t => statuses.push(t), language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 assert.equal($('#agent-chat').dataset.fileDrop, 'true');
 drop($('#agent-transcript'), [fileItem(new File(['x'], 'a.txt'))]); await tick(6);
 assert.match(statuses.at(-1), /Inicie um agente/);
 $('#agent-start').click(); await tick();
 const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
 drop($('#agent-transcript'), [
  fileItem(new File(['<?php // src/User.php\n'], 'User.php', {type: 'text/x-php'})),
  fileItem(new File(['# Notas\nfora do projeto'], 'notas.md', {type: 'text/markdown'})),
  fileItem(new File([PNG], 'tela.png', {type: 'image/png'})),
  fileItem(new File([new Uint8Array([0, 1, 2])], 'dump.bin')),
  {kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => dirEntry('docs', {'b.md': 1, 'a.md': 1, node_modules: {'x.js': 1}, sub: {'c.md': 1}})},
 ]);
 await tick(20); await new Promise(r => setTimeout(r, 50));
 assert.equal($('.agent-input').classList.contains('agent-drop'), false);
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip')].map(c => [c.dataset.kind, c.querySelector('.agent-chip-label').textContent]).sort(), [['dropped', 'docs/'], ['dropped', 'notas.md'], ['file', 'User.php'], ['image', 'tela.png']]);
 assert.match(statuses.join('\n'), /dump\.bin: arquivo binário/);
 $('#agent-prompt').value = 'Use estes anexos'; $('#agent-send').click(); await tick(8);
 const attachments = api.calls.find(c => c[0] === 'agentPrompt')[3].attachments;
 const byType = Object.fromEntries(attachments.map(a => [a.type === 'dropped' ? a.name : a.type, a]));
 assert.deepEqual(byType.file, {type: 'file', path: 'src/User.php'}, 'arquivo idêntico ao do projeto vai como referência');
 assert.deepEqual(byType['notas.md'], {type: 'dropped', name: 'notas.md', text: '# Notas\nfora do projeto'});
 assert.equal(byType['docs/'].text, 'Pasta docs (3 arquivos):\ndocs/a.md\ndocs/b.md\ndocs/sub/c.md');
 assert.equal(byType.image.mimeType, 'image/png');
 w.happyDOM.abort();
});
