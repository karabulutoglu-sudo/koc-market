use crate::authorization::receipt_id;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::value::RawValue;
use std::path::Path;

pub(super) const KEY: &str = "koc-sales";
const PRESENT: &str = "koc_sales_rows_present_v1";
const CLEAN_DIGEST: &str = "koc_sales_clean_projection_v1";
pub(super) const ACTIVE_SENTINEL_SQL: &str = "X'6B6F632D73616C65732D726F77732D7631'";

pub(super) fn is_legacy_copy(key: &str) -> bool {
    matches!(key, "koc-sales-shadow" | "koc-sales-emergency" | "koc-sales-emergency-ts")
}

pub(super) fn active(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='kv' AND type='view')", [], |row| row.get(0))
}

pub(super) fn projected(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| row.get(0)).optional()
}

pub(super) fn stored(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT payload FROM koc_sales WHERE id=?1", [id], |row| row.get(0)).optional()
}

fn replace_rows(tx: &Transaction<'_>, raw: Option<&str>) -> Result<(), String> {
    let receipts: Vec<&RawValue> = raw.map(serde_json::from_str).transpose()
        .map_err(|e| format!("Eski satış dizisi okunamadı: {e}"))?.unwrap_or_default();
    tx.execute("DELETE FROM koc_sales", []).map_err(|e| e.to_string())?;
    let mut insert = tx.prepare_cached("INSERT INTO koc_sales(id,payload) VALUES (?1,?2)")
        .map_err(|e| e.to_string())?;
    for receipt in receipts.iter().rev() {
        let value = serde_json::from_str(receipt.get()).map_err(|e| format!("Fiş okunamadı: {e}"))?;
        let id = receipt_id(&value).ok_or("Eski fişte geçersiz kimlik var; satış geçmişi değiştirilmedi.")?;
        insert.execute(params![id, receipt.get()])
            .map_err(|e| format!("Fiş satırı taşınamadı ({id}); geçmiş değiştirilmedi: {e}"))?;
    }
    if raw.is_some() {
        mark_present(tx).map_err(|e| e.to_string())?;
    } else {
        tx.execute("DELETE FROM meta WHERE key=?1", [PRESENT]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn mark_present(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute("INSERT OR IGNORE INTO meta(key,value) VALUES (?1,'1')", [PRESENT])?;
    Ok(())
}

fn projection_digest(raw: Option<&str>) -> String {
    raw.map(|value| super::digest(value.as_bytes()))
        .unwrap_or_else(|| "absent".to_owned())
}

pub(super) fn activate(conn: &mut Connection, dir: &Path, data: &super::Kv) -> Result<(), String> {
    let raw = data.get(KEY).map(String::as_str);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let had_rows: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='koc_sales' AND type='table')", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let saved_digest: Option<String> = tx.query_row("SELECT value FROM meta WHERE key=?1", [CLEAN_DIGEST], |row| row.get(0))
        .optional().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS koc_sales(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    if !had_rows || saved_digest.as_deref() != Some(projection_digest(raw).as_str()) {
        replace_rows(&tx, raw)?;
    }
    if data.keys().any(|key| is_legacy_copy(key)) {
        super::verified_recovery_backup(dir, data, "satis-kopyalari").map_err(|e| {
            format!("Eski satış kurtarma kopyaları güvenle arşivlenemedi: {e}")
        })?;
    }
    // 2.0.4, ani kapanma sonrası metin olmayan işareti görünce açılışı
    // reddeder. Onaylı temiz kapanışta yazılabilir eski tablo geri gelir.
    tx.execute_batch(&format!(
        "ALTER TABLE kv RENAME TO koc_live_kv;
         DELETE FROM koc_live_kv WHERE key IN ('koc-sales', 'koc-sales-shadow', 'koc-sales-emergency', 'koc-sales-emergency-ts');
         CREATE VIEW kv AS
           SELECT key,value,updated_at FROM koc_live_kv
           UNION ALL
           SELECT 'koc-sales', '[' || COALESCE((SELECT group_concat(payload, ',')
               FROM (SELECT payload FROM koc_sales ORDER BY seq DESC)), '') || ']', NULL
             FROM meta WHERE key='koc_sales_rows_present_v1'
           UNION ALL SELECT {ACTIVE_SENTINEL_SQL}, 'Satış satırı aktarımı sürüyor', NULL;"
    )).map_err(|e| e.to_string())?;
    verify_projection(&tx, raw)?;
    tx.commit().map_err(|e| e.to_string())
}

fn verify_projection(conn: &Connection, raw: Option<&str>) -> Result<(), String> {
    let actual = projected(conn).map_err(|e| e.to_string())?;
    if actual.as_deref() == raw { return Ok(()); }
    // Dizi ayraçları yeniden birleştirilir; her fişin ham JSON metni değişmez.
    let parse = |value| serde_json::from_str::<Vec<Box<RawValue>>>(value).ok();
    if let (Some(before), Some(after)) = (raw.and_then(parse), actual.as_deref().and_then(parse)) {
        if before.iter().map(|item| item.get()).eq(after.iter().map(|item| item.get())) {
            return Ok(());
        }
    }
    Err("Satış tablosuna aktarılan fişler kaynakla eşleşmedi; geçiş geri alındı.".into())
}

pub(super) fn replace(tx: &Transaction<'_>, raw: Option<&str>) -> Result<(), String> {
    replace_rows(tx, raw)
}

pub(super) fn append(tx: &Transaction<'_>, id: &str, raw: &str) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO koc_sales(id,payload) VALUES (?1,?2)", params![id, raw])?;
    mark_present(tx)
}

pub(super) fn finish(conn: &mut Connection) -> Result<Option<String>, String> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let canonical = projected(&tx).map_err(|e| e.to_string())?;
    tx.execute_batch("DROP VIEW kv; ALTER TABLE koc_live_kv RENAME TO kv;")
        .map_err(|e| e.to_string())?;
    if let Some(raw) = &canonical {
        tx.execute("INSERT INTO kv(key,value,updated_at) VALUES (?1,?2,?3)", params![KEY, raw, super::now_iso()])
            .map_err(|e| e.to_string())?;
    }
    if projected(&tx).map_err(|e| e.to_string())? != canonical {
        return Err("Eski sürüm için satış görünümü doğrulanamadı.".into());
    }
    tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES (?1,?2)", params![CLEAN_DIGEST,projection_digest(canonical.as_deref())])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(canonical)
}
