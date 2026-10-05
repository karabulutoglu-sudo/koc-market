//! Plans a reversible repair of UTF-8 text that was read as Windows-1252.
//!
//! Planning is read-only. Only string values in the four live data roots can
//! change, including their active shadow/emergency recovery copies. Archived
//! backups, object keys and numeric values are never repaired.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

const ROOTS: [(&str, &str); 4] = [
    ("koc-prods", "Ürünler"),
    ("koc-sales", "Satışlar"),
    ("koc-held", "Bekleyen satışlar"),
    ("koc-cari-state", "Cariler"),
];
const MAX_LAYERS: usize = 8;
const MAX_SAMPLES: usize = 20;
const SAMPLE_CHAR_LIMIT: usize = 160;

#[derive(Debug, Clone, Serialize, Default)]
pub struct RepairPreview {
    /// Counts changed string fields, rather than whole records.
    pub changes: usize,
    pub product_changes: usize,
    pub sale_changes: usize,
    pub other_changes: usize,
    /// Suspicious fields which cannot be repaired without guessing.
    pub unresolved: usize,
    pub samples: Vec<RepairSample>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepairSample {
    pub scope: String,
    /// JSON Pointer within the root. Object keys are escaped, never modified.
    pub path: String,
    pub before: String,
    pub after: String,
    pub layers: usize,
}

#[derive(Debug)]
pub struct RepairPlan {
    /// Only roots containing a changed field appear in these two maps.
    pub before: HashMap<String, String>,
    pub after: HashMap<String, String>,
    pub preview: RepairPreview,
}

pub fn plan(mem: &HashMap<String, String>) -> Result<RepairPlan, String> {
    let mut result = RepairPlan {
        before: HashMap::new(),
        after: HashMap::new(),
        preview: RepairPreview::default(),
    };
    for (base, base_scope) in ROOTS {
        for suffix in ["", "-shadow", "-emergency"] {
            let key = format!("{base}{suffix}");
            let scope = if suffix.is_empty() {
                base_scope
            } else {
                "Kurtarma kopyası"
            };
            let Some(source) = mem.get(&key) else {
                continue;
            };
            let mut value: Value = serde_json::from_str(source)
                .map_err(|err| format!("{scope} verisi okunamadı ({key}): {err}"))?;
            let changes_before = result.preview.changes;
            repair_value(&mut value, &key, scope, "", &mut result.preview);
            if result.preview.changes != changes_before {
                let repaired = serde_json::to_string(&value)
                    .map_err(|err| format!("{scope} onarım planı hazırlanamadı: {err}"))?;
                result.before.insert(key.clone(), source.clone());
                result.after.insert(key, repaired);
            }
        }
    }
    Ok(result)
}

fn repair_value(
    value: &mut Value,
    root: &str,
    scope: &str,
    path: &str,
    preview: &mut RepairPreview,
) {
    match value {
        Value::String(text) => match repair_text(text) {
            TextRepair::Changed {
                text: repaired,
                layers,
            } => {
                preview.changes += 1;
                match root {
                    "koc-prods" => preview.product_changes += 1,
                    "koc-sales" => preview.sale_changes += 1,
                    _ => preview.other_changes += 1,
                }
                if preview.samples.len() < MAX_SAMPLES {
                    preview.samples.push(RepairSample {
                        scope: scope.to_owned(),
                        path: path.to_owned(),
                        before: sample_text(text),
                        after: sample_text(&repaired),
                        layers,
                    });
                }
                *text = repaired;
            }
            TextRepair::Unresolved => preview.unresolved += 1,
            TextRepair::Unchanged => {}
        },
        Value::Array(values) => {
            for (index, item) in values.iter_mut().enumerate() {
                repair_value(item, root, scope, &format!("{path}/{index}"), preview);
            }
        }
        Value::Object(values) => {
            for (key, item) in values.iter_mut() {
                // Identity fields and barcodes link records and must not be
                // changed, even if a non-ASCII identifier resembles damage.
                if item.is_string()
                    && matches!(
                        key.as_str(),
                        "b" | "barcode" | "id" | "cid" | "productId" | "saleId" | "accountId"
                    )
                {
                    continue;
                }
                let escaped = key.replace('~', "~0").replace('/', "~1");
                repair_value(item, root, scope, &format!("{path}/{escaped}"), preview);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn sample_text(text: &str) -> String {
    let mut chars = text.chars();
    let mut sample: String = chars.by_ref().take(SAMPLE_CHAR_LIMIT).collect();
    if chars.next().is_some() {
        sample.push('…');
    }
    sample
}

#[derive(Debug, PartialEq, Eq)]
enum TextRepair {
    Unchanged,
    Changed { text: String, layers: usize },
    Unresolved,
}

fn repair_text(source: &str) -> TextRepair {
    if source.is_ascii() {
        return TextRepair::Unchanged;
    }
    // Replacement characters mean a previous read already discarded bytes.
    // Reject the entire field, including any apparently reversible portion.
    if source.contains('\u{fffd}') {
        return TextRepair::Unresolved;
    }
    let mut text = source.to_owned();
    let mut layers = 0;
    for _ in 0..MAX_LAYERS {
        match decode_pass(&text) {
            DecodePass::Invalid => return TextRepair::Unresolved,
            DecodePass::Unchanged => {
                return if layers == 0 {
                    TextRepair::Unchanged
                } else if text.chars().any(|ch| ('\u{80}'..='\u{9f}').contains(&ch)) {
                    TextRepair::Unresolved
                } else {
                    TextRepair::Changed { text, layers }
                };
            }
            DecodePass::Changed(next) => {
                text = next;
                layers += 1;
            }
        }
    }
    // Do not commit an eight-layer partial repair of a deeper damaged value.
    match decode_pass(&text) {
        DecodePass::Unchanged if !text.chars().any(|ch| ('\u{80}'..='\u{9f}').contains(&ch)) => {
            TextRepair::Changed { text, layers }
        }
        _ => TextRepair::Unresolved,
    }
}

enum DecodePass {
    Unchanged,
    Changed(String),
    Invalid,
}

fn decode_pass(source: &str) -> DecodePass {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    let mut changed = false;
    while index < chars.len() {
        let ch = chars[index];
        let Some(first) = cp1252_byte(ch).filter(|byte| is_mojibake_lead(*byte)) else {
            out.push(ch);
            index += 1;
            continue;
        };
        let width = if first < 0xe0 {
            2
        } else if first < 0xf0 {
            3
        } else {
            4
        };
        // A bare accented character is legitimate. It becomes a repair
        // candidate only with a following continuation-byte-shaped character.
        // This preserves e.g. Äpfel, ÜLKER, Müller and clean Turkish text.
        let Some(next) = chars.get(index + 1) else {
            out.push(ch);
            index += 1;
            continue;
        };
        let continuation =
            cp1252_byte(*next).is_some_and(|byte| (0x80..=0xbf).contains(&byte));
        let invalid_c1 = ('\u{80}'..='\u{9f}').contains(next) && cp1252_byte(*next).is_none();
        if !continuation && !invalid_c1 && *next != '\u{fffd}' {
            out.push(ch);
            index += 1;
            continue;
        }
        if index + width > chars.len() {
            return DecodePass::Invalid;
        }
        let mut bytes = [0_u8; 4];
        bytes[0] = first;
        for offset in 1..width {
            let Some(byte) = cp1252_byte(chars[index + offset]) else {
                return DecodePass::Invalid;
            };
            if !(0x80..=0xbf).contains(&byte) {
                return DecodePass::Invalid;
            }
            bytes[offset] = byte;
        }
        // Strict UTF-8 rejects overlong encodings, surrogate values, incomplete
        // sequences and values above U+10FFFF. No lossy conversion is used.
        let Ok(decoded) = std::str::from_utf8(&bytes[..width]) else {
            return DecodePass::Invalid;
        };
        // Undefined CP1252 controls may appear in an intermediate layer (for
        // example double-encoded ā), but a final C1 control is rejected above.
        if decoded.chars().any(|value| {
            value == '\u{fffd}'
                || (value.is_control()
                    && !matches!(value, '\u{81}' | '\u{8d}' | '\u{8f}' | '\u{90}' | '\u{9d}'))
        }) {
            return DecodePass::Invalid;
        }
        out.push_str(decoded);
        changed = true;
        index += width;
    }
    if changed {
        DecodePass::Changed(out)
    } else {
        DecodePass::Unchanged
    }
}

fn is_mojibake_lead(byte: u8) -> bool {
    // These cover Latin/Turkish letters, the special CP1252 punctuation which
    // appears in repeated damage, Unicode punctuation, BOM/replacement loss
    // and emoji. Other accented letters stay untouched to avoid guessing
    // about unrelated alphabets or accidental adjacent legitimate characters.
    matches!(byte, 0xc2..=0xc7 | 0xcb | 0xe2 | 0xef | 0xf0..=0xf4)
}

/// Exact inverse of the browser's Windows-1252 decoder. Undefined C1 bytes
/// 81, 8D, 8F, 90 and 9D map to the corresponding Unicode control values.
fn cp1252_byte(ch: char) -> Option<u8> {
    match ch {
        '\u{20ac}' => Some(0x80),
        '\u{81}' => Some(0x81),
        '\u{201a}' => Some(0x82),
        '\u{192}' => Some(0x83),
        '\u{201e}' => Some(0x84),
        '\u{2026}' => Some(0x85),
        '\u{2020}' => Some(0x86),
        '\u{2021}' => Some(0x87),
        '\u{2c6}' => Some(0x88),
        '\u{2030}' => Some(0x89),
        '\u{160}' => Some(0x8a),
        '\u{2039}' => Some(0x8b),
        '\u{152}' => Some(0x8c),
        '\u{8d}' => Some(0x8d),
        '\u{17d}' => Some(0x8e),
        '\u{8f}' => Some(0x8f),
        '\u{90}' => Some(0x90),
        '\u{2018}' => Some(0x91),
        '\u{2019}' => Some(0x92),
        '\u{201c}' => Some(0x93),
        '\u{201d}' => Some(0x94),
        '\u{2022}' => Some(0x95),
        '\u{2013}' => Some(0x96),
        '\u{2014}' => Some(0x97),
        '\u{2dc}' => Some(0x98),
        '\u{2122}' => Some(0x99),
        '\u{161}' => Some(0x9a),
        '\u{203a}' => Some(0x9b),
        '\u{153}' => Some(0x9c),
        '\u{9d}' => Some(0x9d),
        '\u{17e}' => Some(0x9e),
        '\u{178}' => Some(0x9f),
        '\u{0}'..='\u{7f}' | '\u{a0}'..='\u{ff}' => Some(ch as u8),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn corrupt(source: &str, layers: usize) -> String {
        const C1: [char; 32] = [
            '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹',
            'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•',
            '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
        ];
        let mut result = source.to_owned();
        for _ in 0..layers {
            result = result.bytes().map(|byte| {
                if (0x80..=0x9f).contains(&byte) {
                    C1[(byte - 0x80) as usize]
                } else {
                    char::from(byte)
                }
            }).collect();
        }
        result
    }

    fn one_root(value: Value) -> HashMap<String, String> {
        HashMap::from([("koc-prods".to_owned(), value.to_string())])
    }

    #[test]
    fn all_turkish_letters_reverse_one_through_eight_layers() {
        let clean = "İıĞğŞşÜüÖöÇç Koç Market";
        for layers in 1..=MAX_LAYERS {
            assert_eq!(repair_text(&corrupt(clean, layers)), TextRepair::Changed {
                text: clean.to_owned(), layers,
            }, "failed at {layers} layers");
        }
    }

    #[test]
    fn photographed_products_reverse_repeated_damage() {
        for clean in [
            "WİNSTONE DARK BLUE",
            "TADELLE KIRMIZI SÜTLÜ ÇİKOLATA 30GR",
            "OLİPS EXRA ŞEKER 28 GR",
            "ÜLKER ÇİKOLATALI GOFRET",
        ] {
            for layers in [1, 2, 3, 4] {
                assert_eq!(repair_text(&corrupt(clean, layers)), TextRepair::Changed {
                    text: clean.to_owned(), layers,
                });
            }
        }
    }

    #[test]
    fn mixed_clean_turkish_german_and_emoji_stay_intact() {
        let clean = "İÇECEK Müller Äpfel ÜLKER € 😀 ";
        let broken = format!("{clean}{}", corrupt("ŞÖLEN ÇİKOLATA 😎", 3));
        assert_eq!(repair_text(&broken), TextRepair::Changed {
            text: format!("{clean}ŞÖLEN ÇİKOLATA 😎"), layers: 3,
        });
        assert_eq!(repair_text(clean), TextRepair::Unchanged);
        assert_eq!(repair_text("TADELLE GOOL 33GR MAGNUM SANDWICH BADEM"), TextRepair::Unchanged);
    }

    #[test]
    fn clean_strings_and_ambiguous_accents_are_unchanged() {
        for clean in ["Âge", "Ã", "Äpfel", "Åland", "ïve", "ð", "ĞÜŞİÖÇ", "çağrı", "Ö¼", "emoji 🧑🏽‍💻"] {
            assert_eq!(repair_text(clean), TextRepair::Unchanged, "{clean}");
        }
    }

    #[test]
    fn undefined_cp1252_bytes_are_fully_reversible() {
        let clean = "ā č ď Đ ŝ";
        for layers in 1..=3 {
            assert_eq!(repair_text(&corrupt(clean, layers)), TextRepair::Changed {
                text: clean.to_owned(), layers,
            });
        }
        for byte in 0_u8..=255 {
            let decoded = if (0x80..=0x9f).contains(&byte) {
                // The forward decoder used in simulated damage is also used
                // for the complete C1 inverse round-trip check.
                let marker = format!("{}", char::from(byte));
                let bytes = [0xc2, byte];
                if let Ok(valid) = std::str::from_utf8(&bytes) {
                    corrupt(valid, 1).chars().nth(1).unwrap()
                } else {
                    marker.chars().next().unwrap()
                }
            } else { char::from(byte) };
            assert_eq!(cp1252_byte(decoded), Some(byte));
        }
    }

    #[test]
    fn loss_invalid_utf8_and_partial_candidates_are_unresolved() {
        for source in [
            "ÜLKER �", "Ã�LKER", "ï¿½", "â€", "â€X", "Ã\u{80}",
            "ðŸ€", "Â\u{81}", "ÃœLKER â€X", "ÄŸ doğru �",
        ] {
            assert_eq!(repair_text(source), TextRepair::Unresolved, "{source:?}");
        }
        assert_eq!(repair_text(&corrupt("ÜLKER", 9)), TextRepair::Unresolved);
    }

    #[test]
    fn historical_and_new_sales_keep_ids_prices_barcodes_and_counts() {
        let historical = json!({
            "id": "sale-20261004-001", "date": "2026-10-04", "total": 160.5,
            "items": [
                {"barcode": "8690504012345", "name": corrupt("ÜLKER ÇİKOLATA", 3), "price": 40.0, "qty": 2},
                {"barcode": "8690504012346", "name": corrupt("İÇİM SÜT", 2), "price": 80.5, "qty": 1}
            ]
        });
        let recent = json!({
            "id": "sale-20261005-009", "date": "2026-10-05", "total": 120,
            "items": [{"barcode": "8690504012347", "name": "WİNSTONE DARK BLUE", "price": 120, "qty": 1}]
        });
        let mut mem = one_root(json!([
            {"barcode": "8690504012345", "name": corrupt("ÜLKER ÇİKOLATA", 3), "price": 40.0, "stock": 15},
            {"barcode": "8690504012347", "name": "WİNSTONE DARK BLUE", "price": 120, "stock": 24}
        ]));
        let original_sales = json!([historical, recent]);
        mem.insert("koc-sales".to_owned(), original_sales.to_string());
        let original_products: Value = serde_json::from_str(&mem["koc-prods"]).unwrap();
        let result = plan(&mem).unwrap();
        assert_eq!(result.preview.changes, 3);
        assert_eq!(result.preview.product_changes, 1);
        assert_eq!(result.preview.sale_changes, 2);
        let mut expected_products = original_products;
        expected_products[0]["name"] = json!("ÜLKER ÇİKOLATA");
        let mut expected_sales = original_sales;
        expected_sales[0]["items"][0]["name"] = json!("ÜLKER ÇİKOLATA");
        expected_sales[0]["items"][1]["name"] = json!("İÇİM SÜT");
        assert_eq!(serde_json::from_str::<Value>(&result.after["koc-prods"]).unwrap(), expected_products);
        assert_eq!(serde_json::from_str::<Value>(&result.after["koc-sales"]).unwrap(), expected_sales);
        assert_eq!(result.before["koc-prods"], mem["koc-prods"]);
        assert_eq!(result.before["koc-sales"], mem["koc-sales"]);
    }

    #[test]
    fn object_keys_numbers_and_backup_roots_are_untouched() {
        let key = corrupt("İSİM", 2);
        let mut mem = one_root(json!({key.clone(): corrupt("ŞÖLEN", 2), "price": 45.75, "count": 7, "ok": true}));
        for root in ["koc-backups", "koc-prods-backup", "unknown-root"] {
            mem.insert(root.to_owned(), "invalid backup JSON Ãœ".to_owned());
        }
        let untouched = mem.clone();
        let result = plan(&mem).unwrap();
        assert_eq!(mem, untouched);
        assert_eq!(result.before.len(), 1);
        assert_eq!(result.after.len(), 1);
        let repaired: Value = serde_json::from_str(&result.after["koc-prods"]).unwrap();
        assert_eq!(repaired[&key], "ŞÖLEN");
        assert_eq!(repaired["price"], 45.75);
        assert_eq!(repaired["count"], 7);
        assert_eq!(repaired["ok"], true);
    }

    #[test]
    fn non_ascii_identity_strings_are_never_repaired() {
        let damaged_id = corrupt("ŞİRKET-ÖZER", 2);
        let value = json!({
            "b": damaged_id, "barcode": damaged_id, "id": damaged_id,
            "cid": damaged_id, "productId": damaged_id, "saleId": damaged_id,
            "accountId": damaged_id, "name": corrupt("İÇİM", 2),
            "nested": [{"id": damaged_id, "name": corrupt("ŞÖLEN", 1)}]
        });
        let result = plan(&one_root(value.clone())).unwrap();
        assert_eq!(result.preview.changes, 2);
        let repaired: Value = serde_json::from_str(&result.after["koc-prods"]).unwrap();
        for key in ["b", "barcode", "id", "cid", "productId", "saleId", "accountId"] {
            assert_eq!(repaired[key], value[key]);
        }
        assert_eq!(repaired["nested"][0]["id"], value["nested"][0]["id"]);
        assert_eq!(repaired["name"], "İÇİM");
        assert_eq!(repaired["nested"][0]["name"], "ŞÖLEN");
    }

    #[test]
    fn special_cp1252_punctuation_and_emoji_reverse_all_supported_layers() {
        let clean = "Müller ß ‘çikolata’ “İÇİM” 5€ ™ ‰ ˆ ˜ 😀 ✅ 🧑🏽‍💻";
        for layers in 1..=MAX_LAYERS {
            assert_eq!(repair_text(&corrupt(clean, layers)), TextRepair::Changed {
                text: clean.to_owned(), layers,
            }, "failed at {layers} layers");
        }
    }

    #[test]
    fn held_and_nested_cari_state_are_repaired() {
        let mut mem = HashMap::new();
        mem.insert("koc-held".to_owned(), json!([{"items": [{"name": corrupt("İÇİM", 3)}]}]).to_string());
        mem.insert("koc-cari-state".to_owned(), json!({"customers": [{"name": corrupt("ÖZER", 2), "entries": [{"note": corrupt("ŞÖLEN borç", 1), "amount": 45}]}]}).to_string());
        let result = plan(&mem).unwrap();
        assert_eq!(result.preview.other_changes, 3);
        assert_eq!(result.preview.changes, 3);
        assert_eq!(result.preview.unresolved, 0);
        assert_eq!(result.after.len(), 2);
    }

    #[test]
    fn active_recovery_copies_are_repaired_independently_and_counted_separately() {
        let mut mem = one_root(json!([{ "name": corrupt("ÜLKER", 3), "stock": 5 }]));
        mem.insert("koc-prods-shadow".to_owned(), json!([{ "name": corrupt("İÇİM", 2), "stock": 4 }]).to_string());
        mem.insert("koc-sales-emergency".to_owned(), json!([{ "name": corrupt("ŞÖLEN", 1), "id": "sale-previous", "price": 30 }]).to_string());
        mem.insert("koc-prods-emergency".to_owned(), "[ { \"name\": \"ÇİÇEK\" } ]".to_owned());
        mem.insert("koc-backups".to_owned(), "archived invalid JSON remains untouched".to_owned());
        let result = plan(&mem).unwrap();
        assert_eq!(result.preview.changes, 3);
        assert_eq!(result.preview.product_changes, 1);
        assert_eq!(result.preview.sale_changes, 0);
        assert_eq!(result.preview.other_changes, 2);
        assert_eq!(result.after.len(), 3);
        assert!(!result.after.contains_key("koc-prods-emergency"));
        assert_eq!(result.preview.samples[1].scope, "Kurtarma kopyası");
        let shadow: Value = serde_json::from_str(&result.after["koc-prods-shadow"]).unwrap();
        assert_eq!(shadow[0]["name"], "İÇİM");
        assert_eq!(shadow[0]["stock"], 4);
        let emergency: Value = serde_json::from_str(&result.after["koc-sales-emergency"]).unwrap();
        assert_eq!(emergency[0]["name"], "ŞÖLEN");
        assert_eq!(emergency[0]["id"], "sale-previous");
        assert_eq!(emergency[0]["price"], 30);
    }

    #[test]
    fn repair_is_idempotent_and_clean_roots_keep_original_bytes() {
        let mut mem = one_root(json!([{"name": corrupt("ÜLKER", 3)}, {"name": "İÇİM"}]));
        mem.insert("koc-sales".to_owned(), " [ { \"name\" : \"ŞÖLEN\", \"price\" : 35 } ] ".to_owned());
        let result = plan(&mem).unwrap();
        assert!(!result.after.contains_key("koc-sales"));
        mem.extend(result.after);
        let second = plan(&mem).unwrap();
        assert_eq!(second.preview.changes, 0);
        assert_eq!(second.preview.unresolved, 0);
        assert!(second.before.is_empty());
        assert!(second.after.is_empty());
    }

    #[test]
    fn invalid_json_in_any_target_root_aborts_the_whole_plan() {
        let mut mem = one_root(json!([{ "name": corrupt("ÜLKER", 2) }]));
        mem.insert("koc-cari-state".to_owned(), "{broken".to_owned());
        let before = mem.clone();
        let error = plan(&mem).unwrap_err();
        assert!(error.contains("koc-cari-state"));
        assert_eq!(mem, before);
    }

    #[test]
    fn unresolved_fields_are_counted_once_and_left_entirely_unchanged() {
        let value = json!([{"name": "ÜLKER �"}, {"name": "ÃœLKER â€X"}, {"name": corrupt("İÇİM", 2)}]);
        let mem = one_root(value.clone());
        let result = plan(&mem).unwrap();
        assert_eq!(result.preview.unresolved, 2);
        assert_eq!(result.preview.changes, 1);
        let repaired: Value = serde_json::from_str(&result.after["koc-prods"]).unwrap();
        assert_eq!(repaired[0], value[0]);
        assert_eq!(repaired[1], value[1]);
        assert_eq!(repaired[2]["name"], "İÇİM");
    }

    #[test]
    fn script_like_strings_remain_inert_data() {
        let clean = "</script><script>alert('İÇİM')</script> & <img src=x onerror=alert('Ş')>";
        let mem = one_root(json!({"name": corrupt(clean, 3)}));
        let result = plan(&mem).unwrap();
        let repaired: Value = serde_json::from_str(&result.after["koc-prods"]).unwrap();
        assert_eq!(repaired["name"], clean);
        assert_eq!(result.preview.samples[0].after, clean);
    }

    #[test]
    fn previews_are_bounded_and_json_pointer_paths_are_escaped() {
        let clean = format!("Ü{}Ş", "x".repeat(200));
        let values: Vec<Value> = (0..35).map(|_| json!({"a/~b": corrupt(&clean, 2)})).collect();
        let mem = one_root(json!(values));
        let result = plan(&mem).unwrap();
        assert_eq!(result.preview.changes, 35);
        assert_eq!(result.preview.samples.len(), MAX_SAMPLES);
        assert_eq!(result.preview.samples[0].path, "/0/a~1~0b");
        assert_eq!(result.preview.samples[0].layers, 2);
        assert_eq!(result.preview.samples[0].after.chars().count(), SAMPLE_CHAR_LIMIT + 1);
        assert!(result.preview.samples[0].after.ends_with('…'));
        let repaired: Value = serde_json::from_str(&result.after["koc-prods"]).unwrap();
        assert_eq!(repaired[34]["a/~b"], clean);
    }
}
