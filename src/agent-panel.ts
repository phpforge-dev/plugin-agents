import {agentGeneration} from './agent-generation';
import {historyView} from './history-view';
import {newId, transcriptText, type Item, type Summary} from './model';
import {Transcript} from './transcript';
import {composer, type Mention} from './composer';
import {mentionProvider, type DatabaseEntry} from './mentions';
import {tr,msg,html,monaco,own,host,service} from './sdk';

type Hooks = {
 /** Arquivo ativo (somente arquivos reais) e seleção, para o contexto da IDE. */
 context(): { path: string; text: string; selection?: string } | undefined;
 /** Recarrega buffers abertos sem alterações após gravar mudanças do agente. */
 reload(paths: string[]): Promise<void>;
 status(message: string): void;
 language(path: string): string | undefined;
};
type Extras = { history?: string; attachments?: Record<string, unknown>[] };

/** Anexo no formato do pedido nativo (o host lê arquivos/pastas confinados ao projeto). */
function payload(m: Mention, context: ReturnType<Hooks['context']>): Record<string, unknown> | undefined {
 switch (m.kind) {
  case 'thisFile': return context && context.path === m.path ? { type: 'file', path: m.path, text: context.text } : { type: 'file', path: m.path };
  case 'selection': return { type: 'selection', path: m.path, text: m.text, line: m.line, endLine: m.endLine };
  case 'file': return { type: 'file', path: m.path };
  case 'folder': return { type: 'folder', path: m.path };
  case 'symbol': return { type: 'symbol', name: m.label, path: m.path, line: m.line, endLine: m.endLine };
  case 'schema': return { type: 'schema', label: m.label, text: m.text };
  case 'image': return { type: 'image', name: m.label, mimeType: m.mimeType, data: m.data };
 }
}

