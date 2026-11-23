//! Windows: the process table from a Toolhelp32 snapshot, a process ended with `TerminateProcess`, and a child's tree
//! held in a Job Object. Windows has no process groups: each row names itself as its group, so a group's processes are
//! the process alone, and the job is what still reaches a command whose parent has exited.

use crate::Process;
use std::collections::HashMap;
use std::io;
use std::mem::size_of;
use std::ptr;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// Every process in one snapshot, with its parent; its group is itself.
pub fn table() -> io::Result<Vec<Process>> {
    // SAFETY: a process snapshot takes no process id (0) and returns a handle rows_of closes, or INVALID_HANDLE_VALUE
    rows_of(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })
}

/// The rows of a process snapshot, which this closes; a snapshot that could not be taken is the OS's error.
fn rows_of(snapshot: HANDLE) -> io::Result<Vec<Process>> {
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut rows = Vec::new();
    // SAFETY: PROCESSENTRY32W is plain data; zeroed is valid for every field, and dwSize says which version it is
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: the snapshot is open and the entry's size is set; each call fills it or returns 0 at the end
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        rows.push(row(&entry));
        // SAFETY: as above
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: the snapshot is this function's handle, closed once
    unsafe { CloseHandle(snapshot) };
    Ok(rows)
}

/// A snapshot entry as a row: Windows has no process groups, so its group is itself.
fn row(entry: &PROCESSENTRY32W) -> Process {
    let pid = entry.th32ProcessID as i32;
    Process { pid, ppid: entry.th32ParentProcessID as i32, pgid: pid }
}

/// End one process now; whether it was ended (a process gone meanwhile, or another user's, is not).
pub fn terminate(pid: i32) -> bool {
    // SAFETY: OpenProcess takes any id and returns null when the process can't be opened for termination
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid as u32) };
    if handle.is_null() {
        return false;
    }
    // SAFETY: the handle was opened with PROCESS_TERMINATE above, and is closed once
    let ended = unsafe { TerminateProcess(handle, 1) } != 0;
    // SAFETY: as above
    unsafe { CloseHandle(handle) };
    ended
}

/// The jobs `contain` made, by the pid each was made for; handles as integers, so the map can cross threads.
fn jobs() -> MutexGuard<'static, HashMap<i32, isize>> {
    static JOBS: OnceLock<Mutex<HashMap<i32, isize>>> = OnceLock::new();
    JOBS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hold `pid` and what it starts from now on in a Job Object of its own. Only the child meant is held: one whose parent
/// is this process, as `table` shows it, and that had started by `at` (Unix milliseconds, taken when it was spawned). A pid
/// handed out again, to a process started later, is not held; neither is a process gone meanwhile. A pid held already
/// stays in its job while it is in it; a job left from an earlier process with that pid is let go.
pub fn contain(pid: i32, at: u64, table: &[Process]) -> io::Result<bool> {
    let own = std::process::id() as i32;
    if !table.iter().any(|p| p.pid == pid && p.ppid == own) {
        return Ok(false);
    }
    let mut jobs = jobs();
    if let Some(&job) = jobs.get(&pid) {
        if members(job as HANDLE).contains(&pid) {
            return Ok(true);
        }
        jobs.remove(&pid);
        // SAFETY: the job came out of the map, so this is its only use; closed once
        unsafe { CloseHandle(job as HANDLE) };
    }
    // SAFETY: no security attributes and no name: an unnamed job only this process holds
    let job = handle_or_error(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let joined = assign(job, pid, at);
    if let Ok(true) = joined {
        jobs.insert(pid, job as isize);
    } else {
        // SAFETY: the job was made above and holds nothing; closed once
        unsafe { CloseHandle(job) };
    }
    joined
}

/// Hold `process`, a child the core just spawned, in a Job Object of its own: whether it is held. Its handle names it, so
/// nothing has to prove which process `pid` is. A child Node starts is in libuv's job, which ends it with this process; this
/// is the same for one the core starts: the job's last handle is this process's, so its going ends all the job holds, and
/// on purpose that is everything the harness started, as a stop already ends it, where libuv's job lets a child's own children
/// break away. `contain`, whose children are in libuv's too, sets no limit, so nothing that must outlive the app starts
/// dying: this job is only ever a harness's. A process already in a job that allows no nesting can't join (as libuv, it runs
/// on, unheld).
pub fn hold(pid: i32, process: HANDLE) -> bool {
    joined(pid, process).unwrap_or(false)
}

/// Set an open job's limits to `flags` alone.
fn set_limits(job: HANDLE, flags: u32) {
    // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION is plain data; zeroed sets no limit but `flags`
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = flags;
    let info = (&raw const limits).cast();
    // SAFETY: the job is open, and `info` is valid for the size given. A job that takes no limit still holds the tree
    unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, size_of_val(&limits) as u32) };
}

