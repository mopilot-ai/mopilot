// disclaim <command> [args...]
// Replaces this process with `command` (posix_spawn with POSIX_SPAWN_SETEXEC, so the pid, stdio, controlling
// terminal and signals carry over exactly as with exec) after asking the system to stop attributing the new
// process to its parent for TCC. The call is a private libSystem symbol, looked up at run time: if a future
// macOS drops it, the command still runs, just not disclaimed.
import Darwin

typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("usage: disclaim <command> [args...]\n", stderr)
    exit(64)
}

var attr: posix_spawnattr_t?
posix_spawnattr_init(&attr)
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))

if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") {  // RTLD_DEFAULT
    let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)
    if setDisclaim(&attr, 1) != 0 { fputs("disclaim: could not disclaim; running the command as is\n", stderr) }
}

var argv: [UnsafeMutablePointer<CChar>?] = args.dropFirst().map { strdup($0) }
argv.append(nil)
let rc = posix_spawnp(nil, args[1], nil, &attr, argv, environ)
// Only reached when the exec failed.
fputs("disclaim: \(args[1]): \(String(cString: strerror(rc)))\n", stderr)
exit(rc == ENOENT ? 127 : 126)
