import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dom, fakeApi, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const $ = sel => document.querySelector(sel);
const database = {sqlIntelligence: {entries: new Map([['s1', {session: {id: 's1', label: 'app@localhost'}, model: {schemas: [{name: 'public', tables: [{name: 'users', kind: 'table', columns: [{name: 'id', type: 'bigint'}]}]}]}}]])}};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
async function mount({image = true, services = {}} = {}) {
 const api = fakeApi(); const status = [];
 const s = makeSdk({services}); activate(s); s.api = api;
 const panel = s.contribution.mount(api, $('#agent'), {context: () => ({path: 'src/User.php', text: '<?php'}), reload: async () => {}, status: t => status.push(t), language: () => 'php'});
 api.connect(e => panel.handle(e.type === 'session' ? {...e, capabilities: {image, embeddedContext: true}} : e)); await tick();
 $('#agent-start').click(); await tick();
 return {api, status};
}
const items = () => [...document.querySelectorAll('#agent-attach-menu .agent-attach-item, #agent-attach-menu .agent-attach-section')].map(b => b.classList.contains('agent-attach-section') ? `# ${b.textContent}` : b.querySelector('.agent-popup-label').textContent + (b.disabled ? ' (desativado)' : ''));
function paste(files) { const e = new Event('paste', {bubbles: true, cancelable: true}); Object.defineProperty(e, 'clipboardData', {value: {files}}); $('#agent-prompt').dispatchEvent(e); return e; }

test('menu + lista Arquivos e pastas, Imagem…, Schema de banco… e recentes; busca anexa arquivo', async () => {
 const w = dom();
 const {api} = await mount({services: {database}});
 $('#agent-attach').click(); await tick();
 assert.equal($('#agent-attach').getAttribute('aria-expanded'), 'true');
 assert.equal(document.activeElement, $('.agent-attach-search'));
 assert.deepEqual(items(), ['Arquivos e pastas', 'Imagem…', 'Schema de banco…', '# Arquivos recentes', 'User.php']);
 const search = $('.agent-attach-search'); search.value = 'Adm'; search.dispatchEvent(new Event('input')); await tick(8);
 assert.equal(items()[0], '# Resultados'); assert.equal(items()[1], 'Admin.php');
 document.querySelectorAll('#agent-attach-menu .agent-attach-item')[0].click(); await tick();
 assert.equal($('#agent-attach-menu'), null, 'menu fecha ao escolher');
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip-label')].map(c => c.textContent), ['Admin.php']);
 assert.equal($('#agent-prompt').value, '', 'anexo pelo + não escreve token no texto');
 // Arquivos e pastas › mostra a lista; Schema de banco… lista schemas/tabelas.
 $('#agent-attach').click(); await tick();
 document.querySelector('#agent-attach-menu .agent-attach-item').click(); await tick(8);
 assert.equal(items()[0], '# Arquivos e pastas'); assert.ok(items().includes('src'));
 document.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); await tick();
 assert.equal($('#agent-attach-menu'), null, 'clique fora fecha');
 $('#agent-attach').click(); await tick();
 [...document.querySelectorAll('#agent-attach-menu .agent-attach-item')].find(b => b.textContent.includes('Schema')).click(); await tick();
 assert.deepEqual(items(), ['# Schema de banco', 'public', 'public.users']);
 document.querySelectorAll('#agent-attach-menu .agent-attach-item')[1].click();
 $('#agent-prompt').value = 'Revise'; $('#agent-send').click(); await tick(8);
 const extras = api.calls.find(c => c[0] === 'agentPrompt')[3];
 assert.deepEqual(extras.attachments.map(a => a.type), ['file', 'schema']);
 w.happyDOM.abort();
});

test('imagem colada vira anexo base64 com miniatura; formato, tamanho e agente sem imagem são recusados', async () => {
 const w = dom();
 const {api, status} = await mount();
 const event = paste([new File([PNG], 'tela.png', {type: 'image/png'})]); await tick(10);
 assert.equal(event.defaultPrevented, true);
 assert.deepEqual([...document.querySelectorAll('#agent-chips .agent-chip-label')].map(c => c.textContent), ['tela.png']);
 assert.match(document.querySelector('#agent-chips img').src, /^data:image\/png;base64,iVBORw0KGgo/);
 paste([new File(['<svg/>'], 'a.svg', {type: 'image/svg+xml'})]); await tick(10);
 const big = new File([PNG], 'grande.png', {type: 'image/png'}); Object.defineProperty(big, 'size', {value: 21 * 1024 * 1024});
 paste([big]); await tick(10);
 assert.deepEqual(status.slice(-2), ['a.svg: use PNG, JPEG, GIF ou WebP', 'grande.png: acima de 20 MB']);
 assert.equal(document.querySelectorAll('#agent-chips .agent-chip').length, 1);
 // Texto colado segue normal.
 assert.equal(paste([]).defaultPrevented, false);
 $('#agent-prompt').value = 'O que há nesta tela?'; $('#agent-send').click(); await tick(8);
 const [, , , extras] = api.calls.find(c => c[0] === 'agentPrompt');
 assert.deepEqual(extras.attachments, [{type: 'image', name: 'tela.png', mimeType: 'image/png', data: PNG.toString('base64')}]);
 // O histórico guarda só o rótulo da imagem, não os bytes.
 const saved = [...api.histories.get('/project').values()][0];
 assert.deepEqual(saved.items[0].attachments, [{kind: 'image', label: 'tela.png'}]);
 assert.doesNotMatch(JSON.stringify(saved), /iVBORw0KGgo/);
 w.happyDOM.abort();
});

test('agente sem promptCapabilities.image: Imagem… desativado e colar avisa', async () => {
 const w = dom();
 const {status} = await mount({image: false});
 $('#agent-attach').click(); await tick();
 assert.ok(items().includes('Imagem… (desativado)'));
 paste([new File([PNG], 'tela.png', {type: 'image/png'})]); await tick(10);
 assert.equal(status.at(-1), 'O agente atual não aceita imagens.');
 assert.equal(document.querySelectorAll('#agent-chips .agent-chip').length, 0);
 w.happyDOM.abort();
});
