// Windows'ta release sürümünde arka planda konsol penceresi açılmasın
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    koc_market_lib::run()
}
