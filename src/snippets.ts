import {applySnippet, minimalEdit, segments, targetPath, type Fence} from './apply';

type Ctx = {
 monaco: any;
 /** Editor principal da IDE (Monaco) e abertura de arquivos. */
 host: { editor?: any; open?(path: string, line?: number): Promise<void>; path?(): string | undefined } | undefined;
 language(path: string): string | undefined;
 status(text: string): void;
 own(fn: () => void): void;
 /** Operações do host: criar arquivo (project.write) e executar trecho (terminal do agente). */
 api?: { fileCreate?(path: string, kind: string, text: string): Promise<string>; agentRunSnippet?(code: string, lang: string): Promise<string> };
};

const SHELL = ['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'shellscript', 'shell-session'];
const EXT: Record<string, string> = { php: 'php', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', json: 'json', yaml: 'yaml', yml: 'yml', xml: 'xml', html: 'html', twig: 'twig', css: 'css', scss: 'scss', sql: 'sql', md: 'md', markdown: 'md', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', vue: 'vue', ini: 'ini', dotenv: 'env', neon: 'neon', blade: 'blade.php' };
/** Comando que o host executa para o trecho (mesma regra de native/src/terminal.rs). */
export function snippetCommand(fence: { lang: string; code: string }): string | undefined {
 const lang = fence.lang.toLowerCase();
 if (SHELL.includes(lang)) return fence.code.split('\n').map(l => l.startsWith('$ ') ? l.slice(2) : l).join('\n').trim();
 if (lang === 'php') { let body = fence.code.trim(); if (body.startsWith('<?php')) body = body.slice(5); body = body.trimEnd(); if (body.endsWith('?>')) body = body.slice(0, -2); body = body.trim(); return `php -r ${/^[\w\-./=:@%+,]+$/.test(body) ? body : `'${body.replace(/'/g, `'\\''`)}'`}`; }
}
/** Nome sugerido: caminho indicado pelo agente, senão a classe declarada, senão snippet.<ext>. */
export function suggestedPath(fence: Fence) {
 const path = targetPath(fence); if (path) return path;
 const type = fence.code.match(/^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/m)?.[1];
 const ext = EXT[fence.lang.toLowerCase()] ?? 'txt';
 return type && ext === 'php' ? `${type}.php` : `snippet.${ext}`;
}

const short = (path: string) => path.split('/').pop() ?? path;

/** Corpo de uma mensagem do agente: texto e blocos de código com Aplicar, Inserir no cursor e Copiar. */
export function renderMessage(el: HTMLElement, text: string, ctx: Ctx) {
 el.replaceChildren();
 for (const part of segments(text)) {
  if (part.kind === 'text') { if (part.text) { const p = document.createElement('div'); p.className = 'agent-text'; p.textContent = part.text; el.append(p); } continue; }
  const block = document.createElement('div'); block.className = 'agent-code';
  const head = document.createElement('div'); head.className = 'agent-code-head';
  const label = document.createElement('span'); label.className = 'agent-code-lang'; const path = targetPath(part);
  label.textContent = path ?? (part.lang || 'texto'); label.title = path ?? '';
  head.append(label);
  if (!part.open) {
   const action = (text: string, title: string, run: () => void | Promise<void>) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.onclick = () => void Promise.resolve(run()).catch((error: Error) => ctx.status(String(error.message ?? error))); head.append(b); return b; };
   action('Aplicar', path ? `Aplicar em ${path} com prévia` : 'Aplicar no arquivo atual com prévia', () => apply(part, ctx)).classList.add('agent-code-apply');
   action('Inserir no cursor', 'Inserir o trecho no cursor do editor', () => insert(part, ctx)).classList.add('agent-code-insert');
   action('Copiar', 'Copiar para a área de transferência', async () => { await navigator.clipboard.writeText(part.code); ctx.status('Trecho copiado.'); }).classList.add('agent-code-copy');
   if (ctx.api?.fileCreate) action('Criar arquivo', 'Criar um arquivo do projeto com este trecho', () => createFile(part, ctx)).classList.add('agent-code-create');
   if (ctx.api?.agentRunSnippet && snippetCommand(part)) action('Executar', 'Executar este trecho no terminal (pede confirmação)', () => runSnippet(part, ctx)).classList.add('agent-code-run');
  }
  const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = part.code; pre.append(code);
  block.append(head, pre); el.append(block);
 }
}

/** Editor com o arquivo alvo: abre o arquivo do bloco quando ele não é o atual. */
async function target(fence: Fence, ctx: Ctx) {
 const editor = ctx.host?.editor; if (!editor) throw new Error('Editor indisponível');
 const path = targetPath(fence);
 const current = () => ctx.host?.path?.() ?? editor.getModel()?.uri?.path;
 if (path && !current()?.endsWith(path)) { if (!ctx.host?.open) throw new Error(`Abra ${path} para aplicar`); await ctx.host.open(path); }
 const model = editor.getModel(); if (!model) throw new Error('Abra um arquivo no editor para aplicar o trecho');
 return { editor, model, path: path ?? ctx.host?.path?.() ?? model.uri?.path ?? 'arquivo atual' };
}

