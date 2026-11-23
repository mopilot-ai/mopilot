//! A record written whole: on the real file system (modes, links, folders, a write that fails or is cut off before its
//! rename), step by step against one that fails where a test says, and through `store.writeRecord`.

use crate::write::{write_atomic, Ask, Disk, Failure, Steps};
use std::cell::RefCell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A fresh folder under the system's temp folder, removed (made writable first) when dropped.
struct Folder(PathBuf);
impl Folder {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("mopilot-store-write-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        Folder(dir)
    }
    fn at(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        #[cfg(unix)]
        for dir in ["", "locked", "ro"] {
            let _ = fs::set_permissions(self.0.join(dir), std::os::unix::fs::PermissionsExt::from_mode(0o700));
        }
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `data` written to `file` through `temp` on the real disk.
fn write(file: &Path, temp: &Path, private: bool, data: &[u8]) -> Result<(), Failure> {
    write_atomic(&Disk, &Ask { file, temp, private, data })
}

/// The names in `dir`, sorted.
fn names(dir: &Path) -> Vec<String> {
    let mut all: Vec<String> =
        fs::read_dir(dir).expect("a listing").map(|e| e.expect("an entry").file_name().to_string_lossy().into_owned()).collect();
    all.sort();
    all
}

#[cfg(unix)]
fn mode(file: &Path) -> u32 {
    std::os::unix::fs::MetadataExt::mode(&fs::metadata(file).expect("a file")) & 0o777
}

#[cfg(unix)]
fn chmod(file: &Path, mode: u32) {
    fs::set_permissions(file, std::os::unix::fs::PermissionsExt::from_mode(mode)).expect("a mode");
}

#[test]
fn the_bytes_land_exactly_and_no_temporary_file_stays() {
    let f = Folder::new("bytes");
    let file = f.at("a%3Ab.v2");
    let bytes = "{\"id\":\"a:b\",\"t\":\"\u{fffd}é\"}".as_bytes();
    write(&file, &f.at(".mopilot-1-x.tmp"), true, bytes).expect("written");
    assert_eq!(fs::read(&file).expect("the file"), bytes);
    // two commits back to back, each through its own temporary file: the later one is what stays
    write(&file, &f.at(".mopilot-1-y.tmp"), true, b"[2]").expect("written again");
    write(&file, &f.at(".mopilot-1-z.tmp"), true, b"[3]").expect("written again");
    assert_eq!(fs::read(&file).expect("the file"), b"[3]");
    assert_eq!(names(&f.0), vec!["a%3Ab.v2"]);
    // an empty record is a file of no bytes, as writeFileSync makes
    write(&file, &f.at(".mopilot-1-e.tmp"), true, b"").expect("written empty");
    assert_eq!(fs::read(&file).expect("the file"), b"");
}

#[cfg(unix)]
#[test]
fn a_private_file_is_owner_only_and_a_shared_one_keeps_its_mode() {
    let f = Folder::new("modes");
    // new and private: 0600, in folders made 0700
    let fresh = f.at("threads/deep/new.v2");
    write(&fresh, &f.at("threads/deep/.t1.tmp"), true, b"1").expect("written");
    assert_eq!((mode(&fresh), mode(&f.at("threads")), mode(&f.at("threads/deep"))), (0o600, 0o700, 0o700));
    // an existing private file loses group and other access and keeps its own bits (an executable stays one)
    for (had, has) in [(0o640, 0o600), (0o755, 0o700), (0o400, 0o400)] {
        let file = f.at(&format!("kept-{had:o}.v2"));
        fs::write(&file, b"old").expect("a file");
        chmod(&file, had);
        write(&file, &f.at(".t2.tmp"), true, b"new").expect("written");
        assert_eq!((mode(&file), fs::read(&file).expect("read")), (has, b"new".to_vec()), "{had:o}");
    }
    // outside the data folder an existing file keeps its mode, and a new one takes what the umask leaves of 0666
    let shared = f.at("shared.json");
    fs::write(&shared, b"old").expect("a file");
    chmod(&shared, 0o644);
    write(&shared, &f.at(".t3.tmp"), false, b"new").expect("written");
    assert_eq!(mode(&shared), 0o644);
    let plain = f.at("plain.json");
    write(&plain, &f.at(".t4.tmp"), false, b"new").expect("written");
    let reference = f.at("reference");
    fs::File::create(&reference).expect("a file the umask shapes");
    assert_eq!(mode(&plain), mode(&reference));
}

#[cfg(unix)]
#[test]
fn a_link_takes_its_targets_mode_and_is_replaced_by_the_file() {
    let f = Folder::new("link");
    let target = f.at("target");
    fs::write(&target, b"target").expect("a file");
    chmod(&target, 0o604);
    let link = f.at("link.v2");
    std::os::unix::fs::symlink(&target, &link).expect("a link");
    write(&link, &f.at(".t.tmp"), false, b"new").expect("written");
    assert!(fs::symlink_metadata(&link).expect("the file").is_file(), "the link itself is replaced, as renameSync does");
    assert_eq!((mode(&link), fs::read(&target).expect("target")), (0o604, b"target".to_vec()));
}

#[cfg(unix)]
#[test]
fn a_write_that_fails_says_what_node_said_and_leaves_the_old_file_whole() {
    let f = Folder::new("fails");
    let file = f.at("x.v2");
    fs::write(&file, b"old").expect("a file");
    // the file's name is past what the folder takes: asking for its mode fails, as statSync did, before anything is made
    let long = f.at(&"n".repeat(300));
    let failure = write(&long, &f.at(".long.tmp"), true, b"new").expect_err("too long");
    assert_eq!(failure.message(), format!("ENAMETOOLONG: name too long, stat '{}'", long.display()));
    assert!(failure.cleanup.is_none());
    // a folder in the file's place: renaming onto it fails and the temporary file goes
    fs::create_dir_all(f.at("dir.v2/inside")).expect("a folder");
    let onto = write(&f.at("dir.v2"), &f.at(".dir.tmp"), true, b"new").expect_err("a folder");
    let temp = f.at(".dir.tmp");
    let dir = f.at("dir.v2");
    assert_eq!(onto.message(), format!("EISDIR: illegal operation on a directory, rename '{}' -> '{}'", temp.display(), dir.display()));
    // a path through a file: nothing is there to keep (ENOTDIR reads as no file), and its folder can't be made
    let through = f.at("x.v2/y.v2");
    let mkdir = write(&through, &f.at("x.v2/.t.tmp"), true, b"new").expect_err("no folder");
    assert_eq!(mkdir.message(), format!("EEXIST: file already exists, mkdir '{}'", file.display()));
    assert_eq!(names(&f.0), vec!["dir.v2", "x.v2"]);
    assert_eq!(fs::read(&file).expect("the file"), b"old");
}

#[cfg(unix)]
#[test]
fn a_folder_that_cannot_be_written_or_searched_fails_before_anything_changes() {
    let f = Folder::new("denied");
    let ro = f.at("ro");
    fs::create_dir(&ro).expect("a folder");
    fs::write(ro.join("x.v2"), b"old").expect("a file");
    chmod(&ro, 0o500);
    // (the unit runs are never root, who writes anywhere)
    let failure = write(&ro.join("x.v2"), &ro.join(".t.tmp"), true, b"new").expect_err("read-only");
    assert_eq!(failure.message(), format!("EACCES: permission denied, open '{}'", ro.join(".t.tmp").display()));
    let locked = f.at("locked");
    fs::create_dir(&locked).expect("a folder");
    chmod(&locked, 0o600);
    let stat = write(&locked.join("x.v2"), &locked.join(".t.tmp"), true, b"new").expect_err("no search");
    assert_eq!(stat.message(), format!("EACCES: permission denied, stat '{}'", locked.join("x.v2").display()));
    chmod(&ro, 0o700);
    assert_eq!(fs::read(ro.join("x.v2")).expect("the file"), b"old");
    assert_eq!(names(&ro), vec!["x.v2"]);
}

/// The real disk, but a crash (a panic) where the rename would be.
struct CrashBeforeRename;
impl Steps for CrashBeforeRename {
    type File = fs::File;
    fn mode(&self, file: &Path) -> io::Result<Option<u32>> {
        Disk.mode(file)
    }
    fn make_folder(&self, dir: &Path, mode: u32) -> io::Result<()> {
        Disk.make_folder(dir, mode)
    }
    fn create(&self, file: &Path, mode: u32) -> io::Result<fs::File> {
        Disk.create(file, mode)
    }
    fn write(&self, open: &mut fs::File, data: &[u8]) -> io::Result<()> {
        Disk.write(open, data)
    }
    fn close(&self, open: fs::File) -> io::Result<()> {
        Disk.close(open)
    }
    fn chmod(&self, file: &Path, mode: u32) -> io::Result<()> {
        Disk.chmod(file, mode)
    }
    fn rename(&self, _: &Path, _: &Path) -> io::Result<()> {
        panic!("the process ends here")
    }
    fn remove(&self, file: &Path) -> io::Result<()> {
        Disk.remove(file)
    }
}

/// On Windows a file's mode is its read-only attribute as libuv reports it, 0444 or 0666. A record written over a
/// read-only one gets that mode on its temporary file, and MoveFileExW refuses to replace a read-only file (std's own
/// rename retries past that; libuv's, and so writeAtomic's, does not): the write fails at the rename with EPERM, the
/// temporary file goes, and the old record stays whole.
#[cfg(windows)]
#[test]
fn a_read_only_record_reads_as_0444_and_writing_over_it_fails_at_the_rename_as_node_did() {
    let f = Folder::new("readonly");
    let file = f.at("x.v2");
    fs::write(&file, b"old").expect("a file");
    assert_eq!(Disk.mode(&file).expect("a mode"), Some(0o666));
    let set_readonly = |readonly| {
        let mut permissions = fs::metadata(&file).expect("the file").permissions();
        permissions.set_readonly(readonly);
        fs::set_permissions(&file, permissions).expect("the attribute");
    };
    set_readonly(true);
    assert_eq!(Disk.mode(&file).expect("a mode"), Some(0o444));
    let temp = f.at(".t.tmp");
    for private in [false, true] {
        let failure = write(&file, &temp, private, b"new").expect_err("a read-only record");
        assert_eq!(failure.message(), format!("EPERM: operation not permitted, rename '{}' -> '{}'", temp.display(), file.display()));
        assert!(failure.cleanup.is_none(), "{:?}", failure.cleanup);
        assert_eq!(fs::read(&file).expect("the file"), b"old");
        assert_eq!(names(&f.0), vec!["x.v2"]);
    }
    set_readonly(false);
}

#[test]
fn a_crash_between_the_temporary_file_and_its_rename_leaves_the_old_file_whole() {
    let f = Folder::new("crash");
    let file = f.at("x.v2");
    fs::write(&file, b"old").expect("a file");
    let temp = f.at(".mopilot-9-crash.tmp");
    let crashed =
        std::panic::catch_unwind(|| write_atomic(&CrashBeforeRename, &Ask { file: &file, temp: &temp, private: true, data: b"new" }));
    assert!(crashed.is_err());
    assert_eq!(fs::read(&file).expect("the file"), b"old");
    // the stray temporary file is the one a crash in JS's writeAtomic left too: never read as a chat (it is no .v2)
    assert_eq!(fs::read(&temp).expect("the temporary file"), b"new");
    CrashBeforeRename.remove(&temp).expect("the stray file cleared");
    assert_eq!(names(&f.0), vec!["x.v2"]);
}

#[test]
fn the_real_disks_removal_takes_a_missing_file_and_refuses_a_folder() {
    let f = Folder::new("remove");
    assert!(Disk.remove(&f.at("missing")).is_ok());
    assert!(Disk.remove(&f.0).is_err());
}

/// A disk in memory that fails the step named in `fail` with its errno, and the removal too when `stuck`.
#[derive(Default)]
struct Fails {
    fail: Option<(&'static str, i32)>,
    stuck: bool,
    mode: Option<u32>,
    steps: RefCell<Vec<String>>,
}
impl Fails {
    fn step(&self, name: &str, detail: String) -> io::Result<()> {
        self.steps.borrow_mut().push(format!("{name} {detail}"));
        match self.fail {
            Some((at, errno)) if at == name => Err(io::Error::from_raw_os_error(errno)),
            _ => Ok(()),
        }
    }
}
impl Steps for Fails {
    type File = ();
    fn mode(&self, file: &Path) -> io::Result<Option<u32>> {
        self.step("stat", file.display().to_string()).map(|()| self.mode)
    }
    fn make_folder(&self, dir: &Path, mode: u32) -> io::Result<()> {
        self.step("mkdir", format!("{} {mode:o}", dir.display()))
    }
    fn create(&self, file: &Path, mode: u32) -> io::Result<()> {
        self.step("open", format!("{} {mode:o}", file.display()))
    }
    fn write(&self, _: &mut (), data: &[u8]) -> io::Result<()> {
        self.step("write", String::from_utf8_lossy(data).into_owned())
    }
    fn close(&self, (): ()) -> io::Result<()> {
        self.step("close", "/d/.t.tmp".to_string())
    }
    fn chmod(&self, file: &Path, mode: u32) -> io::Result<()> {
        self.step("chmod", format!("{} {mode:o}", file.display()))
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.step("rename", format!("{} {}", from.display(), to.display()))
    }
    fn remove(&self, file: &Path) -> io::Result<()> {
        self.steps.borrow_mut().push(format!("rm {}", file.display()));
        if self.stuck {
            Err(io::Error::from_raw_os_error(16))
        } else {
            Ok(())
        }
    }
}

fn run(fails: &Fails, private: bool) -> Result<(), Failure> {
    write_atomic(fails, &Ask { file: Path::new("/d/x.v2"), temp: Path::new("/d/.t.tmp"), private, data: b"{}" })
}

#[test]
fn each_step_in_order_with_the_mode_the_file_had() {
    let kept = Fails { mode: Some(0o100_664), ..Fails::default() };
    run(&kept, true).expect("written");
    assert_eq!(
        *kept.steps.borrow(),
        [
            "stat /d/x.v2",
            "mkdir /d 700",
            "open /d/.t.tmp 600",
            "write {}",
            "close /d/.t.tmp",
            "chmod /d/.t.tmp 600",
            "rename /d/.t.tmp /d/x.v2"
        ]
    );
    let shared = Fails { mode: Some(0o100_664), ..Fails::default() };
    run(&shared, false).expect("written");
    assert_eq!(shared.steps.borrow()[1..3], ["mkdir /d 777", "open /d/.t.tmp 664"]);
    assert_eq!(shared.steps.borrow()[5], "chmod /d/.t.tmp 664");
    // a new file outside the data folder: 0666 less the umask, and no chmod after
    let fresh = Fails::default();
    run(&fresh, false).expect("written");
    assert_eq!(
        *fresh.steps.borrow(),
        ["stat /d/x.v2", "mkdir /d 777", "open /d/.t.tmp 666", "write {}", "close /d/.t.tmp", "rename /d/.t.tmp /d/x.v2"]
    );
}

#[cfg(unix)]
#[test]
fn a_failed_step_is_nodes_error_and_removes_the_temporary_file_once_it_may_exist() {
    let cases: [(&str, i32, &str, bool); 7] = [
        ("stat", libc::EACCES, "EACCES: permission denied, stat '/d/x.v2'", false),
        ("mkdir", libc::EROFS, "EROFS: read-only file system, mkdir '/d'", false),
        ("open", libc::EMFILE, "EMFILE: too many open files, open '/d/.t.tmp'", true),
        // the disk is full
        ("write", libc::ENOSPC, "ENOSPC: no space left on device, write", true),
        // a write a network or over-quota disk refuses only when the file is closed
        ("close", libc::EIO, "EIO: i/o error, close", true),
        ("chmod", libc::EPERM, "EPERM: operation not permitted, chmod '/d/.t.tmp'", true),
        ("rename", libc::EXDEV, "EXDEV: cross-device link not permitted, rename '/d/.t.tmp' -> '/d/x.v2'", true),
    ];
    for (step, errno, message, removes) in cases {
        let fails = Fails { fail: Some((step, errno)), ..Fails::default() };
        let failure = run(&fails, true).expect_err(step);
        assert_eq!(failure.message(), message);
        assert_eq!(fails.steps.borrow().last().map(String::as_str) == Some("rm /d/.t.tmp"), removes, "{step}");
        // nothing after the failed step but the removal: a short temporary file is never published
        let after = fails.steps.borrow().iter().skip_while(|s| !s.starts_with(step)).skip(1).cloned().collect::<Vec<_>>();
        assert!(after.iter().all(|s| s.starts_with("rm ")), "{step}: {after:?}");
        // the removal failing too: the step's error is the one thrown, and the removal's is said beside it
        let stuck = Fails { fail: Some((step, errno)), stuck: true, ..Fails::default() };
        let both = run(&stuck, true).expect_err(step);
        assert_eq!(both.message(), message);
        assert_eq!(both.cleanup.is_some(), removes, "{step}");
    }
    let stuck = Fails { fail: Some(("write", libc::ENOSPC)), stuck: true, ..Fails::default() };
    let reply: serde_json::Value = serde_json::from_str(&run(&stuck, true).expect_err("full").reply()).expect("JSON");
    assert_eq!(
        reply,
        serde_json::json!({
            "code": "ENOSPC", "syscall": "write", "path": null, "dest": null,
            "message": "ENOSPC: no space left on device, write",
            "cleanup": "EBUSY: resource busy or locked, rm '/d/.t.tmp'",
        })
    );
}

#[test]
fn the_route_writes_the_bytes_it_is_given_and_refuses_what_names_no_write() {
    let f = Folder::new("route");
    let file = f.at("c.v2");
    let head = |file: &Path, temp: &Path| serde_json::json!({ "file": file, "temp": temp, "private": true }).to_string();
    // the bytes after the first line are the record, newlines and all
    let payload = [head(&file, &f.at(".t.tmp")).as_bytes(), b"\n", b"{\"a\":\"x\\ny\"}\n\n"].concat();
    assert_eq!(dispatch::dispatch("store.writeRecord", &payload), Ok(Vec::new()));
    assert_eq!(fs::read(&file).expect("the file"), b"{\"a\":\"x\\ny\"}\n\n");
    // a failure is Node's error as JSON
    let deep = f.at("c.v2/d.v2");
    let failing = [head(&deep, &f.at("c.v2/.t.tmp")).as_bytes(), b"\n{}"].concat();
    let error = dispatch::dispatch("store.writeRecord", &failing).expect_err("through a file");
    let reply: serde_json::Value = serde_json::from_str(&error).expect("JSON");
    assert_eq!(reply["syscall"], "mkdir");
    assert_eq!(reply["path"], file.display().to_string());
    let elsewhere = f.at("other/.t.tmp");
    for bad in [
        b"no newline".to_vec(),
        b"not json\n{}".to_vec(),
        b"{\"file\":\"/d/x\",\"temp\":\"/d/.t\"}\n{}".to_vec(),
        b"{\"file\":\"/d/x\",\"temp\":\"/d/.t\",\"private\":1}\n{}".to_vec(),
        b"{\"file\":\"\",\"temp\":\"/d/.t\",\"private\":true}\n{}".to_vec(),
        b"{\"file\":\"/d/x\",\"temp\":7,\"private\":true}\n{}".to_vec(),
        [head(&file, &elsewhere).as_bytes(), b"\n{}"].concat(),
        [head(&file, &file).as_bytes(), b"\n{}"].concat(),
    ] {
        let refused = dispatch::dispatch("store.writeRecord", &bad).expect_err("no write");
        assert!(refused.starts_with("store.writeRecord takes "), "{refused}");
    }
    assert_eq!(names(&f.0), vec!["c.v2"]);
    let table: serde_json::Value = serde_json::from_slice(&dispatch::dispatch("store.errorNames", b"").expect("names")).expect("JSON");
    assert!(table.as_array().is_some_and(|rows| rows.len() > 60), "{table}");
}
