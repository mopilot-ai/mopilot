//! The core's ordered stream, as JS sees it (docs/architecture/rust-core.md §4). An environment has one threadsafe
//! function, made when it first needs one, and everything the core sends it goes through that: the events `subscribe`
//! hands to a listener as Buffers, and the reply of every call, so a reply follows the events its call emitted.
//!
//! The function's life decides what is safe here. Node closes it as its environment ends, and versions before 24.14 then
//! free it whatever thread count it holds. So a core thread may only call it under the lock in dispatch's `stream`, and it
//! is detached in its own finalizer, which also gives up the core's thread count: from 24.14 Node keeps a function until
//! that is gone. A function per call could not do this: a call on a core thread has no way to learn that its function is
//! gone. Messages still queued at the end reach `deliver` with no env, after the finalizer. An environment with no call
//! running doesn't keep its process alive.

use super::{args, buffer, check, instance, settled, string, thrown, Fail, Instance};
use dispatch::stream::{attach, detach, Message};
use napi_sys as sys;
use std::ffi::c_void;
use std::ptr;

type Function = sys::napi_threadsafe_function;

/// The function, as a core thread holds it.
struct Sender(Function);

// SAFETY: a threadsafe function is made to be called from any thread, and this one is called only under the streams' lock
unsafe impl Send for Sender {}

impl Sender {
    fn send(&self, message: Message) {
        let data = Box::into_raw(Box::new(message));
        // SAFETY: while attached the function is alive, as this file's header says. The queue has no limit, so this never blocks
        let status = unsafe { sys::napi_call_threadsafe_function(self.0, data.cast(), sys::ThreadsafeFunctionCallMode::nonblocking) };
        if status != sys::Status::napi_ok {
            // the env is going: Node never took `data`, so it is still this function's to free
            // SAFETY: `data` is the Box leaked above, and nothing else holds it
            drop(unsafe { Box::from_raw(data) });
        }
    }
}

/// Call the env's listener, if it has one, with `bytes`. A listener that throws has thrown at nobody, as an event
/// emitter's would: the exception goes to the process's handler, and the next message still comes.
fn event(env: sys::napi_env, data: &Instance, bytes: &[u8]) -> Result<(), Fail> {
    if data.listener.get().is_null() {
        return Ok(());
    }
    let mut listener = ptr::null_mut();
    // SAFETY: `listener` receives the function the reference holds, which lives as long as the env
    check(unsafe { sys::napi_get_reference_value(env, data.listener.get(), &mut listener) })?;
    let value = buffer(env, bytes)?;
    let mut global = ptr::null_mut();
    // SAFETY: `global` receives the env's global object
    check(unsafe { sys::napi_get_global(env, &mut global) })?;
    // SAFETY: `listener` is the function given to `subscribe`, called with one value from this env
    let status = unsafe { sys::napi_call_function(env, global, listener, 1, &value, ptr::null_mut()) };
    if status == sys::Status::napi_pending_exception {
        let mut thrown = ptr::null_mut();
        // SAFETY: `thrown` receives the exception that is pending, which is then reported once
        check(unsafe { sys::napi_get_and_clear_last_exception(env, &mut thrown) })?;
        // SAFETY: as above
        return check(unsafe { sys::napi_fatal_exception(env, thrown) });
    }
    check(status)
}

/// One message, on the JS thread. With no env the stream has ended, and `context` may be gone: only the message is freed.
unsafe extern "C" fn deliver(env: sys::napi_env, _callback: sys::napi_value, context: *mut c_void, data: *mut c_void) {
    // SAFETY: `data` is the Box `send` leaked, taken back here once
    let message = unsafe { Box::from_raw(data.cast::<Message>()) };
    if env.is_null() {
        return;
    }
    // SAFETY: an env is passed only before the function's end, when `context` is this env's instance
    let instance = unsafe { &*context.cast::<Instance>() };
    match *message {
        Message::Event(bytes) => {
            // nobody is left to hear of a failure here: the env can't run JS
            let _ = event(env, instance, &bytes);
        }
        Message::Reply { ticket, reply } => {
            settled(env, ticket as sys::napi_deferred, reply);
            instance.running.set(instance.running.get() - 1);
            if instance.running.get() == 0 {
                // SAFETY: on the JS thread of the env that made the function
                let _ = check(unsafe { sys::napi_unref_threadsafe_function(env, instance.stream.get()) });
            }
        }
    }
}

