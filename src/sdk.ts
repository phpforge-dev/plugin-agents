export let sdk:any; export let monaco:any; export let dockWindow:any,resizeToolWindow:any,toolIcon:any,editorFont:any,keymap:any,fileIcon:any;
export const tr=(...args:any[])=>sdk?.tr(...args)??args[0];export const msg=(...args:any[])=>sdk.msg(...args);export const html=(...args:any[])=>sdk.html(...args);export const activeLanguage=(...args:any[])=>sdk.activeLanguage(...args);
export const own=(value:any)=>{if(typeof value==='function')sdk.own(value);return value;};
export const on=(target:any,event:string,fn:any)=>{target.addEventListener(event,fn);own(()=>target.removeEventListener(event,fn));};
export const every=(fn:any,ms:number)=>{const id=setInterval(fn,ms);own(()=>clearInterval(id));return id;};
export function configure(value:any){sdk=value;({monaco,dockWindow,resizeToolWindow,toolIcon,editorFont,keymap,fileIcon}=value);}