fn joined(pid: i32, process: HANDLE) -> io::Result<bool> {
    // SAFETY: no security attributes and no name: an unnamed job only this process holds
    let job = handle_or_error(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    set_limits(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION);
    // SAFETY: `job` is open, and a `process` that isn't only fails
    let joined = unsafe { AssignProcessToJobObject(job, process) } != 0;
    if joined {
        jobs().insert(pid, job as isize);
    } else {
        // SAFETY: the job was made above and holds nothing; closed once
        unsafe { CloseHandle(job) };
    }
    Ok(joined)
}

/// A handle the OS returned, or its error when it returned none.
fn handle_or_error(handle: HANDLE) -> io::Result<HANDLE> {
    if handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(handle)
    }
}

/// Put `pid` in `job` when its process had started by `at`: false when it can't be opened (gone meanwhile) or started
/// later (another process with the pid), the OS's error when it can't join.
fn assign(job: HANDLE, pid: i32, at: u64) -> io::Result<bool> {
    let rights = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
    // SAFETY: OpenProcess takes any id and returns null when the process can't be opened with these rights
    let process = unsafe { OpenProcess(rights, 0, pid as u32) };
    if process.is_null() {
        return Ok(false);
    }
    let joined = if !started_by(process, at) {
        Ok(false)
    // SAFETY: both handles are open
    } else if unsafe { AssignProcessToJobObject(job, process) } != 0 {
        Ok(true)
    } else {
        Err(io::Error::last_os_error())
    };
    // SAFETY: the process handle was opened above and is closed once, after the error is read
    unsafe { CloseHandle(process) };
    joined
}

/// How far `at` may trail a process's creation time: JS's Date.now() can lag the kernel's precise clock by a tick (about
/// 16 ms on Windows). A pid handed out again is still refused unless its new process started this soon after the hold.
const CLOCK_SLACK_MS: u64 = 50;

/// Whether `process` had started by `at` (Unix milliseconds, give or take CLOCK_SLACK_MS); false when its times can't
/// be read.
fn started_by(process: HANDLE, at: u64) -> bool {
    created(process).is_some_and(|start| start <= at.saturating_add(CLOCK_SLACK_MS))
}

/// When `process` was created (Unix milliseconds), or None when its times can't be read.
fn created(process: HANDLE) -> Option<u64> {
    let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
    let [created, exited, kernel, user] = &mut times;
    // SAFETY: four FILETIMEs to fill; a handle that can't be read leaves them and returns 0
    if unsafe { GetProcessTimes(process, created, exited, kernel, user) } == 0 {
        return None;
    }
    // FILETIME counts 100 ns steps from 1601; Unix time starts 11644473600 s later
    let ticks = (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime);
    Some(ticks.saturating_sub(116_444_736_000_000_000) / 10_000)
}

/// When `pid` started (Unix milliseconds), or None for a process this user can't open: gone, or another user's.
pub fn started(pid: i32) -> Option<u64> {
    // SAFETY: OpenProcess takes any id and returns null when the process can't be opened
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if process.is_null() {
        return None;
    }
    let start = created(process);
    // SAFETY: the handle was opened above and is closed once
    unsafe { CloseHandle(process) };
    start
}

/// End what is held for `pid`: the pids it ended, or None when nothing is held for it. The whole job ends at once, and goes,
/// when `pid` goes too (`with_root`, a kill) or is gone already. While it still runs (ending on its own), what it started
/// ends and it is left to finish, as POSIX ends only what a harness started: its job stays held, limits and all, so what it
/// starts from here still ends with the next call or with this process, and closing it can't end the root.
pub fn end_contained(pid: i32, with_root: bool) -> Option<Vec<i32>> {
    let job = jobs().remove(&pid)? as HANDLE;
    let held = members(job);
    if !with_root && held.contains(&pid) {
        let ended = held.into_iter().filter(|&p| p != pid && terminate(p)).collect();
        jobs().insert(pid, job as isize);
        return Some(ended);
    }
    // SAFETY: the job came out of the map, so this is its only use; closed once
    unsafe {
        TerminateJobObject(job, 1);
        CloseHandle(job);
    }
    Some(held)
}

/// The most processes a job's list is read for at once: more than any harness runs.
const MAX_MEMBERS: usize = 1024;

/// JOBOBJECT_BASIC_PROCESS_ID_LIST with room for MAX_MEMBERS ids.
#[repr(C)]
struct IdList {
    assigned: u32,
    listed: u32,
    ids: [usize; MAX_MEMBERS],
}

/// The processes in `job` now (at most MAX_MEMBERS: a longer list reads its first ones, and the job still ends them all).
fn members(job: HANDLE) -> Vec<i32> {
    // SAFETY: IdList is plain data; zeroed is a valid empty list
    let mut list: IdList = unsafe { std::mem::zeroed() };
    // SAFETY: the buffer is the list's own size; on any failure the counts stay as the OS left them, at most the room
    unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            (&mut list as *mut IdList).cast(),
            size_of::<IdList>() as u32,
            ptr::null_mut(),
        )
    };
    list.ids[..(list.listed as usize).min(MAX_MEMBERS)].iter().map(|&id| id as i32).collect()
}

