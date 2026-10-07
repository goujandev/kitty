// Release builds must not attach a console, or launching pantheon from Explorer
// flashes a terminal window behind it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pantheon_lib::run();
}
