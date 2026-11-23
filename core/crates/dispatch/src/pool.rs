//! The core's own threads for dispatched routes (docs/architecture/rust-core.md §3): a capped pool of plain threads, so a
//! long route never holds one of libuv's, which `fs.promises` shares. Threads start as work arrives, none before, and
//! stay parked for the process's life. Jobs run in the order they came.

use std::collections::VecDeque;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;

/// One piece of work. Its own failures are its own to report: a panic that gets out of one ends only that job.
pub type Job = Box<dyn FnOnce() + Send>;

/// The threads dispatched routes run on: as many as libuv's default pool, which they ran on before.
pub const THREADS: usize = 4;

struct State {
    queue: VecDeque<Job>,
    /// threads parked with nothing to do
    idle: usize,
    /// threads started
    workers: usize,
}

pub struct Pool {
    state: Mutex<State>,
    ready: Condvar,
    cap: usize,
    start: fn(&'static Pool) -> io::Result<()>,
}

/// Each thread's stack: as much as a libuv thread has on macOS and most Linux systems, since a stack overflow is the one
/// failure in a route that `catch_unwind` can't turn into an error. Only the pages a route touches take memory.
const STACK_BYTES: usize = 8 << 20;

/// A named thread working `pool`. The OS may refuse one, which `submit` allows for.
fn start_thread(pool: &'static Pool) -> io::Result<()> {
    thread::Builder::new().name("mopilot-core".into()).stack_size(STACK_BYTES).spawn(move || pool.work()).map(drop)
}

impl Pool {
    pub const fn new(cap: usize) -> Self {
        Pool::starting(cap, start_thread)
    }

    /// A pool whose threads `start` begins.
    const fn starting(cap: usize, start: fn(&'static Pool) -> io::Result<()>) -> Self {
        Pool { state: Mutex::new(State { queue: VecDeque::new(), idle: 0, workers: 0 }), ready: Condvar::new(), cap, start }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queue `job`, starting a thread when none is free and the cap allows one. A pool that cannot start its first thread
    /// has nothing to run the job on, so it runs here: late is better than a call that never answers.
    pub fn submit(&'static self, job: Job) {
        let mut state = self.lock();
        if state.idle <= state.queue.len() && state.workers < self.cap {
            match (self.start)(self) {
                Ok(()) => state.workers += 1,
                Err(_) if state.workers == 0 => {
                    drop(state);
                    run(job);
                    return;
                }
                // the threads there are will reach it
                Err(_) => {}
            }
        }
        state.queue.push_back(job);
        drop(state);
        self.ready.notify_one();
    }

    /// A thread's whole life: the next job, or a nap until there is one.
    fn work(&self) {
        let mut state = self.lock();
        loop {
            if let Some(job) = state.queue.pop_front() {
                drop(state);
                run(job);
                state = self.lock();
            } else {
                state.idle += 1;
                state = self.ready.wait(state).unwrap_or_else(PoisonError::into_inner);
                state.idle -= 1;
            }
        }
    }
}

fn run(job: Job) {
    // the thread outlives a job that panics: routes are caught in `dispatch_call`, and this holds for the rest
    let _ = catch_unwind(AssertUnwindSafe(job));
}

/// The process's pool.
pub static POOL: Pool = Pool::new(THREADS);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    fn leaked(pool: Pool) -> &'static Pool {
        Box::leak(Box::new(pool))
    }

    #[test]
    fn jobs_past_the_cap_wait_and_all_finish() {
        let pool = leaked(Pool::new(3));
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        // the cap is reached: these three only get past each other by running at once
        let together = Arc::new(Barrier::new(3));
        let (done, finished) = channel();
        for _ in 0..3 {
            let (together, done) = (together.clone(), done.clone());
            pool.submit(Box::new(move || {
                together.wait();
                done.send(-1).expect("the test waits");
            }));
        }
        for i in 0..64 {
            let (running, most, done) = (running.clone(), most.clone(), done.clone());
            pool.submit(Box::new(move || {
                most.fetch_max(running.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(1));
                running.fetch_sub(1, Ordering::SeqCst);
                done.send(i).expect("the test waits");
            }));
        }
        let mut seen: Vec<i32> = (0..67).map(|_| finished.recv().expect("every job ends")).collect();
        seen.sort_unstable();
        assert_eq!(seen, [vec![-1; 3], (0..64).collect()].concat());
        assert!(most.load(Ordering::SeqCst) <= 3, "and never passed");
    }

    #[test]
    fn threads_start_only_as_work_needs_them() {
        let pool = leaked(Pool::new(8));
        let (done, finished) = channel();
        for _ in 0..4 {
            let done = done.clone();
            pool.submit(Box::new(move || done.send(()).expect("the test waits")));
            finished.recv().expect("the job ran");
            // the thread is on its way back to parked: a job after that needs no other
            while pool.lock().idle == 0 {
                thread::yield_now();
            }
        }
        assert_eq!(pool.lock().workers, 1);
    }

    #[test]
    fn a_job_that_panics_leaves_its_thread_working() {
        let pool = leaked(Pool::new(1));
        pool.submit(Box::new(|| panic!("a core bug")));
        let (done, finished) = channel();
        pool.submit(Box::new(move || done.send(()).expect("the test waits")));
        finished.recv().expect("the one thread ran the next job");
    }

    #[test]
    fn jobs_start_in_the_order_they_came() {
        let pool = leaked(Pool::new(1));
        let gate = Arc::new(Barrier::new(2));
        let wait = gate.clone();
        pool.submit(Box::new(move || {
            wait.wait();
        }));
        let (order, seen): (Sender<i32>, _) = channel();
        for i in 0..5 {
            let order = order.clone();
            pool.submit(Box::new(move || order.send(i).expect("the test waits")));
        }
        gate.wait();
        assert_eq!((0..5).map(|_| seen.recv().expect("ran")).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
    }

    fn refuse(_: &'static Pool) -> io::Result<()> {
        Err(io::Error::other("no more threads"))
    }

    #[test]
    fn a_pool_with_no_thread_at_all_runs_the_job_on_the_caller() {
        let pool = leaked(Pool::starting(4, refuse));
        let here = thread::current().id();
        let ran = Arc::new(Mutex::new(None));
        let seen = ran.clone();
        pool.submit(Box::new(move || *seen.lock().expect("unpoisoned") = Some(thread::current().id())));
        assert_eq!(*ran.lock().expect("unpoisoned"), Some(here));
    }

    /// Starts one thread, then refuses.
    fn once(pool: &'static Pool) -> io::Result<()> {
        static STARTED: AtomicUsize = AtomicUsize::new(0);
        if STARTED.fetch_add(1, Ordering::SeqCst) == 0 {
            start_thread(pool)
        } else {
            refuse(pool)
        }
    }

    #[test]
    fn a_refused_thread_leaves_the_job_to_the_threads_there_are() {
        let pool = leaked(Pool::starting(4, once));
        let gate = Arc::new(Barrier::new(2));
        let wait = gate.clone();
        pool.submit(Box::new(move || {
            wait.wait();
        }));
        let (done, finished) = channel();
        pool.submit(Box::new(move || done.send(()).expect("the test waits")));
        gate.wait();
        finished.recv().expect("the one thread reached it");
    }
}
