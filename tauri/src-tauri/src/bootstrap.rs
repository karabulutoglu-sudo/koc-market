//! HTML kodlamasından bağımsız, kayıpsız açılış verisi aktarımı.

use std::fmt::Write;

const BRIDGE_JS: &str = include_str!("bridge.js");
const UTF8_META: &str = "<meta charset=\"UTF-8\">";
pub const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";

/// JSON ve köprüdeki string/comment karakterlerini JS UTF-16 kaçışlarına çevir.
/// ASCII karakterler (özellikle mevcut JSON kaçışları) aynen korunur.
fn ascii_js(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for ch in source.chars() {
        if ch.is_ascii() {
            out.push(ch);
        } else {
            for unit in ch.encode_utf16(&mut [0; 2]) {
                write!(out, "\\u{unit:04x}").expect("String'e yazma");
            }
        }
    }
    out
}

/// boot_json, serde_json ile üretilmiş JSON'dur; köprüden önce yüklenir.
pub fn build_boot_script(boot_json: &str) -> String {
    // JSON string'indeki </script> ve <!-- HTML ayrıştırıcısını etkileyemez.
    let boot_json = ascii_js(&boot_json.replace('<', "\\u003c"));
    let bridge = ascii_js(BRIDGE_JS);
    format!(
        "<script>window.__KOC_BOOT__={boot_json};</script>\n<script>{bridge}</script>\n"
    )
}

pub fn inject_into_html(html: &[u8], boot: &str) -> Vec<u8> {
    let s = String::from_utf8_lossy(html);
    let lower = s.to_ascii_lowercase();
    if let Some(pos) = lower.find("<head") {
        if let Some(end) = lower[pos..].find('>') {
            let head_end = pos + end + 1;
            // Ortak index.html'in ilk head elemanı UTF-8 bildirimidir.
            // Megabaytlarca açılış verisi bu bildirimi ilk 1024 bayttan dışarı itmez.
            let rest = &lower[head_end..];
            let trimmed = rest.trim_start();
            if trimmed.starts_with(&UTF8_META.to_ascii_lowercase()) {
                let at = head_end + rest.len() - trimmed.len() + UTF8_META.len();
                return format!("{}\n{boot}{}", &s[..at], &s[at..]).into_bytes();
            }
            // Bildirim kaldırılmış olsa bile köprüden önce UTF-8'i belirt.
            return format!(
                "{}\n{UTF8_META}\n{boot}{}", &s[..head_end], &s[head_end..]
            ).into_bytes();
        }
    }
    format!("{UTF8_META}\n{boot}{s}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turkish_and_surrogate_pairs_are_lossless() {
        assert_eq!(
            ascii_js("İıĞğŞşÜüÖöÇç ✅ 😀"),
            "\\u0130\\u0131\\u011e\\u011f\\u015e\\u015f\\u00dc\\u00fc\\u00d6\\u00f6\\u00c7\\u00e7 \\u2705 \\ud83d\\ude00"
        );
        assert_eq!(ascii_js(r#"\"\\\n\u0130"#), r#"\"\\\n\u0130"#);
    }

    #[test]
    fn entire_boot_and_bridge_are_ascii_and_script_safe() {
        let script = build_boot_script(
            r#"{"engine":"kapalı","report":{"warnings":["Koç Market"]},"data":{"ürün":"İÇİM </script><script> <!-- 😀"}}"#
        );
        assert!(script.is_ascii());
        assert!(script.contains(r#""engine":"kapal\u0131""#));
        assert!(script.contains(r#""\u00fcr\u00fcn":"\u0130\u00c7\u0130M \u003c/script>\u003cscript> \u003c!-- \ud83d\ude00""#));
        assert_eq!(script.matches("<script>").count(), 2);
        assert_eq!(script.matches("</script>").count(), 2);
        assert!(script.contains("window.kocStore = Object.freeze(kocStore)"));
    }

    #[test]
    fn megabytes_of_data_stay_after_charset_and_before_app_scripts() {
        let html = include_bytes!("../../../index.html");
        let boot = build_boot_script(&format!(r#"{{"data":{{"koc-prods":"{}ÜLKER"}}}}"#, "x".repeat(2_000_000)));
        let injected = String::from_utf8(inject_into_html(html, &boot)).unwrap();
        let meta = injected.find(UTF8_META).unwrap();
        let start = injected.find("window.__KOC_BOOT__").unwrap();
        assert!(meta + UTF8_META.len() < 1024);
        assert!(meta < start);
        assert!(start < injected.find("<script src=").unwrap());
        assert_eq!(injected.matches(UTF8_META).count(), 1);
        // Enjeksiyon çıkarılınca uygulama dosyası bayt bayt aynıdır.
        assert_eq!(injected.replacen(&format!("\n{boot}"), "", 1).as_bytes(), html);
    }

    #[test]
    fn head_and_charset_are_case_insensitive() {
        let html = b"<!doctype html><HTML><HEAD lang=\"tr\">\r\n<META CHARSET=\"UTF-8\"><script>app()</script></HEAD></HTML>";
        let boot = "<script>boot()</script>";
        let result = String::from_utf8(inject_into_html(html, boot)).unwrap();
        assert!(result.contains("<META CHARSET=\"UTF-8\">\n<script>boot()</script><script>app()</script>"));
    }

    #[test]
    fn missing_charset_gets_a_declaration_before_boot() {
        let result = String::from_utf8(inject_into_html(
            b"<html><head><script>app()</script></head></html>", "<script>boot()</script>"
        )).unwrap();
        assert!(result.starts_with("<html><head>\n<meta charset=\"UTF-8\">\n<script>boot()</script><script>app()"));
    }

    #[test]
    fn missing_head_still_declares_utf8_before_boot() {
        let result = String::from_utf8(inject_into_html(b"<p>app</p>", "<script>boot()</script>")).unwrap();
        assert!(result.starts_with("<meta charset=\"UTF-8\">\n<script>boot()</script>"));
    }
}
