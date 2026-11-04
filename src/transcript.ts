import type {Item} from './model';

export type Renderers = {
 /** Corpo de uma mensagem do agente (texto com blocos de código e suas ações). */
 message?(el: HTMLElement, text: string): void;
 /** Bloco do terminal do agente (aprovação, saída, interromper). */
 terminal?(el: HTMLElement, item: Extract<Item, {kind: 'terminal'}>): void;
};
const statusLabel: Record<string, string> = { pending: 'pendente', in_progress: 'em andamento', completed: 'concluído', failed: 'falhou' };

/** Transcrição: lista de itens serializáveis + seus elementos; atualizações de streaming alteram o último item. */
export class Transcript {
 items: Item[] = [];
 private els: HTMLElement[] = [];
 /** Mensagem/raciocínio em andamento (um novo bloco começa após ferramentas, plano etc.). */
 private open?: 'message' | 'thought';
 constructor(readonly root: HTMLElement, readonly renderers: Renderers = {}) {}
 clear() { this.items = []; this.els = []; this.open = undefined; this.root.replaceChildren(); }
 load(items: Item[]) { this.clear(); for (const item of items) this.add(item); this.open = undefined; }
 add(item: Item) {
  if (item.kind !== 'message' && item.kind !== 'thought') this.open = undefined;
  const el = this.create(item); this.items.push(item); this.els.push(el); this.root.append(el); this.scroll(); return el;
 }
 /** Acrescenta texto à mensagem ou ao raciocínio em andamento. */
 append(kind: 'message' | 'thought', text: string) {
  const last = this.items[this.items.length - 1];
  if (this.open === kind && last?.kind === kind) { last.text += text; this.update(this.items.length - 1); return; }
  this.add({ kind, text } as Item); this.open = kind;
 }
 endStream() { this.open = undefined; }
 tool(id: string, patch: { title?: string; status?: string; toolKind?: string }) {
  const index = this.items.findIndex(i => i.kind === 'tool' && i.id === id);
  if (index < 0) { this.add({ kind: 'tool', id, title: patch.title ?? 'Ferramenta', status: patch.status ?? 'pending', toolKind: patch.toolKind }); return; }
  const item = this.items[index] as Extract<Item, {kind: 'tool'}>;
  if (patch.title) item.title = patch.title; if (patch.status) item.status = patch.status; if (patch.toolKind) item.toolKind = patch.toolKind;
  this.update(index); this.open = undefined;
 }
 /** Atualizações seguidas do plano substituem o bloco anterior em vez de repeti-lo. */
 plan(entries: { content: string; status: string }[]) {
  const last = this.items[this.items.length - 1];
  if (last?.kind === 'plan') { last.entries = entries; this.update(this.items.length - 1); return; }
  this.add({ kind: 'plan', entries });
 }
 terminal(id: string, patch: Partial<Extract<Item, {kind: 'terminal'}>>) {
  const index = this.items.findIndex(i => i.kind === 'terminal' && i.id === id);
  if (index < 0) return;
  Object.assign(this.items[index], patch); this.update(index);
 }
 /** Saída do terminal chega em pedaços: atualiza só o texto, mantendo o bloco (e a rolagem do usuário). */
 terminalOutput(id: string, text: string, limit = 200000) {
  const index = this.items.findIndex(i => i.kind === 'terminal' && i.id === id); if (index < 0) return;
  const item = this.items[index] as Extract<Item, {kind: 'terminal'}>;
  item.output += text; if (item.output.length > limit) { item.output = item.output.slice(item.output.length - limit); item.truncated = true; }
  const pre = this.els[index].querySelector<HTMLElement>('.agent-terminal-output');
  if (!pre) { this.update(index); return; }
  const follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = item.output; if (follow) pre.scrollTop = pre.scrollHeight;
  this.scroll();
 }
 element(item: Item) { return this.els[this.items.indexOf(item)]; }
 private update(index: number) { const el = this.create(this.items[index]); this.els[index].replaceWith(el); this.els[index] = el; this.scroll(); }
 private scroll() { this.root.scrollTop = this.root.scrollHeight; }
 private create(item: Item): HTMLElement {
  const block = (cls: string, text = '') => { const el = document.createElement('div'); el.className = `agent-block ${cls}`; el.textContent = text; return el; };
  switch (item.kind) {
   case 'user': {
    const el = block('agent-user'); const text = document.createElement('div'); text.className = 'agent-user-text'; text.textContent = item.text; el.append(text);
    if (item.attachments?.length) { const list = document.createElement('div'); list.className = 'agent-sent-attachments'; for (const a of item.attachments) { const chip = document.createElement('span'); chip.className = 'agent-chip'; chip.dataset.kind = a.kind; chip.textContent = a.label; chip.title = a.path ?? a.label; list.append(chip); } el.append(list); }
    return el;
   }
   case 'message': { const el = block('agent-message'); if (this.renderers.message) this.renderers.message(el, item.text); else el.textContent = item.text; return el; }
   case 'thought': { const el = document.createElement('details'); el.className = 'agent-block agent-thought'; const s = document.createElement('summary'); s.textContent = 'Raciocínio'; const d = document.createElement('div'); d.textContent = item.text; el.append(s, d); return el; }
   case 'tool': { const el = block('agent-tool', `${item.title} · ${statusLabel[item.status] ?? item.status}`); el.dataset.id = item.id; el.dataset.status = item.status; if (item.toolKind) el.dataset.kind = item.toolKind; return el; }
   case 'plan': { const el = block('agent-plan'); el.replaceChildren(...item.entries.map(e => { const li = document.createElement('div'); li.dataset.status = e.status; li.textContent = `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '▸' : '○'} ${e.content}`; return li; })); return el; }
   case 'note': return block('agent-note', item.text);
   case 'error': return block('agent-error', item.text);
   case 'terminal': { const el = block('agent-terminal'); el.dataset.id = item.id; el.dataset.status = item.status; if (this.renderers.terminal) this.renderers.terminal(el, item); else el.textContent = `$ ${item.command}\n${item.output}`; return el; }
  }
 }
}
