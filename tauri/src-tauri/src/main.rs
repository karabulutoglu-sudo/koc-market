// Windows'ta release sürümünde arka planda konsol penceresi açılmasın
#![cfg_attr(not(any(debug_assertions, feature = "verify-build")), windows_subsystem = "windows")]

fn main() {
    koc_market_lib::run()
}
