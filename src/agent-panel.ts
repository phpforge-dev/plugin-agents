import {agentGeneration} from './agent-generation';
import {historyView} from './history-view';
import {newId, transcriptText, type Item, type Summary} from './model';
import {Transcript} from './transcript';
import {composer, type Mention} from './composer';
import {mentionProvider, fileItem, schemaSuggestions, type DatabaseEntry} from './mentions';
import {attachmentMenu, readImage} from './attachments';
import {renderMessage} from './snippets';
import {findInChat} from './find';
import {tr,msg,html,monaco,own,host,service,keymap} from './sdk';

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
  case 'commit': return { type: 'commit', hash: m.hash };
  case 'localChanges': return { type: 'localChanges' };
  case 'projectStructure': return { type: 'projectStructure' };
  case 'rule': return { type: 'rule', path: m.path };
  case 'problems': return { type: 'problems', path: m.path, text: m.text };
  case 'dropped': return { type: 'dropped', name: m.label, text: m.text };
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
<div class="agent-input"><textarea id="agent-prompt" placeholder="Digite sua tarefa, use @ para adicionar arquivos ou / para comandos" aria-label="Pedido ao agente (Enter envia, Shift+Enter quebra linha)" disabled></textarea><div id="agent-command-hint" class="agent-command-hint" hidden></div><div id="agent-chips" class="agent-chips" hidden></div>
<div class="agent-actions"><button id="agent-attach" class="agent-icon" type="button" title="Adicionar anexo" aria-label="Adicionar anexo" aria-haspopup="menu" aria-expanded="false">+</button><button id="agent-allow-all" type="button" class="agent-allow-all" aria-pressed="false" disabled title="Executar comandos do terminal e ações do agente sem pedir aprovação, só nesta sessão (não recomendado)">Permitir tudo</button><label><input type="checkbox" id="agent-context"> Contexto da IDE</label><button id="agent-cancel" disabled>Interromper</button><button id="agent-send" class="primary" disabled>Enviar</button></div></div>
</div>`;
 const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
 const liveTerminals = new Set<string>();
 const snippetContext = { monaco, host, language: (path: string) => hooks.language(path), status: (text: string) => hooks.status(text), own };
 const transcript = new Transcript($('agent-transcript'), { terminal: (el, item) => renderTerminal(el, item), message: (el, text) => renderMessage(el, text, snippetContext) });
 const welcome = root.querySelector<HTMLElement>('.agent-welcome')!;
 // Buscar na conversa (Find in Chat): ⌘F/Ctrl+F dentro do chat ou ⋮ › Buscar na conversa.
 const find = findInChat($('agent-transcript'), welcome);
 own(() => find.dispose());
 const inChat = (target: Element | null) => !!target?.closest('#agent-chat') && $('agent-history').hidden;
 if (keymap?.defineContext && keymap?.registerAction) {
  own(keymap.defineContext('agent-chat', inChat));
  own(keymap.registerAction({ id: 'agent.findInChat', label: 'Buscar na conversa', category: 'Agente', aliases: 'find in chat search conversation', context: 'agent-chat', defaults: { mac: 'Meta+F', other: 'Ctrl+F' }, run: () => find.open() }));
 }
 // Sem o keymap da IDE (ou com ele desativado), o próprio painel atende ao atalho.
 root.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || !inChat(event.target as Element)) return;
  event.preventDefault(); find.open();
 });
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
 let commands: { name: string; description: string; hint?: string | null }[] = [];
 let capabilities = { image: false, embeddedContext: false };
 const databaseEntries = (): DatabaseEntry[] => { const entries = service('database')?.sqlIntelligence?.entries as Map<string, DatabaseEntry> | undefined; return entries ? [...entries.values()].filter(e => e?.model?.schemas) : []; };
 const findMentions = mentionProvider({
  listFiles: () => api.listFiles('', false),
  searchSymbols: (query: string) => api.searchSymbols(query),
  context: editorContext,
  recent: () => { remember(hooks.context()?.path); return recent; },
  database: () => databaseEntries(),
  root: () => projectRoot,
  list: api.agentMentions ? (kind: string, query: string) => api.agentMentions(kind, query) : undefined,
  problems: () => problems(),
 });
 const input = composer($<HTMLTextAreaElement>('agent-prompt'), $('agent-chips'), {
  // Comandos "/" vêm do agente (ACP available_commands_update), como no modo agente do AI Chat.
  commands: query => {
   const q = query.toLowerCase();
   return commands.filter(c => c.name.toLowerCase().startsWith(q)).concat(commands.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)))
    .map(c => ({ label: `/${c.name}`, hint: c.description, insert: `/${c.name}` }));
  },
  changed: () => commandHint(),
  known: name => commands.some(c => c.name === name),
  mentions: findMentions,
 });
 own(() => input.dispose());
 // Anexos: botão +, imagem por seletor, colar ou arrastar (20 MB, PNG/JPEG/GIF/WebP), como no AI Chat.
 const attachImage = (file: File) => {
  if (!capabilities.image) { hooks.status(tr('O agente atual não aceita imagens.')); return; }
  void readImage(file).then(m => input.attach(m), (error: Error) => hooks.status(String(error.message ?? error)));
 };
 const menu = attachmentMenu($<HTMLButtonElement>('agent-attach'), {
  search: async (query, signal) => (await Promise.all([findMentions(`file:${query}`, signal), findMentions(`folder:${query}`, signal)])).flat().slice(0, 40),
  recent: () => { remember(hooks.context()?.path); return recent.slice(0, 8).map(fileItem); },
  schemas: () => schemaSuggestions(databaseEntries(), ''),
  imageAllowed: () => capabilities.image,
  attach: m => { input.attach(m); $<HTMLTextAreaElement>('agent-prompt').focus(); },
  status: hooks.status,
 });
 own(() => menu.dispose());
 const promptBox = $<HTMLTextAreaElement>('agent-prompt');
 promptBox.addEventListener('paste', event => {
  const images = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
  if (!images.length) return; event.preventDefault(); images.forEach(attachImage);
 });
 const inputBox = root.querySelector<HTMLElement>('.agent-input')!;
 inputBox.addEventListener('dragover', event => { if ([...(event.dataTransfer?.items ?? [])].some(i => i.kind === 'file')) { event.preventDefault(); inputBox.classList.add('agent-drop'); } });
 inputBox.addEventListener('dragleave', () => inputBox.classList.remove('agent-drop'));
 inputBox.addEventListener('drop', event => {
  inputBox.classList.remove('agent-drop');
  const files = [...(event.dataTransfer?.files ?? [])]; if (!files.length) return;
  event.preventDefault();
  for (const file of files) { if (file.type.startsWith('image/')) attachImage(file); else hooks.status(msg`${file.name}: arraste imagens; para arquivos do projeto use @file: ou +`); }
 });
 /** Dica do argumento do comando digitado (ACP `input.hint`). */
 function commandHint() {
  const name = $<HTMLTextAreaElement>('agent-prompt').value.match(/^\/([\w:.-]+)\s/)?.[1];
  const hint = commands.find(c => c.name === name)?.hint;
  $('agent-command-hint').hidden = !hint; $('agent-command-hint').textContent = hint ? `/${name} ${hint}` : '';
 }
 /** @problems: marcadores do arquivo aberto (os mesmos da janela Problemas e da faixa do editor). */
 function problems() {
  const model = host?.editor?.getModel?.(); const path = hooks.context()?.path;
  if (!model || !path || !monaco?.editor?.getModelMarkers) return undefined;
  const severity: Record<number, string> = { 8: 'ERRO', 4: 'AVISO', 2: 'INFO', 1: 'DICA' };
  const markers = (monaco.editor.getModelMarkers({ resource: model.uri }) as { severity: number; message: string; startLineNumber: number; startColumn: number; source?: string }[])
   .filter(m => m.severity >= 2).sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber).slice(0, 200);
  const text = markers.length ? markers.map(m => `${severity[m.severity] ?? 'INFO'} ${path}:${m.startLineNumber}:${m.startColumn} ${m.message}${m.source ? ` [${m.source}]` : ''}`).join('\n') : `Nenhum problema detectado em ${path}.`;
  return { path, text, count: markers.length };
 }
 let projectRoot = '';
 void api.workspace?.().then((w: { root: string }) => { projectRoot = w.root; }).catch(() => {});
 $('agent-chips').addEventListener('agent-open-attachment', event => {
  const m = (event as CustomEvent<Mention>).detail;
  if (m.kind === 'image' && m.data) { previewImage(m); return; }
  if (m.path && !['folder', 'schema', 'problems', 'dropped'].includes(m.kind)) void host?.open?.(m.path, m.line ? m.line - 1 : undefined);
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
 /** Bloco do terminal: comando exato, pasta, aprovação (Executar/Recusar), saída e Interromper. */
 function renderTerminal(el: HTMLElement, item: Extract<Item, { kind: 'terminal' }>) {
  const live = liveTerminals.has(item.id);
  const status = item.status === 'waiting' ? (live ? 'Aguardando aprovação' : 'Não executado') : item.status === 'running' ? (live ? 'Executando…' : 'Não concluído')
   : item.status === 'rejected' ? 'Recusado' : item.status === 'killed' ? `Interrompido${item.signal ? ` (${item.signal})` : ''}` : item.exitCode === 0 ? 'Concluído' : `Falhou · código ${item.exitCode ?? '?'}`;
  el.dataset.state = item.status === 'exited' ? (item.exitCode === 0 ? 'ok' : 'failed') : item.status;
  const head = document.createElement('div'); head.className = 'agent-terminal-head';
  const title = document.createElement('strong'); title.textContent = item.status === 'waiting' && live ? 'Executar comando no terminal?' : 'Terminal';
  const state = document.createElement('span'); state.className = 'agent-terminal-status'; state.textContent = status;
  head.append(title, state);
  const command = document.createElement('pre'); command.className = 'agent-terminal-command'; command.textContent = `$ ${item.command}`;
  const cwd = document.createElement('div'); cwd.className = 'agent-terminal-cwd'; cwd.textContent = item.cwd ? `em ${item.cwd}/` : 'na raiz do projeto';
  if (item.auto) { const auto = document.createElement('span'); auto.className = 'agent-terminal-auto'; auto.textContent = item.auto === 'all' ? ' · sem aprovação (Permitir tudo)' : ' · permitido pela allowlist'; cwd.append(auto); }
  el.replaceChildren(head, command, cwd);
  if (live && (item.status === 'waiting' || item.status === 'running')) {
   const actions = document.createElement('div'); actions.className = 'agent-terminal-actions';
   const button = (label: string, cls: string, run: () => Promise<unknown>) => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = () => { actions.querySelectorAll('button').forEach(x => x.disabled = true); void run().catch((error: unknown) => hooks.status(String(error))); }; actions.append(b); return b; };
   if (item.status === 'waiting') {
    button(tr('Executar'), 'primary agent-terminal-run', () => api.agentTerminalDecision(item.id, true)); button(tr('Recusar'), 'agent-terminal-reject', () => api.agentTerminalDecision(item.id, false));
    // Como o "More actions" do Junie: executar e guardar na allowlist do projeto.
    if (api.agentTerminalPolicySet) {
     const more = document.createElement('button'); more.className = 'agent-terminal-more agent-icon'; more.textContent = '⋯'; more.title = tr('Executar e permitir sem perguntar'); more.setAttribute('aria-haspopup', 'menu');
     more.onclick = () => rememberMenu(more, item, (kind: string) => { actions.querySelectorAll('button').forEach(x => x.disabled = true); void api.agentTerminalDecision(item.id, true, kind).catch((error: unknown) => hooks.status(String(error))); });
     actions.append(more);
    }
   }
   else button(tr('Interromper'), 'agent-terminal-kill', () => api.agentTerminalKill(item.id));
   el.append(actions);
  }
  if (item.output) { const out = document.createElement('pre'); out.className = 'agent-terminal-output'; out.textContent = (item.truncated ? '…\n' : '') + item.output; el.append(out); requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; }); }
 }
 function rememberMenu(anchor: HTMLElement, item: Extract<Item, { kind: 'terminal' }>, run: (kind: string) => void) {
  const menu = document.createElement('div'); menu.className = 'agent-menu agent-terminal-menu'; menu.setAttribute('role', 'menu');
  const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.max(4, rect.left)}px`; menu.style.top = `${rect.bottom + 2}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside); };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const entry = (label: string, detail: string, kind: string) => { const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.dataset.kind = kind; b.innerHTML = '<span></span><code></code>'; b.firstElementChild!.textContent = label; b.lastElementChild!.textContent = detail; b.onclick = () => { close(); run(kind); }; menu.append(b); };
  entry(tr('Executar e permitir este comando'), item.command, 'exact');
  if (item.similar) entry(tr('Executar e permitir comandos semelhantes'), `${item.similar}…`, 'similar');
  document.body.append(menu); (menu.firstElementChild as HTMLElement).focus(); own(() => menu.remove());
  menu.onkeydown = e => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  setTimeout(() => document.addEventListener('mousedown', outside));
 }
 /** "Permitir tudo": só para a sessão atual do agente; o host o desliga a cada sessão nova. */
 let allowAll = false;
 function showAllowAll(value: boolean) { allowAll = value; const b = $<HTMLButtonElement>('agent-allow-all'); b.setAttribute('aria-pressed', String(value)); b.classList.toggle('on', value); }
 $('agent-allow-all').onclick = async () => {
  try { const policy = await api.agentTerminalPolicySet({ allowAll: !allowAll }); showAllowAll(!!policy.allowAll); hooks.status(policy.allowAll ? tr('Permitir tudo ligado nesta sessão: comandos e ações rodam sem aprovação.') : tr('Permitir tudo desligado: cada comando volta a pedir aprovação.')); }
  catch (error) { hooks.status(String(error)); }
 };
 /** Allowlist do terminal (⋮): regras gravadas por projeto, removíveis. */
 async function allowlistDialog() {
  const dialog = document.createElement('dialog'); dialog.className = 'agent-allowlist'; dialog.setAttribute('aria-label', tr('Allowlist do terminal'));
  const head = document.createElement('header'); const title = document.createElement('strong'); title.textContent = tr('Allowlist do terminal'); const closeButton = document.createElement('button'); closeButton.textContent = tr('Fechar'); head.append(title, closeButton);
  const info = document.createElement('p'); info.className = 'agent-allowlist-info'; info.textContent = tr('Comandos que o agente pode executar sem pedir aprovação neste projeto. Os demais continuam esperando Executar.');
  const list = document.createElement('ul'); list.className = 'agent-allowlist-rules';
  dialog.append(head, info, list); document.body.append(dialog); own(() => dialog.remove()); dialog.showModal();
  const render = (policy: { rules: { kind: string; pattern: string }[] }) => {
   list.replaceChildren(...policy.rules.map(rule => {
    const li = document.createElement('li'); const code = document.createElement('code'); code.textContent = rule.kind === 'similar' ? `${rule.pattern}…` : rule.pattern;
    const kind = document.createElement('span'); kind.className = 'agent-allowlist-kind'; kind.textContent = rule.kind === 'similar' ? tr('semelhantes') : tr('igual');
    const remove = document.createElement('button'); remove.textContent = tr('Remover'); remove.onclick = async () => { try { render(await api.agentTerminalPolicySet({ remove: rule })); } catch (error) { hooks.status(String(error)); } };
    li.append(code, kind, remove); return li;
   }));
   if (!policy.rules.length) { const li = document.createElement('li'); li.className = 'agent-allowlist-empty'; li.textContent = tr('Nenhuma regra. Use ⋯ ao aprovar um comando para adicionar.'); list.append(li); }
  };
  closeButton.onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove());
  try { render(await api.agentTerminalPolicy()); } catch (error) { hooks.status(String(error)); }
 }
 const pendingApprovals = () => transcript.items.some(i => i.kind === 'terminal' && i.status === 'waiting' && liveTerminals.has(i.id)) || !!root.querySelector('.agent-permission');
 function save() {
  if (!conversation.id || !transcript.items.length) return saving;
  // Saída de terminal guardada só pelo final (20 KB) no histórico.
  const items = JSON.parse(JSON.stringify(transcript.items)).map((i: Item) => i.kind === 'terminal' && i.output.length > 20000 ? { ...i, output: i.output.slice(-20000), truncated: true } : i);
  const payload = { id: conversation.id, agent: agentId, items };
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
  transcript.clear(); welcome.hidden = false; conversation = { restored: false }; waiting = false; find.refresh();
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
  transcript.load(data.items); welcome.hidden = data.items.length > 0; find.refresh();
  conversation = { id: data.id, restored: true };
  if (data.agent && agents.some(a => a.id === data.agent && a.available) && !started) $<HTMLSelectElement>('agent-select').value = data.agent;
  showHistory(false);
 }
 $('agent-options').onclick = event => {
  const menu = document.createElement('div'); menu.className = 'agent-menu'; menu.setAttribute('role', 'menu');
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menu.style.left = `${Math.max(4, rect.right - 220)}px`; menu.style.top = `${rect.bottom + 2}px`;
  const item = (label: string, shortcut: string, run: () => unknown) => { const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.innerHTML = '<span></span><kbd></kbd>'; b.firstElementChild!.textContent = label; b.lastElementChild!.textContent = shortcut; b.onclick = () => { menu.remove(); void run(); }; menu.append(b); return b; };
  item(tr('Buscar na conversa'), keymap?.shortcut?.('agent.findInChat') || (navigator.platform?.startsWith('Mac') ? '⌘F' : 'Ctrl+F'), () => { showHistory(false); find.open(); });
  if (api.agentTerminalPolicy) item(tr('Allowlist do terminal…'), '', () => allowlistDialog());
  item(tr('Excluir todas as conversas'), '', async () => { await history.deleteAll(); if (!$('agent-history').hidden) void history.show(); });
  document.body.append(menu); (menu.firstElementChild as HTMLElement).focus();
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
  // @problems vale para o estado do arquivo no envio, não no momento em que foi digitado.
  const mentioned = input.mentions().map(m => { if (m.kind !== 'problems') return m; const p = problems(); return p && p.path === m.path ? { ...m, text: p.text } : m; });
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
    started = true; busy(false); agentId = event.agent; commands = []; input.refresh();
    $<HTMLButtonElement>('agent-allow-all').disabled = !api.agentTerminalPolicySet; showAllowAll(false);
    capabilities = { image: !!(event as any).capabilities?.image, embeddedContext: !!(event as any).capabilities?.embeddedContext };
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
   case 'commands': commands = (event as any).commands; input.refresh(); commandHint(); break;
   case 'permission': {
    transcript.endStream(); waiting = true; history.refresh();
    const box = document.createElement('div'); box.className = 'agent-block agent-permission'; const title = document.createElement('p'); title.textContent = `Permitir: ${event.title}?`; box.replaceChildren(title);
    for (const option of event.options) {
     const button = document.createElement('button'); button.textContent = option.name; button.dataset.kind = option.kind;
     button.onclick = () => { box.querySelectorAll('button').forEach(b => b.disabled = true); title.textContent = `${event.title} — ${option.name}`; box.remove(); waiting = pendingApprovals(); transcript.add({ kind: 'note', text: `${event.title} — ${option.name}` }); void api.agentPermission(event.id, option.id).catch((error: unknown) => hooks.status(String(error))); };
     box.append(button);
    }
    $('agent-transcript').append(box); box.scrollIntoView({ block: 'nearest' });
    break;
   }
   case 'changes': changes = event.changes; renderChanges(); break;
   case 'terminal' as never: {
    const e = event as unknown as { id: string; command?: string; cwd?: string; status: 'waiting' | 'running' | 'exited' | 'rejected' | 'killed'; exitCode?: number | null; signal?: string | null; auto?: 'all' | 'allowlist'; similar?: string | null; origin?: 'snippet' };
    // Pedido novo: espera aprovação, ou já roda (allowlist, Permitir tudo, Executar trecho).
    if (e.command !== undefined && !transcript.items.some(i => i.kind === 'terminal' && i.id === e.id)) { liveTerminals.add(e.id); transcript.endStream(); transcript.add({ kind: 'terminal', id: e.id, command: e.command, cwd: e.cwd ?? '', status: e.status, output: '', ...(e.auto ? { auto: e.auto } : {}), ...(e.similar ? { similar: e.similar } : {}), ...(e.origin ? { origin: e.origin } : {}) }); }
    else transcript.terminal(e.id, { status: e.status, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}), ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    waiting = pendingApprovals(); history.refresh();
    if (e.status === 'waiting') transcript.element(transcript.items[transcript.items.length - 1])?.scrollIntoView?.({ block: 'nearest' });
    break;
   }
   case 'permission-auto' as never: { const e = event as unknown as { title: string; option: string }; transcript.add({ kind: 'note', text: `${e.title} — ${e.option} (Permitir tudo)` }); break; }
   case 'terminal-output' as never: { const e = event as unknown as { id: string; text: string }; transcript.terminalOutput(e.id, e.text); break; }
   case 'done':
    transcript.endStream(); busy(false);
    root.querySelectorAll('.agent-permission').forEach(el => el.remove());
    // Pedidos de terminal ainda abertos ao fim do turno foram recusados pelo host.
    for (const i of transcript.items) if (i.kind === 'terminal' && i.status === 'waiting') transcript.terminal(i.id, { status: 'rejected' });
    waiting = pendingApprovals();
    if (event.error) transcript.add({ kind: 'error', text: event.error });
    else if (event.stopReason === 'cancelled') transcript.add({ kind: 'note', text: 'Interrompido.' });
    hooks.status(event.error ? tr('Falha no agente') : tr('Resposta concluída'));
    void save();
    break;
  }
 }
 void load().catch(error => { $('agent-detail').textContent = String(error); });
 return { handle, generate: generation.generate, cancel: generation.cancel, reset() { generation.reset(); showAllowAll(false); $<HTMLButtonElement>('agent-allow-all').disabled = true; transcript.clear(); welcome.hidden = false; conversation = { restored: false }; waiting = false; changes = []; renderChanges(); started = false; busy(false); showHistory(false); void load(); } };
}

function ownEditor(...args:any[]){const v=monaco.editor.createDiffEditor(...args);own(()=>v.dispose());return v;}

function ownModel(...args:any[]){const model=monaco.editor.createModel(...args);own(()=>model.dispose());return model;}
