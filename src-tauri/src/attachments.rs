//! Files the user attaches to a message: pictures and text documents.
//!
//! A picked file is checked and copied into pantheon's own folder straight away.
//! The copy is what the preview shows, what the transcript links to and what
//! the agent reads, so moving or editing the original afterwards changes
//! nothing about a message already written. Nothing outside that folder is
//! ever sent: the frontend names attachments by path, and a path from the
//! window is checked here again rather than trusted.
//!
//! Pictures go to each agent the way it wants them (see `pantheon_harness`).
//! Text documents are folded into the message itself, labelled with their
//! names, because every model reads that the same way and neither CLI has to
//! be given access to pantheon's folder.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use pantheon_engine::{ImageInput, TurnInput};
use serde::Serialize;

/// Pictures both vendors accept. BMP is not one of them.
const IMAGES: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// Claude's API refuses a picture larger than this.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Roughly 60,000 tokens of text: a long document, not a context window.
pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// Attachments on one message.
pub const MAX_PER_MESSAGE: usize = 10;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Where attachments are kept: `attachments` in the app's data folder. Set
/// once at startup; without it, attaching says it is unavailable.
pub fn prepare(data_dir: Option<PathBuf>) {
    let Some(dir) = data_dir.map(|dir| dir.join("attachments")) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = ROOT.set(dir);
    }
}

pub fn root() -> Option<&'static Path> {
    ROOT.get().map(PathBuf::as_path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Image,
    Text,
}

/// An attachment as the window sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Pantheon's own copy. The window names the attachment by this.
    pub path: String,
    /// The original file name, for display.
    pub name: String,
    pub kind: AttachmentKind,
    pub size: u64,
}

/// What a pick produced: the files taken and, for the rest, why not.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub attached: Vec<Attachment>,
    pub refused: Vec<String>,
}

/// An attachment ready to go to an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub attachment: Attachment,
    pub mime: Option<&'static str>,
    pub bytes: Vec<u8>,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

/// Whether the bytes are really the picture the name says.
///
/// A renamed file would otherwise be sent with the wrong type and refused by
/// the vendor mid-turn, which is a worse place to find out.
fn looks_like(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// Text a model can read: UTF-8, with no NUL bytes, which only binaries have.
fn readable_text(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?;
    (!text.contains('\0')).then(|| text.strip_prefix('\u{feff}').unwrap_or(text))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| "file".to_owned(), |n| n.to_string_lossy().into_owned())
}

/// Decides what a file is, or why it cannot be sent.
pub fn load(path: &Path, name: String) -> Result<Loaded, String> {
    let size = std::fs::metadata(path)
        .map_err(|_| format!("{name} could not be read"))?
        .len();
    if let Some(mime) = image_mime(path) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "{name} is larger than 5 MB, the limit for a picture"
            ));
        }
        let bytes = std::fs::read(path).map_err(|_| format!("{name} could not be read"))?;
        if !looks_like(mime, &bytes) {
            return Err(format!("{name} is not the picture its name says"));
        }
        return Ok(Loaded {
            attachment: Attachment {
                path: path.to_string_lossy().into_owned(),
                name,
                kind: AttachmentKind::Image,
                size,
            },
            mime: Some(mime),
            bytes,
        });
    }
    if size > MAX_TEXT_BYTES {
        return Err(format!(
            "{name} is larger than 256 KB, the limit for a text document"
        ));
    }
    let bytes = std::fs::read(path).map_err(|_| format!("{name} could not be read"))?;
    if readable_text(&bytes).is_none() {
        return Err(format!(
            "{name} is not a picture or a text document. Pantheon can send PNG, JPEG, GIF and WebP pictures, and plain-text files such as .txt, .md, .csv, .json or code."
        ));
    }
    Ok(Loaded {
        attachment: Attachment {
            path: path.to_string_lossy().into_owned(),
            name,
            kind: AttachmentKind::Text,
            size,
        },
        mime: None,
        bytes,
    })
}

