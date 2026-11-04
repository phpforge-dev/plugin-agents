import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const marks = () => [...document.querySelectorAll('mark.agent-find-match')];
const key = async (el, k, opts = {}) => { el.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...opts})); await tick(4); };

test('Buscar na conversa: ⌘F abre, realça, conta, navega, acompanha mensagens novas e Esc fecha', async () => {
 const w = dom();
 const api = fakeApi({script: async (text, _e, emit) => { emit({type: 'message', text: `Resposta sobre User: ${text}`}); emit({type: 'thought', text: 'pensando em user'}); }});
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: () => {}, language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 $('#agent-prompt').value = 'Explique a classe User'; $('#agent-send').click(); await tick(8);
 assert.equal($('.agent-find').hidden, true);
 $('#agent-prompt').focus();
 await key($('#agent-prompt'), 'f', {metaKey: true});
 assert.equal($('.agent-find').hidden, false);
 assert.equal(document.activeElement, $('.agent-find-input'));
 const input = $('.agent-find-input');
 input.value = 'user'; input.dispatchEvent(new Event('input')); await tick();
 // Pedido, resposta (2x: "User" e "User" do texto ecoado) e raciocínio; sem diferenciar maiúsculas.
 assert.equal(marks().length, 4);
 assert.equal($('.agent-find-count').textContent, '1/4');
 assert.ok(marks()[0].classList.contains('agent-find-current'));
 await key(input, 'Enter'); assert.equal($('.agent-find-count').textContent, '2/4');
 await key(input, 'Enter', {shiftKey: true}); await key(input, 'Enter', {shiftKey: true});
 assert.equal($('.agent-find-count').textContent, '4/4', 'volta ao fim');
 assert.equal(document.querySelector('.agent-thought').open, true, 'raciocínio recolhido se abre na ocorrência');
 $('.agent-find-next').click(); assert.equal($('.agent-find-count').textContent, '1/4');
 // Mensagens que chegam com a barra aberta entram na busca.
 $('#agent-prompt').value = 'E o user admin?'; $('#agent-send').click(); await tick(8);
 await new Promise(r => setTimeout(r, 200));
 assert.equal(marks().length, 8);
 input.value = 'inexistente'; input.dispatchEvent(new Event('input')); await tick();
 assert.equal($('.agent-find-count').textContent, 'Sem resultados');
 assert.ok($('.agent-find').classList.contains('agent-find-empty'));
 input.value = 'admin'; input.dispatchEvent(new Event('input')); await tick();
 await key(input, 'Escape');
 assert.equal($('.agent-find').hidden, true);
 assert.equal(marks().length, 0, 'realces removidos');
 assert.equal(document.activeElement, $('#agent-prompt'), 'foco volta ao campo');
 assert.match($('#agent-transcript').textContent, /E o user admin\?/, 'texto intacto');
 // Também pelo ⋮.
 $('#agent-options').click();
 const items = [...document.querySelectorAll('.agent-menu button')].map(b => b.firstElementChild.textContent);
 assert.deepEqual(items, ['Buscar na conversa', 'Allowlist do terminal…', 'Excluir todas as conversas']);
 document.querySelector('.agent-menu button').click();
 assert.equal($('.agent-find').hidden, false);
 assert.equal($('.agent-find-input').value, 'admin', 'mantém o último termo');
 assert.equal(marks().length, 2);
 w.happyDOM.abort();
});
