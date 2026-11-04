/**
 * Campo de pedido do agente (AI-ACP-001): popup de conclusão para `@` (contexto) e `/` (comandos do agente),
 * realce dos tokens inseridos e fichas de contexto abaixo do texto, como o AI Chat do PhpStorm.
 * ↩ insere a sugestão, ⇥ substitui o token sob o cursor, Esc fecha; ↑/↓ navegam.
 */
export type Mention = { kind: 'thisFile' | 'selection' | 'file' | 'folder' | 'symbol' | 'schema' | 'image'; label: string; path?: string; line?: number; endLine?: number; text?: string; mimeType?: string; data?: string; size?: number };
export type Suggestion = {
 label: string; hint?: string; icon?: string;
 /** Texto que substitui o token (sem espaço final). */
 insert: string;
 /** Categoria (`@file:`): mantém o popup aberto para escolher o alvo. */
 category?: boolean;
 mention?: Mention;
};
export type Provider = (query: string, signal: AbortSignal) => Promise<Suggestion[]> | Suggestion[];
type Options = { mentions: Provider; commands?: Provider; changed?(): void; /** Comando conhecido (realçado no início do texto). */ known?(name: string): boolean };

type Token = { start: number; end: number; text: string; trigger: '@' | '/' };

export function composer(textarea: HTMLTextAreaElement, chips: HTMLElement, options: Options) {
 // Camada atrás do texto que desenha o fundo dos tokens (@file:…, /comando) com a mesma quebra de linha.
 const wrap = document.createElement('div'); wrap.className = 'agent-editor';
 const backdrop = document.createElement('div'); backdrop.className = 'agent-highlight'; backdrop.setAttribute('aria-hidden', 'true');
 textarea.replaceWith(wrap); wrap.append(backdrop, textarea);
 const popup = document.createElement('div'); popup.className = 'agent-popup'; popup.hidden = true; popup.setAttribute('role', 'listbox'); popup.id = 'agent-popup';
 const list = document.createElement('div'); list.className = 'agent-popup-list';
 const footer = document.createElement('div'); footer.className = 'agent-popup-footer'; footer.textContent = 'Pressione ↩ para inserir, ⇥ para substituir';
 popup.append(list, footer); document.body.append(popup);
 textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-controls', popup.id);
 let mentions: { token: string; mention: Mention }[] = [];
 let items: Suggestion[] = []; let selected = 0; let token: Token | undefined; let request: AbortController | undefined; let generation = 0;

 function tokenAt(): Token | undefined {
  const caret = textarea.selectionStart; if (caret !== textarea.selectionEnd) return;
  const text = textarea.value; let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret; while (end < text.length && !/\s/.test(text[end])) end++;
  const word = text.slice(start, caret);
  if (word.startsWith('@')) return { start, end, text: word.slice(1), trigger: '@' };
  if (word.startsWith('/') && options.commands && !text.slice(0, start).trim()) return { start, end, text: word.slice(1), trigger: '/' };
 }
 const escape = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
 function paint() {
  // Tokens válidos: menções registradas (com ficha) e o comando inicial.
  let html = escape(textarea.value);
  const marks = new Set(mentions.map(m => m.token));
  const first = textarea.value.match(/^\/([\w:.-]+)(?=\s|$)/); if (first && options.known?.(first[1])) marks.add(first[0]);
  for (const mark of [...marks].sort((a, b) => b.length - a.length)) html = html.split(escape(mark)).join(`<mark>${escape(mark)}</mark>`);
  backdrop.innerHTML = html + '\n';
  backdrop.scrollTop = textarea.scrollTop;
 }
 function renderChips() {
  chips.replaceChildren(...mentions.map(entry => {
   const chip = document.createElement('span'); chip.className = 'agent-chip'; chip.dataset.kind = entry.mention.kind; chip.title = entry.mention.path ?? entry.mention.label;
   if (entry.mention.kind === 'image' && entry.mention.data) { const img = document.createElement('img'); img.src = `data:${entry.mention.mimeType};base64,${entry.mention.data}`; img.alt = ''; chip.append(img); }
   const label = document.createElement('button'); label.type = 'button'; label.className = 'agent-chip-label'; label.textContent = entry.mention.label;
   label.onclick = () => chips.dispatchEvent(new CustomEvent('agent-open-attachment', { detail: entry.mention, bubbles: true }));
   const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'agent-chip-remove'; remove.textContent = '×'; remove.title = 'Remover do contexto'; remove.setAttribute('aria-label', `Remover ${entry.mention.label}`);
   remove.onclick = () => { removeMention(entry.token); textarea.focus(); };
   chip.append(label, remove); return chip;
  }));
  chips.hidden = !mentions.length;
 }
 function removeMention(text: string) {
  mentions = mentions.filter(m => m.token !== text);
  if (text.startsWith('@')) { const i = textarea.value.indexOf(text); if (i >= 0) textarea.value = (textarea.value.slice(0, i) + textarea.value.slice(i + text.length)).replace(/ {2,}/g, ' ').replace(/^ /, ''); }
  sync();
 }
 /** Menções cujo texto o usuário apagou deixam de valer (anexos sem token, como imagens, ficam). */
 function sync() { mentions = mentions.filter(m => !m.token.startsWith('@') || textarea.value.includes(m.token)); renderChips(); paint(); options.changed?.(); }
 function position() {
  const rect = textarea.getBoundingClientRect();
  // Linha do cursor: mede o texto até ele numa cópia invisível com o mesmo estilo.
  const probe = backdrop.cloneNode() as HTMLElement; probe.style.visibility = 'hidden'; probe.style.position = 'absolute';
  probe.textContent = textarea.value.slice(0, textarea.selectionStart); const marker = document.createElement('span'); marker.textContent = '​'; probe.append(marker); wrap.append(probe);
  const top = marker.offsetTop + marker.offsetHeight - textarea.scrollTop; probe.remove();
  const width = Math.max(rect.width, 320);
  popup.style.left = `${Math.max(4, Math.min(rect.left - 24, window.innerWidth - width - 4))}px`;
  popup.style.top = `${Math.min(rect.top + top + 4, window.innerHeight - 120)}px`; popup.style.width = `${width}px`;
 }
 function render() {
  list.replaceChildren(...items.map((item, i) => {
   const row = document.createElement('div'); row.className = 'agent-popup-item'; row.setAttribute('role', 'option'); row.id = `agent-popup-${i}`;
   if (i === selected) row.setAttribute('aria-selected', 'true');
   if (item.icon) { const icon = document.createElement('span'); icon.className = 'agent-popup-icon'; icon.textContent = item.icon; row.append(icon); }
   const label = document.createElement('span'); label.className = 'agent-popup-label'; label.textContent = item.label; row.append(label);
   if (item.hint) { const hint = document.createElement('span'); hint.className = 'agent-popup-hint'; hint.textContent = item.hint; row.append(hint); }
   row.onmousedown = event => { event.preventDefault(); selected = i; accept(false); };
   return row;
  }));
  if (!items.length) { const empty = document.createElement('div'); empty.className = 'agent-popup-empty'; empty.textContent = token?.trigger === '/' ? 'O agente não anunciou comandos' : 'Nada encontrado'; list.append(empty); }
  textarea.setAttribute('aria-activedescendant', items.length ? `agent-popup-${selected}` : '');
  list.querySelector('[aria-selected]')?.scrollIntoView?.({ block: 'nearest' });
 }
 function close() { popup.hidden = true; token = undefined; request?.abort(); textarea.setAttribute('aria-expanded', 'false'); }
 async function update() {
  const current = tokenAt();
  if (!current) { close(); return; }
  token = current; request?.abort(); request = new AbortController(); const mine = ++generation;
  const provider = current.trigger === '@' ? options.mentions : options.commands!;
  let result: Suggestion[];
  try { result = await provider(current.text, request.signal); } catch { result = []; }
  if (mine !== generation || !token) return;
  items = result.slice(0, 50); selected = 0; popup.hidden = false; textarea.setAttribute('aria-expanded', 'true'); position(); render();
 }
 /** Rótulo curto (nome do arquivo); usa o caminho quando outro anexo já tem o mesmo nome. */
 function tokenFor(item: Suggestion) {
  if (!item.mention || item.mention.kind !== 'file' && item.mention.kind !== 'folder') return item.insert;
  const clash = mentions.some(m => m.mention.label === item.mention!.label && m.mention.path !== item.mention!.path);
  return clash ? item.insert.replace(item.mention.label, item.mention.path!) : item.insert;
 }
 function accept(replace: boolean) {
  const item = items[selected]; if (!item || !token) return;
  const value = textarea.value; const end = replace ? token.end : textarea.selectionStart;
  const text = item.category ? item.insert : tokenFor(item);
  const tail = value.slice(end);
  const insert = item.category ? text : text + (tail.startsWith(' ') ? '' : ' ');
  textarea.value = value.slice(0, token.start) + insert + tail;
  const caret = token.start + insert.length; textarea.setSelectionRange(caret, caret);
  if (item.mention && !mentions.some(m => m.token === text)) mentions.push({ token: text, mention: item.mention });
  close(); sync(); textarea.focus();
  if (item.category) void update();
 }
 textarea.addEventListener('input', () => { sync(); void update(); });
 textarea.addEventListener('click', () => void update());
 textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; });
 textarea.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== textarea) close(); }, 100));
 textarea.addEventListener('keydown', event => {
  if (popup.hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); if (items.length) { selected = (selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; render(); } }
  else if ((event.key === 'Enter' || event.key === 'Tab') && items.length && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); accept(event.key === 'Tab'); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
 }, true);
 window.addEventListener('resize', close);
 paint();
 return {
  /** Menções e anexos a enviar com o pedido. */
  mentions: () => mentions.map(m => m.mention),
  /** Anexo sem token no texto (imagem, arquivo pelo botão +); `token` só identifica a ficha. */
  attach(mention: Mention) { const key = `#${mention.kind}:${mention.path ?? mention.label}:${mentions.length}`; if (!mentions.some(m => m.mention.kind === mention.kind && m.mention.path === mention.path && m.mention.label === mention.label && m.mention.data === mention.data)) mentions.push({ token: key, mention }); renderChips(); options.changed?.(); },
  clear() { mentions = []; textarea.value = ''; close(); sync(); },
  close, refresh: paint,
  get open() { return !popup.hidden; },
  dispose() { popup.remove(); window.removeEventListener('resize', close); },
 };
}
