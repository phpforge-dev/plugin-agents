import {applySnippet, minimalEdit, segments, targetPath, type Fence} from './apply';

type Ctx = {
 monaco: any;
 /** Editor principal da IDE (Monaco) e abertura de arquivos. */
 host: { editor?: any; open?(path: string, line?: number): Promise<void>; path?(): string | undefined } | undefined;
 language(path: string): string | undefined;
 status(text: string): void;
 own(fn: () => void): void;
};

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
