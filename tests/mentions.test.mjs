import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const database = {sqlIntelligence: {entries: new Map([['s1', {session: {id: 's1', label: 'app@localhost', driver: 'postgres'}, model: {schemas: [{name: 'public', tables: [{name: 'users', kind: 'table', columns: [{name: 'id', type: 'bigint'}, {name: 'email', type: 'text', nullable: false}]}]}]}}]])}};
async function mount({context, services = {database}} = {}) {
 const api = fakeApi();
 const opened = [];
 const s = makeSdk({services, host: {editor: {getSelection: () => ({startLineNumber: 7, startColumn: 5, endLineNumber: 9, endColumn: 6})}, open: async (path, line) => opened.push([path, line])}});
 activate(s); s.api = api;
 const hooks = {context: () => context, reload: async () => {}, status: () => {}, language: () => 'php'};
 const panel = s.contribution.mount(api, $('#agent'), hooks);
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 return {api, opened};
}
async function type(text) {
 const t = $('#agent-prompt'); const caret = t.selectionStart ?? t.value.length;
 t.value = t.value.slice(0, caret) + text + t.value.slice(caret); t.setSelectionRange(caret + text.length, caret + text.length);
 t.dispatchEvent(new Event('input')); await tick(8);
}
const key = async k => { $('#agent-prompt').dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true})); await tick(8); };
const rows = () => [...document.querySelectorAll('.agent-popup-item')].map(r => r.querySelector('.agent-popup-label').textContent);

test('@ lista categorias e arquivos recentes; @file: escolhe arquivo, insere token e ficha', async () => {
 const w = dom();
 const {api} = await mount({context: {path: 'src/User.php', text: '<?php // buffer', selection: 'return 1;'}});
 assert.equal($('#agent-prompt').placeholder, 'Digite sua tarefa, use @ para adicionar arquivos ou / para comandos');
 await type('Explique @');
 assert.equal($('#agent-popup').hidden, false);
 assert.deepEqual(rows(), ['@thisFile', '@selection', '@file:', '@folder:', '@symbol:', '@dbObject:', 'User.php']);
 assert.equal($('.agent-popup-footer').textContent, 'Pressione ↩ para inserir, ⇥ para substituir');
 await type('fi');
 assert.deepEqual(rows(), ['@file:']);
 await key('Enter');
 assert.equal($('#agent-prompt').value, 'Explique @file:');
 assert.equal($('#agent-popup').hidden, false, 'categoria mantém o popup aberto');
 await type('Adm');
 assert.equal(rows()[0], 'Admin.php', 'prefixo do nome primeiro');
 assert.equal(document.querySelector('.agent-popup-hint').textContent, 'src');
 await key('Enter');
 assert.equal($('#agent-prompt').value, 'Explique @file:Admin.php ');
 assert.equal($('#agent-popup').hidden, true);
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip-label')].map(c => c.textContent), ['Admin.php']);
 assert.equal($('.agent-highlight mark').textContent, '@file:Admin.php');
 // @thisFile manda o buffer do editor (não salvo); @selection manda o trecho com linhas.
 await type('e @thisF'); await key('Enter');
 await type('e @sel'); await key('Enter');
 assert.equal($('#agent-prompt').value, 'Explique @file:Admin.php e @thisFile e @selection ');
 $('#agent-send').click(); await tick(8);
 const [, text, , extras] = api.calls.find(c => c[0] === 'agentPrompt');
 assert.equal(text, 'Explique @file:Admin.php e @thisFile e @selection');
 assert.deepEqual(extras.attachments, [{type: 'file', path: 'src/Admin.php'}, {type: 'file', path: 'src/User.php', text: '<?php // buffer'}, {type: 'selection', path: 'src/User.php', text: 'return 1;', line: 7, endLine: 9}]);
 assert.deepEqual([...document.querySelectorAll('.agent-user .agent-chip')].map(c => c.textContent), ['Admin.php', 'User.php', 'User.php:7-9']);
 assert.equal($('#agent-chips').hidden, true, 'fichas limpas após enviar');
 w.happyDOM.abort();
});

test('@symbol: busca símbolos, @folder: pastas, @dbObject: schema/tabelas; Tab substitui; × remove', async () => {
 const w = dom();
 const {api, opened} = await mount({context: undefined});
 await type('@');
 assert.deepEqual(rows().slice(0, 4), ['@file:', '@folder:', '@symbol:', '@dbObject:'], 'sem editor: sem @thisFile/@selection');
 await type('symbol:User'); await new Promise(r => setTimeout(r, 250)); await tick();
 assert.deepEqual(rows(), ['User', 'UserRepository']);
 await key('ArrowDown'); await key('Enter');
 assert.equal($('#agent-prompt').value, '@symbol:UserRepository ');
 await type('@folder:sr'); await key('Enter');
 await type('@dbObject:users');
 assert.deepEqual(rows(), ['public.users']);
 await key('Enter');
 // Tab substitui o token inteiro sob o cursor (↩ só insere até o cursor).
 const t = $('#agent-prompt'); t.value += '@file:REAxyz'; t.setSelectionRange(t.value.length - 5, t.value.length - 5); t.dispatchEvent(new Event('click')); await tick(8);
 assert.equal(rows()[0], 'README.md');
 await key('Tab');
 assert.match(t.value, /@file:README\.md $/);
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip-label')].map(c => c.textContent), ['UserRepository', 'src', 'public.users', 'README.md']);
 // Clicar na ficha abre o arquivo/símbolo no editor.
 document.querySelector('#agent-chips .agent-chip-label').click(); await tick();
 assert.deepEqual(opened, [['src/UserRepository.php', 2]]);
 // × remove a ficha e o token; apagar o token remove a ficha.
 document.querySelectorAll('#agent-chips .agent-chip-remove')[1].click();
 assert.doesNotMatch(t.value, /@folder:src/);
 t.value = t.value.replace('@file:README.md', ''); t.dispatchEvent(new Event('input'));
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip-label')].map(c => c.textContent), ['UserRepository', 'public.users']);
 $('#agent-send').click(); await tick(8);
 const extras = api.calls.find(c => c[0] === 'agentPrompt')[3];
 assert.deepEqual(extras.attachments[0], {type: 'symbol', name: 'UserRepository', path: 'src/UserRepository.php', line: 3, endLine: 4});
 assert.equal(extras.attachments[1].type, 'schema');
 assert.match(extras.attachments[1].text, /TABLE public\.users \(id bigint, email text NOT NULL\)/);
 assert.doesNotMatch(JSON.stringify(extras), /password/i);
 // Esc fecha o popup sem inserir.
 await type('@fi'); await key('Escape');
 assert.equal($('#agent-popup').hidden, true);
 w.happyDOM.abort();
});
