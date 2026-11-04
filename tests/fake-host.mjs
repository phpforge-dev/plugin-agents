// Ambiente sintético para testes da UI: DOM (happy-dom), SDK mínimo e uma API que imita o host nativo
// com um agente falso em memória (sem processo nem inferência). O histórico fica num Map por "projeto".
import {Window} from 'happy-dom';
export {fakeApi} from './fake-api.mjs';

export function dom() {
 const w = new Window({url: 'http://localhost/'});
 for (const key of ['window','document','MutationObserver','ResizeObserver','HTMLElement','HTMLDialogElement','HTMLInputElement','Node','Event','KeyboardEvent','MouseEvent','CustomEvent','ClipboardEvent','DataTransfer','File','FileReader','Blob','localStorage','navigator','CSS','getComputedStyle'])
  if (w[key] !== undefined) Object.defineProperty(globalThis, key, {value: w[key], configurable: true, writable: true});
 globalThis.Option = function (text, value, _d, selected) { const el = document.createElement('option'); el.text = text; el.value = value; if (selected) el.selected = true; return el; };
 globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
 globalThis.confirm = () => true;
 globalThis.CSS ??= {escape: s => String(s).replace(/["\\]/g, '\\$&')};
 document.body.innerHTML = '<section id="agent"></section>';
 return w;
}

export const tick = (n = 3) => new Promise(r => { let i = 0; const step = () => (++i >= n ? r() : setTimeout(step, 0)); setTimeout(step, 0); });

/** Editor Monaco mínimo: modelo com texto, seleção, posição e edições desfazíveis registradas. */
export function fakeEditor(path, text) {
 let value = text; const edits = [];
 const offsetAt = (line, column) => value.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
 const model = {
  uri: {path}, getValue: () => value, setValue: v => { value = v; },
  getLanguageId: () => 'php', getLineCount: () => value.split('\n').length, getLineMaxColumn: l => value.split('\n')[l - 1].length + 1,
  getFullModelRange: () => ({startLineNumber: 1, startColumn: 1, endLineNumber: value.split('\n').length, endColumn: value.split('\n').at(-1).length + 1}),
  getValueInRange: r => value.slice(offsetAt(r.startLineNumber, r.startColumn), offsetAt(r.endLineNumber, r.endColumn)),
  pushEditOperations: (_s, ops) => { for (const op of ops) { const a = offsetAt(op.range.startLineNumber, op.range.startColumn), b = offsetAt(op.range.endLineNumber, op.range.endColumn); value = value.slice(0, a) + op.text + value.slice(b); edits.push(op); } return null; },
  pushStackElement: () => {},
 };
 let selection = {startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty() { return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn; }};
 return {
  model, edits,
  editor: {getModel: () => model, getSelection: () => selection, getPosition: () => ({lineNumber: selection.startLineNumber, column: selection.startColumn}), setSelection: s => { selection = {...s, isEmpty: selection.isEmpty}; }, focus() {}, executeEdits: (_src, ops) => { model.pushEditOperations([], ops); return true; }, pushUndoStop() {}, revealLineInCenter() {}, onDidChangeModel: () => ({dispose() {}})},
 };
}

export function sdk({services = {}, host} = {}) {
 const cleanups = []; let contribution;
 const format = (parts, ...args) => typeof parts === 'string' ? parts : parts.reduce((v, s, i) => v + s + (args[i] ?? ''), '');
 const created = [];
 return {
  cleanups, created, get contribution() { return contribution; },
  own: fn => cleanups.push(fn), provide: (_name, value) => { contribution = value; }, service: name => services[name],
  tr: s => s, msg: format, html: format, activeLanguage: () => 'pt-BR', dockWindow: () => () => {}, resizeToolWindow: () => {}, toolIcon: () => {}, editorFont: {size: 13, family: 'monospace'}, fileIcon: () => '',
  keymap: {registerAction: () => () => {}, onChange: () => () => {}, shortcut: () => '', ariaShortcuts: () => ''},
  host,
  monaco: {editor: {
   createModel: (text, language) => { const m = {text, language, getValue: () => text, dispose() {}}; created.push(m); return m; },
   createDiffEditor: (el, options) => { const d = {el, options, model: undefined, setModel(m) { this.model = m; }, dispose() {}, goToDiff(dir) { d.navigated = dir; }, getLineChanges: () => [{}], layout() {}}; created.push(d); return d; },
  }, Range: class { constructor(a, b, c, d) { Object.assign(this, {startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d}); } }},
 };
}

export const hooks = (context) => ({context: () => context, reload: async () => {}, status: text => { hooks.last = text; }, language: () => 'php'});
