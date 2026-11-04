import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const commands = [{name: 'explain', description: 'Explica o código mencionado'}, {name: 'tests', description: 'Gera testes', hint: 'classe ou método'}, {name: 'compact', description: 'Resume a conversa'}];
async function mount(list = commands) {
 const api = fakeApi({commands: list});
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: () => {}, language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 return {api, panel};
}
async function type(text) { const t = $('#agent-prompt'); t.value += text; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('input')); await tick(8); }
const key = async k => { $('#agent-prompt').dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true})); await tick(8); };
const rows = () => [...document.querySelectorAll('.agent-popup-item')].map(r => [r.querySelector('.agent-popup-label').textContent, r.querySelector('.agent-popup-hint')?.textContent]);

test('/ no início lista os comandos anunciados pelo agente, filtra, insere e mostra a dica do argumento', async () => {
 const w = dom();
 const {api, panel} = await mount();
 await type('/');
 assert.deepEqual(rows(), [['/explain', 'Explica o código mencionado'], ['/tests', 'Gera testes'], ['/compact', 'Resume a conversa']]);
 await type('te');
 assert.deepEqual(rows().map(r => r[0]), ['/tests']);
 await key('Enter');
 assert.equal($('#agent-prompt').value, '/tests ');
 assert.equal($('.agent-highlight mark').textContent, '/tests');
 assert.equal($('#agent-command-hint').hidden, false);
 assert.equal($('#agent-command-hint').textContent, '/tests classe ou método');
 await type('User');
 $('#agent-send').click(); await tick(8);
 assert.equal(api.calls.find(c => c[0] === 'agentPrompt')[1], '/tests User', 'comando vai ao agente como texto do pedido (ACP)');
 assert.equal($('#agent-command-hint').hidden, true);
 // "/" no meio do texto não abre o popup; comando desconhecido não é realçado.
 await type('veja a/b');
 assert.equal($('#agent-popup').hidden, true);
 $('#agent-prompt').value = ''; await type('/xyz ');
 assert.equal($('.agent-highlight mark'), null);
 // Atualização da lista pelo agente substitui os comandos.
 $('#agent-prompt').value = ''; panel.handle({type: 'commands', commands: [{name: 'review', description: 'Revisa'}]});
 await type('/');
 assert.deepEqual(rows(), [['/review', 'Revisa']]);
 w.happyDOM.abort();
});

test('sem comandos anunciados, o popup informa', async () => {
 const w = dom();
 await mount([]);
 await type('/');
 assert.equal($('#agent-popup').hidden, false);
 assert.equal($('.agent-popup-empty').textContent, 'O agente não anunciou comandos');
 w.happyDOM.abort();
});
