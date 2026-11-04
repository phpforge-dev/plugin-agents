import {relativeTime, type Summary} from './model';

type Api = { agentHistory(): Promise<Summary[]>; agentHistoryRename(id: string, title: string): Promise<Summary>; agentHistoryDelete(id: string | null): Promise<void> };
type Hooks = { open(id: string): void; deleted(id: string | null): void; current(): string | undefined; waiting(): boolean; status(text: string): void };

/**
 * Lista "Histórico de conversas" (Chat History): substitui a transcrição, mostra título e tempo relativo,
 * filtra ao digitar, abre com clique/Enter, menu de contexto Renomear (⇧F6) / Excluir conversa (⌫)
 * e ponto amarelo na conversa atual quando ela espera aprovação.
 */
export function historyView(api: Api, root: HTMLElement, hooks: Hooks) {
 root.innerHTML = '<input type="search" class="agent-history-search" placeholder="Buscar conversas" aria-label="Buscar conversas"><ul class="agent-history-list" role="listbox" aria-label="Histórico de conversas"></ul><p class="agent-history-empty" hidden>Nenhuma conversa neste projeto.</p>';
 const search = root.querySelector<HTMLInputElement>('.agent-history-search')!;
 const list = root.querySelector<HTMLUListElement>('.agent-history-list')!;
 const empty = root.querySelector<HTMLElement>('.agent-history-empty')!;
 let entries: Summary[] = []; let menu: HTMLElement | undefined;
 const closeMenu = () => { menu?.remove(); menu = undefined; };
 function render() {
  const query = search.value.trim().toLowerCase();
  const shown = entries.filter(e => !query || e.title.toLowerCase().includes(query));
  empty.hidden = shown.length > 0; empty.textContent = entries.length ? 'Nenhuma conversa corresponde à busca.' : 'Nenhuma conversa neste projeto.';
  list.replaceChildren(...shown.map((entry, index) => {
   const li = document.createElement('li'); li.dataset.id = entry.id; li.tabIndex = index === 0 ? 0 : -1; li.setAttribute('role', 'option');
   const title = document.createElement('span'); title.className = 'agent-history-title'; title.textContent = entry.title;
   const time = document.createElement('span'); time.className = 'agent-history-time'; time.textContent = relativeTime(entry.updated); time.title = new Date(entry.updated).toLocaleString('pt-BR');
   if (entry.id === hooks.current()) { li.setAttribute('aria-current', 'true'); if (hooks.waiting()) { const dot = document.createElement('span'); dot.className = 'agent-history-waiting'; dot.title = 'Aguardando sua resposta'; title.prepend(dot); } }
   li.append(title, time);
   li.onclick = () => hooks.open(entry.id);
   li.oncontextmenu = event => { event.preventDefault(); contextMenu(entry, event.clientX, event.clientY); };
   li.onkeydown = event => keys(event, entry, li);
   return li;
  }));
 }
 function keys(event: KeyboardEvent, entry: Summary, li: HTMLLIElement) {
  const rows = [...list.querySelectorAll<HTMLLIElement>('li')]; const i = rows.indexOf(li);
  if (event.key === 'Enter') { event.preventDefault(); hooks.open(entry.id); }
  else if (event.key === 'F6' && event.shiftKey) { event.preventDefault(); rename(entry); }
  else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); void remove(entry.id); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))]; next?.focus(); }
 }
 function contextMenu(entry: Summary, x: number, y: number) {
  closeMenu();
  menu = document.createElement('div'); menu.className = 'agent-menu'; menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  const item = (label: string, shortcut: string, run: () => void) => { const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.innerHTML = '<span></span><kbd></kbd>'; b.firstElementChild!.textContent = label; b.lastElementChild!.textContent = shortcut; b.onclick = () => { closeMenu(); run(); }; menu!.append(b); };
  item('Renomear', '⇧F6', () => rename(entry));
  item('Excluir conversa', '⌫', () => void remove(entry.id));
  document.body.append(menu); (menu.firstElementChild as HTMLElement).focus();
  menu.onkeydown = event => { if (event.key === 'Escape') closeMenu(); };
 }
 function rename(entry: Summary) {
  const li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(entry.id)}"]`); if (!li) return;
  const input = document.createElement('input'); input.className = 'agent-history-rename'; input.value = entry.title; input.setAttribute('aria-label', 'Nome da conversa');
  li.querySelector('.agent-history-title')!.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (save: boolean) => {
   if (done) return; done = true;
   if (save && input.value.trim() && input.value.trim() !== entry.title) { try { const s = await api.agentHistoryRename(entry.id, input.value); entry.title = s.title; } catch (error) { hooks.status(String(error)); } }
   render(); list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(entry.id)}"]`)?.focus();
  };
  input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter') void finish(true); if (event.key === 'Escape') void finish(false); };
  input.onblur = () => void finish(true);
  input.onclick = event => event.stopPropagation();
 }
 async function remove(id: string | null) {
  try { await api.agentHistoryDelete(id); } catch (error) { hooks.status(String(error)); return; }
  entries = id ? entries.filter(e => e.id !== id) : []; hooks.deleted(id); render();
  list.querySelector<HTMLElement>('li')?.focus();
 }
 search.oninput = render;
 search.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector<HTMLElement>('li')?.focus(); } };
 const outside = (event: MouseEvent) => { if (menu && !menu.contains(event.target as Node)) closeMenu(); };
 document.addEventListener('mousedown', outside);
 return {
  async show() { search.value = ''; try { entries = await api.agentHistory(); } catch (error) { entries = []; hooks.status(String(error)); } render(); (list.querySelector<HTMLElement>('li') ?? search).focus(); },
  refresh: render,
  deleteAll: () => remove(null),
  closeMenu,
  dispose() { closeMenu(); document.removeEventListener('mousedown', outside); },
 };
}
