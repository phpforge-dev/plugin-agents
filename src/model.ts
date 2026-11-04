/** Itens serializáveis da transcrição: o histórico grava e restaura exatamente esta lista. */
export type Attachment = { kind: 'file' | 'folder' | 'selection' | 'symbol' | 'schema' | 'image' | 'thisFile'; label: string; path?: string };
export type Item =
 | { kind: 'user'; text: string; attachments?: Attachment[] }
 | { kind: 'message'; text: string }
 | { kind: 'thought'; text: string }
 | { kind: 'tool'; id: string; title: string; status: string; toolKind?: string }
 | { kind: 'plan'; entries: { content: string; status: string }[] }
 | { kind: 'note'; text: string }
 | { kind: 'error'; text: string }
 | { kind: 'terminal'; id: string; command: string; cwd: string; status: 'waiting' | 'running' | 'exited' | 'rejected' | 'killed'; output: string; exitCode?: number | null; signal?: string | null; truncated?: boolean };
export type Conversation = { id: string; agent: string; items: Item[] };
export type Summary = { id: string; title: string; agent: string; created: number; updated: number };

export const newId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** Tempo relativo em pt-BR, como a coluna à direita do Chat History ("6 minutes ago"). */
export function relativeTime(then: number, now = Date.now()): string {
 const s = Math.max(0, Math.round((now - then) / 1000));
 if (s < 45) return 'agora';
 const m = Math.round(s / 60); if (m < 60) return m === 1 ? 'há 1 minuto' : `há ${m} minutos`;
 const h = Math.round(m / 60); if (h < 24) return h === 1 ? 'há 1 hora' : `há ${h} horas`;
 const d = Math.round(h / 24); if (d === 1) return 'ontem'; if (d < 30) return `há ${d} dias`;
 return new Date(then).toLocaleDateString('pt-BR');
}

/** Texto da conversa anterior enviado ao agente ao continuar uma conversa restaurada (últimos 40 KB). */
export function transcriptText(items: Item[], limit = 40000): string {
 const lines: string[] = [];
 for (const item of items) {
  if (item.kind === 'user') lines.push(`Usuário: ${item.text}`);
  else if (item.kind === 'message') lines.push(`Agente: ${item.text}`);
  else if (item.kind === 'terminal') lines.push(`Terminal (${item.status}${item.exitCode != null ? `, código ${item.exitCode}` : ''}): ${item.command}`);
 }
 const text = lines.join('\n\n');
 return text.length > limit ? '…' + text.slice(text.length - limit) : text;
}
