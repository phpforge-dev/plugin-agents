import type {Mention, Suggestion} from './composer';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_LIMIT = 20 * 1024 * 1024;

/** Lê uma imagem (arquivo escolhido, colado ou arrastado) como anexo base64; recusa formato ou tamanho. */
export function readImage(file: File): Promise<Mention> {
 if (!IMAGE_TYPES.includes(file.type)) return Promise.reject(new Error(`${file.name || 'Imagem'}: use PNG, JPEG, GIF ou WebP`));
 if (file.size > IMAGE_LIMIT) return Promise.reject(new Error(`${file.name || 'Imagem'}: acima de 20 MB`));
 return new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler a imagem'));
  reader.onload = () => {
   const url = String(reader.result); const data = url.slice(url.indexOf(',') + 1);
   resolve({ kind: 'image', label: file.name || `imagem-colada.${file.type.split('/')[1]}`, mimeType: file.type, data, size: file.size });
  };
  reader.readAsDataURL(file);
 });
}

type Sources = {
 /** Busca de arquivos e pastas (mesma do `@file:`/`@folder:`). */
 search(query: string, signal: AbortSignal): Promise<Suggestion[]>;
 recent(): Suggestion[];
 schemas(): Suggestion[];
 imageAllowed(): boolean;
 attach(m: Mention): void;
 status(text: string): void;
};

/**
 * Menu "Adicionar anexo" (+): busca, Arquivos e pastas ›, Imagem…, Schema de banco… (quando há bancos
 * conectados) e Arquivos recentes, como o popup observado no AI Chat.
 */
export function attachmentMenu(button: HTMLButtonElement, sources: Sources) {
 const picker = document.createElement('input'); picker.type = 'file'; picker.accept = IMAGE_TYPES.join(','); picker.multiple = true; picker.hidden = true; picker.id = 'agent-image-picker';
 button.after(picker);
 picker.onchange = async () => { for (const file of [...picker.files ?? []]) await readImage(file).then(sources.attach, error => sources.status(String(error.message ?? error))); picker.value = ''; };
 let menu: HTMLElement | undefined; let abort: AbortController | undefined;
 const close = () => { abort?.abort(); menu?.remove(); menu = undefined; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); };
 const outside = (event: Event) => { if (menu && !menu.contains(event.target as Node) && event.target !== button) close(); };
 function row(label: string, options: { hint?: string; icon?: string; disabled?: string; submenu?: boolean; run(): void }) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'agent-attach-item'; b.setAttribute('role', 'menuitem');
  const icon = document.createElement('span'); icon.className = 'agent-popup-icon'; icon.textContent = options.icon ?? '';
  const text = document.createElement('span'); text.className = 'agent-popup-label'; text.textContent = label;
  b.append(icon, text);
  if (options.hint) { const hint = document.createElement('span'); hint.className = 'agent-popup-hint'; hint.textContent = options.hint; b.append(hint); }
  if (options.submenu) { const arrow = document.createElement('span'); arrow.className = 'agent-popup-hint'; arrow.textContent = '›'; b.append(arrow); }
  if (options.disabled) { b.disabled = true; b.title = options.disabled; }
  b.onclick = () => options.run();
  return b;
 }
 const pick = (s: Suggestion) => { if (s.mention) sources.attach(s.mention); close(); };
 function section(title: string) { const h = document.createElement('div'); h.className = 'agent-attach-section'; h.textContent = title; return h; }
 function render(view: 'root' | 'files' | 'schemas', query = '') {
  const body = menu!.querySelector<HTMLElement>('.agent-attach-body')!;
  abort?.abort(); abort = new AbortController(); const signal = abort.signal;
  if (view === 'schemas') { body.replaceChildren(section('Schema de banco'), ...sources.schemas().filter(s => !query || s.label.toLowerCase().includes(query.toLowerCase())).map(s => row(s.label, { hint: s.hint, icon: s.icon, run: () => pick(s) }))); return; }
  if (view === 'files' || query) {
   body.replaceChildren(section(query ? 'Resultados' : 'Arquivos e pastas'));
   void sources.search(query, signal).then(items => { if (signal.aborted) return; body.append(...items.map(s => row(s.label, { hint: s.hint, icon: s.icon, run: () => pick(s) }))); if (!items.length) body.append(section('Nada encontrado')); });
   return;
  }
  const image = sources.imageAllowed();
  const items = [
   row('Arquivos e pastas', { icon: '▤', submenu: true, run: () => { view = 'files'; render('files', search.value); search.focus(); } }),
   row('Imagem…', { icon: '▧', disabled: image ? undefined : 'O agente atual não aceita imagens', run: () => { close(); picker.click(); } }),
  ];
  if (sources.schemas().length) items.push(row('Schema de banco…', { icon: '⛁', run: () => render('schemas') }));
  const recent = sources.recent();
  body.replaceChildren(...items, ...(recent.length ? [section('Arquivos recentes'), ...recent.map(s => row(s.label, { hint: s.mention?.path, icon: s.icon, run: () => pick(s) }))] : []));
 }
 let search: HTMLInputElement;
 function open() {
  close();
  menu = document.createElement('div'); menu.className = 'agent-menu agent-attach-menu'; menu.setAttribute('role', 'menu'); menu.id = 'agent-attach-menu';
  search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Buscar'; search.className = 'agent-attach-search'; search.setAttribute('aria-label', 'Buscar arquivos para anexar');
  const body = document.createElement('div'); body.className = 'agent-attach-body';
  menu.append(search, body); document.body.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(4, rect.left)}px`; menu.style.bottom = `${Math.max(4, window.innerHeight - rect.top + 4)}px`;
  let view: 'root' | 'files' | 'schemas' = 'root';
  search.oninput = () => render(view === 'schemas' ? 'schemas' : search.value ? 'files' : view, search.value);
  menu.onkeydown = event => {
   if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
   const rows = [...menu!.querySelectorAll<HTMLButtonElement>('.agent-attach-item:not(:disabled)')]; const i = rows.indexOf(document.activeElement as HTMLButtonElement);
   if (event.key === 'ArrowDown') { event.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
   if (event.key === 'ArrowUp') { event.preventDefault(); if (i <= 0) search.focus(); else rows[i - 1]?.focus(); }
  };
  render('root'); search.focus(); button.setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', outside);
 }
 button.onclick = () => (menu ? close() : open());
 return { close, picker, dispose() { close(); picker.remove(); } };
}
