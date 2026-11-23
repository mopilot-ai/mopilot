//! The core as a Node addon (docs/architecture/rust-core.md §3): `dispatch(route, payload)` runs a route on the core's
//! threads and resolves with its reply (a Buffer) or rejects with its error, `dispatchCancellable(route, payload)` does
//! the same as `{ id, reply }`, `cancel(id)` asks such a call to stop, `dispatchSync(route, payload)` runs a route on the
//! calling thread for a caller that must answer at once, `subscribe(listener)` hears what routes emit, and `routes()`
//! lists the routes. Replies and events reach JS through one ordered stream (`stream`). It holds no logic of its own
//! (the routes, threads and handles live in crates/dispatch and the crates that submit routes), and registers its
//! exports through Node-API directly, so every line here is one the binding tests run.

use napi_sys as sys;
use std::cell::Cell;
use std::ffi::{c_char, c_void, CString};
use std::panic::catch_unwind;
use std::ptr;

// the routes these crates submit are linked in only if each crate is used
use batcher as _;
use caps as _;
use framing as _;
use llmroute as _;
use proc as _;
use rank as _;
use rollout as _;
use session as _;
use store as _;
use transcript as _;
use translate as _;

#[cfg(windows)]
mod pin;
mod stream;
#[cfg(feature = "test-routes")]
mod test_routes;

/// A failed Node-API call, as its status.
type Fail = sys::napi_status;

fn check(status: sys::napi_status) -> Result<(), Fail> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(status)
    }
}

/// A JS string of `text`.
fn string(env: sys::napi_env, text: &str) -> Result<sys::napi_value, Fail> {
    let mut value = ptr::null_mut();
    // SAFETY: `text` is valid UTF-8 for its length, and `value` receives the new string
    check(unsafe { sys::napi_create_string_utf8(env, text.as_ptr().cast::<c_char>(), text.len() as isize, &mut value) })?;
    Ok(value)
}

/// A JS Error whose message is `message`. A cancelled call's has the code CORE_CANCELLED, for a caller to tell it from a
/// failure.
fn error(env: sys::napi_env, message: &str) -> Result<sys::napi_value, Fail> {
    let text = string(env, message)?;
    let code = if message == dispatch::CANCELLED { string(env, "CORE_CANCELLED")? } else { ptr::null_mut() };
    let mut value = ptr::null_mut();
    // SAFETY: `text` and `code` (when there is one) are JS strings from this env
    check(unsafe { sys::napi_create_error(env, code, text, &mut value) })?;
    Ok(value)
}

/// The call's first `N` arguments (missing ones are `undefined`).
fn args<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info) -> Result<[sys::napi_value; N], Fail> {
    let mut argv = [ptr::null_mut(); N];
    let mut argc = N;
    // SAFETY: `argv` has room for `argc` values
    check(unsafe { sys::napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), ptr::null_mut()) })?;
    Ok(argv)
}

/// The Rust string a JS string holds.
fn read_string(env: sys::napi_env, value: sys::napi_value) -> Result<String, Fail> {
    let mut len = 0;
    // SAFETY: a null buffer asks for the length only
    check(unsafe { sys::napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut len) })?;
    let mut buf = vec![0u8; len + 1];
    // SAFETY: `buf` has room for the string and its NUL
    check(unsafe { sys::napi_get_value_string_utf8(env, value, buf.as_mut_ptr().cast(), buf.len(), &mut len) })?;
    buf.truncate(len);
    String::from_utf8(buf).map_err(|_| sys::Status::napi_string_expected)
}

/// The bytes a JS Buffer holds, copied.
fn read_buffer(env: sys::napi_env, value: sys::napi_value) -> Result<Vec<u8>, Fail> {
    let mut data = ptr::null_mut();
    let mut len = 0;
    // SAFETY: the Buffer's memory is valid for `len` bytes while this call runs, and is copied before it returns
    check(unsafe { sys::napi_get_buffer_info(env, value, &mut data, &mut len) })?;
    // SAFETY: as above; an empty Buffer may hand back a null pointer, which a zero length never reads
    Ok(if len == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec() })
}

/// Settle the promise behind `deferred`, once, with `reply`. A promise that can't be settled has nothing left to report to.
fn settled(env: sys::napi_env, deferred: sys::napi_deferred, reply: dispatch::Reply) {
    let settled = match reply {
        Ok(bytes) => buffer(env, &bytes).and_then(|value| {
            // SAFETY: `deferred` is this call's promise, settled exactly once
            check(unsafe { sys::napi_resolve_deferred(env, deferred, value) })
        }),
        Err(message) => error(env, &message).and_then(|value| {
            // SAFETY: as above
            check(unsafe { sys::napi_reject_deferred(env, deferred, value) })
        }),
    };
    let _ = settled;
}

/// A JS Buffer holding a copy of `bytes`.
fn buffer(env: sys::napi_env, bytes: &[u8]) -> Result<sys::napi_value, Fail> {
    let mut value = ptr::null_mut();
    // SAFETY: `bytes` is valid for its length and is copied into the new Buffer
    check(unsafe { sys::napi_create_buffer_copy(env, bytes.len(), bytes.as_ptr().cast(), ptr::null_mut(), &mut value) })?;
    Ok(value)
}

