//! Keeps the addon's code loaded on Windows for the process's life. Node closes an addon when the environment that loaded
//! it ends, which unmaps it once no other environment holds it, and the core's threads (crates/dispatch) run and park in
//! that code. Only Windows does unmap it: napi-build links a glibc build NODELETE (crates/node/build.rs), musl never
//! unloads and macOS won't unload a library with thread-locals, so there it stays by itself (checked by looking for it
//! after its only environment ended).

use std::sync::Once;
use windows_sys::Win32::System::LibraryLoader::{
    GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_PIN,
};

/// Pin the library, once a process.
pub fn pin() {
    static PINNED: Once = Once::new();
    PINNED.call_once(|| {
        let mut module = std::ptr::null_mut();
        // SAFETY: the "name" is an address in this library, as the flag says, and `module` receives its handle
        unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                pin as *const () as *const u16,
                &mut module,
            )
        };
    });
}
