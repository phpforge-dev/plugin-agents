import {tr} from './sdk';

export function agentGeneration(api: IdeApi, available: () => boolean, busy: (value: boolean) => void) {
 let pending: {text: string; resolve(value: string): void; reject(error: Error): void} | undefined;
 function fail(reason: string) {
  const request = pending;
  pending = undefined;
  request?.reject(new Error(reason));
 }
 return {
  generate(prompt: string): Promise<string> {
   if (pending || !available()) return Promise.reject(new Error(tr('Conecte um agente livre no painel Agente e revise suas alterações pendentes.')));
   busy(true);
   return new Promise((resolve, reject) => {
    const request = pending = {text: '', resolve, reject};
    void api.agentPrompt(prompt).catch(error => {
     if (pending !== request) return;
     fail(String(error));
     busy(false);
    });
   });
  },
  cancel() { return api.agentCancel(); },
  reset() { fail(tr('A sessão do agente foi encerrada.')); },
  handle(event: AgentEvent) {
   if (!pending) return;
   if (event.type === 'message') pending.text += event.text;
   if (event.type !== 'done') return;
   const request = pending;
   pending = undefined;
   if (event.error || event.stopReason === 'cancelled') request.reject(new Error(event.error || tr('Geração interrompida.')));
   else if (!request.text.trim()) request.reject(new Error(tr('O agente não retornou uma mensagem. Tente novamente.')));
   else request.resolve(request.text.trim());
  },
 };
}
