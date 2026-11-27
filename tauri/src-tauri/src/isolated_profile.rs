use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn is_local_absolute(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    path.is_absolute()
        && matches!(path.components().next(), Some(Component::Prefix(p))
            if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

#[cfg(not(windows))]
fn is_local_absolute(path: &Path) -> bool {
    path.is_absolute()
}

fn child_path(parent: &Path, path: &Path) -> Result<PathBuf, String> {
    if !is_local_absolute(path) {
        return Err("Sınama yolu mutlak ve yerel olmalı.".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| format!("Sınama yolu açılamadı: {e}"))?;
    if canonical == parent || !is_local_absolute(&canonical) || !canonical.starts_with(parent) {
        return Err("Sınama yolu ayrılmış geçici klasörün içinde olmalı.".into());
    }
    Ok(canonical)
}

pub fn requested() -> Result<Option<PathBuf>, String> {
    let Some(requested) = env::var_os("KOC_DATA_DIR") else {
        return if cfg!(feature = "verify-build") {
            Err("Sınama ikilisi KOC_DATA_DIR ile ayrılmış mevcut bir geçici klasör gerektirir.".into())
        } else {
            Ok(None)
        };
    };
    let temp = fs::canonicalize(env::temp_dir()).map_err(|e| format!("Geçici klasör açılamadı: {e}"))?;
    let profile = child_path(&temp, Path::new(&requested))?;
    // SQLite ve WebView2 mevcut bir dizin bağlantısı üzerinden üretim
    // profiline ulaşmamalı. Dışa yönlenen üst seviye girdileri reddet.
    for entry in fs::read_dir(&profile).map_err(|e| format!("Sınama profili okunamadı: {e}"))? {
        let entry = entry.map_err(|e| format!("Sınama profili girdisi okunamadı: {e}"))?;
        child_path(&profile, &entry.path())?;
    }
    Ok(Some(profile))
}

pub fn script(profile: &Path) -> Option<String> {
    let file = env::var_os("KOC_TEST_JS")?;
    let path = child_path(profile, Path::new(&file)).ok()?;
    if path.extension().and_then(|ext| ext.to_str()) != Some("js") {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_policy_rejects_parent_and_outside_paths() {
        let temp = fs::canonicalize(env::temp_dir()).unwrap();
        let name = format!("koc-isolated-path-{}", std::process::id());
        let profile = temp.join(name);
        fs::create_dir_all(&profile).unwrap();
        assert_eq!(child_path(&temp, &profile).unwrap(), fs::canonicalize(&profile).unwrap());
        assert!(child_path(&temp, &temp).is_err());
        assert!(child_path(&temp, Path::new(".")).is_err());
        assert!(child_path(&profile, &temp).is_err());
        fs::remove_dir(&profile).unwrap();
    }
}
