//! The CPU clock the [`Clock::ThreadCpu`](crate::Clock::ThreadCpu) budgets use, public for hosts that time threads too.
//!
//! The CPU time a thread has used: time the OS scheduled it, not time it waited for a core, slept or blocked. A busy
//! machine stretches wall-clock time; a thread's CPU time only grows while the thread runs.
//!
//! [`ThreadClock::current`] takes the calling thread's clock; [`ThreadClock::now`] reads it from any thread, for
//! instance a host timing another thread's slice.
//!
//! - Linux and Android: `clock_gettime` on the thread's CPU clock (`pthread_getcpuclockid`). Once the thread has
//!   ended the clock is gone and reads as zero. The clock names the thread by its id, which the kernel only resolves
//!   among the threads of this process: a new thread of this process given the same id (after the ids wrap around at
//!   `pid_max`) would be read instead.
//! - Apple platforms: `thread_info(THREAD_BASIC_INFO)`, user and system time, to the microsecond. Each clock holds its
//!   own send right to the thread's port (`mach_thread_self`, released on drop), so once the thread has ended its name
//!   is a dead name that reads as zero, and can't be reused for another port while a clock holds it.
//! - Windows: `GetThreadTimes`, kernel and user time in 100 ns units, on a duplicated handle to the thread, closed when
//!   the last clone is dropped; the handle keeps the thread's identity. Once the thread has ended it reads as zero.
//! - Elsewhere (wasm, ...): wall-clock time since the first reading, which is what there is.
//!
//! Every `unsafe` block is one OS call, with out pointers to locals of the size the call expects, or handles this
//! module owns.

#![deny(unsafe_op_in_unsafe_fn)]

use std::time::Duration;

/// A thread's CPU clock: taken on the thread, read from any thread.
#[derive(Clone, Debug)]
#[cfg_attr(not(any(target_vendor = "apple", windows)), derive(Copy))]
pub struct ThreadClock(sys::Handle);

impl ThreadClock {
    /// The calling thread's clock.
    pub fn current() -> ThreadClock {
        ThreadClock(sys::current())
    }

    /// CPU time (user + system) the thread has used; zero once it has ended.
    pub fn now(&self) -> Duration {
        sys::now(&self.0)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod sys {
    use std::time::Duration;

    pub type Handle = libc::clockid_t;

    pub fn current() -> Handle {
        let mut id: libc::clockid_t = 0;
        // SAFETY: `pthread_self` is the calling thread, and `id` a valid out pointer for its clock id.
        if unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut id) } != 0 {
            id = libc::CLOCK_THREAD_CPUTIME_ID;
        }
        id
    }

    pub fn now(clock: &Handle) -> Duration {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid out pointer; the clock of a thread that ended fails (`EINVAL`), and reads as zero.
        if unsafe { libc::clock_gettime(*clock, &mut ts) } != 0 {
            return Duration::ZERO;
        }
        Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
    }
}

#[cfg(target_vendor = "apple")]
#[allow(deprecated)] // libc marks the mach bindings deprecated in favour of the mach2 crate, which has the same calls.
mod sys {
    use std::time::Duration;

    // Not in libc; part of libSystem, as `mach_thread_self` and `thread_info` are.
    unsafe extern "C" {
        fn mach_port_mod_refs(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
            right: libc::c_uint,
            delta: libc::c_int,
        ) -> libc::kern_return_t;
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
    }

    const MACH_PORT_NULL: libc::mach_port_t = 0;
    const MACH_PORT_RIGHT_SEND: libc::c_uint = 0;
    const MACH_PORT_RIGHT_DEAD_NAME: libc::c_uint = 4;

    fn task() -> libc::mach_port_t {
        // SAFETY: the task's own port, set before `main` and never written again.
        unsafe { libc::mach_task_self_ }
    }

    /// A thread's port name with one user reference this handle owns: a send right while the thread lives, a dead
    /// name once it has ended. Holding it keeps the name from naming another port.
    #[derive(Debug)]
    pub struct Handle(libc::mach_port_t);

