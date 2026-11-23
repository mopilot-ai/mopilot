//! One record file written whole or not at all (`store.writeRecord`, the chat store's commit): the bytes go to a
//! temporary sibling, which takes the permissions the file had and replaces it by a rename, so a reader, or a crash at
//! any point, sees the old file whole or the new one. Step for step what electron/platform/fsutil.cjs `writeAtomic` does,
//! which every other state file still uses: no fsync, the folder made when missing, and in the data folder (`private`)
//! the file and the folders made for it owner-only.

use crate::errors::uv_name;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The permissions of a new private file, and of a folder made for one (electron/platform/privateFiles.cjs).
pub const PRIVATE_FILE: u32 = 0o600;
pub const PRIVATE_DIR: u32 = 0o700;

/// One write: where, through which temporary sibling, and what.
pub struct Ask<'a> {
    pub file: &'a Path,
    pub temp: &'a Path,
    /// under the data folder, whose files are owner-only whatever they were
    pub private: bool,
    pub data: &'a [u8],
}

/// A step that failed, with what Node's error for it named, and why the temporary file could not be removed after.
#[derive(Debug)]
pub struct Failure {
    pub error: io::Error,
    pub syscall: &'static str,
    pub path: Option<PathBuf>,
    pub dest: Option<PathBuf>,
    /// Node's message for removing the temporary file failing, when it did
    pub cleanup: Option<String>,
}

impl Failure {
    fn at(syscall: &'static str, path: Option<&Path>, dest: Option<&Path>) -> impl FnOnce(io::Error) -> Failure {
        let (path, dest) = (path.map(Path::to_path_buf), dest.map(Path::to_path_buf));
        move |error| Failure { error, syscall, path, dest, cleanup: None }
    }

    /// Node's message for it: `ENOSPC: no space left on device, write`, `EACCES: permission denied, open '<path>'`,
    /// `EISDIR: illegal operation on a directory, rename '<from>' -> '<to>'`.
    pub fn message(&self) -> String {
        let (code, text) = uv_name(&self.error);
        let quoted = |p: &Option<PathBuf>, lead: &str| p.as_ref().map_or(String::new(), |p| format!("{lead}'{}'", p.display()));
        format!("{code}: {text}, {}{}{}", self.syscall, quoted(&self.path, " "), quoted(&self.dest, " -> "))
    }

    /// The failure as the route's error, for JS to throw as Node would have: `code`, `syscall`, `path`, `dest`,
    /// `message`, and `cleanup` when the temporary file stayed.
    pub fn reply(&self) -> String {
        let text = |p: &Option<PathBuf>| p.as_ref().map(|p| p.display().to_string());
        serde_json::json!({
            "code": uv_name(&self.error).0,
            "syscall": self.syscall,
            "path": text(&self.path),
            "dest": text(&self.dest),
            "message": self.message(),
            "cleanup": self.cleanup,
        })
        .to_string()
    }
}

/// The file-system steps a write takes, as a trait so a test can fail any one (a full disk, a folder that went read-only).
pub trait Steps {
    type File;
    /// The mode of what is at `file`, following a link; None when nothing is there (as `statSync` with
    /// `throwIfNoEntry: false` says of a missing entry or a path through a file).
    fn mode(&self, file: &Path) -> io::Result<Option<u32>>;
    /// `dir` and the folders above it, made with `mode` where missing.
    fn make_folder(&self, dir: &Path, mode: u32) -> io::Result<()>;
    /// A new file at `file` for writing, made with `mode`.
    fn create(&self, file: &Path, mode: u32) -> io::Result<Self::File>;
    fn write(&self, open: &mut Self::File, data: &[u8]) -> io::Result<()>;
    /// The file closed, saying whether that failed: a network or over-quota disk can report a write's failure only here.
    fn close(&self, open: Self::File) -> io::Result<()>;
    fn chmod(&self, file: &Path, mode: u32) -> io::Result<()>;
    /// `from` in place of `to`, replacing it.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// `file` gone; one that is not there is fine.
    fn remove(&self, file: &Path) -> io::Result<()>;
}

