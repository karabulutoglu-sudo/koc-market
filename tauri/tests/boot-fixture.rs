#[path = "../src-tauri/src/bootstrap.rs"]
mod bootstrap;

use std::io::{self, Read, Write};

fn main() {
    let mut boot_json = String::new();
    io::stdin().read_to_string(&mut boot_json).unwrap();
    let boot = bootstrap::build_boot_script(&boot_json);
    let html = bootstrap::inject_into_html(include_bytes!("../../index.html"), &boot);
    io::stdout().write_all(&html).unwrap();
}
