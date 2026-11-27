use crate::store::{Kv, Op};
use ring::{pbkdf2, rand::{SecureRandom, SystemRandom}};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::num::NonZeroU32;
use std::time::{Duration, Instant};

const PIN: &str = "koc-admin-pin";
const RECOVERY: [&str; 3] = ["-shadow", "-emergency", "-emergency-ts"];
const PRODUCT: &str = "koc-prods";
const SALE: &str = "koc-sales";
const CARI: &str = "koc-cari-state";
const HELD: &str = "koc-held";
const BACKUPS: &str = "koc-backups";
const CATEGORY: &str = "koc-category-tree";
const STOCK: &str = "koc-operational-settings";
const MARKER: &str = "koc-atomic-last-operation";
fn pin_rounds() -> NonZeroU32 { NonZeroU32::new(210_000).expect("PIN iteration count") }
const ADMIN_REQUIRED: &str = "Yönetici yetkisi gerekli veya kayıt geçersiz.";

#[derive(Default)]
pub struct AdminSession {
    until: Option<Instant>,
    retry_at: Option<Instant>,
    failures: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ok: bool,
    remaining_ms: u64,
    retry_ms: u64,
}

impl AdminSession {
    pub fn status(&self, ok: bool) -> Status {
        let now = Instant::now();
        let ms = |value: Option<Instant>| value.map_or(0, |time| time.saturating_duration_since(now).as_millis() as u64);
        Status { ok, remaining_ms: ms(self.until), retry_ms: ms(self.retry_at) }
    }

    pub fn authenticated(&self) -> bool {
        self.until.is_some_and(|until| until > Instant::now())
    }

    pub fn lock(&mut self) {
        self.until = None;
    }

    pub fn open(&mut self) {
        self.until = Some(Instant::now() + Duration::from_secs(300));
    }

    pub fn check(&mut self, mem: &Kv, pin: &str) -> Result<Option<PinCheck>, String> {
        if self.status(false).retry_ms > 0 {
            return Ok(None);
        }
        let raw = mem.get(PIN).map(String::as_str);
        let quoted: Option<String> = raw.filter(|s| s.starts_with('"')).and_then(|s| serde_json::from_str(s).ok());
        let stored = quoted.as_deref().or(raw);
        let verified = match stored.and_then(|s| s.strip_prefix("pbkdf2:")) {
            Some(fields) => {
                let (salt, expected) = fields.split_once(':').ok_or("PIN kaydı geçersiz.")?;
                let salt = unhex::<16>(salt).ok_or("PIN kaydı geçersiz.")?;
                let expected = unhex::<32>(expected).ok_or("PIN kaydı geçersiz.")?;
                valid_pin(pin) && pbkdf2::verify(pbkdf2::PBKDF2_HMAC_SHA256, pin_rounds(), &salt, pin.as_bytes(), &expected).is_ok()
            }
            None => valid_pin(pin) && pin == stored.unwrap_or("1234"),
        };
        if !verified {
            self.failures = self.failures.saturating_add(1);
            if self.failures >= 3 {
                self.retry_at = Some(Instant::now() + Duration::from_secs(5));
            }
            return Ok(None);
        }
        self.failures = 0;
        self.retry_at = None;
        let migrate = !stored.is_some_and(|s| s.starts_with("pbkdf2:"));
        let mut ops = if migrate { pin_ops(pin)? } else { Vec::new() };
        if !migrate {
            ops.extend(RECOVERY.iter().map(|suffix| format!("{PIN}{suffix}"))
                .filter(|key| mem.contains_key(key)).map(remove));
        }
        Ok(Some(PinCheck { migration: ops }))
    }
}

pub struct PinCheck {
    pub migration: Vec<Op>,
}

pub fn valid_pin(pin: &str) -> bool {
    pin.len() == 4 && pin.bytes().all(|byte| byte.is_ascii_digit())
}

fn unhex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[2*i..2*i+2], 16).ok()?;
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn pin_ops(pin: &str) -> Result<Vec<Op>, String> {
    if !valid_pin(pin) { return Err("PIN dört haneli olmalı.".into()); }
    let mut salt = [0; 16];
    SystemRandom::new().fill(&mut salt).map_err(|_| "PIN tuzu oluşturulamadı.")?;
    let mut digest = [0; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, pin_rounds(), &salt, pin.as_bytes(), &mut digest);
    let raw = format!("pbkdf2:{}:{}", hex(&salt), hex(&digest));
    let mut ops = vec![set(PIN, raw)];
    ops.extend(RECOVERY.iter().map(|suffix| remove(format!("{PIN}{suffix}"))));
    Ok(ops)
}

