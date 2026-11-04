// API sintética do host nativo com agente falso em memória, usada pelos testes do plugin e pelo harness WebKit do php-ide.
/**
 * API sintética. `script(prompt, blocks, emit, api)` decide o que o agente falso faz em cada pedido;
 * o padrão responde "Resposta a: <texto>". `calls` registra cada operação para asserções.
 */
// Mesma regra do host (native/src/policy.rs): "semelhantes" = tudo menos o último argumento, sem operadores.
const operators = c => /[`;&|<>\n\r]|\$\(|\$\{/.test(c);
export const similar = c => { c = c.trim(); if (operators(c) || /['"\\]/.test(c)) return null; const i = c.lastIndexOf(' '); return i > 0 && c.slice(0, i + 1).trim() ? c.slice(0, i + 1) : null; };
const matches = (r, c) => r.kind === 'exact' ? r.pattern === c : c.startsWith(r.pattern) && c.length > r.pattern.length && !/\s/.test(c.slice(r.pattern.length)) && !operators(c.slice(r.pattern.length));

export function fakeApi({script, histories = new Map(), project = '/project', files = ['src/User.php', 'src/Admin.php', 'README.md'], commands = []} = {}) {
 const calls = []; let emit = () => {}; let permission; let terminals = new Map(); const pending = new Map();
 const policy = {allowAll: false, rules: []};
 const store = () => { if (!histories.has(project)) histories.set(project, new Map()); return histories.get(project); };
 const api = {
  calls, histories, connect(fn) { emit = fn; },
  agents: async () => [{id: 'fake', name: 'Agente de teste', available: true, detail: 'ACP falso'}],
  policy,
  /** Pedido de terminal como o host faz: allowlist/Permitir tudo rodam direto; senão espera a decisão. */
  terminal: async (id, command, cwd = '') => {
   const auto = policy.allowAll ? 'all' : policy.rules.some(r => matches(r, command)) ? 'allowlist' : null;
   if (auto) { emit({type: 'terminal', id, command, cwd, status: 'running', auto}); return true; }
   pending.set(id, command);
   const decision = new Promise(r => terminals.set(id, r));
   emit({type: 'terminal', id, command, cwd, status: 'waiting', similar: similar(command)});
   const allow = await decision; if (!allow) emit({type: 'terminal', id, status: 'rejected'}); else emit({type: 'terminal', id, status: 'running'});
   return allow;
  },
  agentTerminalPolicy: async () => structuredClone(policy),
  agentTerminalPolicySet: async change => {
   calls.push(['agentTerminalPolicySet', change]);
   if (typeof change.allowAll === 'boolean') policy.allowAll = change.allowAll;
   if (change.remove) policy.rules = policy.rules.filter(r => r.kind !== change.remove.kind || r.pattern !== change.remove.pattern);
   return structuredClone(policy);
  },
  agentStart: async id => { calls.push(['agentStart', id]); policy.allowAll = false; emit({type: 'session', agent: id, protocol: 1, modes: [{id: 'default', name: 'Padrão'}], mode: 'default', capabilities: {image: true, embeddedContext: true}}); if (commands.length) emit({type: 'commands', commands}); },
  agentReset: async () => { calls.push(['agentReset']); policy.allowAll = false; emit({type: 'session', agent: 'fake', protocol: 1, modes: [], mode: null, capabilities: {image: true, embeddedContext: true}}); if (commands.length) emit({type: 'commands', commands}); },
  agentPrompt: async (text, context, extras) => {
   calls.push(['agentPrompt', text, context, extras]);
   setTimeout(async () => { if (script) await script(text, extras, emit, api); else { emit({type: 'message', text: `Resposta a: ${text}`}); } emit({type: 'done', stopReason: 'end_turn'}); }, 0);
  },
  agentCancel: async () => { calls.push(['agentCancel']); },
  agentMode: async () => {}, agentKeep: async () => {}, agentDiscard: async () => {},
  agentPermission: async (id, option) => { calls.push(['agentPermission', id, option]); permission?.(option); },
  waitPermission: () => new Promise(r => { permission = r; }),
  agentTerminalDecision: async (id, allow, remember) => {
   calls.push(['agentTerminalDecision', id, allow, ...(remember ? [remember] : [])]);
   const command = pending.get(id); pending.delete(id);
   if (allow && remember && command) { const pattern = remember === 'exact' ? command : similar(command); if (!pattern) throw Error('Este comando só pode ser permitido exatamente como está'); if (!policy.rules.some(r => r.kind === remember && r.pattern === pattern)) policy.rules.push({kind: remember, pattern}); }
   terminals.get(id)?.(allow);
  },
  waitTerminal: id => new Promise(r => terminals.set(id, r)),
  agentTerminalKill: async id => { calls.push(['agentTerminalKill', id]); },
  agentHistory: async () => [...store().values()].map(({items, ...s}) => s).sort((a, b) => b.updated - a.updated),
  agentHistoryLoad: async id => { const c = store().get(id); if (!c) throw Error('Conversa não encontrada no histórico'); return structuredClone(c); },
  agentHistorySave: async c => { calls.push(['agentHistorySave', c.id]); const old = store().get(c.id); const first = c.items.find(i => i.kind === 'user')?.text ?? ''; const now = Date.now() + store().size; const s = {id: c.id, title: old?.renamed ? old.title : first.split('\n')[0].slice(0, 60) || 'Nova conversa', agent: c.agent, created: old?.created ?? now, updated: now, renamed: !!old?.renamed}; store().set(c.id, {...s, items: structuredClone(c.items)}); return s; },
  agentHistoryRename: async (id, title) => { const c = store().get(id); c.title = title.trim(); c.renamed = true; return c; },
  agentHistoryDelete: async id => { calls.push(['agentHistoryDelete', id]); if (id) store().delete(id); else store().clear(); },
  agentMentions: async (kind, query) => { calls.push(['agentMentions', kind, query]); const q = query.toLowerCase(); return kind === 'commit' ? [{hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', short: 'a1b2c3d', subject: 'Add User fixture', author: 'Fixture', when: '2 days ago'}, {hash: 'ffee000011112222333344445555666677778888', short: 'ffee000', subject: 'Initial commit', author: 'Fixture', when: '3 days ago'}].filter(c => !q || c.hash.startsWith(q) || c.subject.toLowerCase().includes(q)) : [{name: 'php-style', path: '.aiassistant/rules/php-style.md'}].filter(r => r.name.includes(q)); },
  listFiles: async () => files,
  read: async path => ({path, text: `<?php // ${path}\n`}),
  searchSymbols: async query => [{name: 'User', kind: 5, containerName: 'Fixture', location: {uri: 'file:///project/src/User.php', range: {start: {line: 4, character: 0}, end: {line: 9, character: 1}}}}, {name: 'UserRepository', kind: 5, containerName: 'Fixture', location: {uri: 'file:///project/src/UserRepository.php', range: {start: {line: 2, character: 0}, end: {line: 3, character: 1}}}}].filter(s => s.name.toLowerCase().includes(query.toLowerCase())),
  workspace: async () => ({root: project}),
 };
 return api;
}

