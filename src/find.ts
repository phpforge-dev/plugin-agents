/**
 * Buscar na conversa (Find in Chat do AI Chat): barra sobre a transcrição aberta por ⌘F/Ctrl+F ou pelo ⋮.
 * Realça todas as ocorrências (sem diferenciar maiúsculas), mostra "n/total", ↩/⇧↩ ou ↓/↑ navegam,
 * Esc fecha e devolve o foco. A busca acompanha mensagens que chegam enquanto a barra está aberta.
 */
export function findInChat(transcript: HTMLElement, before: HTMLElement) {
 const bar = document.createElement('div'); bar.className = 'agent-find'; bar.hidden = true; bar.setAttribute('role', 'search');
 bar.innerHTML = '<input type="search" class="agent-find-input" placeholder="Buscar na conversa" aria-label="Buscar na conversa"><span class="agent-find-count" aria-live="polite"></span><button type="button" class="agent-icon agent-find-prev" title="Ocorrência anterior (⇧↩)" aria-label="Ocorrência anterior">↑</button><button type="button" class="agent-icon agent-find-next" title="Próxima ocorrência (↩)" aria-label="Próxima ocorrência">↓</button><button type="button" class="agent-icon agent-find-close" title="Fechar (Esc)" aria-label="Fechar busca">×</button>';
 before.before(bar);
 const input = bar.querySelector<HTMLInputElement>('.agent-find-input')!;
 const count = bar.querySelector<HTMLElement>('.agent-find-count')!;
 let marks: HTMLElement[] = []; let current = -1; let returnFocus: HTMLElement | null = null;
 let observer: MutationObserver | undefined; let timer: ReturnType<typeof setTimeout> | undefined;

 function clear() {
  for (const mark of marks) { const parent = mark.parentNode; if (!parent) continue; mark.replaceWith(document.createTextNode(mark.textContent ?? '')); parent.normalize(); }
  marks = []; current = -1;
 }
 function search(keep = false) {
  observer?.disconnect();
  const previous = current;
  clear();
  const query = input.value.toLowerCase();
  if (query) {
   const walker = document.createTreeWalker(transcript, 4 /* SHOW_TEXT */, { acceptNode: (node: Node) => node.parentElement?.closest('button, summary') ? 2 /* REJECT */ : 1 /* ACCEPT */ });
   const nodes: Text[] = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
   for (const node of nodes) {
    const text = node.data; const lower = text.toLowerCase(); let from = 0; let at = lower.indexOf(query);
    if (at < 0) continue;
    const fragment = document.createDocumentFragment();
    while (at >= 0) {
     fragment.append(text.slice(from, at));
     const mark = document.createElement('mark'); mark.className = 'agent-find-match'; mark.textContent = text.slice(at, at + query.length);
     fragment.append(mark); marks.push(mark);
     from = at + query.length; at = lower.indexOf(query, from);
    }
    fragment.append(text.slice(from)); node.replaceWith(fragment);
   }
  }
  current = marks.length ? (keep && previous >= 0 ? Math.min(previous, marks.length - 1) : 0) : -1;
  show(!keep);
  observer?.observe(transcript, { childList: true, subtree: true, characterData: true });
 }
 function show(scroll: boolean) {
  marks.forEach((m, i) => m.classList.toggle('agent-find-current', i === current));
  count.textContent = !input.value ? '' : marks.length ? `${current + 1}/${marks.length}` : 'Sem resultados';
  bar.classList.toggle('agent-find-empty', !!input.value && !marks.length);
  const mark = marks[current];
  if (mark && scroll) { const details = mark.closest('details'); if (details) details.open = true; mark.scrollIntoView?.({ block: 'center' }); }
 }
 function step(delta: number) { if (!marks.length) return; current = (current + delta + marks.length) % marks.length; show(true); }
 function open() {
  if (!returnFocus || bar.hidden) returnFocus = document.activeElement instanceof HTMLElement && !bar.contains(document.activeElement) ? document.activeElement : null;
  bar.hidden = false;
  // Texto selecionado na conversa vira a busca, como no editor.
  const selected = window.getSelection?.()?.toString() ?? '';
  if (selected && !selected.includes('\n') && transcript.contains(window.getSelection()!.anchorNode)) input.value = selected;
  observer ??= new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => search(true), 120); });
  input.focus(); input.select(); search();
 }
 function close() {
  if (bar.hidden) return;
  observer?.disconnect(); clearTimeout(timer); clear(); bar.hidden = true; count.textContent = '';
  returnFocus?.focus(); returnFocus = null;
 }
 input.addEventListener('input', () => search());
 input.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === 'F3') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
 });
 bar.querySelector<HTMLButtonElement>('.agent-find-prev')!.onclick = () => step(-1);
 bar.querySelector<HTMLButtonElement>('.agent-find-next')!.onclick = () => step(1);
 bar.querySelector<HTMLButtonElement>('.agent-find-close')!.onclick = close;
 return {
  open, close, get visible() { return !bar.hidden; },
  /** A transcrição foi trocada (nova conversa, histórico): refaz a busca se a barra estiver aberta. */
  refresh() { if (!bar.hidden) search(); },
  dispose() { observer?.disconnect(); clearTimeout(timer); bar.remove(); },
 };
}
