import type {Mention, Suggestion} from './composer';

type Context = { path: string; text: string; selection?: string; selectionRange?: { startLine: number; endLine: number } } | undefined;
type Sources = {
 listFiles(): Promise<string[]>;
 searchSymbols?(query: string): Promise<{ name: string; kind: number; containerName?: string; location: { uri: string; range: { start: { line: number }; end: { line: number } } } }[]>;
 context(): Context;
 recent(): string[];
 database(): DatabaseEntry[];
 root(): string;
 /** `@commit:` e `@rule:` resolvidos pelo host (git log e .aiassistant/rules). */
 list?(kind: 'commit' | 'rule', query: string): Promise<any[]>;
 /** Problemas do arquivo aberto (marcadores do editor), para `@problems`. */
 problems?(): { path: string; text: string; count: number } | undefined;
};
export type DatabaseEntry = { session: { id: string; label: string; driver?: string }; model: { database?: string; schemas: { name: string; tables: { name: string; kind: string; columns: { name: string; type: string; nullable?: boolean }[] }[] }[] } };

const base = (path: string) => path.split('/').pop() ?? path;
const dir = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/** Pontuação simples: prefixo do nome > contém no nome > subsequência no caminho. */
function score(path: string, query: string) {
 if (!query) return 1;
 const q = query.toLowerCase(), name = base(path).toLowerCase(), full = path.toLowerCase();
 if (name.startsWith(q)) return 4; if (name.includes(q)) return 3; if (full.includes(q)) return 2;
 let i = 0; for (const c of full) if (c === q[i]) i++; return i === q.length ? 1 : 0;
}
export const fileItem = (path: string): Suggestion => ({ label: base(path), hint: dir(path), icon: '▤', insert: `@file:${base(path)}`, mention: { kind: 'file', label: base(path), path } });

/** Texto do schema (tabelas e colunas) enviado ao agente; só metadados já carregados pelo plugin Database. */
export function schemaText(entry: DatabaseEntry, schema: string, table?: string) {
 const s = entry.model.schemas.find(x => x.name === schema); if (!s) return '';
 const tables = table ? s.tables.filter(t => t.name === table) : s.tables;
 const lines = [`-- ${entry.session.label}${entry.session.driver ? ` (${entry.session.driver})` : ''} · schema ${schema}`];
 for (const t of tables.slice(0, 400)) lines.push(`${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${schema}.${t.name} (${t.columns.map(c => `${c.name} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}`).join(', ')})`);
 if (tables.length > 400) lines.push(`-- … ${tables.length - 400} tabelas omitidas`);
 return lines.join('\n');
}

/** Schemas e tabelas dos bancos conectados no plugin Database (metadados já carregados, sem credenciais). */
export function schemaSuggestions(entries: DatabaseEntry[], q: string): Suggestion[] {
 const out: Suggestion[] = []; const lower = q.toLowerCase();
 for (const entry of entries) for (const schema of entry.model.schemas) {
  if (!lower || schema.name.toLowerCase().includes(lower)) out.push({ label: schema.name, hint: `schema · ${entry.session.label}`, icon: '⛁', insert: `@dbObject:${schema.name}`, mention: { kind: 'schema', label: schema.name, path: `${entry.session.label}/${schema.name}`, text: schemaText(entry, schema.name) } });
  for (const table of schema.tables) if (!lower || `${schema.name}.${table.name}`.toLowerCase().includes(lower)) out.push({ label: `${schema.name}.${table.name}`, hint: `${table.kind === 'view' ? 'view' : 'tabela'} · ${entry.session.label}`, icon: '▦', insert: `@dbObject:${schema.name}.${table.name}`, mention: { kind: 'schema', label: `${schema.name}.${table.name}`, path: `${entry.session.label}/${schema.name}.${table.name}`, text: schemaText(entry, schema.name, table.name) } });
 }
 return out.slice(0, 50);
}

/**
 * Fontes de `@`: categorias como no popup do PhpStorm (@thisFile, @file:, @folder:, @dbObject:) mais @selection
 * e @symbol: da documentação; sem categoria, também lista arquivos recentes.
 */
