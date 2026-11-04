//! Menções `@` e anexos do pedido viram blocos de conteúdo ACP (AI-ACP-001).
//!
//! Arquivos e pastas são lidos aqui, confinados ao projeto; seleção, símbolo e schema chegam como texto
//! já resolvido pela interface (schema: só metadados que o plugin Database carregou). Imagens só vão para
//! agentes que anunciam `promptCapabilities.image`; recursos embutidos dependem de `embeddedContext`.
use crate::workspace::{self, err, Res};
use serde_json::{json, Value};
use std::path::Path;

const MAX_ATTACHMENTS: usize = 20;
const MAX_TEXT: usize = 1024 * 1024;
const MAX_FOLDER_ENTRIES: usize = 300;

#[derive(Clone, Copy, Default)]
pub struct Capabilities {
    pub image: bool,
    pub embedded: bool,
}
impl Capabilities {
    pub fn from(init: &Value) -> Self {
        let p = &init["agentCapabilities"]["promptCapabilities"];
        Self {
            image: p["image"] == true,
            embedded: p["embeddedContext"] == true,
        }
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Res<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Anexo sem {}", key))
}
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "php" | "phtml" => "text/x-php",
        "js" | "mjs" => "text/javascript",
        "ts" => "text/x-typescript",
        "json" => "application/json",
        "md" => "text/markdown",
        "sql" => "text/x-sql",
        "html" | "twig" => "text/html",
        "css" => "text/css",
        "yaml" | "yml" => "text/yaml",
        "xml" => "application/xml",
        _ => "text/plain",
    }
}
fn uri(root: &Path, path: &str) -> Res<String> {
    let full = workspace::confined(root, path)?;
    url::Url::from_file_path(full)
        .map(|u| u.to_string())
        .map_err(|_| "URI inválida".into())
}
/// Recurso de texto: embutido quando o agente aceita, senão link + texto simples.
fn resource(caps: Capabilities, uri: String, name: &str, mime: &str, text: &str) -> Vec<Value> {
    if caps.embedded {
        vec![json!({"type":"resource","resource":{"uri":uri,"mimeType":mime,"text":text}})]
    } else {
        vec![
            json!({"type":"resource_link","uri":uri,"name":name,"mimeType":mime}),
            json!({"type":"text","text":format!("Conteúdo de {}:\n```\n{}\n```", name, text)}),
        ]
    }
}
fn lines(text: &str, from: usize, to: usize) -> String {
    text.split('\n')
        .skip(from.saturating_sub(1))
        .take(to.saturating_sub(from) + 1)
        .collect::<Vec<_>>()
        .join("\n")
}
/// Blocos ACP e o texto equivalente (para o Codex, que recebe só texto).
pub fn blocks(root: &Path, attachments: &[Value], caps: Capabilities) -> Res<(Vec<Value>, String)> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(format!("Até {} anexos por pedido", MAX_ATTACHMENTS));
    }
    let mut out = vec![];
    let mut text_total = 0usize;
    let mut plain = String::new();
    for a in attachments {
        let kind = s(a, "type")?;
        let mut add_text = |t: &str| -> Res<()> {
            text_total += t.len();
            if text_total > MAX_TEXT {
                return Err("Anexos excedem 1 MB de texto".into());
            }
            Ok(())
        };
        match kind {
            "file" => {
                let path = s(a, "path")?;
                // Buffer do editor (@thisFile, possivelmente não salvo) ou leitura confinada do disco.
                let text = match a["text"].as_str() {
                    Some(t) => {
                        workspace::confined(root, path)?;
                        t.to_string()
                    }
                    None => workspace::read(root, path)?["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                };
                add_text(&text)?;
                out.extend(resource(caps, uri(root, path)?, path, mime(path), &text));
                plain.push_str(&format!("\n<file path=\"{}\">\n{}\n</file>", path, text));
            }
            "folder" => {
                let path = s(a, "path")?;
                let dir = workspace::confined(root, path)?;
                if !dir.is_dir() {
                    return Err(format!("{} não é uma pasta", path));
                }
                let mut entries = vec![];
                let mut stack = vec![dir.clone()];
                while let Some(d) = stack.pop() {
                    let mut items: Vec<_> = std::fs::read_dir(&d).map_err(err)?.filter_map(Result::ok).collect();
                    items.sort_by_key(|e| e.file_name());
                    for e in items {
                        let name = e.file_name().to_string_lossy().to_string();
                        let ft = e.file_type().map_err(err)?;
                        if ft.is_symlink() || [".git", "node_modules", "vendor", ".idea", "target"].contains(&name.as_str()) {
                            continue;
                        }
                        if ft.is_dir() {
                            stack.push(e.path());
                        } else if entries.len() < MAX_FOLDER_ENTRIES {
                            entries.push(e.path().strip_prefix(root).map_err(err)?.to_string_lossy().to_string());
                        }
                    }
                }
                entries.sort();
                let listing = format!("Pasta {} ({} arquivos{}):\n{}", path, entries.len(), if entries.len() >= MAX_FOLDER_ENTRIES { ", lista truncada" } else { "" }, entries.join("\n"));
                add_text(&listing)?;
                out.push(json!({"type":"resource_link","uri":uri(root, path)?,"name":path}));
                out.push(json!({"type":"text","text":listing}));
                plain.push_str(&format!("\n{}", listing));
            }
            "selection" | "symbol" => {
                let path = s(a, "path")?;
                let from = a["line"].as_u64().unwrap_or(1).max(1) as usize;
                let to = (a["endLine"].as_u64().unwrap_or(from as u64) as usize).max(from);
                if to - from > 2000 {
                    return Err("Trecho anexado com mais de 2000 linhas".into());
                }
                let text = if kind == "selection" {
                    s(a, "text")?.to_string()
                } else {
                    lines(workspace::read(root, path)?["text"].as_str().unwrap_or(""), from, to)
                };
                add_text(&text)?;
                let name = if kind == "symbol" { format!("{} ({}:{}-{})", s(a, "name")?, path, from, to) } else { format!("{}:{}-{}", path, from, to) };
                out.extend(resource(caps, format!("{}#L{}-L{}", uri(root, path)?, from, to), &name, mime(path), &text));
                plain.push_str(&format!("\n<snippet source=\"{}\">\n{}\n</snippet>", name, text));
            }
            "schema" => {
                let label = s(a, "label")?;
                let text = s(a, "text")?;
                add_text(text)?;
                let name = format!("Schema de banco {}", label);
                out.extend(resource(caps, format!("php-ide://database/{}", label.replace(' ', "%20")), &name, "text/x-sql", text));
                plain.push_str(&format!("\n<database-schema name=\"{}\">\n{}\n</database-schema>", label, text));
            }
            _ => return Err("Tipo de anexo desconhecido".into()),
        }
    }
    Ok((out, plain))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src/Sub")).unwrap();
        std::fs::write(root.join("src/User.php"), "<?php\nclass User\n{\n    public $a;\n}\n").unwrap();
        std::fs::write(root.join("src/Sub/A.php"), "<?php\n").unwrap();
        (dir, root)
    }
    const EMB: Capabilities = Capabilities { image: true, embedded: true };
    #[test]
    fn files_folders_snippets_schema_and_images_become_acp_blocks() {
        let (_d, root) = project();
        let (blocks, plain) = blocks(
            &root,
            &[
                json!({"type":"file","path":"src/User.php"}),
                json!({"type":"file","path":"src/User.php","text":"<?php // não salvo"}),
                json!({"type":"folder","path":"src"}),
                json!({"type":"symbol","name":"User","path":"src/User.php","line":2,"endLine":5}),
                json!({"type":"selection","path":"src/User.php","text":"public $a;","line":4,"endLine":4}),
                json!({"type":"schema","label":"public.users","text":"TABLE public.users (id bigint)"}),
            ],
            EMB,
        )
        .unwrap();
        assert_eq!(blocks[0]["resource"]["mimeType"], "text/x-php");
        assert!(blocks[0]["resource"]["uri"].as_str().unwrap().ends_with("/src/User.php"));
        assert_eq!(blocks[1]["resource"]["text"], "<?php // não salvo");
        assert_eq!(blocks[2]["type"], "resource_link");
        assert!(blocks[3]["text"].as_str().unwrap().contains("src/Sub/A.php"));
        assert_eq!(blocks[4]["resource"]["text"], "class User\n{\n    public $a;\n}");
        assert!(blocks[4]["resource"]["uri"].as_str().unwrap().ends_with("#L2-L5"));
        assert_eq!(blocks[5]["resource"]["text"], "public $a;");
        assert_eq!(blocks[6]["resource"]["uri"], "php-ide://database/public.users");
        assert!(plain.contains("<database-schema name=\"public.users\">"));
    }
    #[test]
    fn without_embedded_context_text_goes_as_link_plus_text() {
        let (_d, root) = project();
        let (b, _) = blocks(&root, &[json!({"type":"file","path":"src/User.php"})], Capabilities::default()).unwrap();
        assert_eq!(b[0]["type"], "resource_link");
        assert!(b[1]["text"].as_str().unwrap().contains("class User"));
    }
    #[test]
    fn rejects_escapes_and_oversize() {
        let (_d, root) = project();
        assert!(blocks(&root, &[json!({"type":"file","path":"../etc/passwd"})], EMB).is_err());
        assert!(blocks(&root, &[json!({"type":"file","path":"/etc/hosts","text":"x"})], EMB).is_err());
        assert!(blocks(&root, &[json!({"type":"folder","path":"src/User.php"})], EMB).is_err());
        let big = json!({"type":"schema","label":"x","text":"x".repeat(MAX_TEXT + 1)});
        assert!(blocks(&root, &[big], EMB).is_err());
        assert!(blocks(&root, &vec![json!({"type":"schema","label":"x","text":"x"}); 21], EMB).is_err());
    }
}
