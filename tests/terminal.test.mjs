import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
// Agente falso: pede dois comandos; o host sintético só "executa" se a decisão for aprovar.
async function script(_text, _extras, emit, api) {
 for (const [id, command] of [['t1', 'php vendor/bin/phpunit'], ['t2', 'rm -rf build']]) {
  emit({type: 'terminal', id, command, cwd: id === 't1' ? '' : 'src', status: 'waiting'});
  const allow = await api.waitTerminal(id);
  if (!allow) { emit({type: 'terminal', id, status: 'rejected'}); emit({type: 'message', text: `${command} recusado. `}); continue; }
  emit({type: 'terminal', id, status: 'running'});
  emit({type: 'terminal-output', id, text: 'PHPUnit 11\n'}); emit({type: 'terminal-output', id, text: 'OK (3 tests)\n'});
  if (api.killRequested) { emit({type: 'terminal', id, status: 'killed', exitCode: null, signal: 'SIGKILL'}); continue; }
  emit({type: 'terminal', id, status: 'exited', exitCode: 0, signal: null});
 }
}
async function mount() {
 const api = fakeApi({script});
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: () => {}, language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 return api;
}

test('cada comando do agente espera aprovação explícita: Executar roda, Recusar bloqueia; saída e estado ficam no histórico', async () => {
 const w = dom();
 const api = await mount();
 $('#agent-prompt').value = 'Rode os testes'; $('#agent-send').click(); await tick(8);
 const block = $('.agent-terminal[data-id="t1"]');
 assert.equal(block.querySelector('strong').textContent, 'Executar comando no terminal?');
 assert.equal(block.querySelector('.agent-terminal-command').textContent, '$ php vendor/bin/phpunit');
 assert.equal(block.querySelector('.agent-terminal-status').textContent, 'Aguardando aprovação');
 assert.deepEqual([...block.querySelectorAll('.agent-terminal-actions button')].map(b => b.textContent), ['Executar', 'Recusar']);
 assert.equal(api.calls.filter(c => c[0] === 'agentTerminalDecision').length, 0, 'nada roda sem decisão');
 // Ponto amarelo no histórico enquanto espera.
 $('#agent-history-button').click(); await tick();
 assert.ok($('.agent-history-waiting'));
 $('#agent-history').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
 $('.agent-terminal[data-id="t1"] .agent-terminal-run').click(); await tick(8);
 assert.deepEqual(api.calls.find(c => c[0] === 'agentTerminalDecision'), ['agentTerminalDecision', 't1', true]);
 const done = $('.agent-terminal[data-id="t1"]');
 assert.equal(done.querySelector('.agent-terminal-status').textContent, 'Concluído');
 assert.equal(done.querySelector('.agent-terminal-output').textContent, 'PHPUnit 11\nOK (3 tests)\n');
 assert.equal(done.querySelector('.agent-terminal-actions'), null);
 // O segundo comando pede nova aprovação (sem "permitir sempre").
 const second = $('.agent-terminal[data-id="t2"]');
 assert.match(second.querySelector('.agent-terminal-cwd').textContent, /src/);
 second.querySelector('.agent-terminal-reject').click(); await tick(10);
 assert.equal($('.agent-terminal[data-id="t2"] .agent-terminal-status').textContent, 'Recusado');
 assert.match($('#agent-transcript').textContent, /rm -rf build recusado/);
 $('#agent-history-button').click(); await tick();
 assert.equal($('.agent-history-waiting'), null);
 const saved = [...api.histories.get('/project').values()][0];
 assert.deepEqual(saved.items.filter(i => i.kind === 'terminal').map(i => [i.command, i.status, i.exitCode ?? null, i.output]), [['php vendor/bin/phpunit', 'exited', 0, 'PHPUnit 11\nOK (3 tests)\n'], ['rm -rf build', 'rejected', null, '']]);
 // Restaurado do histórico: sem botões de ação.
 $('#agent-new').click(); await tick();
 $('#agent-history-button').click(); await tick();
 document.querySelector('.agent-history-list li').click(); await tick(6);
 assert.equal(document.querySelectorAll('.agent-terminal').length, 2);
 assert.equal(document.querySelectorAll('.agent-terminal-actions').length, 0);
 w.happyDOM.abort();
});

test('Interromper encerra o comando em execução; fim do turno recusa pedido pendente', async () => {
 const w = dom();
 const api = fakeApi({script: async (_t, _e, emit, api) => {
  emit({type: 'terminal', id: 'k', command: 'php artisan serve', cwd: '', status: 'waiting'});
  await api.waitTerminal('k');
  emit({type: 'terminal', id: 'k', status: 'running'});
  await new Promise(r => { api.agentTerminalKill = async id => { api.calls.push(['agentTerminalKill', id]); r(); }; });
  emit({type: 'terminal', id: 'k', status: 'killed', exitCode: null, signal: 'SIGKILL'});
  emit({type: 'terminal', id: 'p', command: 'ls', cwd: '', status: 'waiting'});
 }});
 const s = makeSdk(); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: () => {}, language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 $('#agent-prompt').value = 'Suba o servidor'; $('#agent-send').click(); await tick(8);
 $('.agent-terminal-run').click(); await tick(8);
 assert.equal($('.agent-terminal-status').textContent, 'Executando…');
 $('.agent-terminal-kill').click(); await tick(10);
 assert.deepEqual(api.calls.find(c => c[0] === 'agentTerminalKill'), ['agentTerminalKill', 'k']);
 assert.equal($('.agent-terminal[data-id="k"] .agent-terminal-status').textContent, 'Interrompido (SIGKILL)');
 assert.equal($('.agent-terminal[data-id="p"] .agent-terminal-status').textContent, 'Recusado', 'turno terminou com pedido aberto');
 w.happyDOM.abort();
});
