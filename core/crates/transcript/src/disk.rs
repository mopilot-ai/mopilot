//! The file operations a writer makes, as a trait so its tests can fail one partway.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

pub trait Disk: Send + Sync + 'static {
    /// Make the folder that holds `file`.
    fn prepare(&self, file: &Path) -> io::Result<()>;
    /// The file's size; 0 when it does not exist.
    fn size(&self, file: &Path) -> io::Result<u64>;
    /// The file's byte at `at`.
    fn byte_at(&self, file: &Path, at: u64) -> io::Result<u8>;
    /// Append `bytes`, creating the file with `mode` where permissions exist.
    fn append(&self, file: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()>;
    fn read(&self, file: &Path) -> io::Result<Vec<u8>>;
    /// Remove the file; one already gone is fine.
    fn remove(&self, file: &Path) -> io::Result<()>;
    fn exists(&self, file: &Path) -> bool;
}

/// The real file system.
pub struct RealDisk;

impl Disk for RealDisk {
    fn prepare(&self, file: &Path) -> io::Result<()> {
        file.parent().map_or(Ok(()), fs::create_dir_all)
    }

    fn size(&self, file: &Path) -> io::Result<u64> {
        match fs::metadata(file) {
            Ok(meta) => Ok(meta.len()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error),
        }
    }

    fn byte_at(&self, file: &Path, at: u64) -> io::Result<u8> {
        let mut open = fs::File::open(file)?;
        open.seek(SeekFrom::Start(at))?;
        let mut byte = [0];
        open.read_exact(&mut byte)?;
        Ok(byte[0])
    }

    fn append(&self, file: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        options.open(file)?.write_all(bytes)
    }

    fn read(&self, file: &Path) -> io::Result<Vec<u8>> {
        fs::read(file)
    }

    fn remove(&self, file: &Path) -> io::Result<()> {
        match fs::remove_file(file) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    fn exists(&self, file: &Path) -> bool {
        file.exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_disk_says_what_the_writer_asks() {
        let dir = std::env::temp_dir().join(format!("transcript-disk-reads-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let disk = RealDisk;
        let file = dir.join("log");

        assert_eq!(disk.size(&file).unwrap(), 0, "no file is no bytes");
        assert!(!disk.exists(&file));
        disk.remove(&file).unwrap();

        disk.append(&file, b"ab", Some(0o600)).unwrap();
        disk.append(&file, b"c", None).unwrap();
        assert_eq!(disk.read(&file).unwrap(), b"abc");
        assert_eq!(disk.size(&file).unwrap(), 3);
        assert_eq!(disk.byte_at(&file, 2).unwrap(), b'c');
        assert!(disk.exists(&file));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // under a file, a size is an error and not an empty file (Windows calls that path missing)
        #[cfg(unix)]
        assert!(disk.size(&file.join("under")).is_err());
        // a folder can't be removed as a file
        assert!(disk.remove(&dir).is_err());

        disk.remove(&file).unwrap();
        assert!(!disk.exists(&file));
        fs::remove_dir_all(&dir).unwrap();
    }
}