pub fn pin_key(key: &str) -> bool {
    key == PIN || RECOVERY.iter().any(|suffix| key.strip_suffix(suffix) == Some(PIN))
}

fn set(key: impl Into<String>, value: impl Into<String>) -> Op {
    Op { key: key.into(), op: "set".into(), val: Some(value.into()) }
}

fn remove(key: String) -> Op {
    Op { key, op: "del".into(), val: None }
}

fn raw_json(raw: Option<&str>) -> Option<Value> {
    serde_json::from_str(raw?).ok()
}

fn read(mem: &Kv, key: &str) -> Option<Value> {
    raw_json(mem.get(key).map(String::as_str))
}

fn normalized_barcode(barcode: &str) -> String {
    barcode.chars().filter(|c| !c.is_whitespace() && !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{feff}')).collect()
}

pub fn startup_migrations(mem: &Kv, html: &str, at: i64) -> Result<Vec<Op>, String> {
    let mut ops = Vec::new();
    let existing = recover(mem, PRODUCT, Value::is_array, &mut ops)?;
    let sales = recover(mem, SALE, Value::is_array, &mut ops)?;
    let held = recover(mem, HELD, Value::is_array, &mut ops)?;
    recover(mem, CARI, Value::is_object, &mut ops)?;
    recover(mem, "koc-business-settings", Value::is_object, &mut ops)?;
    recover(mem, "koc-user-settings", Value::is_object, &mut ops)?;
    let mut products = match existing.clone() {
        Some(value) => value,
        None if mem.contains_key("koc-ulker-v6-yuklendi") || sales.is_some() || held.is_some() => json!([]),
        None => {
            let seed = html.split_once("const ULKER_URUNLER =[").and_then(|(_, tail)| tail.split_once("\n];"));
            let seed = seed.ok_or("Paketin başlangıç kataloğu bulunamadı.")?.0;
            serde_json::from_str(&format!("[{seed}]")).map_err(|_| "Başlangıç kataloğu okunamadı.")?
        }
    };
    for key in ["koc-migrated-to-disk-v1", "koc-ulker-v6-yuklendi", "koc-kat-birlesim-v1",
        "koc-barcode-cleanup-v1", "koc-kdv-migrated-v1", "koc-kdv-sigara-fix-v10", "koc-category-tree-native-v1"] {
        if !mem.contains_key(key) { ops.push(set(key, "1")); }
    }

    let merge = !mem.contains_key("koc-kat-birlesim-v1");
    let clean = !mem.contains_key("koc-barcode-cleanup-v1");
    let fill_vat = !mem.contains_key("koc-kdv-migrated-v1");
    let fix_tobacco = !mem.contains_key("koc-kdv-sigara-fix-v10");
    let migrate_tree = !mem.contains_key("koc-category-tree-native-v1");
    let settings = recover(mem, STOCK, Value::is_object, &mut ops)?;
    let default_vat = settings.and_then(|v| v.get("defaultVat").cloned()).filter(Value::is_number).unwrap_or(json!(20));
    let old_tree = recover(mem, CATEGORY, Value::is_object, &mut ops)?;
    let mut categories = old_tree.as_ref().and_then(|v| v["categories"].as_array()).cloned().unwrap_or_default();
    let rows = products.as_array_mut().ok_or("Başlangıç kataloğu geçersiz.")?;
    for p in rows.iter_mut().filter(|v| v.is_object()) {
        if clean {
            if let Some(b) = p["b"].as_str() {
                let next = normalized_barcode(b);
                if !next.is_empty() && next != b { p["b"] = json!(next); }
            }
        }
        if merge && matches!(p["c"].as_str(), Some("Bisküvi" | "Çikolata" | "Kraker" | "Bar" | "Gofret" |
            "Kek" | "Şekerleme" | "Fırın" | "Süt" | "Gıda" | "Temizlik" | "Diğer")) {
            p["c"] = json!("Atıştırmalık");
        }
        let category = p["c"].as_str().unwrap_or("");
        let zero = matches!(category, "Sigara" | "Tütün");
        if (fix_tobacco && zero) || (fill_vat && p["k"].is_null()) {
            p["k"] = match category {
                "Sigara" | "Tütün" => json!(0),
                "Temel Gıda" | "Ekmek" | "Süt" | "Süt Ürünleri" | "Sebze" | "Meyve" => json!(1),
                "Atıştırmalık" | "Bar" | "Kraker" | "Bisküvi" | "Çikolata" | "Gofret" | "Kek" |
                "Kuruyemiş" | "Şekerleme" | "Dondurma" | "İçecek" => json!(10),
                _ => default_vat.clone(),
            };
        }
    }
    if migrate_tree {
        let names = ["Atıştırmalık", "Sigara", "Otomotiv Ürünleri", "Muhtelif Ürünler", "İçecek", "Dondurma", "Kuruyemiş"];
        let mut category_ids: HashSet<String> = categories.iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
        let mut ids: HashMap<String, Value> = categories.iter().filter_map(|c| c["name"].as_str()
            .filter(|_| c["active"] != json!(false)).map(|name| (name.to_string(), c["id"].clone()))).collect();
        let mut serial = 0;
        for name in names.into_iter().chain(rows.iter().filter_map(|p| p["c"].as_str())) {
            let name = name.trim();
            if name.is_empty() || ids.contains_key(name) { continue; }
            let id = loop {
                serial += 1;
                let id = format!("cat-native-{serial}");
                if category_ids.insert(id.clone()) { break id; }
            };
            ids.insert(name.to_string(), json!(&id));
            categories.push(json!({"id":id,"name":name,"parentId":null,"active":true,"createdAt":at}));
        }
        for p in rows.iter_mut().filter(|v| v.is_object()) {
            if p["cid"].as_str().is_some_and(|id| category_ids.contains(id)) { continue; }
            if let Some(id) = p["c"].as_str().and_then(|name| ids.get(name)) { p["cid"] = id.clone(); }
        }
        let tree = json!({"schemaVersion":1,"categories":categories});
        if old_tree.as_ref() != Some(&tree) {
            for key in [CATEGORY, "koc-category-tree-shadow", "koc-category-tree-emergency"] {
                ops.push(set(key, tree.to_string()));
            }
        }
    }
    if existing.as_ref() != Some(&products) || !read(mem, PRODUCT).is_some_and(|v| v.is_array()) {
        for key in [PRODUCT, "koc-prods-shadow", "koc-prods-emergency"] {
            ops.push(set(key, products.to_string()));
        }
        // Eski oran/ürün anahtarları yazılmadan önce kendi değerleri bir kurtarma kopyasında kalır.
        if let Some(before) = existing {
            let mut backups = read(mem, BACKUPS).and_then(|b| b.as_array().cloned()).unwrap_or_default();
            let snapshot = json!({"ts":at,"reason":"Yerel başlangıç bakımı öncesi","products":before,
                "sales":sales.unwrap_or(json!([])), "heldSales":held.unwrap_or(json!([])),
                "categoryState": old_tree, "v":4});
            let mut snapshot = snapshot.as_object().unwrap().clone();
            snapshot.retain(|_, value| !value.is_null());
            backups.insert(0, Value::Object(snapshot));
            backups.truncate(10);
            ops.push(set(BACKUPS, Value::Array(backups).to_string()));
        }
    }
    Ok(ops)
}

fn recover(mem: &Kv, key: &str, valid: fn(&Value) -> bool, ops: &mut Vec<Op>) -> Result<Option<Value>, String> {
    let keys = [key.to_string(), format!("{key}-shadow"), format!("{key}-emergency")];
    for candidate in &keys {
        if let Some(value) = read(mem, candidate).filter(valid) {
            if candidate != key {
                ops.push(set(key,mem.get(candidate).unwrap().clone()));
            }
            return Ok(Some(value));
        }
    }
    if keys.iter().any(|candidate| mem.contains_key(candidate)) {
        return Err(format!("Kayıtlı veri okunamadı: {key}"));
    }
    Ok(None)
}

fn core_key(key: &str) -> bool {
    matches!(key, PRODUCT | SALE | CARI | HELD | BACKUPS | CATEGORY | STOCK | "koc-business-settings" | "koc-user-settings")
}

fn cashier_trace(key: &str, raw: &str) -> bool {
    match key {
        "koc-last-auto-backup-date" | "koc-son-acilis-gunu" => {
            raw.len() == 10 && raw.bytes().enumerate().all(|(i,b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
        }
        "koc-son-yedek" => raw.parse::<u64>().is_ok(),
        "koc-tauri-gecis-bildirildi" => chrono::DateTime::parse_from_rfc3339(raw).is_ok(),
        _ => false,
    }
}

pub fn authorize(mem: &Kv, ops: &[Op], is_admin: bool) -> Result<(), String> {
    authorize_inner(mem, ops, is_admin).ok_or_else(|| ADMIN_REQUIRED.to_string())
}

fn authorize_inner(mem: &Kv, ops: &[Op], is_admin: bool) -> Option<()> {
    let mut writes = HashMap::new();
    for op in ops {
        if op.op == "del" && op.val.is_none() && is_admin && core_key(&op.key) {
            if writes.insert(op.key.as_str(), None).is_some() { return None; }
            continue;
        }
        let raw = match (op.op.as_str(), op.val.as_deref()) {
            ("set", Some(raw)) => raw,
            _ => return None,
        };
        if pin_key(&op.key) || writes.insert(op.key.as_str(), Some(raw)).is_some() { return None; }
    }
    let mut records = HashMap::new();
    for (&key, raw) in &writes {
        let Some(raw) = *raw else { continue; };
        if core_key(key) {
            let value = raw_json(Some(raw))?;
            if matches!(key, PRODUCT | SALE | HELD | BACKUPS) && !value.is_array() { return None; }
            if matches!(key, CARI | CATEGORY | STOCK | "koc-business-settings" | "koc-user-settings") && !value.is_object() { return None; }
            if mem.get(key).map(String::as_str) != Some(raw) { records.insert(key, value); }
        } else if key == MARKER {
            if raw.is_empty() || raw.len() > 160 || !raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return None;
            }
            if !writes.keys().any(|candidate| core_key(candidate)) { return None; }
        } else if !cashier_trace(key, raw) {
            let (base, suffix) = RECOVERY.into_iter().find_map(|suffix| key.strip_suffix(suffix).map(|base| (base,suffix)))?;
            if !core_key(base) || base == BACKUPS { return None; }
            let current = writes.get(base).copied().unwrap_or_else(|| mem.get(base).map(String::as_str));
            if suffix == "-emergency-ts" {
                if raw.parse::<u64>().is_err() { return None; }
            } else if current != Some(raw) {
                return None;
            }
        }
    }
    if is_admin { return Some(()); }
    if records.keys().any(|key| !matches!(*key, PRODUCT | SALE | CARI | HELD | BACKUPS)) { return None; }
    let mut receipt = None;
    if let Some(next) = records.get(SALE) {
        let old = stored_array(mem, SALE)?;
        let next = next.as_array()?;
        let (sale, rest) = next.split_first()?;
        if rest != old || !valid_receipt(sale) || old.iter().any(|entry| id(&entry["id"]) == id(&sale["id"])) {
            return None;
        }
        let old_catalog = stored_array(mem, PRODUCT)?;
        let next_catalog = records.get(PRODUCT).and_then(Value::as_array).unwrap_or(&old_catalog);
        if !valid_stock_delta(mem, &old_catalog, next_catalog, sale) { return None; }
        receipt = Some(sale);
    } else if records.contains_key(PRODUCT) {
        return None;
    }
    if let Some(next) = records.get(CARI) {
        validate_cari(mem, next, receipt)?;
    } else if receipt.is_some_and(|sale| sale["paymentMethod"] == "cari") {
        return None;
    }
    if let Some(next) = records.get(HELD) {
        let old = stored_array(mem, HELD)?;
        let next = next.as_array()?;
        let existing: Vec<_> = next.iter().filter(|item| old.contains(item)).collect();
        let old_remaining: Vec<_> = old.iter().filter(|item| next.contains(item)).collect();
        if existing != old_remaining || old.len().saturating_sub(existing.len()) > 1 || next.len().saturating_sub(existing.len()) > 1 {
            return None;
        }
        let mut ids = HashSet::new();
        if !next.iter().all(|item| id(&item["id"]).is_some_and(|id| ids.insert(id)) && item["cart"].is_array()) {
            return None;
        }
    }
    if let Some(next) = records.get(BACKUPS) {
        let old = stored_array(mem, BACKUPS)?;
        let (added, kept) = next.as_array()?.split_first()?;
        if kept.len() > old.len() || kept != &old[..kept.len()] { return None; }
        for (field, key) in [("products",PRODUCT),("sales",SALE),("heldSales",HELD)] {
            if added[field].as_array()? != &stored_array(mem, key)? { return None; }
        }
        if let Some(cari) = read(mem, CARI) {
            if added["cariState"] != cari { return None; }
        }
    }
    Some(())
}

fn stored_array(mem: &Kv, key: &str) -> Option<Vec<Value>> {
    if !mem.contains_key(key) { return Some(Vec::new()); }
    read(mem, key)?.as_array().cloned()
}

fn id(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str().filter(|s| !s.is_empty()) { return Some(s.to_string()); }
    value.as_i64().map(|number| number.to_string())
}

fn money(value: &Value) -> Option<i64> {
    let n = value.as_f64()? * 100.0;
    (n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n)).then(|| n.round() as i64)
}

fn nonneg(value: &Value) -> Option<i64> {
    value.as_i64().filter(|&n| n >= 0)
}

fn valid_receipt(sale: &Value) -> bool {
    fn validate(sale: &Value) -> Option<()> {
        id(&sale["id"])?;
        sale["at"].as_i64()?;
        sale["d"].as_str()?;
        let items = sale["items"].as_array()?.iter();
        let mut total = 0i64;
        let mut count = 0;
        for item in items {
            item["b"].as_str().filter(|b| !b.is_empty())?;
            let qty = item["q"].as_i64().filter(|&q| q > 0)?;
            let vat = item["k"].as_f64()?;
            if !(0.0..=100.0).contains(&vat) { return None; }
            let line = money(&item["p"])?.checked_mul(qty)?;
            if item["totalCents"].as_i64()? != line { return None; }
            total = total.checked_add(line)?;
            count += 1;
        }
        if count == 0 || money(&sale["total"])? != total { return None; }
        let paid = money(&sale["paid"])?;
        let change = money(&sale["change"])?;
        let accepted = match sale["paymentMethod"].as_str()? {
            "cash" => paid >= total && change == paid - total && sale["customerId"].is_null(),
            "card" => paid == total && change == 0 && sale["customerId"].is_null(),
            "cari" => paid == 0 && change == 0 && id(&sale["customerId"]).is_some(),
            _ => false,
        };
        accepted.then_some(())
    }
    validate(sale).is_some()
}

fn valid_stock_delta(mem: &Kv, old: &[Value], new: &[Value], sale: &Value) -> bool {
    if old.len() != new.len() { return false; }
    let settings = read(mem, STOCK).unwrap_or(Value::Null);
    let mut expected = old.to_vec();
    if settings["trackStock"] != json!(false) {
        let mut quantities = HashMap::new();
        for item in sale["items"].as_array().unwrap() {
            let sum = quantities.entry(item["b"].as_str()).or_insert(0i64);
            let Some(next) = sum.checked_add(item["q"].as_i64().unwrap()) else { return false; };
            *sum = next;
        }
        for p in expected.iter_mut().filter(|p| p.is_object()) {
            let stock = p["s"].as_i64().unwrap_or_default();
            if p["stockTracked"] == json!(true) || (p["stockTracked"].is_null() && stock > 0) {
                if let Some(qty) = quantities.get(&p["b"].as_str()) {
                    let Some(remaining) = stock.checked_sub(*qty) else { return false; };
                    if remaining < 0 && settings["allowNegativeStock"] != json!(true) { return false; }
                    p["s"] = json!(remaining);
                    p["stockTracked"] = json!(true);
                }
            }
        }
    }
    expected == new
}

fn same_except(before: &Value, after: &Value, allowed: &[&str]) -> Option<()> {
    let old = before.as_object()?;
    let new = after.as_object()?;
    if old.iter().any(|(k,v)| !allowed.contains(&k.as_str()) && new.get(k) != Some(v)) ||
        new.keys().any(|k| !allowed.contains(&k.as_str()) && !old.contains_key(k)) {
        return None;
    }
    Some(())
}

fn validate_cari(mem: &Kv, next: &Value, receipt: Option<&Value>) -> Option<()> {
    let old = read(mem, CARI).or_else(|| (!mem.contains_key(CARI)).then(|| json!({"schemaVersion":1,"customers":[],"lots":[],"entries":[]})))?;
    same_except(&old,next,&["lastId","customers","lots","entries"])?;
    if new_counter(next)? < new_counter(&old)? { return None; }
    let before_customers = old["customers"].as_array()?;
    let customers = next["customers"].as_array()?;
    let before_lots = old["lots"].as_array()?;
    let lots = next["lots"].as_array()?;
    let before_entries = old["entries"].as_array()?;
    let entries = next["entries"].as_array()?;
    if customers.starts_with(before_customers) && customers.len() == before_customers.len()+1 {
        let added = customers.last()?;
        let customer_id = id(&added["id"])?;
        return (receipt.is_none() && before_lots == lots && before_entries == entries && added["active"] == json!(true)
            && added["name"].as_str().is_some_and(|s| !s.trim().is_empty())
            && !before_customers.iter().any(|c| id(&c["id"]).as_ref() == Some(&customer_id))).then_some(());
    }
    if before_customers != customers || entries.len() != before_entries.len()+1 || lots.len() < before_lots.len() {
        return None;
    }
    let added = entries.last()?;
    let customer_id = &added["customerId"];
    let customer = customers.iter().find(|c| &c["id"] == customer_id)?;
    let kind = added["type"].as_str()?;
    let debit = nonneg(&added["debitCents"])?;
    let credit = nonneg(&added["creditCents"])?;
    let new_lots = &lots[before_lots.len()..];
    if before_entries.iter().any(|line| line["id"] == added["id"]) { return None; }
    let previous_balance = before_entries.iter().filter(|line| &line["customerId"] == customer_id).try_fold(0i64, |sum,line|
        sum.checked_add(line["debitCents"].as_i64()?)?.checked_sub(line["creditCents"].as_i64()?))?;
    if added["balanceCents"].as_i64()? != previous_balance.checked_add(debit)?.checked_sub(credit)? { return None; }
    match kind {
        "payment" if receipt.is_none() && debit == 0 && credit > 0 && new_lots.is_empty() => {
            if customer["active"] == json!(false) && credit > previous_balance { return None; }
        }
        "credit_sale" | "manual_product" if credit == 0 && customer["active"] != json!(false) => {
            let max = customer["riskLimit"].as_f64().unwrap_or(0.0);
            if max > 0.0 && added["balanceCents"].as_i64()? > (max * 100.0).round() as i64 { return None; }
            let items = added["details"]["items"].as_array()?;
            if items.is_empty() || new_lots.len() != items.len() { return None; }
            let from_sale = receipt.filter(|s| s["paymentMethod"] == "cari" && &s["customerId"] == customer_id &&
                id(&s["id"]) == id(&added["referenceId"]) && money(&s["total"]) == Some(debit)).and_then(|s| s["items"].as_array());
            let catalog = stored_array(mem, PRODUCT)?;
            if kind == "credit_sale" && !from_sale.is_some_and(|items_from_sale| items_from_sale.len() == items.len()) { return None; }
            if kind == "manual_product" && (receipt.is_some() || items.len() != 1) { return None; }
            let mut lots_ids: HashSet<_> = before_lots.iter().map(|row| id(&row["id"])).collect();
            let mut total = 0i64;
            for (index,(line,lot)) in items.iter().zip(new_lots).enumerate() {
                let qty = line["quantity"].as_i64().filter(|&q| q > 0)?;
                let unit = nonneg(&line["unitPriceCents"])?;
                let line_cents = qty.checked_mul(unit)?;
                if let Some(source) = from_sale {
                    if line["barcode"] != source[index]["b"] || money(&source[index]["p"]) != Some(unit) || source[index]["q"].as_i64() != Some(qty) { return None; }
                } else if qty != 1 || !catalog.iter().any(|p| p["b"] == line["barcode"] && money(&p["p"]) == Some(unit)) {
                    return None;
                }
                if !lots_ids.insert(Some(id(&lot["id"])?)) || lot["id"] != line["lotId"] || &lot["customerId"] != customer_id ||
                    id(&lot["saleId"]) != id(&added["referenceId"]) || lot["barcode"] != line["barcode"] ||
                    lot["originalQuantity"] != line["quantity"] || lot["highestAppliedUnitPriceCents"].as_i64()? != unit ||
                    lot["originalUnitPriceCents"].as_i64()? != unit || nonneg(&line["lineCents"])? != line_cents ||
                    nonneg(&lot["outstandingCents"])? > line_cents { return None; }
                total = total.checked_add(line_cents)?;
            }
            if total != debit { return None; }
        }
        _ => return None,
    }
    // Avans mahsupları aynı müşterinin mevcut tahsilat detaylarını ve açık kalemini azaltabilir.
    // Deftere yazılmış tutar ve diğer müşterilerin tüm kayıtları sabit kalır.
    let mut allocated = 0i64;
    for (before,after) in before_entries.iter().zip(entries) {
        if before == after { continue; }
        if &before["customerId"] != customer_id || before["type"] != "payment" { return None; }
        same_except(before, after, &["details"])?;
        same_except(&before["details"], &after["details"], &["unallocatedCreditCents","allocations"])?;
        let prev = nonneg(&before["details"]["unallocatedCreditCents"])?;
        let remaining = nonneg(&after["details"]["unallocatedCreditCents"])?;
        if remaining > prev { return None; }
        let prior = before["details"]["allocations"].as_array()?;
        let next = after["details"]["allocations"].as_array()?;
        if !next.starts_with(prior) { return None; }
        let append_total = next[prior.len()..].iter().try_fold(0i64, |sum,allocation| sum.checked_add(nonneg(&allocation["appliedCents"])?))?;
        if append_total != prev-remaining { return None; }
        allocated = allocated.checked_add(append_total)?;
    }
    let mut lot_decrease = 0i64;
    for (before,after) in before_lots.iter().zip(lots) {
        if before == after { continue; }
        if &before["customerId"] != customer_id || !before["closedAt"].is_null() { return None; }
        same_except(before,after,&["outstandingCents","closedAt"])?;
        let remaining = nonneg(&after["outstandingCents"])?;
        let prior = nonneg(&before["outstandingCents"])?;
        if remaining > prior || after["closedAt"].is_null() != (remaining > 0) { return None; }
        lot_decrease = lot_decrease.checked_add(prior-remaining)?;
    }
    if kind == "payment" {
        let unapplied = nonneg(&added["details"]["unallocatedCreditCents"])?;
        let applied = added["details"]["allocations"].as_array()?.iter()
            .try_fold(0i64, |sum,allocation| sum.checked_add(nonneg(&allocation["appliedCents"])?))?;
        if credit.checked_sub(unapplied)? != applied { return None; }
        allocated = allocated.checked_add(applied)?;
    } else {
        let remaining = new_lots.iter().try_fold(0i64, |sum,lot| sum.checked_add(nonneg(&lot["outstandingCents"])?))?;
        lot_decrease = lot_decrease.checked_add(debit.checked_sub(remaining)?)?;
    }
    (lot_decrease == allocated).then_some(())
}

fn new_counter(cari: &Value) -> Option<i64> {
    if cari["lastId"].is_null() { Some(0) } else { nonneg(&cari["lastId"]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_op(key: &str, value: Value) -> Op { set(key,value.to_string()) }
    fn apply(mem: &mut Kv, ops: Vec<Op>) {
        for op in ops {
            if let Some(raw) = op.val { mem.insert(op.key,raw); }
            else { mem.remove(&op.key); }
        }
    }

    #[test]
    fn cashier_receipt_and_stock_are_validated_as_one_change() {
        let product = json!({"b":"830001","n":"Örnek ürün","p":12.8,"c":"İçecek","s":10,"stockTracked":true,"k":20});
        let mut mem = Kv::new();
        apply(&mut mem,vec![value_op(PRODUCT,json!([product])),value_op(SALE,json!([]))]);
        let item = json!({"b":"830001","n":"Örnek ürün","p":12.8,"q":3,"totalCents":3840,"k":20});
        let sale = json!({"id":"sentetik-1","at":1234,"d":"27.11.2026","total":38.4,"paid":38.4,
            "change":0,"paymentMethod":"cash","customerId":null,"items":[item]});
        let mut remaining = product.clone();
        remaining["s"] = json!(7);
        let ops = vec![value_op(SALE,json!([sale])),value_op(PRODUCT,json!([remaining])),
            set(MARKER,"sentetik-1")];
        assert!(authorize(&mem,&ops,false).is_ok());
        let mut priced = product;
        priced["p"] = json!(3.0);
        let changes = [value_op(PRODUCT,json!([priced]))];
        assert!(authorize(&mem,&changes,false).is_err());
        assert!(authorize(&mem,&changes,true).is_ok());
        assert!(authorize(&mem,&[value_op(STOCK,json!({"trackStock":false}))],false).is_err());
    }

    #[test]
    fn cashier_can_post_veresiye_with_exactly_one_matching_cari_entry() {
        let customer = json!({"id":"customer-1","name":"Örnek cari","active":true,"riskLimit":0});
        let old_state = json!({"schemaVersion":1,"lastId":1,"customers":[customer],"entries":[],"lots":[]});
        let mut mem = Kv::new();
        apply(&mut mem,vec![value_op(PRODUCT,json!([])),value_op(SALE,json!([])),value_op(CARI,old_state)]);
        let sale = json!({"id":"sentetik-2","at":1000,"d":"27.11.2026","total":10,"paid":0,"change":0,
            "customerId":"customer-1","paymentMethod":"cari","items":[{"b":"830001","n":"Örnek ürün","p":10,"q":1,"totalCents":1000,"k":20}]});
        let entry = json!({"id":"entry-3","referenceId":"sentetik-2","type":"credit_sale","at":1000,"customerId":"customer-1",
            "debitCents":1000,"creditCents":0,"balanceCents":1000,"details":{"items":[{"lotId":"lot-2","barcode":"830001",
                "quantity":1,"unitPriceCents":1000,"lineCents":1000}]}});
        let lot = json!({"id":"lot-2","saleId":"sentetik-2","customerId":"customer-1","barcode":"830001","originalQuantity":1,
            "originalUnitPriceCents":1000,"highestAppliedUnitPriceCents":1000,"outstandingCents":1000,"closedAt":null});
        let post = json!({"schemaVersion":1,"lastId":3,"customers":[customer],"entries":[entry],"lots":[lot]});
        assert!(authorize(&mem,&[value_op(SALE,json!([sale])),value_op(CARI,post.clone())],false).is_ok());
        let payment = json!({"id":"entry-5","referenceId":"payment-4","type":"payment","at":1100,"customerId":"customer-1",
            "debitCents":0,"creditCents":200,"balanceCents":800,"details":{"unallocatedCreditCents":0,
                "allocations":[{"lotId":"lot-2","appliedCents":200}]}});
        let mut paid = post.clone();
        paid["lastId"] = json!(5);
        paid["entries"].as_array_mut().unwrap().push(payment);
        paid["lots"][0]["outstandingCents"] = json!(800);
        apply(&mut mem,vec![value_op(CARI,post)]);
        assert!(authorize(&mem,&[value_op(CARI,paid)],false).is_ok());
    }

    #[test]
    fn startup_normalizes_legacy_data_once_and_retains_previous_catalog() {
        let product = json!({"b":" 830001 ", "n":"Örnek ürün", "p":12.8,"c":"Tütün","s":10,"k":20});
        let mut mem = Kv::new();
        apply(&mut mem,vec![value_op(PRODUCT,json!([product])),value_op("koc-sales-shadow",json!([{"id":12}]))]);
        let ops = startup_migrations(&mem,"",123).unwrap();
        apply(&mut mem,ops);
        let products = read(&mem,PRODUCT).unwrap();
        assert_eq!(products[0]["b"],"830001");
        assert_eq!(products[0]["k"],0);
        assert_eq!(products[0]["s"],10);
        assert_eq!(read(&mem,SALE).unwrap()[0]["id"],12);
        assert_eq!(read(&mem,BACKUPS).unwrap()[0]["products"][0],product);
        assert!(startup_migrations(&mem,"",234).unwrap().is_empty());
    }

    #[test]
    fn native_pin_keeps_old_identity_and_rate_limits() {
        let mut mem = Kv::new();
        apply(&mut mem,vec![set(PIN,"0944"), set("koc-admin-pin-shadow","0944")]);
        let mut session = AdminSession::default();
        let legacy = session.check(&mem,"0944").unwrap().unwrap();
        apply(&mut mem,legacy.migration);
        assert!(mem[PIN].starts_with("pbkdf2:"));
        assert!(!mem.contains_key("koc-admin-pin-shadow"));
        assert!(session.check(&mem,"0944").unwrap().is_some());
        session.open();
        assert!(session.authenticated());
        session.lock();
        for _ in 0..3 { assert!(session.check(&mem,"0000").unwrap().is_none()); }
        assert!(session.status(false).retry_ms > 0);
        assert!(session.check(&mem,"0944").unwrap().is_none());
    }
}
