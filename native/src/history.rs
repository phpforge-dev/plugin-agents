//! Histórico de conversas do agente, por projeto (AI-ACP-001).
//!
//! Cada projeto tem uma pasta própria no diretório de estado da IDE (fora do projeto, como o
//! histórico do AI Chat, que não entra no repositório): `index.json` com os resumos e um arquivo
//! por conversa. Gravações são atômicas (arquivo temporário + rename) e os tamanhos são limitados.
use crate::workspace::{err, hash, Res};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_CONVERSATIONS: usize = 300;
const MAX_ITEMS: usize = 5000;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_TITLE: usize = 120;

pub struct History {
    dir: PathBuf,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn valid_id(id: &str) -> Res<&str> {
    if (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(id)
    } else {
        Err("Conversa inválida".into())
    }
}

/// Título curto: primeira linha não vazia, sem espaços repetidos, até 60 caracteres.
pub fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let clean = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > 60 {
        format!("{}…", clean.chars().take(59).collect::<String>().trim_end())
    } else if clean.is_empty() {
        "Nova conversa".into()
    } else {
        clean
    }
}

fn clean_title(title: &str) -> Res<String> {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("Informe um nome".into());
    }
    Ok(t.chars().take(MAX_TITLE).collect())
}

fn write_atomic(path: &Path, value: &Value) -> Res<()> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(err)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })
}

