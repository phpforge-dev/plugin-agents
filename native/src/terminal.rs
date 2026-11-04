//! Terminal do agente (ACP `terminal/*`, AI-ACP-001): cada comando só roda depois de o usuário aprovar
//! no painel. Diretório confinado ao projeto, saída combinada (stdout+stderr) limitada pelo final, grupo de
//! processos próprio para interromper filhos, e tudo é encerrado ao trocar de sessão ou fechar.
use crate::workspace::{self, err, Res};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{oneshot, watch},
};

const DEFAULT_LIMIT: usize = 1024 * 1024;

#[derive(Default)]
struct Output {
    text: String,
    truncated: bool,
}
pub struct Terminal {
    pid: Option<u32>,
    output: Arc<Mutex<Output>>,
    exit: watch::Receiver<Option<Value>>,
}
/// Comando como o usuário o vê na aprovação: `sh -c` quando o agente manda só a linha de comando.
pub fn display(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        return command.to_string();
    }
    let quote = |a: &String| {
        if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
            a.clone()
        } else {
            format!("'{}'", a.replace('\'', "'\\''"))
        }
    };
    std::iter::once(command.to_string()).chain(args.iter().map(quote)).collect::<Vec<_>>().join(" ")
}
fn push(out: &Mutex<Output>, chunk: &str, limit: usize) {
    if let Ok(mut o) = out.lock() {
        o.text.push_str(chunk);
        if o.text.len() > limit {
            let mut cut = o.text.len() - limit;
            while !o.text.is_char_boundary(cut) {
                cut += 1;
            }
            o.text.drain(..cut);
            o.truncated = true;
        }
    }
}

#[derive(Default)]
pub struct Terminals {
    running: Mutex<HashMap<String, Terminal>>,
    approvals: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}
