//! The clocks: `std::time`, except in a browser (wasm32), where it panics and `web-time` reads `performance.now()`
//! and `Date.now()` instead.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::{Instant, SystemTime, UNIX_EPOCH};
#[cfg(target_arch = "wasm32")]
pub use web_time::{Instant, SystemTime, UNIX_EPOCH};