impl History {
    /// Pasta de estado deste projeto (também guarda a allowlist do terminal).
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    /// Pasta do projeto `root` dentro de `state` (identificada pelo hash do caminho canônico).
    pub fn new(state: &Path, root: &Path) -> Self {
        let key = hash(root.to_string_lossy().as_bytes());
        Self {
            dir: state.join("agent-history").join(&key[..24]),
        }
    }
    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }
    fn index(&self) -> Vec<Value> {
        fs::read(self.index_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    }
    fn store_index(&self, mut list: Vec<Value>) -> Res<Vec<Value>> {
        list.sort_by_key(|v| std::cmp::Reverse(v["updated"].as_u64().unwrap_or(0)));
        for old in list.split_off(list.len().min(MAX_CONVERSATIONS)) {
            if let Some(id) = old["id"].as_str() {
                let _ = fs::remove_file(self.dir.join(format!("{}.json", id)));
            }
        }
        fs::create_dir_all(&self.dir).map_err(err)?;
        write_atomic(&self.index_path(), &json!(list))?;
        Ok(list)
    }
    /// Resumos (id, título, agente, criação, atualização), mais recentes primeiro.
    pub fn list(&self) -> Value {
        let mut list = self.index();
        list.sort_by_key(|v| std::cmp::Reverse(v["updated"].as_u64().unwrap_or(0)));
        json!(list)
    }
    pub fn load(&self, id: &str) -> Res<Value> {
        let id = valid_id(id)?;
        let bytes = fs::read(self.dir.join(format!("{}.json", id)))
            .map_err(|_| "Conversa não encontrada no histórico".to_string())?;
        serde_json::from_slice(&bytes).map_err(err)
    }
    /// Grava a conversa. O título vem do primeiro pedido, a menos que já exista (renomeado).
    pub fn save(&self, conversation: &Value) -> Res<Value> {
        let id = valid_id(conversation["id"].as_str().ok_or("Conversa inválida")?)?;
        let items = conversation["items"]
            .as_array()
            .ok_or("Itens inválidos")?;
        if items.len() > MAX_ITEMS {
            return Err("Conversa longa demais para o histórico".into());
        }
        let mut list = self.index();
        let existing = list.iter().position(|v| v["id"] == id);
        let first = items
            .iter()
            .find(|i| i["kind"] == "user")
            .and_then(|i| i["text"].as_str())
            .unwrap_or("");
        let title = match existing.and_then(|i| list[i]["title"].as_str()) {
            Some(t) if list[existing.unwrap()]["renamed"] == true => t.to_string(),
            _ => title_from(first),
        };
        let created = existing
            .and_then(|i| list[i]["created"].as_u64())
            .unwrap_or_else(now);
        // Estritamente crescente: a última gravada fica no topo mesmo no mesmo milissegundo.
        let updated = now().max(list.iter().filter_map(|v| v["updated"].as_u64()).max().unwrap_or(0) + 1);
        let summary = json!({"id":id,"title":title,"agent":conversation["agent"].as_str().unwrap_or(""),"created":created,"updated":updated,"renamed":existing.map(|i|list[i]["renamed"]==true).unwrap_or(false)});
        let full = json!({"id":id,"title":title,"agent":summary["agent"],"created":created,"updated":updated,"items":items});
        if serde_json::to_vec(&full).map_err(err)?.len() > MAX_BYTES {
            return Err("Conversa maior que 4 MB não cabe no histórico".into());
        }
        fs::create_dir_all(&self.dir).map_err(err)?;
        write_atomic(&self.dir.join(format!("{}.json", id)), &full)?;
        match existing {
            Some(i) => list[i] = summary.clone(),
            None => list.push(summary.clone()),
        }
        self.store_index(list)?;
        Ok(summary)
    }
    pub fn rename(&self, id: &str, title: &str) -> Res<Value> {
        let id = valid_id(id)?;
        let title = clean_title(title)?;
        let mut list = self.index();
        let entry = list
            .iter_mut()
            .find(|v| v["id"] == id)
            .ok_or("Conversa não encontrada no histórico")?;
        entry["title"] = json!(title);
        entry["renamed"] = json!(true);
        let summary = entry.clone();
        let path = self.dir.join(format!("{}.json", id));
        if let Ok(mut full) = self.load(id) {
            full["title"] = json!(title);
            write_atomic(&path, &full)?;
        }
        self.store_index(list)?;
        Ok(summary)
    }
    /// Exclui uma conversa, ou todas do projeto quando `id` é `None`.
    pub fn delete(&self, id: Option<&str>) -> Res<Value> {
        match id {
            Some(id) => {
                let id = valid_id(id)?;
                let list: Vec<_> = self.index().into_iter().filter(|v| v["id"] != id).collect();
                let _ = fs::remove_file(self.dir.join(format!("{}.json", id)));
                self.store_index(list)?;
            }
            None => {
                if self.dir.exists() {
                    fs::remove_dir_all(&self.dir).map_err(err)?;
                }
            }
        }
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn conv(id: &str, text: &str) -> Value {
        json!({"id":id,"agent":"fake","items":[{"kind":"user","text":text},{"kind":"message","text":"ok"}]})
    }
    #[test]
    fn saves_lists_renames_and_deletes_per_project() {
        let state = tempfile::tempdir().unwrap();
        let a = History::new(state.path(), Path::new("/projects/a"));
        let b = History::new(state.path(), Path::new("/projects/b"));
        let s = a.save(&conv("conv-0001", "  Explique   a classe User\nmais")).unwrap();
        assert_eq!(s["title"], "Explique a classe User");
        std::thread::sleep(std::time::Duration::from_millis(5));
        a.save(&conv("conv-0002", "Segundo")).unwrap();
        assert_eq!(a.list()[0]["id"], "conv-0002");
        assert_eq!(b.list().as_array().unwrap().len(), 0, "histórico é por projeto");
        assert_eq!(a.load("conv-0001").unwrap()["items"][1]["text"], "ok");
        a.rename("conv-0001", " Meu   nome ").unwrap();
        // Renomeado: novas gravações não trocam o título.
        a.save(&conv("conv-0001", "outro texto")).unwrap();
        assert_eq!(a.load("conv-0001").unwrap()["title"], "Meu nome");
        assert_eq!(a.list()[0]["id"], "conv-0001");
        a.delete(Some("conv-0001")).unwrap();
        assert!(a.load("conv-0001").is_err());
        assert_eq!(a.list().as_array().unwrap().len(), 1);
        a.delete(None).unwrap();
        assert_eq!(a.list().as_array().unwrap().len(), 0);
    }
    #[test]
    fn rejects_invalid_ids_titles_and_sizes() {
        let state = tempfile::tempdir().unwrap();
        let h = History::new(state.path(), Path::new("/p"));
        assert!(h.load("../../etc").is_err());
        assert!(h.save(&conv("a/b/c/d/e", "x")).is_err());
        h.save(&conv("conv-0001", "x")).unwrap();
        assert!(h.rename("conv-0001", "   ").is_err());
        let big = "x".repeat(MAX_BYTES);
        assert!(h.save(&conv("conv-0002", &big)).is_err());
        assert_eq!(title_from(&"a".repeat(80)).chars().count(), 60);
        assert_eq!(title_from(""), "Nova conversa");
    }
}