pub struct Request {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub limit: usize,
}
impl Request {
    /// Valida o pedido ACP: diretório dentro do projeto, variáveis e limite de saída.
    pub fn parse(root: &Path, params: &Value) -> Res<Self> {
        let command = params["command"].as_str().filter(|c| !c.trim().is_empty()).ok_or("Comando vazio")?.to_string();
        if command.len() > 8192 {
            return Err("Comando longo demais".into());
        }
        let args = params["args"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
        let env = params["env"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| Some((v["name"].as_str()?.to_string(), v["value"].as_str().unwrap_or("").to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let cwd = match params["cwd"].as_str() {
            Some(dir) if !dir.is_empty() => workspace::confined(root, dir)?,
            _ => root.to_path_buf(),
        };
        if !cwd.is_dir() {
            return Err("Diretório do terminal inválido".into());
        }
        let limit = params["outputByteLimit"].as_u64().map(|v| v as usize).unwrap_or(DEFAULT_LIMIT).clamp(1024, 16 * DEFAULT_LIMIT);
        Ok(Self { command, args, env, cwd, limit })
    }
}
impl Terminals {
    /// Registra o pedido de aprovação; a resposta vem de `decide`. Cancelado/encerrado = recusado.
    pub fn ask(&self, id: &str) -> Res<oneshot::Receiver<bool>> {
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().map_err(err)?.insert(id.into(), tx);
        Ok(rx)
    }
    pub fn decide(&self, id: &str, allow: bool) -> Res<()> {
        let tx = self.approvals.lock().map_err(err)?.remove(id).ok_or("Pedido expirado")?;
        let _ = tx.send(allow);
        Ok(())
    }
    /// Inicia o processo aprovado. `chunk` recebe a saída conforme chega (para o painel).
    pub fn spawn(&self, id: &str, req: Request, chunk: Arc<dyn Fn(&str) + Send + Sync>, exited: Arc<dyn Fn(&Value) + Send + Sync>) -> Res<()> {
        let mut command = if req.args.is_empty() {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(&req.command);
            c
        } else {
            let mut c = Command::new(&req.command);
            c.args(&req.args);
            c
        };
        command.current_dir(&req.cwd).envs(req.env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|e| format!("Não foi possível executar: {}", e))?;
        let output = Arc::new(Mutex::new(Output::default()));
        let (tx, rx) = watch::channel(None);
        let mut readers = vec![];
        for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
            let output = output.clone();
            let chunk = chunk.clone();
            let limit = req.limit;
            readers.push(tokio::spawn(async move {
                let mut stream = stream;
                let mut buf = [0u8; 8192];
                let mut pending = Vec::new();
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    // Só envia UTF-8 completo; um caractere partido espera o próximo pedaço.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).to_string();
                    pending.drain(..valid);
                    push(&output, &text, limit);
                    chunk(&text);
                }
            }));
        }
        let pid = child.id();
        tokio::spawn(async move {
            let status = child.wait().await;
            for r in readers {
                let _ = r.await;
            }
            let value = match status {
                Ok(s) => {
                    #[cfg(unix)]
                    let signal = std::os::unix::process::ExitStatusExt::signal(&s).map(|n| match n {
                        9 => "SIGKILL".to_string(),
                        15 => "SIGTERM".to_string(),
                        2 => "SIGINT".to_string(),
                        n => format!("SIG{}", n),
                    });
                    #[cfg(not(unix))]
                    let signal: Option<String> = None;
                    json!({"exitCode":s.code(),"signal":signal})
                }
                Err(e) => json!({"exitCode":null,"signal":null,"error":e.to_string()}),
            };
            exited(&value);
            let _ = tx.send(Some(value));
        });
        self.running.lock().map_err(err)?.insert(id.into(), Terminal { pid, output, exit: rx });
        Ok(())
    }
    pub fn output(&self, id: &str) -> Res<Value> {
        let map = self.running.lock().map_err(err)?;
        let t = map.get(id).ok_or("Terminal desconhecido")?;
        let o = t.output.lock().map_err(err)?;
        let exit = t.exit.borrow().clone();
        Ok(json!({"output":o.text,"truncated":o.truncated,"exitStatus":exit}))
    }
    pub async fn wait(&self, id: &str) -> Res<Value> {
        let mut rx = self.running.lock().map_err(err)?.get(id).ok_or("Terminal desconhecido")?.exit.clone();
        loop {
            if let Some(v) = rx.borrow().clone() {
                return Ok(v);
            }
            rx.changed().await.map_err(|_| "Terminal encerrado".to_string())?;
        }
    }
    pub fn kill(&self, id: &str) -> Res<()> {
        let map = self.running.lock().map_err(err)?;
        let t = map.get(id).ok_or("Terminal desconhecido")?;
        if t.exit.borrow().is_none() {
            kill_group(t.pid);
        }
        Ok(())
    }
    pub fn release(&self, id: &str) -> Res<()> {
        if let Some(t) = self.running.lock().map_err(err)?.remove(id) {
            if t.exit.borrow().is_none() {
                kill_group(t.pid);
            }
        }
        Ok(())
    }
    /// Recusa aprovações pendentes e encerra todos os processos (nova sessão, interromper, fechar).
    pub fn stop_all(&self) {
        if let Ok(mut a) = self.approvals.lock() {
            for (_, tx) in a.drain() {
                let _ = tx.send(false);
            }
        }
        if let Ok(mut map) = self.running.lock() {
            for (_, t) in map.drain() {
                if t.exit.borrow().is_none() {
                    kill_group(t.pid);
                }
            }
        }
    }
    pub fn deny_pending(&self) {
        if let Ok(mut a) = self.approvals.lock() {
            for (_, tx) in a.drain() {
                let _ = tx.send(false);
            }
        }
    }
}
fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        std::fs::create_dir(r.join("sub")).unwrap();
        (d, r)
    }
    #[test]
    fn requests_are_confined_and_displayed_as_typed() {
        let (_d, r) = root();
        let req = Request::parse(&r, &json!({"command":"git","args":["log","--oneline","a b"],"cwd":r.join("sub")})).unwrap();
        assert_eq!(req.cwd, r.join("sub"));
        assert_eq!(display(&req.command, &req.args), "git log --oneline 'a b'");
        assert_eq!(display("ls -la | head", &[]), "ls -la | head");
        assert!(Request::parse(&r, &json!({"command":"ls","cwd":"/"})).is_err());
        assert!(Request::parse(&r, &json!({"command":"  "})).is_err());
        assert_eq!(Request::parse(&r, &json!({"command":"ls"})).unwrap().cwd, r);
    }
    #[tokio::test]
    async fn runs_only_after_approval_and_reports_output_and_exit() {
        let (_d, r) = root();
        let t = Terminals::default();
        let rx = t.ask("t1").unwrap();
        t.decide("t1", false).unwrap();
        assert!(!rx.await.unwrap(), "recusado");
        assert!(t.decide("t1", true).is_err(), "decisão só uma vez");
        let seen = Arc::new(Mutex::new(String::new()));
        let s = seen.clone();
        let req = Request::parse(&r, &json!({"command":"printf 'olá\\n'; echo erro >&2; exit 3","env":[{"name":"X","value":"1"}]})).unwrap();
        t.spawn("t2", req, Arc::new(move |c| s.lock().unwrap().push_str(c)), Arc::new(|_| {})).unwrap();
        let exit = t.wait("t2").await.unwrap();
        assert_eq!(exit["exitCode"], 3);
        let out = t.output("t2").unwrap();
        assert!(out["output"].as_str().unwrap().contains("olá\n") && out["output"].as_str().unwrap().contains("erro"));
        assert_eq!(out["exitStatus"]["exitCode"], 3);
        assert!(seen.lock().unwrap().contains("olá"));
        t.release("t2").unwrap();
        assert!(t.output("t2").is_err());
    }
    #[tokio::test]
    async fn kill_stops_the_process_group_and_output_keeps_the_tail() {
        let (_d, r) = root();
        let t = Terminals::default();
        let req = Request::parse(&r, &json!({"command":"sh","args":["-c","sleep 30 & sleep 30"]})).unwrap();
        t.spawn("k", req, Arc::new(|_| {}), Arc::new(|_| {})).unwrap();
        t.kill("k").unwrap();
        let exit = tokio::time::timeout(std::time::Duration::from_secs(5), t.wait("k")).await.unwrap().unwrap();
        assert_eq!(exit["signal"], "SIGKILL");
        let req = Request::parse(&r, &json!({"command":"yes 0123456789 | head -c 5000","outputByteLimit":1024})).unwrap();
        t.spawn("big", req, Arc::new(|_| {}), Arc::new(|_| {})).unwrap();
        t.wait("big").await.unwrap();
        let out = t.output("big").unwrap();
        assert_eq!(out["truncated"], true);
        assert!(out["output"].as_str().unwrap().len() <= 1024);
        let rx = t.ask("p").unwrap();
        t.stop_all();
        assert!(!rx.await.unwrap(), "pendente recusado ao encerrar");
    }
}
