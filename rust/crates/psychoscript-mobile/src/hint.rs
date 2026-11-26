//! Android's performance hint (ADPF) for a live run's thread: a frame's work, from the program receiving `{ type:
//! "frame" }` to its next wait for a message, against a target of one vsync period (the shortest `frame.dt` so far),
//! so the system runs the thread on a core and at a clock that fit. One session per run thread, made at its first
//! frame and closed as the thread ends; a frame costs two clock readings and one call. Nothing where the API is
//! missing (before Android 13, or a device without it) or off Android.

#[cfg(target_os = "android")]
mod imp {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use std::time::Instant;

    type GetManager = unsafe extern "C" fn() -> *mut c_void;
    type CreateSession = unsafe extern "C" fn(*mut c_void, *const i32, usize, i64) -> *mut c_void;
    type SetTarget = unsafe extern "C" fn(*mut c_void, i64) -> i32;
    type Report = unsafe extern "C" fn(*mut c_void, i64) -> i32;
    type Close = unsafe extern "C" fn(*mut c_void);

    /// `APerformanceHint_*` from `libandroid.so` (API 33), looked up once.
    struct Api {
        manager: *mut c_void,
        create: CreateSession,
        target: SetTarget,
        report: Report,
        close: Close,
    }

    // SAFETY: the manager is a process-wide singleton the NDK documents as usable from any thread.
    unsafe impl Send for Api {}
    unsafe impl Sync for Api {}

    fn api() -> Option<&'static Api> {
        static API: OnceLock<Option<Api>> = OnceLock::new();
        API.get_or_init(|| {
            // SAFETY: dlopen/dlsym with NUL-terminated names; each symbol is cast to its NDK signature.
            unsafe {
                let lib = libc::dlopen(
                    c"libandroid.so".as_ptr(),
                    libc::RTLD_NOW | libc::RTLD_NOLOAD,
                );
                let lib = match lib.is_null() {
                    true => libc::dlopen(c"libandroid.so".as_ptr(), libc::RTLD_NOW),
                    false => lib,
                };
                if lib.is_null() {
                    return None;
                }
                let sym = |name: &std::ffi::CStr| {
                    let f = libc::dlsym(lib, name.as_ptr());
                    (!f.is_null()).then_some(f)
                };
                let get = std::mem::transmute::<*mut c_void, GetManager>(sym(
                    c"APerformanceHint_getManager",
                )?);
                let manager = get();
                if manager.is_null() {
                    return None;
                }
                Some(Api {
                    manager,
                    create: std::mem::transmute::<*mut c_void, CreateSession>(sym(
                        c"APerformanceHint_createSession",
                    )?),
                    target: std::mem::transmute::<*mut c_void, SetTarget>(sym(
                        c"APerformanceHint_updateTargetWorkDuration",
                    )?),
                    report: std::mem::transmute::<*mut c_void, Report>(sym(
                        c"APerformanceHint_reportActualWorkDuration",
                    )?),
                    close: std::mem::transmute::<*mut c_void, Close>(sym(
                        c"APerformanceHint_closeSession",
                    )?),
                })
            }
        })
        .as_ref()
    }

    /// The calling thread's session, its target, and the frame in progress.
    struct Session {
        api: &'static Api,
        raw: *mut c_void,
        target: i64,
        since: Option<Instant>,
    }

    impl Drop for Session {
        fn drop(&mut self) {
            // SAFETY: a session this thread made, closed once.
            unsafe { (self.api.close)(self.raw) }
        }
    }

    thread_local! {
        /// `None` until the thread's first frame; `Some(None)` where no session could be made.
        static SESSION: RefCell<Option<Option<Session>>> = const { RefCell::new(None) };
    }

    /// The program on this thread received a frame, `dt` seconds after the one before.
    pub(crate) fn frame(dt: Option<f64>) {
        let dt = dt
            .filter(|d| d.is_finite() && *d > 0.004)
            .map(|d| (d * 1e9) as i64);
        SESSION.with_borrow_mut(|s| {
            let s = s.get_or_insert_with(|| {
                let api = api()?;
                // SAFETY: the calling thread's own id, a target in nanoseconds.
                let tid = unsafe { libc::gettid() };
                let target = dt.unwrap_or(16_666_667);
                let raw = unsafe { (api.create)(api.manager, &tid, 1, target) };
                (!raw.is_null()).then_some(Session {
                    api,
                    raw,
                    target,
                    since: None,
                })
            });
            let Some(s) = s.as_mut() else { return };
            if let Some(dt) = dt.filter(|dt| *dt < s.target) {
                s.target = dt;
                // SAFETY: this thread's session.
                unsafe { (s.api.target)(s.raw, dt) };
            }
            s.since = Some(Instant::now());
        });
    }

    /// The program on this thread waits for its next message: the frame's work, if one is in progress, is reported.
    pub(crate) fn idle() {
        SESSION.with_borrow_mut(|s| {
            let Some(Some(s)) = s.as_mut() else { return };
            if let Some(since) = s.since.take() {
                let work = (since.elapsed().as_nanos() as i64).max(1);
                // SAFETY: this thread's session.
                unsafe { (s.api.report)(s.raw, work) };
            }
        });
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    pub(crate) fn frame(_dt: Option<f64>) {}
    pub(crate) fn idle() {}
}

pub(crate) use imp::{frame, idle};
