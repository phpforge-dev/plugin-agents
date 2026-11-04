//! Política do terminal do agente (AI-ACP-001): por padrão cada comando espera aprovação explícita.
//! O usuário pode, por escolha própria, (1) guardar regras na allowlist do projeto — "este comando"
//! (igual) ou "comandos semelhantes" (mesmo prefixo + um argumento simples, como a regra que o Junie
//! gera) — e (2) ligar "Permitir tudo", que vale só para a sessão atual do agente e nunca é gravado.
//! Comandos com operadores do shell (`;`, `&`, `|`, `` ` ``, `$(`, `>`, `<`, quebra de linha) só passam
//! por regra igual, nunca por semelhança.
use crate::workspace::{err, Res};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

const MAX_RULES: usize = 200;

#[derive(Clone, PartialEq, Debug)]
pub enum Rule {
    Exact(String),
    Similar(String),
}
impl Rule {
    fn to_json(&self) -> Value {
        match self {
            Rule::Exact(c) => json!({"kind":"exact","pattern":c}),
            Rule::Similar(p) => json!({"kind":"similar","pattern":p}),
        }
    }
    fn from_json(v: &Value) -> Option<Self> {
        let p = v["pattern"].as_str()?.to_string();
        match v["kind"].as_str()? {
            "exact" => Some(Rule::Exact(p)),
            "similar" if similar(&format!("{}x", p)).as_deref() == Some(p.as_str()) => Some(Rule::Similar(p)),
            _ => None,
        }
    }
    fn matches(&self, command: &str) -> bool {
        match self {
            Rule::Exact(c) => c == command,
            Rule::Similar(prefix) => command
                .strip_prefix(prefix.as_str())
                .is_some_and(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace) && !operators(rest)),
        }
    }
}

/// Operadores que mudam o que o shell executa.
pub fn operators(command: &str) -> bool {
    command.contains(['`', ';', '&', '|', '>', '<', '\n', '\r']) || command.contains("$(") || command.contains("${")
}

/// Prefixo de "comandos semelhantes": tudo menos o último argumento (precisa de ao menos dois termos).
pub fn similar(command: &str) -> Option<String> {
    let command = command.trim();
    if operators(command) || command.contains(['\'', '"', '\\']) {
        return None;
    }
    let cut = command.rfind(' ')?;
    let prefix = &command[..=cut];
    (!prefix.trim().is_empty()).then(|| prefix.to_string())
}