function insert(fence: Fence, ctx: Ctx) {
 const editor = ctx.host?.editor; const selection = editor?.getSelection?.();
 if (!editor || !selection) throw new Error('Posicione o cursor no editor');
 editor.pushUndoStop?.(); editor.executeEdits('agent-insert', [{ range: selection, text: fence.code, forceMoveMarkers: true }]); editor.pushUndoStop?.(); editor.focus?.();
 ctx.status('Trecho inserido no cursor.');
}

/** Aplicar: calcula o resultado e abre a prévia (diff); nada muda até Aceitar tudo. */
export async function apply(fence: Fence, ctx: Ctx) {
 const { editor, model, path } = await target(fence, ctx);
 const original: string = model.getValue();
 const sel = editor.getSelection?.();
 const offset = (line: number, column: number) => original.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
 const range = sel && !(sel.isEmpty?.() ?? (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)) ? { start: offset(sel.startLineNumber, sel.startColumn), end: offset(sel.endLineNumber, sel.endColumn) } : undefined;
 const caret = sel ? offset(sel.positionLineNumber ?? sel.startLineNumber, sel.positionColumn ?? sel.startColumn) : original.length;
 const result = applySnippet(original, fence, range, caret);
 if (result.text === original) { ctx.status('O trecho já está aplicado.'); return; }
 preview(path, original, result.text, result.mode, editor, model, ctx);
}

const modeLabel = { patch: 'diff', file: 'arquivo inteiro', region: 'bloco localizado', selection: 'seleção', insert: 'no cursor' };

function preview(path: string, original: string, proposed: string, mode: keyof typeof modeLabel, editor: any, model: any, ctx: Ctx) {
 const dialog = document.createElement('dialog'); dialog.className = 'agent-diff agent-apply';
 dialog.setAttribute('aria-label', `Aplicar alterações em ${path}`);
 const head = document.createElement('header');
 const title = document.createElement('strong'); title.textContent = `Aplicar em ${short(path)}`; title.title = path;
 const info = document.createElement('span'); info.textContent = `Atual · Proposto (${modeLabel[mode]}) — use ↶ na margem para reverter uma alteração`;
 const button = (text: string, cls: string, title: string) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls; b.title = title; head.append(b); return b; };
 head.append(title, info);
 const prev = button('↑', 'agent-apply-prev', 'Alteração anterior (⇧F7)'); const next = button('↓', 'agent-apply-next', 'Próxima alteração (F7)');
 const discard = button('Descartar tudo', 'agent-apply-discard', 'Fechar sem alterar o editor (Esc)'); const accept = button('Aceitar tudo', 'primary agent-apply-accept', 'Aplicar no editor (⌘↩)');
 const host = document.createElement('div'); host.className = 'agent-diff-editor';
 dialog.append(head, host); document.body.append(dialog); dialog.showModal();
 const language = ctx.language(path) ?? model.getLanguageId?.();
 const left = ctx.monaco.editor.createModel(original, language); const right = ctx.monaco.editor.createModel(proposed, language);
 const diff = ctx.monaco.editor.createDiffEditor(host, { automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: false, renderMarginRevertIcon: true, minimap: { enabled: false } });
 diff.setModel({ original: left, modified: right });
 let closed = false;
 const close = () => { if (closed) return; closed = true; diff.dispose(); left.dispose(); right.dispose(); if (dialog.open) dialog.close(); dialog.remove(); editor.focus?.(); };
 ctx.own(close);
 // goToDiff parte da posição do lado direito; sem ela o Monaco lança erro.
 const go = (dir: 'next' | 'previous') => { try { const m = diff.getModifiedEditor?.(); if (m && !m.getPosition?.()) m.setPosition({ lineNumber: 1, column: 1 }); diff.goToDiff?.(dir); } catch { /* sem alterações para navegar */ } };
 prev.onclick = () => go('previous'); next.onclick = () => go('next');
 discard.onclick = () => { close(); ctx.status('Alterações descartadas.'); };
 accept.onclick = () => {
  // O usuário pode ter revertido partes na prévia: vale o lado direito como está.
  const text = right.getValue(); const current = model.getValue();
  if (current !== original) { ctx.status(`${short(path)} mudou durante a prévia; aplique de novo.`); close(); return; }
  const edit = minimalEdit(current, text);
  const pos = (o: number) => { const before = current.slice(0, o).split('\n'); return { lineNumber: before.length, column: before.at(-1)!.length + 1 }; };
  const a = pos(edit.start), b = pos(edit.end);
  editor.pushUndoStop?.();
  editor.executeEdits('agent-apply', [{ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: edit.text, forceMoveMarkers: true }]);
  editor.pushUndoStop?.();
  editor.revealLineInCenter?.(a.lineNumber);
  close(); ctx.status(`Alterações aplicadas em ${short(path)} (não salvas; ⌘Z desfaz).`);
 };
 dialog.addEventListener('cancel', event => { event.preventDefault(); discard.click(); });
 dialog.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); accept.click(); }
  if (event.key === 'F7') { event.preventDefault(); (event.shiftKey ? prev : next).click(); }
 });
 setTimeout(() => { if (!closed) go('next'); }, 80);
 accept.focus();
}

