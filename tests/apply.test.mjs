import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dom, fakeApi, fakeEditor, sdk as makeSdk, tick} from './fake-host.mjs';
import {activate} from '../workbench.js';

const USER = "<?php\n\nnamespace Fixture;\n\nfinal class User\n{\n    public function name(): string\n    {\n        return 'Synthetic user';\n    }\n}\n";
async function load() {
 const folder = await mkdtemp(join(tmpdir(), 'agent-apply-')); const output = join(folder, 'apply.mjs');
 await build({entryPoints: ['src/apply.ts'], outfile: output, bundle: true, format: 'esm'});
 const mod = await import(pathToFileURL(output)); await rm(folder, {recursive: true, force: true}); return mod;
}

test('segmentos, alvo e as quatro formas de aplicar', async () => {
 const {segments, targetPath, applySnippet, minimalEdit} = await load();
 const parts = segments('Troque assim:\n```php src/User.php\n$a = 1;\n```\nfim\n```diff\n-x\n');
 assert.deepEqual(parts.map(p => p.kind + (p.kind === 'code' ? `:${p.lang}:${p.path ?? ''}:${p.open}` : '')), ['text', 'code:php:src/User.php:false', 'text', 'code:diff::true']);
 assert.equal(targetPath({lang: 'php', path: 'src/User.php', code: ''}), 'src/User.php');
 assert.equal(targetPath({lang: 'php', code: '// file: src/Admin.php\n<?php'}), 'src/Admin.php');
 assert.equal(targetPath({lang: 'php', code: '$x = 1;'}), undefined);
 // 1. diff unificado pelo contexto (números de linha errados não importam).
 const diff = "@@ -90,3 +90,3 @@\n     {\n-        return 'Synthetic user';\n+        return 'Edited';\n     }\n";
 assert.deepEqual(applySnippet(USER, {lang: 'diff', code: diff}), {text: USER.replace("'Synthetic user'", "'Edited'"), mode: 'patch'});
 assert.throws(() => applySnippet(USER, {lang: 'diff', code: '@@ @@\n-nao existe\n+x\n'}), /não corresponde/);
 // 2. arquivo inteiro.
 assert.equal(applySnippet(USER, {lang: 'php', code: '<?php\n\necho 1;\n'}).mode, 'file');
 assert.equal(applySnippet(USER, {lang: 'php', code: '<?php\n\necho 1;\n'}).text, '<?php\n\necho 1;\n');
 // 3. região: método localizado pela 1ª e última linha e reindentado (trecho veio sem recuo).
 const method = "public function name(): string\n{\n    return strtoupper('x');\n}";
 const region = applySnippet(USER, {lang: 'php', code: method});
 assert.equal(region.mode, 'region');
 assert.equal(region.text, USER.replace("        return 'Synthetic user';", "        return strtoupper('x');"));
 // 4. sem âncora: seleção, senão cursor.
 assert.deepEqual(applySnippet('abc', {lang: 'php', code: 'X'}, {start: 1, end: 2}), {text: 'aXc', mode: 'selection'});
 assert.deepEqual(applySnippet('abc', {lang: 'php', code: 'X'}, undefined, 1), {text: 'aXbc', mode: 'insert'});
 assert.deepEqual(minimalEdit('hello world', 'hello brave world'), {start: 6, end: 6, text: 'brave '});
});

function mountWith(editorFile, path = 'src/User.php') {
 const api = fakeApi({script: async (_t, _e, emit) => emit({type: 'message', text: "Sugestão:\n```php src/User.php\npublic function name(): string\n{\n    return 'Edited';\n}\n```\n"})});
 const opened = []; const status = [];
 let current = path;
 const host = {editor: editorFile.editor, path: () => current, open: async p => { opened.push(p); current = p; }};
 const s = makeSdk({host}); activate(s); s.api = api;
 const panel = s.contribution.mount(api, document.querySelector('#agent'), {context: () => undefined, reload: async () => {}, status: t => status.push(t), language: () => 'php'});
 api.connect(e => panel.handle(e));
 return {api, s, opened, status};
}

test('Aplicar abre a prévia (Atual · Proposto); Aceitar tudo edita o buffer com uma edição desfazível; Descartar não muda nada', async () => {
 const w = dom();
 const file = fakeEditor('/project/src/User.php', USER);
 const {s, status} = mountWith(file);
 await tick(); document.querySelector('#agent-start').click(); await tick();
 document.querySelector('#agent-prompt').value = 'melhore'; document.querySelector('#agent-send').click(); await tick(10);
 const block = document.querySelector('.agent-code');
 assert.equal(block.querySelector('.agent-code-lang').textContent, 'src/User.php');
 assert.deepEqual([...block.querySelectorAll('.agent-code-head button')].map(b => b.textContent), ['Aplicar', 'Inserir no cursor', 'Copiar']);
 // Descartar.
 block.querySelector('.agent-code-apply').click(); await tick(4);
 let dialog = document.querySelector('dialog.agent-apply');
 assert.ok(dialog?.open);
 assert.equal(dialog.querySelector('strong').textContent, 'Aplicar em User.php');
 assert.match(dialog.querySelector('span').textContent, /bloco localizado/);
 const diffEditor = s.created.find(c => c.setModel);
 assert.equal(diffEditor.options.renderMarginRevertIcon, true, 'reverter alteração pela margem');
 assert.equal(diffEditor.model.original.getValue(), USER);
 assert.match(diffEditor.model.modified.getValue(), /return 'Edited';/);
 dialog.querySelector('.agent-apply-discard').click();
 assert.equal(document.querySelector('dialog.agent-apply'), null);
 assert.equal(file.model.getValue(), USER); assert.equal(file.edits.length, 0);
 // Aceitar.
 block.querySelector('.agent-code-apply').click(); await tick(4);
 dialog = document.querySelector('dialog.agent-apply');
 dialog.querySelector('.agent-apply-next').click();
 dialog.querySelector('.agent-apply-accept').click();
 assert.equal(file.model.getValue(), USER.replace("'Synthetic user'", "'Edited'"));
 assert.equal(file.edits.length, 1, 'uma edição mínima (desfazível)');
 assert.equal(file.edits[0].text, 'Edited');
 assert.match(status.at(-1), /Alterações aplicadas em User\.php \(não salvas/);
 // Inserir no cursor.
 file.editor.setSelection({startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1});
 block.querySelector('.agent-code-insert').click();
 assert.ok(file.model.getValue().startsWith('public function name()'));
 w.happyDOM.abort();
});

test('bloco de outro arquivo abre o arquivo antes da prévia; trecho já aplicado só avisa', async () => {
 const w = dom();
 const file = fakeEditor('/project/src/Admin.php', USER.replace("'Synthetic user'", "'Edited'"));
 const {opened, status} = mountWith(file, 'src/Admin.php');
 await tick(); document.querySelector('#agent-start').click(); await tick();
 document.querySelector('#agent-prompt').value = 'melhore'; document.querySelector('#agent-send').click(); await tick(10);
 document.querySelector('.agent-code-apply').click(); await tick(4);
 assert.deepEqual(opened, ['src/User.php']);
 assert.equal(document.querySelector('dialog.agent-apply'), null);
 assert.equal(status.at(-1), 'O trecho já está aplicado.');
 w.happyDOM.abort();
});
