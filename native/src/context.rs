//! Contexto de projeto para as menções `@commit:`, `@localChanges`, `@projectStructure` e `@rule:`
//! (AI-ACP-001). Tudo é lido aqui, confinado ao projeto: Git roda sem prompt de credencial e sem pager,
//! a estrutura respeita o `.gitignore` quando há repositório, e regras só vêm de `.aiassistant/rules/*.md`.
use crate::workspace::{self, err, Res};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Limite de texto por item de contexto (o pedido inteiro ainda é limitado a 1 MB em `prompt`).
pub const MAX_CONTEXT: usize = 200 * 1024;
const MAX_STRUCTURE_LINES: usize = 1500;
pub const RULES_DIR: &str = ".aiassistant/rules";

fn git(root: &Path, args: &[&str]) -> Res<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off", "--no-pager"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Git indisponível: {}", e))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "Falha no Git".into() } else { msg });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
fn clip(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut cut = limit;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (truncado)");
    }
    text
}
fn hex(q: &str) -> bool {
    (4..=40).contains(&q.len()) && q.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Sugestões para `@commit:` (últimos commits, filtrados por hash ou assunto) e `@rule:`.
pub fn list(root: &Path, kind: &str, query: &str) -> Res<Value> {
    let q = query.trim().to_lowercase();
    match kind {
        "commit" => {
            let log = git(root, &["log", "-n", "200", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar"]).unwrap_or_default();
            let mut items: Vec<Value> = log
                .lines()
                .filter_map(|l| {
                    let p: Vec<&str> = l.split('\u{1f}').collect();
                    (p.len() == 5).then(|| json!({"hash":p[0],"short":p[1],"subject":p[2],"author":p[3],"when":p[4]}))
                })
                .filter(|c| q.is_empty() || c["hash"].as_str().unwrap_or("").starts_with(&q) || c["subject"].as_str().unwrap_or("").to_lowercase().contains(&q))
                .take(50)
                .collect();
            // Hash digitado que não está entre os recentes: resolve direto no repositório.
            if items.is_empty() && hex(&q) {
                if let Ok(line) = git(root, &["log", "-n", "1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar", &format!("{}^{{commit}}", q), "--"]) {
                    let p: Vec<&str> = line.trim().split('\u{1f}').collect();
                    if p.len() == 5 {
                        items.push(json!({"hash":p[0],"short":p[1],"subject":p[2],"author":p[3],"when":p[4]}));
                    }
                }
            }
            Ok(json!(items))
        }
        "rule" => {
            let dir = root.join(RULES_DIR);
            let mut items = vec![];
            if let Ok(read) = std::fs::read_dir(&dir) {
                let mut names: Vec<String> = read
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".md"))
                    .collect();
                names.sort();
                for n in names {
                    let name = n.trim_end_matches(".md").to_string();
                    if q.is_empty() || name.to_lowercase().contains(&q) {
                        items.push(json!({"name":name,"path":format!("{}/{}", RULES_DIR, n)}));
                    }
                }
            }
            Ok(json!(items))
        }
        _ => Err("Tipo de menção desconhecido".into()),
    }
}

/// Commit completo: cabeçalho, estatística e patch, limitado pelo começo.
pub fn commit(root: &Path, hash: &str) -> Res<String> {
    if !hex(hash) {
        return Err("Hash de commit inválido".into());
    }
    let text = git(root, &["show", "--stat", "--patch", "--no-color", "--no-ext-diff", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", &format!("{}^{{commit}}", hash), "--"])?;
    Ok(clip(text, MAX_CONTEXT))
}

/// Alterações não commitadas: status, diff contra HEAD (ou índice, sem commits) e arquivos novos.
pub fn local_changes(root: &Path) -> Res<String> {
    let status = git(root, &["status", "--porcelain=v1", "--untracked-files=all"])?;
    if status.trim().is_empty() {
        return Ok("Nenhuma alteração local (árvore de trabalho limpa).".into());
    }
    let diff = git(root, &["diff", "HEAD", "--no-color", "--no-ext-diff"])
        .or_else(|_| Ok::<_, String>(git(root, &["diff", "--cached", "--no-color", "--no-ext-diff"])? + &git(root, &["diff", "--no-color", "--no-ext-diff"])?))?;
    let mut text = format!("git status:\n{}\n{}", status, diff);
    for line in status.lines().filter(|l| l.starts_with("?? ")) {
        let path = line[3..].trim();
        if text.len() > MAX_CONTEXT {
            break;
        }
        if let Ok(file) = workspace::read(root, path) {
            if let Some(content) = file["text"].as_str() {
                text.push_str(&format!("\nArquivo novo (não rastreado) {}:\n{}\n", path, content));
            }
        }
    }
    Ok(clip(text, MAX_CONTEXT))
}

/// Árvore do projeto como na janela Project: pastas antes de arquivos, ignorados pelo Git ficam de fora.
pub fn structure(root: &Path) -> Res<String> {
    let mut paths: BTreeSet<String> = BTreeSet::new();
    match git(root, &["ls-files", "--cached", "--others", "--exclude-standard"]) {
        Ok(out) => paths.extend(out.lines().filter(|l| !l.is_empty()).map(String::from)),
        Err(_) => {
            let mut stack = vec![root.to_path_buf()];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).map_err(err)?.filter_map(Result::ok) {
                    let name = e.file_name().to_string_lossy().to_string();
                    let ft = e.file_type().map_err(err)?;
                    if ft.is_symlink() || [".git", "node_modules", "vendor", ".idea", "target"].contains(&name.as_str()) {
                        continue;
                    }
                    if ft.is_dir() {
                        stack.push(e.path());
                    } else if paths.len() < 20000 {
                        paths.insert(e.path().strip_prefix(root).map_err(err)?.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut lines = vec![format!("{}/ ({} arquivos)", name, paths.len())];
    render(&paths.iter().map(PathBuf::from).collect::<Vec<_>>(), Path::new(""), 1, &mut lines);
    if lines.len() > MAX_STRUCTURE_LINES {
        let more = lines.len() - MAX_STRUCTURE_LINES;
        lines.truncate(MAX_STRUCTURE_LINES);
        lines.push(format!("… {} entradas omitidas", more));
    }
    Ok(clip(lines.join("\n"), MAX_CONTEXT))
}
fn render(paths: &[PathBuf], dir: &Path, depth: usize, out: &mut Vec<String>) {
    if out.len() > MAX_STRUCTURE_LINES {
        return;
    }
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    let mut files = vec![];
    for p in paths {
        let Ok(rest) = p.strip_prefix(dir) else { continue };
        let mut parts = rest.components();
        let Some(first) = parts.next() else { continue };
        let first = first.as_os_str().to_string_lossy().to_string();
        if parts.next().is_some() {
            dirs.insert(first);
        } else {
            files.push(first);
        }
    }
    let indent = "  ".repeat(depth);
    for d in dirs {
        out.push(format!("{}{}/", indent, d));
        render(paths, &dir.join(&d), depth + 1, out);
    }
    files.sort();
    for f in files {
        out.push(format!("{}{}", indent, f));
    }
}

/// Regra do projeto: só arquivos `.md` de `.aiassistant/rules/`, lidos com confinamento.
pub fn rule(root: &Path, path: &str) -> Res<String> {
    let p = Path::new(path);
    if !path.starts_with(&format!("{}/", RULES_DIR)) || p.extension().and_then(|e| e.to_str()) != Some("md") || p.components().count() != 3 {
        return Err("Regra fora de .aiassistant/rules".into());
    }
    let text = workspace::read(root, path)?["text"].as_str().unwrap_or("").to_string();
    Ok(clip(text, MAX_CONTEXT))
}

/// Preenche o texto das menções resolvidas pelo host antes de virarem blocos ACP.
pub fn resolve(root: &Path, attachments: &[Value]) -> Res<Vec<Value>> {
    attachments
        .iter()
        .map(|a| {
            let mut a = a.clone();
            let text = match a["type"].as_str().unwrap_or("") {
                "commit" => Some(commit(root, a["hash"].as_str().ok_or("Anexo sem hash")?)?),
                "localChanges" => Some(local_changes(root)?),
                "projectStructure" => Some(structure(root)?),
                "rule" => Some(rule(root, a["path"].as_str().ok_or("Anexo sem path")?)?),
                _ => None,
            };
            if let Some(t) = text {
                a["text"] = json!(t);
            }
            Ok(a)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&r).args(args).env("GIT_AUTHOR_NAME", "Fixture").env("GIT_AUTHOR_EMAIL", "f@x.test").env("GIT_COMMITTER_NAME", "Fixture").env("GIT_COMMITTER_EMAIL", "f@x.test").output().unwrap().status.success());
        run(&["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::create_dir_all(r.join(RULES_DIR)).unwrap();
        std::fs::write(r.join("src/User.php"), "<?php\nclass User {}\n").unwrap();
        std::fs::write(r.join(".gitignore"), "cache/\n").unwrap();
        std::fs::write(r.join(format!("{}/php-style.md", RULES_DIR)), "Use strict_types.\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "Add User fixture"]);
        std::fs::write(r.join("src/User.php"), "<?php\nclass User { public $name; }\n").unwrap();
        std::fs::write(r.join("src/New.php"), "<?php // new\n").unwrap();
        std::fs::create_dir_all(r.join("cache")).unwrap();
        std::fs::write(r.join("cache/x"), "ignored").unwrap();
        (d, r)
    }
    #[test]
    fn commits_local_changes_structure_and_rules() {
        let (_d, r) = repo();
        let commits = list(&r, "commit", "add user").unwrap();
        assert_eq!(commits[0]["subject"], "Add User fixture");
        let hash = commits[0]["hash"].as_str().unwrap();
        assert_eq!(list(&r, "commit", &hash[..7]).unwrap()[0]["hash"], hash);
        let shown = commit(&r, &hash[..7]).unwrap();
        assert!(shown.contains("Add User fixture") && shown.contains("+class User {}"));
        assert!(commit(&r, "HEAD; rm -rf /").is_err());
        assert!(commit(&r, "--output=/tmp/x").is_err());
        let local = local_changes(&r).unwrap();
        assert!(local.contains("+class User { public $name; }"), "{}", local);
        assert!(local.contains("Arquivo novo (não rastreado) src/New.php"));
        let tree = structure(&r).unwrap();
        assert!(tree.contains("  src/\n    New.php\n    User.php"), "{}", tree);
        assert!(!tree.contains("cache"), "ignorado pelo Git");
        assert_eq!(list(&r, "rule", "").unwrap()[0], json!({"name":"php-style","path":".aiassistant/rules/php-style.md"}));
        assert_eq!(rule(&r, ".aiassistant/rules/php-style.md").unwrap(), "Use strict_types.\n");
        assert!(rule(&r, "src/User.php").is_err());
        assert!(rule(&r, ".aiassistant/rules/../../src/User.php").is_err());
        let resolved = resolve(&r, &[json!({"type":"localChanges","text":"forjado"}), json!({"type":"file","path":"src/User.php"})]).unwrap();
        assert_ne!(resolved[0]["text"], "forjado");
        assert!(resolved[1]["text"].is_null());
    }
    #[test]
    fn outside_a_repository_structure_still_works_and_git_errors_are_reported() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(r.join("app")).unwrap();
        std::fs::write(r.join("app/a.php"), "").unwrap();
        assert!(structure(&r).unwrap().contains("  app/\n    a.php"));
        assert!(local_changes(&r).is_err());
        assert_eq!(list(&r, "commit", "").unwrap(), json!([]));
        assert_eq!(list(&r, "rule", "").unwrap(), json!([]));
    }
}
