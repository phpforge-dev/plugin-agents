// API sintética do host nativo com agente falso em memória, usada pelos testes do plugin e pelo harness WebKit do php-ide.
/**
 * API sintética. `script(prompt, blocks, emit, api)` decide o que o agente falso faz em cada pedido;
 * o padrão responde "Resposta a: <texto>". `calls` registra cada operação para asserções.
 */
export function fakeApi({script, histories = new Map(), project = '/project', files = ['src/User.php', 'src/Admin.php', 'README.md'], commands = []} = {}) {
 const calls = []; let emit = () => {}; let permission; let terminals = new Map();
 const store = () => { if (!histories.has(project)) histories.set(project, new Map()); return histories.get(project); };
 const api = {
  calls, histories, connect(fn) { emit = fn; },
  agents: async () => [{id: 'fake', name: 'Agente de teste', available: true, detail: 'ACP falso'}],
  agentStart: async id => { calls.push(['agentStart', id]); emit({type: 'session', agent: id, protocol: 1, modes: [{id: 'default', name: 'Padrão'}], mode: 'default', capabilities: {image: true, embeddedContext: true}}); if (commands.length) emit({type: 'commands', commands}); },
  agentReset: async () => { calls.push(['agentReset']); emit({type: 'session', agent: 'fake', protocol: 1, modes: [], mode: null, capabilities: {image: true, embeddedContext: true}}); if (commands.length) emit({type: 'commands', commands}); },
  agentPrompt: async (text, context, extras) => {
   calls.push(['agentPrompt', text, context, extras]);
   setTimeout(async () => { if (script) await script(text, extras, emit, api); else { emit({type: 'message', text: `Resposta a: ${text}`}); } emit({type: 'done', stopReason: 'end_turn'}); }, 0);
  },
  agentCancel: async () => { calls.push(['agentCancel']); },
  agentMode: async () => {}, agentKeep: async () => {}, agentDiscard: async () => {},
  agentPermission: async (id, option) => { calls.push(['agentPermission', id, option]); permission?.(option); },
  waitPermission: () => new Promise(r => { permission = r; }),
  agentTerminalDecision: async (id, allow) => { calls.push(['agentTerminalDecision', id, allow]); terminals.get(id)?.(allow); },
  waitTerminal: id => new Promise(r => terminals.set(id, r)),
  agentTerminalKill: async id => { calls.push(['agentTerminalKill', id]); },
  agentHistory: async () => [...store().values()].map(({items, ...s}) => s).sort((a, b) => b.updated - a.updated),
  agentHistoryLoad: async id => { const c = store().get(id); if (!c) throw Error('Conversa não encontrada no histórico'); return structuredClone(c); },
  agentHistorySave: async c => { calls.push(['agentHistorySave', c.id]); const old = store().get(c.id); const first = c.items.find(i => i.kind === 'user')?.text ?? ''; const now = Date.now() + store().size; const s = {id: c.id, title: old?.renamed ? old.title : first.split('\n')[0].slice(0, 60) || 'Nova conversa', agent: c.agent, created: old?.created ?? now, updated: now, renamed: !!old?.renamed}; store().set(c.id, {...s, items: structuredClone(c.items)}); return s; },
  agentHistoryRename: async (id, title) => { const c = store().get(id); c.title = title.trim(); c.renamed = true; return c; },
  agentHistoryDelete: async id => { calls.push(['agentHistoryDelete', id]); if (id) store().delete(id); else store().clear(); },
  listFiles: async () => files,
  read: async path => ({path, text: `<?php // ${path}\n`}),
  searchSymbols: async query => [{name: 'User', kind: 5, containerName: 'Fixture', location: {uri: 'file:///project/src/User.php', range: {start: {line: 4, character: 0}, end: {line: 9, character: 1}}}}, {name: 'UserRepository', kind: 5, containerName: 'Fixture', location: {uri: 'file:///project/src/UserRepository.php', range: {start: {line: 2, character: 0}, end: {line: 3, character: 1}}}}].filter(s => s.name.toLowerCase().includes(query.toLowerCase())),
  workspace: async () => ({root: project}),
 };
 return api;
}