/// What an env keeps here, used only on its JS thread: who it is, its stream once it has one, its listener once it has
/// one, and how many of its calls are running, which is what holds its process open for them.
struct Instance {
    owner: dispatch::Owner,
    stream: Cell<sys::napi_threadsafe_function>,
    listener: Cell<sys::napi_ref>,
    running: Cell<usize>,
}

/// This env's `Instance`, which `adopt` stored and Node frees after the env's last use of it.
fn instance<'a>(env: sys::napi_env) -> Result<&'a Instance, Fail> {
    let mut data = ptr::null_mut();
    // SAFETY: `data` receives the pointer stored at registration
    check(unsafe { sys::napi_get_instance_data(env, &mut data) })?;
    // SAFETY: that pointer is a live `Instance`, as long as a call can come from this env
    Ok(unsafe { &*data.cast::<Instance>() })
}

/// This env's owner number.
fn owner(env: sys::napi_env) -> Result<dispatch::Owner, Fail> {
    instance(env).map(|data| data.owner)
}

/// Throw an Error of `message`: what a JS-callable returns then.
fn thrown(env: sys::napi_env, message: &str) -> Result<sys::napi_value, Fail> {
    let value = error(env, message)?;
    // SAFETY: `value` is an Error from this env, thrown once; the call returns nothing after it
    check(unsafe { sys::napi_throw(env, value) })?;
    Ok(ptr::null_mut())
}

/// Start the call `info` describes on the core's threads: its id and the promise of its reply.
fn start(env: sys::napi_env, info: sys::napi_callback_info) -> Result<(u64, sys::napi_value), Fail> {
    let [route, payload] = args::<2>(env, info)?;
    let (route, payload, data) = (read_string(env, route)?, read_buffer(env, payload)?, instance(env)?);
    let mut promise = ptr::null_mut();
    let mut deferred = ptr::null_mut();
    // SAFETY: both out-pointers receive the new promise and its deferred
    check(unsafe { sys::napi_create_promise(env, &mut deferred, &mut promise) })?;
    stream::call_starts(env, data)?;
    Ok((dispatch::spawn_ordered(data.owner, route, payload, deferred as usize), promise))
}

/// `dispatchCancellable(route, payload)`: `{ id, reply }`, the call's id for `cancel` and the promise `dispatch` returns.
fn start_cancellable(env: sys::napi_env, info: sys::napi_callback_info) -> Result<sys::napi_value, Fail> {
    let (id, promise) = start(env, info)?;
    with_id(env, id, promise)
}

/// `{ id, reply }`, what a call that can be cancelled returns.
fn with_id(env: sys::napi_env, id: u64, promise: sys::napi_value) -> Result<sys::napi_value, Fail> {
    let mut object = ptr::null_mut();
    // SAFETY: `object` receives the new object
    check(unsafe { sys::napi_create_object(env, &mut object) })?;
    let mut number = ptr::null_mut();
    // SAFETY: `number` receives the new number; ids stay far below 2^53, JS's exact integers
    check(unsafe { sys::napi_create_int64(env, id as i64, &mut number) })?;
    // SAFETY: the names are NUL-terminated, and every value is from this env
    check(unsafe { sys::napi_set_named_property(env, object, c"id".as_ptr(), number) })?;
    // SAFETY: as above
    check(unsafe { sys::napi_set_named_property(env, object, c"reply".as_ptr(), promise) })?;
    Ok(object)
}

/// `cancel(id)`: ask a call of `dispatchCancellable` to stop; whether it was still running. Its reply says how it ended.
fn stop(env: sys::napi_env, info: sys::napi_callback_info) -> Result<sys::napi_value, Fail> {
    let [id] = args::<1>(env, info)?;
    let mut number = 0;
    // SAFETY: `number` receives the id
    check(unsafe { sys::napi_get_value_int64(env, id, &mut number) })?;
    let mut value = ptr::null_mut();
    // SAFETY: `value` receives the boolean
    check(unsafe { sys::napi_get_boolean(env, dispatch::cancel(number as u64), &mut value) })?;
    Ok(value)
}

/// `dispatchSync(route, payload)`: the route's reply now (a Buffer), or its error thrown. It runs on the JS thread and
/// blocks it meanwhile: for a caller that must answer synchronously, such as the chat store opening at startup.
fn call(env: sys::napi_env, info: sys::napi_callback_info) -> Result<sys::napi_value, Fail> {
    let [route, payload] = args::<2>(env, info)?;
    match dispatch::dispatch_call(&read_string(env, route)?, &read_buffer(env, payload)?, &dispatch::Call::of(owner(env)?)) {
        Ok(bytes) => buffer(env, &bytes),
        Err(message) => thrown(env, &message),
    }
}

