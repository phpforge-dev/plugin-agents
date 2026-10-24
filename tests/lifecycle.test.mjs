import {test} from 'node:test';import assert from 'node:assert/strict';import {Window} from 'happy-dom';
import {activate} from '../workbench.js';
test('mounts existing workflow and removes owned UI on disable',async()=>{
 const w=new Window();for(const key of ['window','document','MutationObserver','ResizeObserver','HTMLElement','HTMLDialogElement','Option','localStorage','navigator'])Object.defineProperty(globalThis,key,{value:w[key],configurable:true,writable:true});
 globalThis.Option=function(text,value){const el=document.createElement('option');el.text=text;el.value=value;return el;};globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
 document.body.innerHTML='<main><aside><div id="project"></div></aside><section class="code"><div id="editor"></div></section><div class="left-rail"></div><section id="agent"></section></main><button id="open"></button>';
 const cleanups=[];let contribution;const format=(parts,...args)=>typeof parts==='string'?parts:parts.reduce((v,s,i)=>v+s+(args[i]??''),'');let disposed=0;
 const sdk={own:fn=>cleanups.push(fn),provide:(name,value)=>contribution=value,tr:s=>s,msg:format,html:format,activeLanguage:()=> 'en',dockWindow:()=>()=>{},resizeToolWindow:()=>{},toolIcon:()=>{},editorFont:{size:13,family:'monospace'},fileIcon:()=>'',keymap:{registerAction:()=>()=>{},onChange:()=>()=>{},shortcut:()=>'',ariaShortcuts:()=>''},monaco:{editor:{createDiffEditor:()=>({dispose:()=>disposed++,setModel:()=>{}})}}};
 activate(sdk);const api=new Proxy({agents:async()=>[],onDockerProgress:()=>()=>{},onTerminalEvent:()=>()=>{}},{get:(obj,key)=>obj[key]??(async()=>{throw Error('unexpected operation '+String(key));})});
 const before=document.querySelectorAll('*').length;
 const args='agents'==='agents'?[api,document.getElementById('agent'),{context:()=>undefined,reload:async()=>{},status:()=>{},language:()=>undefined}]:'agents'==='git'?[api,()=>false,async()=>{}]:'agents'==='docker-services'?[api,{docker:async()=>{}}]:[api];
 const controller=contribution.mount(...args);await Promise.resolve();assert.ok(document.querySelectorAll('*').length>before);assert.equal(typeof controller.reset,'function');
 for(const fn of cleanups.reverse())fn();assert.equal(document.querySelectorAll('#git-panel,#docker-panel,#terminal-panel,#agent-transcript').length,0);if('agents'==='git')assert.equal(disposed,1);w.happyDOM.abort();
});
