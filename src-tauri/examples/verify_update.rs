//! Release check: verify the installer using the exact key embedded in Pantheon.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs};

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("pass the NSIS installer path")?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("missing updater public key")?;
    let key = PublicKey::decode(&String::from_utf8(STANDARD.decode(key)?)?)?;
    let signature = fs::read_to_string(format!("{path}.sig"))?;
    let signature = Signature::decode(&String::from_utf8(STANDARD.decode(signature.trim())?)?)?;
    let mut bytes = fs::read(path)?;
    key.verify(&bytes, &signature, false)?;
    // Verify rejection too, without writing a modified installer to disk.
    let first = bytes.first_mut().ok_or("empty installer")?;
    *first ^= 1;
    if key.verify(&bytes, &signature, false).is_ok() {
        return Err("modified installer unexpectedly passed verification".into());
    }
    println!("Installer signature verified; modified installer rejected.");
    Ok(())
}
