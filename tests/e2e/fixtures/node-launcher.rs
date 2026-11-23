// The Windows stand-in for a fake command's `#!/bin/sh` script (fixtures/nodeCommand.ts): a real .exe that runs a Node script.

// execFile and the Rust core find only a program on PATH there (an .exe, never a .cmd). `<name>.exe` reads `<name>.launch`
// beside it: the first line is node.exe, the second the script, and each line after it a `NAME=value` the script gets in
// its environment. The arguments, standard streams and exit code pass through. A Job Object ends the script when this
// process is ended (Windows does not end a process's children with it), and Ctrl+C is the script's to handle, not this one's.
use std::env;
use std::fs;
use std::process::{exit, Command};

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        counts: [u64; 6],
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn SetConsoleCtrlHandler(handler: *mut c_void, add: i32) -> i32;
    }

    /// Ctrl+C goes to the console's every process: this one ignores it, so the script decides (as it would started on its
    /// own) and this one lives on to pass its exit code through. Set after the script started, which would inherit it.
    pub fn ignore_ctrl_c() {
        // SAFETY: a null handler with TRUE only sets this process to ignore Ctrl+C; it takes no pointer
        unsafe { SetConsoleCtrlHandler(std::ptr::null_mut(), 1) };
    }

    /// Puts the child in a job that ends with this process: the handle is never closed, so the job closes when this exits.
    /// A job that can't be made or set is said, with the child ended, so a test never runs a script that may outlive it.
    pub fn tie(child: &mut std::process::Child) {
        fn failed(child: &mut std::process::Child, what: &str) -> ! {
            eprintln!("node-launcher: {what} failed: {}", std::io::Error::last_os_error());
            let _ = child.kill();
            std::process::exit(126)
        }
        let handle = child.as_raw_handle() as *mut c_void;
        // SAFETY: the calls take a job this function made and the child's own handle, both open throughout
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                failed(child, "CreateJobObjectW");
            }
            let mut limits = ExtendedLimits::default();
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<ExtendedLimits>() as u32;
            if SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &mut limits as *mut _ as *mut c_void, size) == 0 {
                failed(child, "SetInformationJobObject");
            }
            // a script that already ended (a quick one) can't join a job, and has nothing left to outlive this
            if AssignProcessToJobObject(job, handle) == 0 && !matches!(child.try_wait(), Ok(Some(_))) {
                failed(child, "AssignProcessToJobObject");
            }
        }
    }
}

fn main() {
    let me = env::current_exe().expect("this launcher's own path");
    let plan_file = me.with_extension("launch");
    let plan = fs::read_to_string(&plan_file).unwrap_or_else(|e| {
        eprintln!("{}: {e}", plan_file.display());
        exit(127)
    });
    let mut lines = plan.lines();
    let (Some(node), Some(script)) = (lines.next(), lines.next()) else {
        eprintln!("{}: expected node.exe and a script", plan_file.display());
        exit(127)
    };
    let mut command = Command::new(node);
    command.arg(script).args(env::args_os().skip(1));
    for line in lines {
        if let Some((name, value)) = line.split_once('=') {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().unwrap_or_else(|e| {
        eprintln!("{node}: {e}");
        exit(127)
    });
    #[cfg(windows)]
    {
        job::tie(&mut child);
        // only after the spawn: a process started later would inherit the ignoring, and the script keeps Windows' default
        job::ignore_ctrl_c();
    }
    let status = child.wait().unwrap_or_else(|e| {
        eprintln!("{node}: {e}");
        exit(127)
    });
    exit(status.code().unwrap_or(1));
}