/// Checks a picked file and copies it into `root`.
///
/// Each copy gets a folder of its own so the original name survives and two
/// files called `notes.md` cannot collide.
pub fn import(root: &Path, source: &Path) -> Result<Attachment, String> {
    let name = display_name(source);
    load(source, name.clone())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut dir = root.join(format!("{stamp:x}"));
    let mut n = 1;
    while dir.exists() {
        dir = root.join(format!("{stamp:x}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|_| format!("{name} could not be copied"))?;
    let copy = dir.join(&name);
    std::fs::copy(source, &copy).map_err(|_| format!("{name} could not be copied"))?;
    // Checked again as the copy, which is what will actually be sent.
    load(&copy, name).map(|loaded| loaded.attachment)
}

/// Reads an attachment the window named, refusing anything outside `root`.
///
/// `canonicalize` is what makes this a check rather than a formality: without
/// it `attachments\..\pantheon.db` passes a prefix test.
pub fn resolve(root: &Path, path: &str) -> Result<Loaded, String> {
    let refused =
        || "an attachment is no longer available; remove it and attach it again".to_owned();
    let real = std::fs::canonicalize(path).map_err(|_| refused())?;
    let root = std::fs::canonicalize(root).map_err(|_| refused())?;
    if !real.starts_with(&root) || !real.is_file() {
        return Err(refused());
    }
    let mut loaded = load(&real, display_name(&real))?;
    // Keep the path as the window and the transcript know it.
    path.clone_into(&mut loaded.attachment.path);
    Ok(loaded)
}

/// One user message for the agent: the words, the documents labelled after
/// them, and the pictures alongside.
pub fn turn_input(text: &str, attachments: &[Loaded]) -> TurnInput {
    let mut message = text.to_owned();
    for loaded in attachments {
        if loaded.attachment.kind != AttachmentKind::Text {
            continue;
        }
        let content = readable_text(&loaded.bytes).unwrap_or_default();
        if !message.is_empty() {
            message.push_str("\n\n");
        }
        let _ = write!(
            message,
            "<attached_file name=\"{}\">\n{}\n</attached_file>",
            loaded.attachment.name.replace('"', "'"),
            content.trim_end()
        );
    }
    let images = attachments
        .iter()
        .filter_map(|loaded| {
            Some(ImageInput {
                path: loaded.attachment.path.clone(),
                mime: loaded.mime?.to_owned(),
                bytes: loaded.bytes.clone(),
            })
        })
        .collect();
    TurnInput {
        text: message,
        images,
    }
}

/// What the transcript records on the user's row, so the message shows its
/// attachments when the chat is reopened. `images` is the key pictures
/// already use, so the existing viewer shows them.
pub fn block_meta(attachments: &[Attachment]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }
    let images: Vec<&str> = attachments
        .iter()
        .filter(|a| a.kind == AttachmentKind::Image)
        .map(|a| a.path.as_str())
        .collect();
    let files: Vec<serde_json::Value> = attachments
        .iter()
        .filter(|a| a.kind == AttachmentKind::Text)
        .map(|a| serde_json::json!({ "name": a.name, "path": a.path, "size": a.size }))
        .collect();
    Some(serde_json::json!({ "images": images, "files": files }).to_string())
}

#[cfg(test)]
mod tests {
    use super::{block_meta, import, resolve, turn_input, AttachmentKind, MAX_TEXT_BYTES};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn folder(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base =
            std::env::temp_dir().join(format!("pantheon-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("attachments");
        std::fs::create_dir_all(&root).expect("root");
        (base, root)
    }

    #[test]
    fn pictures_and_text_are_copied_and_classified() {
        let (base, root) = folder("classify");
        std::fs::write(base.join("cat.png"), PNG).expect("png");
        std::fs::write(base.join("notes.md"), "# Notes\nhello").expect("md");

        let image = import(&root, &base.join("cat.png")).expect("image");
        let text = import(&root, &base.join("notes.md")).expect("text");
        assert_eq!(image.kind, AttachmentKind::Image);
        assert_eq!(text.kind, AttachmentKind::Text);
        assert_eq!(text.name, "notes.md");
        assert!(std::path::Path::new(&image.path).starts_with(&root));
        // Two files with one name do not collide.
        let again = import(&root, &base.join("notes.md")).expect("again");
        assert_ne!(again.path, text.path);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn binaries_renamed_pictures_and_oversized_text_are_refused() {
        let (base, root) = folder("refuse");
        std::fs::write(base.join("app.exe"), b"MZ\0\0binary").expect("exe");
        std::fs::write(base.join("fake.png"), b"not a picture").expect("fake");
        std::fs::write(
            base.join("huge.txt"),
            "x".repeat(usize::try_from(MAX_TEXT_BYTES).unwrap_or(0) + 1),
        )
        .expect("huge");
        for name in ["app.exe", "fake.png", "huge.txt"] {
            assert!(
                import(&root, &base.join(name)).is_err(),
                "{name} should be refused"
            );
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn only_pantheons_own_copies_can_be_sent() {
        let (base, root) = folder("resolve");
        std::fs::write(base.join("secret.txt"), "private").expect("secret");
        std::fs::write(base.join("ok.txt"), "fine").expect("ok");
        let kept = import(&root, &base.join("ok.txt")).expect("import");
        assert!(resolve(&root, &kept.path).is_ok());
        assert!(resolve(&root, &base.join("secret.txt").to_string_lossy()).is_err());
        let escape = root.join("..").join("secret.txt");
        assert!(resolve(&root, &escape.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn documents_are_labelled_in_the_message_and_pictures_ride_alongside() {
        let (base, root) = folder("input");
        std::fs::write(base.join("cat.png"), PNG).expect("png");
        std::fs::write(base.join("notes.md"), "\u{feff}line one\n").expect("md");
        let image = import(&root, &base.join("cat.png")).expect("image");
        let text = import(&root, &base.join("notes.md")).expect("text");
        let loaded = [
            resolve(&root, &image.path).expect("i"),
            resolve(&root, &text.path).expect("t"),
        ];

        let input = turn_input("Summarise this", &loaded);
        assert_eq!(
            input.text,
            "Summarise this\n\n<attached_file name=\"notes.md\">\nline one\n</attached_file>"
        );
        assert_eq!(input.images.len(), 1);
        assert_eq!(input.images[0].mime, "image/png");
        assert_eq!(input.images[0].path, image.path);

        let meta: serde_json::Value =
            serde_json::from_str(&block_meta(&[image.clone(), text]).expect("meta")).expect("json");
        assert_eq!(meta["images"][0], image.path.as_str());
        assert_eq!(meta["files"][0]["name"], "notes.md");
        assert!(block_meta(&[]).is_none());
        let _ = std::fs::remove_dir_all(base);
    }
}
