import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, hooks, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

async function mount(api) {
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, document.getElementById('agent'), hooks());
 api.connect(e => panel.handle(e)); await tick();
 return {s, panel};
}
const $ = sel => document.querySelector(sel);
async function ask(text) {
 $('#agent-prompt').value = text; $('#agent-send').click(); await tick(6);
}

test('histórico por projeto: grava, lista, abre, continua, renomeia e exclui', async () => {
 const w = dom();
 const histories = new Map();
 const api = fakeApi({histories});
 const {s} = await mount(api);
 $('#agent-start').click(); await tick();
 await ask('Explique a classe User\ncom detalhes');
 assert.match($('#agent-transcript').textContent, /Resposta a: Explique a classe User/);
 assert.equal(histories.get('/project').size, 1, 'conversa gravada após o pedido');
 // Nova conversa limpa a transcrição e recria a sessão do agente.
 $('#agent-new').click(); await tick();
 assert.equal($('#agent-transcript').children.length, 0);
 assert.ok(api.calls.some(c => c[0] === 'agentReset'));
 await ask('Segundo pedido');
 // Lista: mais recente primeiro, título do primeiro pedido e tempo relativo.
 $('#agent-history-button').click(); await tick();
 assert.equal($('#agent-history').hidden, false); assert.equal($('#agent-chat').hidden, true);
 let rows = [...document.querySelectorAll('.agent-history-list li')];
 assert.deepEqual(rows.map(r => r.querySelector('.agent-history-title').textContent), ['Segundo pedido', 'Explique a classe User']);
 assert.equal(rows[0].querySelector('.agent-history-time').textContent, 'agora');
 assert.equal(rows[0].getAttribute('aria-current'), 'true');
 // Busca filtra pelo título.
 const search = $('.agent-history-search'); search.value = 'classe'; search.dispatchEvent(new Event('input'));
 assert.equal(document.querySelectorAll('.agent-history-list li').length, 1);
 search.value = ''; search.dispatchEvent(new Event('input'));
 // Abrir a conversa antiga restaura a transcrição; o próximo pedido leva a conversa anterior à sessão nova.
 document.querySelectorAll('.agent-history-list li')[1].click(); await tick(6);
 assert.equal($('#agent-chat').hidden, false);
 assert.match($('#agent-transcript').textContent, /Explique a classe User/);
 assert.match($('#agent-transcript').textContent, /Resposta a: Explique/);
 await ask('E os testes?');
 const prompt = api.calls.filter(c => c[0] === 'agentPrompt').at(-1);
 assert.match(prompt[3].history, /Usuário: Explique a classe User/);
 assert.match(prompt[3].history, /Agente: Resposta a: Explique/);
 await ask('Mais um');
 assert.equal(api.calls.filter(c => c[0] === 'agentPrompt').at(-1)[3].history, undefined, 'histórico enviado só uma vez');
 assert.equal(histories.get('/project').size, 2, 'continuar não cria outra conversa');
 // Renomear pelo menu de contexto (⇧F6) e excluir (⌫).
 $('#agent-history-button').click(); await tick();
 rows = [...document.querySelectorAll('.agent-history-list li')];
 rows[0].dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 10, clientY: 10}));
 const menu = [...document.querySelectorAll('.agent-menu button')].map(b => b.textContent);
 assert.deepEqual(menu, ['Renomear⇧F6', 'Excluir conversa⌫']);
 document.querySelector('.agent-menu button').click();
 const input = $('.agent-history-rename'); input.value = 'Classe User';
 input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'})); await tick();
 assert.equal(document.querySelector('.agent-history-list li .agent-history-title').textContent, 'Classe User');
 document.querySelector('.agent-history-list li').dispatchEvent(new KeyboardEvent('keydown', {key: 'Backspace', bubbles: true})); await tick();
 assert.equal(document.querySelectorAll('.agent-history-list li').length, 1);
 // Esc volta para a conversa; "Excluir todas as conversas" no menu de opções.
 $('#agent-history').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
 assert.equal($('#agent-history').hidden, true);
 $('#agent-options').click(); [...document.querySelectorAll('.agent-menu button')].find(b => b.textContent.startsWith('Excluir todas')).click(); await tick();
 assert.equal(histories.get('/project').size, 0);
 // Outro projeto: lista vazia.
 const other = fakeApi({histories, project: '/other'});
 document.body.innerHTML = '<section id="agent"></section>';
 for (const fn of s.cleanups.reverse()) fn();
 await mount(other);
 $('#agent-history-button').click(); await tick();
 assert.equal(document.querySelectorAll('.agent-history-list li').length, 0);
 assert.equal($('.agent-history-empty').hidden, false);
 w.happyDOM.abort();
});

test('ponto amarelo na conversa que espera aprovação', async () => {
 const w = dom();
 const api = fakeApi({script: async (_t, _e, emit, api) => { emit({type: 'permission', id: 'p1', title: 'Editar src/User.php', kind: 'edit', options: [{id: 'allow', name: 'Permitir', kind: 'allow_once'}]}); await api.waitPermission(); }});
 await mount(api);
 $('#agent-start').click(); await tick();
 $('#agent-prompt').value = 'editar'; $('#agent-send').click(); await tick(6);
 $('#agent-history-button').click(); await tick();
 assert.ok(document.querySelector('.agent-history-list li .agent-history-waiting'));
 $('#agent-history').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
 document.querySelector('.agent-permission button').click(); await tick(6);
 $('#agent-history-button').click(); await tick();
 assert.equal(document.querySelector('.agent-history-waiting'), null);
 w.happyDOM.abort();
});