pub struct Policy {
    file: PathBuf,
    allow_all: AtomicBool,
    rules: Mutex<Vec<Rule>>,
}
impl Policy {
    /// Allowlist em `dir/terminal-allowlist.json` (pasta de estado do projeto, fora do repositório).
    pub fn new(dir: &Path) -> Self {
        let file = dir.join("terminal-allowlist.json");
        let rules = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["rules"].as_array().map(|a| a.iter().filter_map(Rule::from_json).take(MAX_RULES).collect()))
            .unwrap_or_default();
        Self { file, allow_all: AtomicBool::new(false), rules: Mutex::new(rules) }
    }
    pub fn get(&self) -> Value {
        let rules = self.rules.lock().map(|r| r.iter().map(Rule::to_json).collect::<Vec<_>>()).unwrap_or_default();
        json!({"allowAll":self.allow_all.load(Ordering::Acquire),"rules":rules})
    }
    /// Nova sessão do agente: "Permitir tudo" volta a desligado.
    pub fn reset_session(&self) {
        self.allow_all.store(false, Ordering::Release);
    }
    pub fn allow_all(&self) -> bool {
        self.allow_all.load(Ordering::Acquire)
    }
    /// Por que o comando pode rodar sem perguntar (`"all"` ou `"allowlist"`), ou `None`.
    pub fn decide(&self, command: &str) -> Option<&'static str> {
        if self.allow_all() {
            return Some("all");
        }
        let rules = self.rules.lock().ok()?;
        rules.iter().any(|r| r.matches(command)).then_some("allowlist")
    }
    pub fn add(&self, kind: &str, command: &str) -> Res<Rule> {
        let command = command.trim();
        if command.is_empty() || command.len() > 8192 {
            return Err("Comando inválido".into());
        }
        let rule = match kind {
            "exact" => Rule::Exact(command.into()),
            "similar" => Rule::Similar(similar(command).ok_or("Este comando só pode ser permitido exatamente como está")?),
            _ => return Err("Regra inválida".into()),
        };
        let mut rules = self.rules.lock().map_err(err)?;
        if !rules.contains(&rule) {
            if rules.len() >= MAX_RULES {
                return Err(format!("A allowlist aceita até {} regras", MAX_RULES));
            }
            rules.push(rule.clone());
            self.save(&rules)?;
        }
        Ok(rule)
    }
    /// Aplica uma mudança vinda do painel: `{allowAll}`, `{add:{kind,command}}` ou `{remove:{kind,pattern}}`.
    pub fn set(&self, change: &Value) -> Res<Value> {
        if let Some(all) = change["allowAll"].as_bool() {
            self.allow_all.store(all, Ordering::Release);
        }
        if change["add"].is_object() {
            self.add(change["add"]["kind"].as_str().unwrap_or(""), change["add"]["command"].as_str().unwrap_or(""))?;
        }
        if change["remove"].is_object() {
            let target = Rule::from_json(&change["remove"]).ok_or("Regra inválida")?;
            let mut rules = self.rules.lock().map_err(err)?;
            rules.retain(|r| *r != target);
            self.save(&rules)?;
        }
        Ok(self.get())
    }
    fn save(&self, rules: &[Rule]) -> Res<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        let bytes = serde_json::to_vec_pretty(&json!({"rules":rules.iter().map(Rule::to_json).collect::<Vec<_>>()})).map_err(err)?;
        let tmp = self.file.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        fs::write(&tmp, bytes).map_err(err)?;
        fs::rename(&tmp, &self.file).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            err(e)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_by_default_rules_persist_and_allow_all_is_per_session() {
        let d = tempfile::tempdir().unwrap();
        let p = Policy::new(d.path());
        assert_eq!(p.decide("php vendor/bin/phpunit"), None, "padrão: perguntar");
        p.add("exact", "php vendor/bin/phpunit").unwrap();
        assert_eq!(p.decide("php vendor/bin/phpunit"), Some("allowlist"));
        assert_eq!(p.decide("php vendor/bin/phpunit --filter x"), None, "igual é igual");
        p.add("similar", "git log --oneline -2").unwrap();
        assert_eq!(p.get()["rules"][1], json!({"kind":"similar","pattern":"git log --oneline "}));
        assert_eq!(p.decide("git log --oneline -20"), Some("allowlist"));
        assert_eq!(p.decide("git log --oneline -2 --all"), None, "um argumento só");
        assert_eq!(p.decide("git log --oneline x;rm"), None);
        assert_eq!(p.decide("git log --oneline $(rm)"), None);
        assert_eq!(p.decide("git log --oneline a|sh"), None);
        assert_eq!(p.decide("git log --oneline "), None);
        assert!(p.add("similar", "ls").is_err(), "sem argumento: só exato");
        assert!(p.add("similar", "echo a && rm -rf b").is_err());
        assert!(p.add("similar", "echo 'a b'").is_err());
        p.add("exact", "make test && make lint").unwrap();
        assert_eq!(p.decide("make test && make lint"), Some("allowlist"), "regra igual pode conter operadores");
        // Persistida por projeto; "Permitir tudo" nunca.
        p.set(&json!({"allowAll":true})).unwrap();
        assert_eq!(p.decide("rm -rf /tmp/x"), Some("all"));
        let again = Policy::new(d.path());
        assert_eq!(again.get()["allowAll"], false);
        assert_eq!(again.get()["rules"].as_array().unwrap().len(), 3);
        p.reset_session();
        assert_eq!(p.decide("rm -rf /tmp/x"), None);
        let v = p.set(&json!({"remove":{"kind":"exact","pattern":"php vendor/bin/phpunit"}})).unwrap();
        assert_eq!(v["rules"].as_array().unwrap().len(), 2);
        assert_eq!(Policy::new(d.path()).decide("php vendor/bin/phpunit"), None);
        // Arquivo adulterado com regra "semelhante" perigosa é ignorado.
        fs::write(d.path().join("terminal-allowlist.json"), r#"{"rules":[{"kind":"similar","pattern":"sh -c "},{"kind":"similar","pattern":"x; "},{"kind":"bogus","pattern":"a"}]}"#).unwrap();
        assert_eq!(Policy::new(d.path()).get()["rules"], json!([{"kind":"similar","pattern":"sh -c "}]));
    }
}