/// Close `pid`'s job as this process's going closes it, for a test.
#[cfg(test)]
pub fn close_job(pid: i32) {
    if let Some(job) = jobs().remove(&pid) {
        // SAFETY: the job came out of the map, so this is its only use; closed once
        unsafe { CloseHandle(job as HANDLE) };
    }
}

/// The processes held for `pid`, without ending them.
#[cfg(test)]
pub fn held(pid: i32) -> Vec<i32> {
    jobs().get(&pid).map(|&job| members(job as HANDLE)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_row_is_its_own_group() {
        // SAFETY: zeroed is a valid PROCESSENTRY32W
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.th32ProcessID = 42;
        entry.th32ParentProcessID = 7;
        assert_eq!(row(&entry), Process { pid: 42, ppid: 7, pgid: 42 });
    }

    #[test]
    fn a_snapshot_that_could_not_be_taken_is_an_error() {
        assert!(rows_of(INVALID_HANDLE_VALUE).is_err());
    }

    #[test]
    fn a_process_that_cannot_be_opened_is_not_ended() {
        assert!(!terminate(-7));
    }

    #[test]
    fn only_the_child_meant_is_held_and_a_failed_join_is_an_error() {
        let own = std::process::id() as i32;
        // not this process's child (a pid handed out again), and a child that is gone by the time it is opened
        assert!(!contain(4242, u64::MAX, &[Process { pid: 4242, ppid: 7, pgid: 4242 }]).expect("refused"));
        assert!(!contain(-7, u64::MAX, &[Process { pid: -7, ppid: own, pgid: -7 }]).expect("gone"));
        assert!(end_contained(-7, false).is_none(), "nothing held for it");
        assert!(handle_or_error(ptr::null_mut()).is_err());
        // this process started after 1970: not by `at` 0, so another process than the one meant
        assert!(!assign(ptr::null_mut(), own, 0).expect("started later"));
        assert!(!started_by(ptr::null_mut(), u64::MAX), "no times to read");
        assert_eq!(created(ptr::null_mut()), None);
        // SAFETY: GetCurrentProcess takes nothing and returns a pseudo handle that needs no closing
        let me = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
        assert!(started(own).is_some_and(|start| started_by(me, start)));
        assert_eq!(started(-7), None);
        // this process opens and started in time, but no job: the join fails with the OS's error
        assert!(assign(ptr::null_mut(), own, u64::MAX).is_err());
        assert!(held(-7).is_empty());
    }

    #[test]
    fn a_process_that_cannot_join_a_job_is_not_held() {
        assert!(!hold(-7, ptr::null_mut()));
        assert!(held(-7).is_empty());
        close_job(-7);
    }

    #[test]
    fn a_job_left_from_an_earlier_process_with_the_pid_is_let_go() {
        // ping starts nothing of its own, so its job holds it alone
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("ping starts");
        let pid = child.id() as i32;
        let rows = [Process { pid, ppid: std::process::id() as i32, pgid: pid }];
        // a job under the pid that the process is not in: what an earlier process with the pid left
        // SAFETY: an unnamed job, put in the map like contain's
        let stale = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        jobs().insert(pid, stale as isize);
        assert!(contain(pid, u64::MAX, &rows).expect("held afresh"));
        assert_eq!(held(pid), vec![pid]);
        // its process still runs: what it started ends, and it is left to finish
        assert_eq!(end_contained(pid, false), Some(vec![]));
        assert!(child.try_wait().expect("a state").is_none(), "the process itself was left running");
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn a_running_root_is_left_to_finish_and_what_it_started_ends() {
        // cmd waits a second (time to hold it), then runs a ping of its own inside the job
        let mut root = std::process::Command::new("cmd")
            .args(["/c", "ping -n 2 127.0.0.1 > nul & ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("cmd starts");
        let pid = root.id() as i32;
        assert!(contain(pid, u64::MAX, &table().expect("a table")).expect("held"));
        // the first ping (perhaps started before the hold) takes a second; by three, cmd's second ping runs in the job
        std::thread::sleep(std::time::Duration::from_secs(3));
        let mine = held(pid);
        let rows = table().expect("a table");
        let children: Vec<i32> = rows.iter().filter(|r| r.ppid == pid).map(|r| r.pid).filter(|p| mine.contains(p)).collect();
        let ping = *children.first().expect("cmd's ping runs in its job");
        let ended = end_contained(pid, false).expect("held");
        assert_eq!([ended.contains(&ping), ended.contains(&pid)], [true, false], "{ended:?}");
        // with its ping gone cmd finishes on its own, unended
        assert!(!root.wait().expect("cmd ends").success());
    }
}
