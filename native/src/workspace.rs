use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
pub type Res<T> = Result<T, String>;
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn confined(root: &Path, input: &str) -> Res<PathBuf> {
    let path = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };
    let path = path.canonicalize().map_err(err)?;
    if !path.starts_with(root) {
        return Err("Arquivo fora do projeto".into());
    }
    Ok(path)
}
/// Caminhos do watcher que viram `project-changed`: ignora metadados/dependências e o
/// arquivo temporário do salvamento atômico (`save`), cujo rename já notifica o destino.
pub fn watched(path: &Path) -> bool {
    !path.components().any(|c| {
        [".git", "node_modules", "target", ".tools"]
            .iter()
            .any(|n| c.as_os_str() == *n)
    }) && !path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with(".php-ide-"))
}
pub fn text(bytes: Vec<u8>) -> Res<String> {
    if bytes.len() > 2 * 1024 * 1024 || bytes.contains(&0) {
        return Err("Abra texto UTF-8 de até 2 MB".into());
    }
    String::from_utf8(bytes).map_err(err)
}
pub fn read(root: &Path, input: &str) -> Res<Value> {
    let path = confined(root, input)?;
    let meta = fs::metadata(&path).map_err(err)?;
    if !meta.is_file() || meta.len() > 2097152 {
        return Err("Abra texto UTF-8 de até 2 MB".into());
    }
    let value = text(fs::read(&path).map_err(err)?)?;
    Ok(
        json!({"path":path.strip_prefix(root).map_err(err)?.to_string_lossy(),"uri":url::Url::from_file_path(&path).map_err(|_|"URI inválida")?.as_str(),"etag":hash(&value),"text":value}),
    )
}
fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() {
                T[(n >> shift & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}
/// Imagem do projeto como data URI para as prévias de imagem e Markdown (a CSP só permite `self` e `data:`).
pub fn image(root: &Path, input: &str) -> Res<Value> {
    let path = confined(root, input)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return Err("Formato de imagem não suportado na prévia".into()),
    };
    let meta = fs::metadata(&path).map_err(err)?;
    if !meta.is_file() || meta.len() > 5 * 1024 * 1024 {
        return Err("Imagem acima de 5 MB não é exibida na prévia".into());
    }
    let bytes = fs::read(&path).map_err(err)?;
    Ok(json!(format!("data:{};base64,{}", mime, base64(&bytes))))
}
pub fn tree(root: &Path, input: &str) -> Res<Value> {
    let path = confined(root, input)?;
    let mut entries = vec![];
    for item in fs::read_dir(path).map_err(err)? {
        let item = item.map_err(err)?;
        let kind = item.file_type().map_err(err)?;
        let name = item.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() || [".git", ".tools", ".php-ide"].contains(&name.as_str()) {
            continue;
        }
        entries.push(json!({"name":name,"path":item.path().strip_prefix(root).map_err(err)?.to_string_lossy(),"directory":kind.is_dir()}));
    }
    entries.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    entries.truncate(2000);
    Ok(json!(entries))
}
pub fn save(root: &Path, input: &str, value: &str, etag: &str) -> Res<Value> {
    if value.len() > 2097152 || value.contains('\0') {
        return Err("Texto inválido".into());
    }
    let before = read(root, input)?;
    if before["etag"] != etag {
        return Err("Arquivo mudou no disco. Reabra antes de salvar.".into());
    }
    let path = confined(root, input)?;
    let tmp = path.with_file_name(format!(".php-ide-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(err)?;
        f.set_permissions(fs::metadata(&path).map_err(err)?.permissions())
            .map_err(err)?;
        f.write_all(value.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
        if read(root, input)?["etag"] != etag {
            return Err("Alteração externa durante salvamento".into());
        }
        fs::rename(&tmp, path).map_err(err)?;
        Ok(json!(hash(value)))
    })();
    let _ = fs::remove_file(tmp);
    result
}
pub fn create(root: &Path, input: &str, value: &str) -> Res<Value> {
    if value.len() > 2097152 {
        return Err("Texto muito grande".into());
    }
    let relative = Path::new(input);
    if relative.is_absolute()
        || relative
            .components()
            .any(|x| matches!(x, std::path::Component::ParentDir))
    {
        return Err("Caminho inválido".into());
    }
    let path = root.join(relative);
    let mut parent = root.to_path_buf();
    if let Some(parts) = relative.parent() {
        for part in parts.components() {
            parent.push(part);
            if !parent.exists() {
                fs::create_dir(&parent).map_err(err)?;
            }
            confined(root, parent.to_str().ok_or("Caminho inválido")?)?;
        }
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(err)?;
    file.write_all(value.as_bytes()).map_err(err)?;
    Ok(json!(hash(value)))
}
