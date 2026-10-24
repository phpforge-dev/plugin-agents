import {configure} from './sdk';
import {mountAgent} from './agent-panel';
export function activate(sdk:any){configure(sdk);sdk.provide('agents',{mount(...args:any[]){const before=new Set(document.querySelectorAll('*'));const result=mountAgent(...args);const added=[...document.querySelectorAll('*')].filter(n=>!before.has(n));sdk.own(()=>{result.dispose?.();for(const n of added)if(n.isConnected)n.remove();});return result;}});}
