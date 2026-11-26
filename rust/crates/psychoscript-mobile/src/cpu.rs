//! The CPU time a thread has used, readable from any thread: a live run's slice budget counts its thread's own CPU
//! time, so time the OS doesn't schedule the thread (a loaded phone, a paused emulator) isn't compute.

use std::time::Duration;

/// A thread's CPU clock: taken on the thread ([`ThreadClock::current`]), read from any thread ([`ThreadClock::now`]).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ThreadClock(Handle);

#[cfg(any(target_os = "linux", target_os = "android"))]
type Handle = libc::clockid_t;

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe extern "C" {
    fn pthread_getcpuclockid(thread: libc::pthread_t, clock: *mut libc::clockid_t) -> libc::c_int;
}

#[cfg(any(target_os = "linux", target_os = "android"))]
impl ThreadClock {
    pub(crate) fn current() -> ThreadClock {
        let mut id: libc::clockid_t = 0;
        // SAFETY: `id` is a valid out pointer for the calling thread's clock.
        if unsafe { pthread_getcpuclockid(libc::pthread_self(), &mut id) } != 0 {
            id = libc::CLOCK_THREAD_CPUTIME_ID;
        }
        ThreadClock(id)
    }

    /// CPU time the thread has used; zero once it has ended.
    pub(crate) fn now(&self) -> Duration {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid out pointer.
        if unsafe { libc::clock_gettime(self.0, &mut ts) } != 0 {
            return Duration::ZERO;
        }
        Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
    }
}

#[cfg(target_vendor = "apple")]
type Handle = libc::mach_port_t;

#[cfg(target_vendor = "apple")]
#[allow(deprecated)]
impl ThreadClock {
    pub(crate) fn current() -> ThreadClock {
        // SAFETY: the calling thread's own port, which needs no release.
        ThreadClock(unsafe { libc::pthread_mach_thread_np(libc::pthread_self()) })
    }

    /// CPU time the thread has used (user and system); zero once it has ended.
    pub(crate) fn now(&self) -> Duration {
        // SAFETY: `info` and `count` are valid out pointers of the size `count` says.
        let mut info: libc::thread_basic_info = unsafe { std::mem::zeroed() };
        let mut count = libc::THREAD_BASIC_INFO_COUNT;
        let kr = unsafe {
            libc::thread_info(
                self.0,
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

/// Elsewhere: wall-clock time, as before.
#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
type Handle = ();

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
impl ThreadClock {
    pub(crate) fn current() -> ThreadClock {
        ThreadClock(())
    }

    pub(crate) fn now(&self) -> Duration {
        static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        ORIGIN.get_or_init(std::time::Instant::now).elapsed()
    }
}