/// The function's end, in the env's teardown: no core thread is inside it once this returns, so the core's thread count
/// can go. `context` is the env's instance, alive here.
unsafe extern "C" fn ended(_env: sys::napi_env, owner: *mut c_void, context: *mut c_void) {
    detach(owner as dispatch::Owner);
    // SAFETY: as above
    let function = unsafe { &*context.cast::<Instance>() }.stream.get();
    // SAFETY: the function is alive during its own finalizer, and this is the core's one release. Node refuses it, harmlessly,
    // if a send during its closing already gave the count up
    let _ = unsafe { sys::napi_release_threadsafe_function(function, sys::ThreadsafeFunctionReleaseMode::release) };
}

/// This env's function, made the first time.
fn stream(env: sys::napi_env, data: &Instance) -> Result<Function, Fail> {
    if !data.stream.get().is_null() {
        return Ok(data.stream.get());
    }
    let name = string(env, "mopilot_core.stream")?;
    let mut function = ptr::null_mut();
    // SAFETY: no JS function, since `deliver` calls the listener itself; an unlimited queue and one thread count, the
    // core's, held for the function's life; `ended` gets the owner number, and `context` is the env's instance
    check(unsafe {
        sys::napi_create_threadsafe_function(
            env,
            ptr::null_mut(),
            ptr::null_mut(),
            name,
            0,
            1,
            data.owner as *mut c_void,
            Some(ended),
            ptr::from_ref(data).cast_mut().cast(),
            Some(deliver),
            &mut function,
        )
    })?;
    // SAFETY: on the JS thread that made it: only a running call holds the process open
    check(unsafe { sys::napi_unref_threadsafe_function(env, function) })?;
    data.stream.set(function);
    let sender = Sender(function);
    attach(data.owner, move |message| sender.send(message));
    Ok(function)
}

/// A call is starting: the stream it will answer on exists, and holds the process open until `deliver` has its reply.
pub(super) fn call_starts(env: sys::napi_env, data: &Instance) -> Result<(), Fail> {
    let function = stream(env, data)?;
    if data.running.get() == 0 {
        // SAFETY: on the JS thread that made it
        check(unsafe { sys::napi_ref_threadsafe_function(env, function) })?;
    }
    data.running.set(data.running.get() + 1);
    Ok(())
}

/// `subscribe(listener)`: this env's events go to `listener`. An env has one, for good: core.cjs shares it.
pub(super) fn subscribe(env: sys::napi_env, info: sys::napi_callback_info) -> Result<sys::napi_value, Fail> {
    let [listener] = args::<1>(env, info)?;
    let data = instance(env)?;
    if !data.listener.get().is_null() {
        return thrown(env, "this environment already has a listener on the core's stream");
    }
    let mut kind = 0;
    // SAFETY: `kind` receives the value's type
    check(unsafe { sys::napi_typeof(env, listener, &mut kind) })?;
    if kind != sys::ValueType::napi_function {
        return thrown(env, "subscribe takes a function");
    }
    stream(env, data)?;
    let mut reference = ptr::null_mut();
    // SAFETY: `reference` receives a strong reference, which holds the listener for as long as the env lives
    check(unsafe { sys::napi_create_reference(env, listener, 1, &mut reference) })?;
    data.listener.set(reference);
    let mut undefined = ptr::null_mut();
    // SAFETY: `undefined` receives the env's undefined
    check(unsafe { sys::napi_get_undefined(env, &mut undefined) })?;
    Ok(undefined)
}
