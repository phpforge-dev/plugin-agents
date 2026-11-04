import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const REPLY = "Crie a classe:\n```php\n<?php\n\nnamespace App;\n\nfinal class Invoice\n{\n}\n```\nDepois rode:\n```bash\n$ composer dump-autoload\n$ php vendor/bin/phpunit\n```\nE em PHP:\n```php\necho 'oi';\n```\nConfig:\n```json\n{}\n```\n";
async function mount() {
 const api = fakeApi({script: async (_t, _e, emit) => emit({type: 'message', text: REPLY})});
 const opened = []; const status = [];
 const s = makeSdk({host: {open: async p => opened.push(p)}}); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => undefined, reload: async () => {}, status: t => status.push(t), language: () => 'php'});
 api.connect(e => panel.handle(e)); await tick();
 $('#agent-start').click(); await tick();
 $('#agent-prompt').value = 'Crie uma fatura'; $('#agent-send').click(); await tick(10);
 return {api, opened, status};
}
const heads = () => [...document.querySelectorAll('.agent-code-head')].map(h => [...h.querySelectorAll('button')].map(b => b.textContent));

test('Criar arquivo: confirma o caminho sugerido, cria pelo host, abre; caminho existente ou inválido não fecha o diálogo', async () => {
 const w = dom();
 const {api, opened, status} = await mount();
 assert.deepEqual(heads(), [
  ['Aplicar', 'Inserir no cursor', 'Copiar', 'Criar arquivo', 'Executar'],
  ['Aplicar', 'Inserir no cursor', 'Copiar', 'Criar arquivo', 'Executar'],
  ['Aplicar', 'Inserir no cursor', 'Copiar', 'Criar arquivo', 'Executar'],
  ['Aplicar', 'Inserir no cursor', 'Copiar', 'Criar arquivo'],
 ]);
 document.querySelector('.agent-code-create').click(); await tick();
 const input = $('dialog.agent-create-file input');
 assert.equal(input.value, 'Invoice.php');
 assert.match($('dialog.agent-create-file .agent-snippet-preview').textContent, /final class Invoice/);
 assert.equal(api.calls.filter(c => c[0] === 'fileCreate').length, 0, 'nada antes de Criar');
 // Caminho inválido desativa Criar; caminho existente mostra o erro e mantém o diálogo.
 input.value = '../fora.php'; input.dispatchEvent(new Event('input'));
 assert.equal($('.agent-create-confirm').disabled, true);
 input.value = 'README.md'; input.dispatchEvent(new Event('input'));
 $('.agent-create-confirm').click(); await tick(4);
 assert.equal($('.agent-snippet-error').textContent, 'README.md já existe');
 assert.ok($('dialog.agent-create-file'));
 input.value = 'src/Invoice.php'; input.dispatchEvent(new Event('input'));
 input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); await tick(4);
 assert.deepEqual(api.calls.filter(c => c[0] === 'fileCreate').at(-1), ['fileCreate', 'src/Invoice.php', 'file', '<?php\n\nnamespace App;\n\nfinal class Invoice\n{\n}']);
 assert.equal($('dialog.agent-create-file'), null);
 assert.deepEqual(opened, ['src/Invoice.php']);
 assert.equal(status.at(-1), 'Arquivo criado: src/Invoice.php');
 // Cancelar não cria nada; sem classe, o nome vem da linguagem.
 document.querySelectorAll('.agent-code-create')[3].click(); await tick();
 assert.equal($('dialog.agent-create-file input').value, 'snippet.json');
 $('.agent-create-cancel').click();
 assert.equal(api.calls.filter(c => c[0] === 'fileCreate').length, 2);
 w.happyDOM.abort();
});

test('Executar trecho: mostra o comando exato, só roda depois de Executar e a saída entra na conversa', async () => {
 const w = dom();
 const {api, status} = await mount();
 document.querySelectorAll('.agent-code-run')[1].click(); await tick();
 assert.equal($('dialog.agent-run-snippet .agent-terminal-command').textContent, '$ composer dump-autoload\nphp vendor/bin/phpunit');
 assert.equal(document.activeElement, $('.agent-run-cancel'), 'foco em Cancelar');
 $('.agent-run-cancel').click();
 assert.equal(api.calls.filter(c => c[0] === 'agentRunSnippet').length, 0);
 assert.equal(status.at(-1), 'Execução cancelada.');
 document.querySelectorAll('.agent-code-run')[2].click(); await tick();
 assert.equal($('dialog.agent-run-snippet .agent-terminal-command').textContent, "$ php -r 'echo '\\''oi'\\'';'");
 $('.agent-run-cancel').click();
 document.querySelectorAll('.agent-code-run')[1].click(); await tick();
 $('.agent-run-confirm').click(); await tick(10);
 assert.deepEqual(api.calls.find(c => c[0] === 'agentRunSnippet'), ['agentRunSnippet', '$ composer dump-autoload\n$ php vendor/bin/phpunit', 'bash']);
 const block = $('.agent-terminal');
 assert.equal(block.querySelector('strong').textContent, 'Trecho executado');
 assert.equal(block.dataset.status, 'exited');
 assert.match(block.querySelector('.agent-terminal-output').textContent, /saída de composer dump-autoload/);
 await tick(6);
 const saved = [...api.histories.get('/project').values()][0];
 assert.deepEqual(saved.items.filter(i => i.kind === 'terminal').map(i => [i.origin, i.status]), [['snippet', 'exited']]);
 w.happyDOM.abort();
});