/** Painel do agente: sessão ACP/Codex, transcrição, histórico por projeto, permissões e alterações pendentes com revisão. */
export function mountAgent(api: any, root: HTMLElement, hooks: Hooks) {
 root.innerHTML = html`<div class="agent-head"><label class="agent-field">Agente<select id="agent-select"></select></label><button id="agent-start">Iniciar</button><label class="agent-field" id="agent-mode-label" hidden>Modo<select id="agent-mode"></select></label>
<div class="agent-toolbar"><button id="agent-new" title="Nova conversa">+ Nova conversa</button><button id="agent-history-button" class="agent-icon" title="Histórico de conversas" aria-label="Histórico de conversas" aria-pressed="false">◷</button><button id="agent-options" class="agent-icon" title="Opções" aria-label="Opções" aria-haspopup="menu">⋮</button></div></div>
<p id="agent-detail" class="agent-detail"></p>
<section id="agent-history" hidden aria-label="Histórico de conversas"></section>
<div id="agent-chat" class="agent-chat">
<div class="agent-welcome"><span class="agent-emblem">✧</span><h2>Vamos construir?</h2><p>Conecte um agente para entender o projeto, explorar código e propor alterações.</p><div class="agent-examples"><button type="button" data-prompt="Explique a arquitetura deste projeto">Explorar o projeto ↗</button><button type="button" data-prompt="Revise o arquivo ativo e sugira melhorias">Revisar código ↗</button></div><small>Você revisa as alterações antes de gravá-las.</small></div>
<div id="agent-transcript" role="log" aria-live="polite" aria-label="Conversa com o agente"></div>
<section id="agent-changes" hidden><div class="agent-changes-head"><strong>Alterações pendentes (<span id="agent-change-count">0</span>)</strong><button id="agent-keep-all">Manter tudo</button><button id="agent-discard-all">Descartar tudo</button></div><ul id="agent-change-list"></ul></section>
<div class="agent-input"><textarea id="agent-prompt" placeholder="Digite sua tarefa, use @ para adicionar arquivos ou / para comandos" aria-label="Pedido ao agente (Enter envia, Shift+Enter quebra linha)" disabled></textarea><div id="agent-chips" class="agent-chips" hidden></div>
<div class="agent-actions"><label><input type="checkbox" id="agent-context"> Contexto da IDE</label><button id="agent-cancel" disabled>Interromper</button><button id="agent-send" class="primary" disabled>Enviar</button></div></div>
</div>`;
 const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
 const transcript = new Transcript($('agent-transcript'));
 const welcome = root.querySelector<HTMLElement>('.agent-welcome')!;
 let agents: AgentInfo[] = []; let started = false; let running = false; let agentId = '';
 let changes: AgentChange[] = [];
 /** Conversa atual: id do histórico (criado no primeiro pedido) e se veio do histórico sem sessão viva. */
 let conversation: { id?: string; restored: boolean } = { restored: false };
 let waiting = false; let saving = Promise.resolve();
 const recent: string[] = [];
 const remember = (path?: string) => { if (!path) return; const i = recent.indexOf(path); if (i >= 0) recent.splice(i, 1); recent.unshift(path); recent.length = Math.min(recent.length, 20); };
 /** Contexto do editor com o intervalo de linhas da seleção (para @selection). */
 function editorContext() {
  const context = hooks.context(); if (!context?.selection) return context;
  const s = host?.editor?.getSelection?.();
  return s ? { ...context, selectionRange: { startLine: s.startLineNumber, endLine: s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber } } : context;
 }
 const input = composer($<HTMLTextAreaElement>('agent-prompt'), $('agent-chips'), {
  mentions: mentionProvider({
   listFiles: () => api.listFiles('', false),
   searchSymbols: (query: string) => api.searchSymbols(query),
   context: editorContext,
   recent: () => { remember(hooks.context()?.path); return recent; },
   database: () => { const entries = service('database')?.sqlIntelligence?.entries as Map<string, DatabaseEntry> | undefined; return entries ? [...entries.values()].filter(e => e?.model?.schemas) : []; },
   root: () => projectRoot,
  }),
 });
 own(() => input.dispose());
 let projectRoot = '';
 void api.workspace?.().then((w: { root: string }) => { projectRoot = w.root; }).catch(() => {});
 $('agent-chips').addEventListener('agent-open-attachment', event => {
  const m = (event as CustomEvent<Mention>).detail;
  if (m.kind === 'image' && m.data) { previewImage(m); return; }
  if (m.path && m.kind !== 'folder' && m.kind !== 'schema') void host?.open?.(m.path, m.line ? m.line - 1 : undefined);
 });
 function previewImage(m: Mention) {
  const dialog = document.createElement('dialog'); dialog.className = 'agent-image-preview';
  const img = document.createElement('img'); img.src = `data:${m.mimeType};base64,${m.data}`; img.alt = m.label;
  const close = document.createElement('button'); close.textContent = tr('Fechar'); close.onclick = () => { dialog.close(); dialog.remove(); };
  const head = document.createElement('header'); const name = document.createElement('strong'); name.textContent = m.label; head.append(name, close);
  dialog.append(head, img); document.body.append(dialog); own(() => dialog.remove()); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
 }

 function busy(value: boolean) {
  for (const id of ['agent-select', 'agent-start', 'agent-mode']) $<HTMLButtonElement>(id).disabled = value;
  running = value; $<HTMLButtonElement>('agent-send').disabled = value || !started; $<HTMLButtonElement>('agent-cancel').disabled = !value;
  $<HTMLTextAreaElement>('agent-prompt').disabled = !started;
 }
 const generation = agentGeneration(api, () => started && !running && !changes.length, busy);
 own(() => generation.reset());
 function save() {
  if (!conversation.id || !transcript.items.length) return saving;
  const payload = { id: conversation.id, agent: agentId, items: JSON.parse(JSON.stringify(transcript.items)) };
  saving = saving.then(() => api.agentHistorySave(payload)).then(() => undefined, (error: unknown) => hooks.status(msg`Histórico: ${String(error)}`));
  return saving;
 }
 const history = historyView(api, $('agent-history'), {
  open: id => void openConversation(id),
  deleted: id => { if (id === null || id === conversation.id) conversation = { restored: false }; },
  current: () => conversation.id, waiting: () => waiting, status: hooks.status,
 });
 own(() => history.dispose());
 function showHistory(visible: boolean) {
  $('agent-history').hidden = !visible; $('agent-chat').hidden = visible; $('agent-history-button').setAttribute('aria-pressed', String(visible));
  if (visible) void history.show(); else $<HTMLTextAreaElement>('agent-prompt').focus();
 }
 $('agent-history-button').onclick = () => showHistory($('agent-history').hidden);
 $('agent-history').addEventListener('keydown', event => { if (event.key === 'Escape' && !(event.target as HTMLElement).matches('.agent-history-rename')) { event.preventDefault(); showHistory(false); } });

 async function load() {
  agents = await api.agents();
  const select = $<HTMLSelectElement>('agent-select');
  select.replaceChildren(...agents.map(a => new Option(a.available ? a.name : msg`${a.name} (indisponível)`, a.id)));
  const first = agents.find(a => a.available); if (first) select.value = first.id;
  detail();
 }
 function detail() { const a = agents.find(a => a.id === $<HTMLSelectElement>('agent-select').value); $('agent-detail').textContent = a?.detail ?? ''; $<HTMLButtonElement>('agent-start').disabled = !a?.available; }
 $<HTMLSelectElement>('agent-select').onchange = () => { started = false; busy(false); detail(); };
 async function start() {
  const id = $<HTMLSelectElement>('agent-select').value; $('agent-detail').textContent = tr('Iniciando agente…');
  $<HTMLButtonElement>('agent-start').disabled = true;
  try { await api.agentStart(id); } catch (error) { detail(); $('agent-detail').textContent = String((error as Error).message ?? error); }
  finally { $<HTMLButtonElement>('agent-start').disabled = false; }
 }
 $('agent-start').onclick = () => void start();
 /** Começa uma conversa vazia; a sessão viva do agente é recriada para não carregar o contexto anterior. */
 async function fresh(restart: boolean) {
  await save();
  transcript.clear(); welcome.hidden = false; conversation = { restored: false }; waiting = false;
  if (restart && started) { try { await api.agentReset(); } catch (error) { hooks.status(String(error)); } }
 }
 $('agent-new').onclick = async () => {
  if (running) { hooks.status(tr('Interrompa o turno atual antes de trocar de conversa.')); return; }
  if (changes.length && !confirm(tr('Descartar as alterações pendentes e iniciar nova conversa?'))) return;
  showHistory(false); await fresh(true);
 };
 async function openConversation(id: string) {
  if (id === conversation.id) { showHistory(false); return; }
  if (running) { hooks.status(tr('Interrompa o turno atual antes de trocar de conversa.')); return; }
  if (changes.length && !confirm(tr('Descartar as alterações pendentes e abrir a conversa?'))) return;
  let data: { id: string; agent: string; items: Item[] };
  try { data = await api.agentHistoryLoad(id); } catch (error) { hooks.status(String(error)); return; }
  await fresh(true);
  transcript.load(data.items); welcome.hidden = data.items.length > 0;
  conversation = { id: data.id, restored: true };
  if (data.agent && agents.some(a => a.id === data.agent && a.available) && !started) $<HTMLSelectElement>('agent-select').value = data.agent;
  showHistory(false);
 }
 $('agent-options').onclick = event => {
  const menu = document.createElement('div'); menu.className = 'agent-menu'; menu.setAttribute('role', 'menu');
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menu.style.left = `${Math.max(4, rect.right - 220)}px`; menu.style.top = `${rect.bottom + 2}px`;
  const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = tr('Excluir todas as conversas');
  b.onclick = async () => { menu.remove(); await history.deleteAll(); if (!$('agent-history').hidden) void history.show(); };
  menu.append(b); document.body.append(menu); b.focus();
  const close = (e: Event) => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close); } };
  document.addEventListener('mousedown', close); menu.onkeydown = e => { if (e.key === 'Escape') menu.remove(); };
  own(() => menu.remove());
 };
 $<HTMLSelectElement>('agent-mode').onchange = event => void api.agentMode((event.target as HTMLSelectElement).value).catch((error: unknown) => hooks.status(String(error)));
 async function send() {
  const prompt = $<HTMLTextAreaElement>('agent-prompt'); const text = prompt.value.trim();
  if (!text || running || !started) return;
  const context = $<HTMLInputElement>('agent-context').checked ? hooks.context() : undefined;
  const extras: Extras = {};
  const mentioned = input.mentions();
  const live = hooks.context();
  if (mentioned.length) extras.attachments = mentioned.map(m => payload(m, live)).filter(Boolean) as Record<string, unknown>[];
  for (const m of mentioned) if (m.kind === 'file' || m.kind === 'thisFile') remember(m.path);
  // Conversa restaurada: a sessão nova do agente recebe a conversa anterior uma única vez.
  if (conversation.restored && transcript.items.length) extras.history = transcriptText(transcript.items);
  conversation.id ??= newId(); conversation.restored = false;
  welcome.hidden = true; transcript.endStream();
  transcript.add({ kind: 'user', text, ...(mentioned.length ? { attachments: mentioned.map(m => ({ kind: m.kind, label: m.label, ...(m.path ? { path: m.path } : {}) })) } : {}) });
  if (context) transcript.add({ kind: 'note', text: `Contexto: ${context.path}${context.selection ? tr(' (com seleção)') : ''}` });
  input.clear(); busy(true); void save();
  try { await api.agentPrompt(text, context, extras); } catch (error) { transcript.add({ kind: 'error', text: String((error as Error).message ?? error) }); busy(false); void save(); }
 }
 root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => { button.onclick = () => { const prompt = $<HTMLTextAreaElement>('agent-prompt'); if (!started) { $('agent-detail').textContent = tr('Selecione um agente disponível e clique em Iniciar.'); return; } prompt.value = button.dataset.prompt!; prompt.focus(); }; });
 $('agent-send').onclick = () => void send();
 $('agent-prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !input.open) { event.preventDefault(); void send(); } });
 $('agent-cancel').onclick = () => void api.agentCancel().catch((error: unknown) => hooks.status(String(error)));

 function diff(change: AgentChange) {
  const dialog = document.createElement('dialog'); dialog.className = 'agent-diff';
  dialog.innerHTML = html('<header><strong></strong><span>Antes · Depois do agente</span><button class="close">Fechar</button></header><div class="agent-diff-editor"></div>');
  dialog.querySelector('strong')!.textContent = change.path;
  document.body.append(dialog);own(()=>dialog.remove()); dialog.showModal();
  const language = hooks.language(change.path);
  const original = ownModel(change.before ?? '', language); const modified = ownModel(change.after, language);
  const editor = ownEditor(dialog.querySelector<HTMLElement>('.agent-diff-editor')!, { readOnly: true, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false } });
  editor.setModel({ original, modified });
  const close = () => { editor.dispose(); original.dispose(); modified.dispose(); dialog.close(); dialog.remove(); };
  dialog.querySelector<HTMLButtonElement>('.close')!.onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
 }
 async function keep(paths?: string[]) {
  const target = paths ?? changes.map(c => c.path);
  try { await api.agentKeep(paths); await hooks.reload(target); hooks.status(msg`${target.length} arquivo(s) gravado(s) pelo agente.`); }
  catch (error) { hooks.status(String((error as Error).message ?? error)); transcript.add({ kind: 'error', text: String((error as Error).message ?? error) }); }
 }
 $('agent-keep-all').onclick = () => void keep();
 $('agent-discard-all').onclick = () => void api.agentDiscard();
 function renderChanges() {
  $('agent-changes').hidden = !changes.length; $('agent-change-count').textContent = String(changes.length);
  $('agent-change-list').replaceChildren(...changes.map(change => {
   const item = document.createElement('li'); item.dataset.path = change.path;
   const before = change.before === null ? [] : change.before.split('\n'); const after = change.after.split('\n');
   const name = document.createElement('button'); name.className = 'agent-change-file'; name.textContent = `${change.before === null ? tr('A') : tr('M')}  ${change.path}`; name.title = `Ver diff (${before.length} → ${after.length} linhas)`; name.onclick = () => diff(change);
   const keepOne = document.createElement('button'); keepOne.textContent = tr('Manter'); keepOne.onclick = () => void keep([change.path]);
   const discardOne = document.createElement('button'); discardOne.textContent = tr('Descartar'); discardOne.onclick = () => void api.agentDiscard([change.path]);
   item.append(name, keepOne, discardOne); return item;
  }));
 }

 function handle(event: AgentEvent) {
  generation.handle(event);
  switch (event.type) {
   case 'session': {
    started = true; busy(false); agentId = event.agent;
    const name = agents.find(a => a.id === event.agent)?.name ?? event.agent;
    $('agent-detail').textContent = `${name} conectado${event.protocol ? ` · ACP v${event.protocol}` : ''}`;
    const mode = $<HTMLSelectElement>('agent-mode'); mode.replaceChildren(...event.modes.map(m => new Option(m.name, m.id, false, m.id === event.mode)));
    $('agent-mode-label').hidden = event.modes.length < 2;
    break;
   }
   case 'message': transcript.append('message', event.text); break;
   case 'thought': transcript.append('thought', event.text); break;
   case 'tool': transcript.tool(event.id, { title: event.title ?? undefined, status: event.status ?? undefined, toolKind: event.kind ?? undefined }); break;
   case 'plan': transcript.plan(event.entries.map(e => ({ content: e.content, status: e.status }))); break;
   case 'mode': $<HTMLSelectElement>('agent-mode').value = event.current; break;
   case 'permission': {
    transcript.endStream(); waiting = true; history.refresh();
    const box = document.createElement('div'); box.className = 'agent-block agent-permission'; const title = document.createElement('p'); title.textContent = `Permitir: ${event.title}?`; box.replaceChildren(title);
    for (const option of event.options) {
     const button = document.createElement('button'); button.textContent = option.name; button.dataset.kind = option.kind;
     button.onclick = () => { box.querySelectorAll('button').forEach(b => b.disabled = true); title.textContent = `${event.title} — ${option.name}`; waiting = false; transcript.add({ kind: 'note', text: `${event.title} — ${option.name}` }); box.remove(); void api.agentPermission(event.id, option.id).catch((error: unknown) => hooks.status(String(error))); };
     box.append(button);
    }
    $('agent-transcript').append(box); box.scrollIntoView({ block: 'nearest' });
    break;
   }
   case 'changes': changes = event.changes; renderChanges(); break;
   case 'done':
    transcript.endStream(); busy(false); waiting = false;
    root.querySelectorAll('.agent-permission').forEach(el => el.remove());
    if (event.error) transcript.add({ kind: 'error', text: event.error });
    else if (event.stopReason === 'cancelled') transcript.add({ kind: 'note', text: 'Interrompido.' });
    hooks.status(event.error ? tr('Falha no agente') : tr('Resposta concluída'));
    void save();
    break;
  }
 }
 void load().catch(error => { $('agent-detail').textContent = String(error); });
 return { handle, generate: generation.generate, cancel: generation.cancel, reset() { generation.reset(); transcript.clear(); welcome.hidden = false; conversation = { restored: false }; waiting = false; changes = []; renderChanges(); started = false; busy(false); showHistory(false); void load(); } };
}

function ownEditor(...args:any[]){const v=monaco.editor.createDiffEditor(...args);own(()=>v.dispose());return v;}

function ownModel(...args:any[]){const model=monaco.editor.createModel(...args);own(()=>model.dispose());return model;}