function modal(cls: string, label: string) {
 const dialog = document.createElement('dialog'); dialog.className = `agent-snippet-dialog ${cls}`; dialog.setAttribute('aria-label', label);
 const head = document.createElement('div'); head.className = 'agent-snippet-head'; const title = document.createElement('strong'); title.textContent = label; head.append(title);
 const footer = document.createElement('div'); footer.className = 'agent-snippet-actions';
 const error = document.createElement('p'); error.className = 'agent-snippet-error'; error.hidden = true; error.setAttribute('role', 'alert');
 dialog.append(head); document.body.append(dialog);
 const button = (text: string, cls: string) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls; footer.append(b); return b; };
 const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
 return { dialog, footer, error, button, close, show(...body: HTMLElement[]) { dialog.append(...body, error, footer); dialog.showModal(); } };
}
const textPreview = (text: string) => { const pre = document.createElement('pre'); pre.className = 'agent-snippet-preview'; const lines = text.split('\n'); pre.textContent = lines.length > 400 ? lines.slice(0, 400).join('\n') + `\n… ${lines.length - 400} linhas` : text; return pre; };

/** Create File from Snippet: confirma o caminho (editável) e cria pelo host; nunca sobrescreve. */
export function createFile(fence: Fence, ctx: Ctx) {
 const m = modal('agent-create-file', 'Criar arquivo a partir do trecho');
 const field = document.createElement('label'); field.className = 'agent-snippet-field'; field.textContent = 'Caminho no projeto';
 const input = document.createElement('input'); input.type = 'text'; input.value = suggestedPath(fence); input.spellcheck = false; field.append(input);
 const cancel = m.button('Cancelar', 'agent-create-cancel'); const create = m.button('Criar', 'primary agent-create-confirm');
 m.show(field, textPreview(fence.code)); ctx.own(m.close);
 const name = input.value.lastIndexOf('/') + 1; input.focus(); input.setSelectionRange(name, input.value.replace(/\.[^./]+$/, '').length);
 const valid = () => { const p = input.value.trim(); return !!p && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '') && !p.endsWith('/'); };
 input.oninput = () => { m.error.hidden = true; create.disabled = !valid(); };
 cancel.onclick = m.close;
 create.onclick = async () => {
  if (!valid()) return;
  create.disabled = true; m.error.hidden = true;
  try {
   const path = await ctx.api!.fileCreate!(input.value.trim(), 'file', fence.code);
   m.close(); await ctx.host?.open?.(path || input.value.trim()); ctx.status(`Arquivo criado: ${path || input.value.trim()}`);
  } catch (error) { m.error.textContent = String((error as Error).message ?? error); m.error.hidden = false; create.disabled = false; input.focus(); }
 };
 input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); create.click(); } };
 m.dialog.addEventListener('cancel', event => { event.preventDefault(); m.close(); });
}

/** Run Snippet: mostra o comando exato e a pasta; só executa depois de Executar. */
export function runSnippet(fence: Fence, ctx: Ctx) {
 const command = snippetCommand(fence)!;
 const m = modal('agent-run-snippet', 'Executar trecho no terminal?');
 const cmd = document.createElement('pre'); cmd.className = 'agent-terminal-command'; cmd.textContent = `$ ${command}`;
 const where = document.createElement('div'); where.className = 'agent-terminal-cwd'; where.textContent = 'na raiz do projeto · a saída aparece na conversa';
 const cancel = m.button('Cancelar', 'agent-run-cancel'); const run = m.button('Executar', 'primary agent-run-confirm');
 m.show(cmd, where); ctx.own(m.close);
 cancel.focus();
 cancel.onclick = () => { m.close(); ctx.status('Execução cancelada.'); };
 run.onclick = async () => {
  run.disabled = cancel.disabled = true;
  try { await ctx.api!.agentRunSnippet!(fence.code, fence.lang); m.close(); }
  catch (error) { m.error.textContent = String((error as Error).message ?? error); m.error.hidden = false; cancel.disabled = false; }
 };
 m.dialog.addEventListener('cancel', event => { event.preventDefault(); cancel.click(); });
}