/// `ask.data` at `ask.file`, published by renaming `ask.temp` over it. The file keeps the mode it had (a private one
/// loses group and other access); a new one takes 0600 when private, else what the umask leaves of 0666. A failure
/// after the temporary file may exist removes it, and the failure is the step's, never the removal's.
pub fn write_atomic<S: Steps>(steps: &S, ask: &Ask) -> Result<(), Failure> {
    let kept = steps.mode(ask.file).map_err(Failure::at("stat", Some(ask.file), None))?;
    let kept = kept.or(ask.private.then_some(PRIVATE_FILE));
    let mode = if ask.private { kept.map(|m| m & PRIVATE_DIR) } else { kept };
    let dir = ask.file.parent().unwrap_or(Path::new(""));
    let folder = if ask.private { PRIVATE_DIR } else { 0o777 };
    steps.make_folder(dir, folder).map_err(Failure::at("mkdir", Some(dir), None))?;
    publish(steps, ask, mode).map_err(|mut failure| {
        failure.cleanup = steps.remove(ask.temp).err().map(|e| Failure::at("rm", Some(ask.temp), None)(e).message());
        failure
    })
}

/// The temporary file written, given its mode and renamed over the file.
fn publish<S: Steps>(steps: &S, ask: &Ask, mode: Option<u32>) -> Result<(), Failure> {
    let mut open = steps.create(ask.temp, mode.map_or(0o666, |m| m & 0o777)).map_err(Failure::at("open", Some(ask.temp), None))?;
    steps.write(&mut open, ask.data).map_err(Failure::at("write", None, None))?;
    // a close that fails may mean bytes that never landed: the temporary file is not published
    steps.close(open).map_err(Failure::at("close", None, None))?;
    // creating it applied the umask: the bits the file had come back before it is published
    if let Some(m) = mode {
        steps.chmod(ask.temp, m & 0o777).map_err(Failure::at("chmod", Some(ask.temp), None))?;
    }
    steps.rename(ask.temp, ask.file).map_err(Failure::at("rename", Some(ask.temp), Some(ask.file)))
}

/// The real file system.
pub struct Disk;

impl Steps for Disk {
    type File = fs::File;

    fn mode(&self, file: &Path) -> io::Result<Option<u32>> {
        match fs::metadata(file) {
            Ok(meta) => Ok(Some(mode_of(&meta))),
            Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn make_folder(&self, dir: &Path, mode: u32) -> io::Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, mode);
        #[cfg(not(unix))]
        let _ = mode;
        builder.create(dir)
    }

    fn create(&self, file: &Path, mode: u32) -> io::Result<fs::File> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
        #[cfg(not(unix))]
        let _ = mode;
        options.open(file)
    }

    fn write(&self, open: &mut fs::File, data: &[u8]) -> io::Result<()> {
        open.write_all(data)
    }

    fn close(&self, open: fs::File) -> io::Result<()> {
        crate::sys::close(open)
    }

    fn chmod(&self, file: &Path, mode: u32) -> io::Result<()> {
        #[cfg(unix)]
        let permissions = std::os::unix::fs::PermissionsExt::from_mode(mode);
        // Windows has only a read-only attribute, which Node sets when the owner may not write
        #[cfg(not(unix))]
        let permissions = {
            let mut p = fs::metadata(file)?.permissions();
            p.set_readonly(mode & 0o200 == 0);
            p
        };
        fs::set_permissions(file, permissions)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        crate::sys::rename(from, to)
    }

    fn remove(&self, file: &Path) -> io::Result<()> {
        match fs::remove_file(file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

/// A file's mode as Node's `stat` reports it.
#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    std::os::unix::fs::MetadataExt::mode(meta)
}

/// libuv's mode on Windows: 0444 for a read-only file, else 0666.
#[cfg(not(unix))]
fn mode_of(meta: &fs::Metadata) -> u32 {
    if meta.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}