export function mentionProvider(sources: Sources) {
 let files: Promise<string[]> | undefined; let stamp = 0;
 const all = () => { if (!files || Date.now() - stamp > 10000) { stamp = Date.now(); files = sources.listFiles().catch(() => []); } return files; };
 const categories: (Suggestion & { available?: () => boolean })[] = [
  { label: '@thisFile', hint: 'Arquivo aberto no editor', insert: '@thisFile', available: () => !!sources.context() },
  { label: '@selection', hint: 'Código selecionado no editor', insert: '@selection', available: () => !!sources.context()?.selection },
  { label: '@file:', hint: 'Adicionar um arquivo ao contexto', insert: '@file:', category: true },
  { label: '@folder:', hint: 'Adicionar uma pasta ao contexto', insert: '@folder:', category: true },
  { label: '@symbol:', hint: 'Adicionar um símbolo (classe, método…)', insert: '@symbol:', category: true },
  { label: '@dbObject:', hint: 'Adicionar um schema ou tabela do banco', insert: '@dbObject:', category: true },
  { label: '@commit:', hint: 'Adicionar um commit', insert: '@commit:', category: true, available: () => !!sources.list },
  { label: '@localChanges', hint: 'Alterações não commitadas', insert: '@localChanges', available: () => !!sources.list },
  { label: '@problems', hint: 'Problemas do arquivo aberto', insert: '@problems', available: () => !!sources.problems?.() },
  { label: '@projectStructure', hint: 'Estrutura da janela Projeto', insert: '@projectStructure', available: () => !!sources.list },
  { label: '@rule:', hint: 'Adicionar uma regra do projeto', insert: '@rule:', category: true, available: () => !!sources.list },
 ];
 return async (query: string, signal: AbortSignal): Promise<Suggestion[]> => {
  const colon = query.indexOf(':');
  if (colon < 0) {
   const q = query.toLowerCase();
   const context = sources.context();
   const head = categories.filter(c => (c.available?.() ?? true) && c.label.slice(1).toLowerCase().startsWith(q)).map(c => {
    const { available: _, ...item } = c;
    if (c.insert === '@thisFile' && context) item.mention = { kind: 'thisFile', label: base(context.path), path: context.path };
    if (c.insert === '@localChanges') item.mention = { kind: 'localChanges', label: 'Alterações locais' };
    if (c.insert === '@projectStructure') item.mention = { kind: 'projectStructure', label: 'Estrutura do projeto' };
    if (c.insert === '@problems') { const p = sources.problems?.(); if (p) item.mention = { kind: 'problems', label: `Problemas: ${base(p.path)} (${p.count})`, path: p.path, text: p.text }; }
    if (c.insert === '@selection' && context?.selection) item.mention = { kind: 'selection', label: `${base(context.path)}${context.selectionRange ? `:${context.selectionRange.startLine}-${context.selectionRange.endLine}` : ''}`, path: context.path, text: context.selection, line: context.selectionRange?.startLine, endLine: context.selectionRange?.endLine };
    return item;
   });
   const recent = [...new Set(sources.recent())].filter(p => score(p, query) > 0).slice(0, 10).map(fileItem);
   return [...head, ...recent];
  }
  const kind = query.slice(0, colon), q = query.slice(colon + 1);
  if (kind === 'file' || kind === 'folder') {
   const paths = await all(); if (signal.aborted) return [];
   const pool = kind === 'file' ? paths : [...new Set(paths.flatMap(p => { const parts = p.split('/').slice(0, -1); return parts.map((_, i) => parts.slice(0, i + 1).join('/')); }))];
   return pool.map(p => [p, score(p, q)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 50)
    .map(([p]) => kind === 'file' ? fileItem(p) : { label: base(p), hint: dir(p), icon: '▸', insert: `@folder:${base(p)}`, mention: { kind: 'folder' as const, label: base(p), path: p } });
  }
  if (kind === 'symbol') {
   if (!q) return [];
   if (!sources.searchSymbols) return [];
   await new Promise(r => setTimeout(r, 150)); if (signal.aborted) return [];
   const root = sources.root().replace(/\/$/, '');
   const found = await sources.searchSymbols(q).catch(() => []); if (signal.aborted) return [];
   return found.slice(0, 50).map(s => {
    const file = decodeURIComponent(s.location.uri.replace(/^file:\/\//, ''));
    const path = file.startsWith(root + '/') ? file.slice(root.length + 1) : file;
    const mention: Mention = { kind: 'symbol', label: s.name, path, line: s.location.range.start.line + 1, endLine: s.location.range.end.line + 1 };
    return { label: s.name, hint: `${s.containerName ? s.containerName + ' · ' : ''}${base(path)}`, icon: 'ⓢ', insert: `@symbol:${s.name}`, mention };
   });
  }
  if (kind === 'dbObject') return schemaSuggestions(sources.database(), q);
  if ((kind === 'commit' || kind === 'rule') && sources.list) {
   const found = await sources.list(kind, q).catch(() => []); if (signal.aborted) return [];
   if (kind === 'rule') return found.map((r: { name: string; path: string }) => ({ label: r.name, hint: r.path, icon: '§', insert: `@rule:${r.name}`, mention: { kind: 'rule' as const, label: r.name, path: r.path } }));
   return found.map((c: { hash: string; short: string; subject: string; author: string; when: string }) => ({ label: `${c.short} ${c.subject}`, hint: `${c.author} · ${c.when}`, icon: '⎇', insert: `@commit:${c.short}`, mention: { kind: 'commit' as const, label: c.short, hash: c.hash, text: c.subject } }));
  }
  return [];
 };
}
