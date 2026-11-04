/**
 * Onde aplicar um trecho sugerido pelo agente (Apply do AI Chat), sem chamar o modelo de novo:
 * 1. diff unificado (```diff ou linhas @@): aplica cada bloco pelo contexto, ignorando números de linha;
 * 2. arquivo inteiro (começa com <?php, ou com a primeira linha do arquivo): substitui tudo;
 * 3. região: a primeira e a última linha do trecho localizam o bloco (ex.: um método) e ele é trocado,
 *    reindentado como o original;
 * 4. senão: substitui a seleção, ou insere no cursor.
 * O resultado sempre passa pela prévia antes de tocar o editor.
 */
export type Applied = { text: string; mode: 'patch' | 'file' | 'region' | 'selection' | 'insert' };
export type Fence = { lang: string; path?: string; code: string };
export type Segment = { kind: 'text'; text: string } | ({ kind: 'code' } & Fence & { open: boolean });

/** Separa texto e blocos ```lang [caminho]; um bloco ainda aberto (streaming) também vira código. */
export function segments(text: string): Segment[] {
 const out: Segment[] = []; const lines = text.split('\n'); let buffer: string[] = []; let fence: { lang: string; path?: string; marker: string; lines: string[] } | undefined;
 const flush = () => { if (buffer.length) { out.push({ kind: 'text', text: buffer.join('\n') }); buffer = []; } };
 for (const line of lines) {
  if (!fence) {
   const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)(?:[:\s]+(\S+))?\s*$/);
   if (m) { flush(); fence = { marker: m[1], lang: m[2].toLowerCase(), path: m[3], lines: [] }; continue; }
   buffer.push(line);
  } else if (/^\s*([`~])\1{2,}\s*$/.test(line) && line.trim()[0] === fence.marker[0] && line.trim().length >= fence.marker.length) {
   out.push({ kind: 'code', lang: fence.lang, path: fence.path, code: fence.lines.join('\n'), open: false }); fence = undefined;
  } else fence.lines.push(line);
 }
 if (fence) out.push({ kind: 'code', lang: fence.lang, path: fence.path, code: fence.lines.join('\n'), open: true });
 flush();
 return out;
}

/** Caminho do arquivo alvo: info do bloco (```php src/User.php) ou comentário na 1ª/2ª linha. */
export function targetPath(fence: Fence): string | undefined {
 if (fence.path && /[./]/.test(fence.path)) return fence.path.replace(/^\.\//, '');
 const head = fence.code.split('\n').slice(0, 2).join('\n');
 const m = head.match(/(?:\/\/|#|--|\/\*)\s*(?:file|arquivo|path)?:?\s*([\w./-]+\.\w+)/i);
 return m && m[1].includes('/') ? m[1].replace(/^\.\//, '') : undefined;
}

const indent = (line: string) => line.match(/^\s*/)![0];
const norm = (line: string) => line.trim().replace(/\s+/g, ' ');

function patch(original: string, diff: string): string {
 const lines = original.split('\n'); let offset = 0;
 const hunks: { before: string[]; after: string[] }[] = []; let current: { before: string[]; after: string[] } | undefined;
 for (const line of diff.split('\n')) {
  if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
  if (line.startsWith('@@')) { current = { before: [], after: [] }; hunks.push(current); continue; }
  if (!current) { current = { before: [], after: [] }; hunks.push(current); }
  if (line.startsWith('+')) current.after.push(line.slice(1));
  else if (line.startsWith('-')) current.before.push(line.slice(1));
  else if (line.startsWith(' ') || line === '') { const l = line.slice(1); current.before.push(l); current.after.push(l); }
  else if (line.startsWith('\\')) continue;
  else throw new Error('Diff inválido');
 }
 for (const hunk of hunks) {
  while (hunk.before.length && hunk.before.at(-1) === '' && hunk.after.at(-1) === '') { hunk.before.pop(); hunk.after.pop(); }
  if (!hunk.before.length) throw new Error('Diff sem contexto: use Inserir no cursor');
  let at = -1;
  for (let i = offset; i <= lines.length - hunk.before.length && at < 0; i++) if (hunk.before.every((l, k) => norm(lines[i + k]) === norm(l))) at = i;
  if (at < 0) throw new Error('O diff não corresponde ao arquivo atual');
  lines.splice(at, hunk.before.length, ...hunk.after); offset = at + hunk.after.length;
 }
 return lines.join('\n');
}

export function applySnippet(original: string, fence: Fence, selection?: { start: number; end: number }, caret = original.length): Applied {
 const code = fence.code.replace(/\n+$/, '');
 const looksDiff = fence.lang === 'diff' || fence.lang === 'patch' || /^@@ .* @@/m.test(code) && /^[+-]/m.test(code);
 if (looksDiff) return { text: patch(original, code), mode: 'patch' };
 const origLines = original.split('\n'); const snip = code.split('\n');
 const first = snip.find(l => l.trim()); const last = [...snip].reverse().find(l => l.trim());
 const firstOriginal = origLines.find(l => l.trim());
 if (first && (/^\s*<\?php/.test(first) && /^\s*<\?php/.test(original) || firstOriginal && norm(first) === norm(firstOriginal) && snip.length >= origLines.length / 2)) {
  return { text: code + (original.endsWith('\n') ? '\n' : ''), mode: 'file' };
 }
 if (first && last && snip.length > 1) {
  for (let i = 0; i < origLines.length; i++) {
   if (norm(origLines[i]) !== norm(first)) continue;
   const firstSnip = snip.indexOf(first), lastSnip = snip.lastIndexOf(last);
   const sameLevel = indent(last).length - indent(first).length;
   for (let j = i + 1; j < origLines.length; j++) {
    if (norm(origLines[j]) !== norm(last) || indent(origLines[j]).length - indent(origLines[i]).length !== sameLevel) continue;
    // Reindenta o trecho para a coluna do bloco original.
    const from = indent(first), to = indent(origLines[i]);
    const body = snip.slice(firstSnip, lastSnip + 1).map(l => !l.trim() ? '' : l.startsWith(from) ? to + l.slice(from.length) : l);
    return { text: [...origLines.slice(0, i), ...body, ...origLines.slice(j + 1)].join('\n'), mode: 'region' };
   }
  }
 }
 if (selection && selection.end > selection.start) return { text: original.slice(0, selection.start) + code + original.slice(selection.end), mode: 'selection' };
 return { text: original.slice(0, caret) + code + original.slice(caret), mode: 'insert' };
}

/** Menor edição que leva `a` a `b` (prefixo/sufixo comuns): preserva desfazer, cursor e marcações. */
export function minimalEdit(a: string, b: string) {
 let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
 let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
 return { start, end: a.length - end, text: b.slice(start, b.length - end) };
}