/// `routes()`: the routes the core serves, as an array of strings.
fn list(env: sys::napi_env) -> Result<sys::napi_value, Fail> {
    let names = dispatch::routes();
    let mut array = ptr::null_mut();
    // SAFETY: `array` receives the new array
    check(unsafe { sys::napi_create_array_with_length(env, names.len(), &mut array) })?;
    for (i, name) in names.iter().enumerate() {
        let value = string(env, name)?;
        // SAFETY: `array` and `value` are from this env
        check(unsafe { sys::napi_set_element(env, array, i as u32, value) })?;
    }
    Ok(array)
}

/// A JS-callable result: the value, or a thrown Error naming the failed Node-API status.
fn returned(env: sys::napi_env, result: Result<sys::napi_value, Fail>) -> sys::napi_value {
    result.unwrap_or_else(|status| {
        // the message holds no NUL, so the CString is the whole of it
        let message = CString::new(format!("the core binding failed (Node-API status {status})")).unwrap_or_default();
        // SAFETY: `message` is NUL-terminated; the error takes no code, and is thrown once
        unsafe { sys::napi_throw_error(env, ptr::null(), message.as_ptr()) };
        ptr::null_mut()
    })
}

unsafe extern "C" fn js_dispatch(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, start(env, info).map(|(_, promise)| promise))
}

unsafe extern "C" fn js_dispatch_cancellable(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, start_cancellable(env, info))
}

unsafe extern "C" fn js_subscribe(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, stream::subscribe(env, info))
}

unsafe extern "C" fn js_cancel(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, stop(env, info))
}

unsafe extern "C" fn js_dispatch_sync(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, call(env, info))
}

unsafe extern "C" fn js_routes(env: sys::napi_env, _info: sys::napi_callback_info) -> sys::napi_value {
    returned(env, list(env))
}

/// Set `exports[name]` to a function calling `cb`.
fn export(env: sys::napi_env, exports: sys::napi_value, name: &str, cb: sys::napi_callback) -> Result<(), Fail> {
    let cname = CString::new(name).map_err(|_| sys::Status::napi_invalid_arg)?;
    let mut function = ptr::null_mut();
    // SAFETY: `cname` is NUL-terminated for its length, and `cb` is this module's callback
    check(unsafe { sys::napi_create_function(env, cname.as_ptr(), name.len() as isize, cb, ptr::null_mut(), &mut function) })?;
    // SAFETY: `exports` is the module's exports object
    check(unsafe { sys::napi_set_named_property(env, exports, cname.as_ptr(), function) })
}

/// The env is going: its calls stop and its handles close, whoever forgot to.
unsafe extern "C" fn env_gone(owner: *mut c_void) {
    let owner = owner as dispatch::Owner;
    // a value's cleanup may panic, which must not end the process in a callback from C
    let _ = catch_unwind(|| dispatch::release(owner));
}

/// The `Instance` going with its env.
unsafe extern "C" fn instance_gone(_env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
    // SAFETY: `data` is the Box `adopt` leaked, and this is its one finalizer
    drop(unsafe { Box::from_raw(data.cast::<Instance>()) });
}

/// Give this env its owner number, and let what it owns go with it.
fn adopt(env: sys::napi_env) -> Result<(), Fail> {
    let owner = dispatch::new_owner();
    let data =
        Box::new(Instance { owner, stream: Cell::new(ptr::null_mut()), listener: Cell::new(ptr::null_mut()), running: Cell::new(0) });
    // SAFETY: Node keeps the pointer for this env and frees it through `instance_gone`
    check(unsafe { sys::napi_set_instance_data(env, Box::into_raw(data).cast(), Some(instance_gone), ptr::null_mut()) })?;
    // SAFETY: the "pointer" is a number that nothing dereferences; each env has its own, so the hook is unique
    check(unsafe { sys::napi_add_env_cleanup_hook(env, Some(env_gone), owner as *mut c_void) })
}

/// On Windows napi-sys resolves Node-API from the host process at run time (`napi_sys::setup`), not at link time as
/// elsewhere: done once, before the first call, and the host's library kept for the process's life.
#[cfg(target_env = "msvc")]
fn load_node_api() {
    static LOADED: std::sync::Once = std::sync::Once::new();
    // SAFETY: setup reads the host process's own exports; the library it returns stays loaded (forgotten) for good
    LOADED.call_once(|| std::mem::forget(unsafe { sys::setup() }));
}

/// Node-API's entry point: the module's exports, as this file's header lists them.
///
/// # Safety
/// Called by Node with a live env and the module's exports object.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: sys::napi_env, exports: sys::napi_value) -> sys::napi_value {
    #[cfg(target_env = "msvc")]
    load_node_api();
    #[cfg(windows)]
    pin::pin();
    returned(
        env,
        adopt(env)
            .and_then(|()| export(env, exports, "dispatch", Some(js_dispatch)))
            .and_then(|()| export(env, exports, "dispatchCancellable", Some(js_dispatch_cancellable)))
            .and_then(|()| export(env, exports, "cancel", Some(js_cancel)))
            .and_then(|()| export(env, exports, "dispatchSync", Some(js_dispatch_sync)))
            .and_then(|()| export(env, exports, "subscribe", Some(js_subscribe)))
            .and_then(|()| export(env, exports, "routes", Some(js_routes)))
            .map(|()| exports),
    )
}