    impl Clone for Handle {
        fn clone(&self) -> Self {
            // Another reference, of whichever right the name is now: the clone's drop gives back only its own.
            for right in [MACH_PORT_RIGHT_SEND, MACH_PORT_RIGHT_DEAD_NAME] {
                // SAFETY: adds one user reference to a name this task holds; it fails if the name isn't that right.
                if self.0 != MACH_PORT_NULL
                    && unsafe { mach_port_mod_refs(task(), self.0, right, 1) } == libc::KERN_SUCCESS
                {
                    return Handle(self.0);
                }
            }
            Handle(MACH_PORT_NULL)
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if self.0 != MACH_PORT_NULL {
                // SAFETY: gives back the one user reference this handle owns, of a send right or a dead name.
                unsafe { mach_port_deallocate(task(), self.0) };
            }
        }
    }

    pub fn current() -> Handle {
        // SAFETY: no arguments; the calling thread's port, with a new send-right reference for the caller to release.
        Handle(unsafe { libc::mach_thread_self() })
    }

    pub fn now(thread: &Handle) -> Duration {
        // SAFETY: a plain C struct of integers, for which all zeroes is a valid value.
        let mut info: libc::thread_basic_info = unsafe { std::mem::zeroed() };
        let mut count = libc::THREAD_BASIC_INFO_COUNT;
        // SAFETY: `info` and `count` are valid out pointers, `count` the size of `info` in words. A dead name (the
        // thread ended) or the null name fails, and reads as zero.
        let kr = unsafe {
            libc::thread_info(
                thread.0,
                libc::THREAD_BASIC_INFO as libc::thread_flavor_t,
                &mut info as *mut libc::thread_basic_info as libc::thread_info_t,
                &mut count,
            )
        };
        if kr != libc::KERN_SUCCESS {
            return Duration::ZERO;
        }
        let micros = |t: libc::time_value_t| t.seconds as u64 * 1_000_000 + t.microseconds as u64;
        Duration::from_micros(micros(info.user_time) + micros(info.system_time))
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::sync::Arc;
    use std::time::Duration;

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    const DUPLICATE_SAME_ACCESS: u32 = 2;
    const WAIT_OBJECT_0: u32 = 0;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetCurrentThread() -> *mut c_void;
        fn DuplicateHandle(
            source_process: *mut c_void,
            source: *mut c_void,
            target_process: *mut c_void,
            target: *mut *mut c_void,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
        fn GetThreadTimes(
            thread: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }

    /// A real handle to a thread, which `GetCurrentThread`'s pseudo-handle is not: valid on every thread, and closed
    /// once, when the last clone of the clock is dropped. Null when it couldn't be duplicated.
    #[derive(Debug)]
    pub struct Owned(*mut c_void);

    // SAFETY: a thread handle may be used and closed from any thread; this one is only read through, and closed once.
    unsafe impl Send for Owned {}
    // SAFETY: as above; reading a thread's times through a handle from several threads at once is allowed.
    unsafe impl Sync for Owned {}

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the handle was duplicated for this value, and is closed once.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    pub type Handle = Arc<Owned>;

    pub fn current() -> Handle {
        let mut handle = std::ptr::null_mut();
        // SAFETY: the pseudo-handles of this process and thread, duplicated into a real handle; `handle` is a valid
        // out pointer, left null if the call fails.
        unsafe {
            let process = GetCurrentProcess();
            if DuplicateHandle(
                process,
                GetCurrentThread(),
                process,
                &mut handle,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) == 0
            {
                handle = std::ptr::null_mut();
            }
        }
        Arc::new(Owned(handle))
    }

    pub fn now(thread: &Handle) -> Duration {
        let handle = thread.0;
        // SAFETY: `handle` is a thread handle this clock owns; a thread's handle is signalled once it has ended.
        if handle.is_null() || unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
            return Duration::ZERO;
        }
        let (mut creation, mut exit, mut kernel, mut user) = Default::default();
        // SAFETY: as above, and the four times are valid out pointers.
        if unsafe { GetThreadTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Duration::ZERO;
        }
        let ticks = |t: FileTime| (u64::from(t.high) << 32) | u64::from(t.low);
        Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
mod sys {
    use std::time::{Duration, Instant};

    #[derive(Clone, Copy, Debug)]
    pub struct Handle;

    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

    pub fn current() -> Handle {
        Handle
    }

    pub fn now(_: &Handle) -> Duration {
        ORIGIN.get_or_init(Instant::now).elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const MEASURES_CPU: bool = cfg!(any(
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple",
        windows
    ));

    fn spin(for_: Duration) {
        let start = Instant::now();
        let mut x = 0u64;
        while start.elapsed() < for_ {
            x = std::hint::black_box(x.wrapping_mul(31).wrapping_add(7));
        }
    }

    /// The clock of a joined thread, read once it reads zero or after five seconds. `join` returns once the kernel has
    /// cleared the thread's id, a moment before it forgets the thread (longer on a busy machine): until then the
    /// clock still reads the thread's time.
    fn settled(clock: &ThreadClock) -> Duration {
        let start = Instant::now();
        loop {
            let read = clock.now();
            if read == Duration::ZERO || start.elapsed() > Duration::from_secs(5) {
                return read;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn an_ended_thread_s_clock_reads_zero_and_never_another_thread_s() {
        if !MEASURES_CPU {
            return;
        }
        // The clocks of threads that used CPU time and ended, and clones of them.
        let ended: Vec<ThreadClock> = (0..16)
            .map(|_| {
                std::thread::spawn(|| {
                    spin(Duration::from_millis(2));
                    ThreadClock::current()
                })
                .join()
                .unwrap()
            })
            .collect();
        let copies: Vec<ThreadClock> = ended.to_vec();
        // Two thousand threads come and go since, each taking its own clock and spinning while the ended ones are
        // read: a port name (Apple) or thread id (Linux) of an ended thread given to one of them would read its time.
        for round in 0..250 {
            let batch: Vec<_> = (0..8)
                .map(|_| {
                    std::thread::spawn(|| {
                        let clock = ThreadClock::current();
                        spin(Duration::from_micros(200));
                        clock.now()
                    })
                })
                .collect();
            for (i, clock) in ended.iter().chain(&copies).enumerate() {
                assert_eq!(clock.now(), Duration::ZERO, "round {round}, clock {i}");
            }
            for t in batch {
                assert!(t.join().unwrap() > Duration::ZERO);
            }
        }
        // The clones hold their own references: dropping the originals leaves them reading zero.
        drop(ended);
        for clock in &copies {
            assert_eq!(clock.now(), Duration::ZERO);
        }
    }

    #[test]
    fn a_spinning_thread_s_clock_grows_and_a_sleeping_one_s_does_not() {
        assert_send_sync::<ThreadClock>();
        let clock = ThreadClock::current();
        let before = clock.now();
        spin(Duration::from_millis(50));
        let spun = clock.now() - before;
        assert!(spun >= Duration::from_millis(30), "{spun:?}");
        let before = clock.now();
        std::thread::sleep(Duration::from_millis(100));
        let slept = clock.now() - before;
        if MEASURES_CPU {
            assert!(slept < Duration::from_millis(20), "{slept:?}");
        }
    }

    // Clones and drops as on the platforms where the clock isn't `Copy`.
    #[allow(clippy::clone_on_copy, dropping_copy_types)]
    #[test]
    fn another_thread_s_clock_is_read_from_here_and_reads_zero_once_it_ended() {
        let (tx, rx) = std::sync::mpsc::channel();
        let (spun, done) = std::sync::mpsc::channel::<()>();
        let (go, wait) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            let own = ThreadClock::current();
            tx.send(own.clone()).unwrap();
            // 60 ms by its own clock, however busy the machine; then blocked, so its clock stops.
            let start = own.now();
            while own.now() - start < Duration::from_millis(60) {
                spin(Duration::from_micros(100));
            }
            spun.send(()).unwrap();
            wait.recv().unwrap();
        });
        let clock = rx.recv().unwrap();
        let copy = clock.clone();
        done.recv().unwrap();
        let read = clock.now();
        assert!(read >= Duration::from_millis(40), "{read:?}");
        if MEASURES_CPU {
            assert!(read < Duration::from_millis(110), "{read:?}");
        }
        go.send(()).unwrap();
        worker.join().unwrap();
        if MEASURES_CPU {
            // Ended: zero, from the clock and its clone, while new threads come and go.
            let others: Vec<_> = (0..32)
                .map(|_| std::thread::spawn(|| spin(Duration::from_millis(2))))
                .collect();
            assert_eq!(settled(&clock), Duration::ZERO);
            assert_eq!(copy.now(), Duration::ZERO);
            others.into_iter().for_each(|t| t.join().unwrap());
            drop(clock);
            assert_eq!(copy.now(), Duration::ZERO);
        }
    }
}
