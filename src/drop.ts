import type {Mention} from './composer';

const TEXT_LIMIT = 1024 * 1024;
const FOLDER_LIMIT = 300;
const SKIP = new Set(['.git', 'node_modules', 'vendor', '.idea', 'target']);
const base = (path: string) => path.split('/').pop() ?? path;

type Sources = {
 /** Caminhos do projeto (para reconhecer um arquivo do projeto arrastado do Finder). */
 listFiles(): Promise<string[]>;
 read(path: string): Promise<{ text: string }>;
 image(file: File): void;
 attach(m: Mention): void;
 status(text: string): void;
};

/** Lista os arquivos de uma pasta arrastada (API de entradas do WebKit), até 300. */
async function listing(entry: any): Promise<string[]> {
 const out: string[] = []; const stack: any[] = [entry];
 while (stack.length && out.length < FOLDER_LIMIT) {
  const dir = stack.pop(); const reader = dir.createReader();
  for (;;) {
   const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
   if (!batch.length) break;
   for (const e of batch.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory) stack.push(e); else if (out.length < FOLDER_LIMIT) out.push(e.fullPath.replace(/^\//, ''));
   }
  }
 }
 return out.sort();
}

/**
 * Arquivos e pastas arrastados do sistema para o chat (AI Chat: "drag and drop a file or folder
 * directly into the chat"). Imagens viram anexo de imagem; um arquivo idêntico a um do projeto vira
 * `@file` (o host relê do disco, confinado); outros textos vão com o conteúdo arrastado (até 1 MB);
 * pastas vão como lista de arquivos. Binários são recusados com aviso.
 */
export async function dropFiles(transfer: DataTransfer, sources: Sources) {
 const items = [...(transfer.items ?? [])].filter(i => i.kind === 'file').map(i => ({ file: i.getAsFile(), entry: (i as any).webkitGetAsEntry?.() }));
 if (!items.length) for (const file of [...(transfer.files ?? [])]) items.push({ file, entry: null });
 let project: Promise<string[]> | undefined;
 for (const { file, entry } of items) {
  try {
   if (entry?.isDirectory) {
    const files = await listing(entry);
    sources.attach({ kind: 'dropped', label: `${entry.name}/`, text: `Pasta ${entry.name} (${files.length} arquivos${files.length >= FOLDER_LIMIT ? ', lista truncada' : ''}):\n${files.join('\n')}` });
    continue;
   }
   if (!file) continue;
   if (file.type.startsWith('image/')) { sources.image(file); continue; }
   if (file.size > TEXT_LIMIT) { sources.status(`${file.name}: acima de 1 MB`); continue; }
   const text = await file.text();
   if (text.includes('\u0000')) { sources.status(`${file.name}: arquivo binário não pode ser anexado`); continue; }
   project ??= sources.listFiles().catch(() => []);
   const same = (await project).filter(p => base(p) === file.name).slice(0, 5);
   let path: string | undefined;
   for (const candidate of same) { const r = await sources.read(candidate).catch(() => undefined); if (r?.text === text) { path = candidate; break; } }
   sources.attach(path ? { kind: 'file', label: file.name, path } : { kind: 'dropped', label: file.name, text });
  } catch (error) { sources.status(`${file?.name ?? entry?.name ?? 'Arquivo'}: ${String((error as Error).message ?? error)}`); }
 }
}
