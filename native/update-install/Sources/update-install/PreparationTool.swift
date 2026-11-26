// Starts local update tools in the installer's process group and cancels the active tool on command-pipe EOF.
import Darwin
import Foundation

struct PreparationTool {
    let executable: String
    let arguments: [String]
    let environment: [String: String]?

    func spawn() throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw startError }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
              posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0 else { throw startError }
        var argv = ([executable] + arguments).map { strdup($0) }
        var env = (environment ?? ProcessInfo.processInfo.environment).map { strdup("\($0.key)=\($0.value)") }
        defer { for pointer in argv + env { free(pointer) } }
        guard !argv.contains(nil), !env.contains(nil) else { throw startError }
        argv.append(nil)
        env.append(nil)
        var pid: pid_t = 0
        // Foundation's Process creates its own group. Inherit the helper's group so a forced stop reaches this tool.
        guard posix_spawn(&pid, executable, &actions, nil, &argv, &env) == 0 else { throw startError }
        return pid
    }

    private var startError: InstallError { InstallError("Could not start \(executable) for the app update.") }
}

/// Reads cancellation while extraction and assessment are still running.
final class InstallerInput {
    private let lock = NSLock()
    private let received = DispatchSemaphore(value: 0)
    private var action: String?
    private var cancelled = false
    private var tool: pid_t?

    init(read: @escaping () -> String? = { readLine() }) {
        DispatchQueue.global(qos: .utility).async {
            let command = read()
            self.lock.withLock {
                self.action = command
                self.cancelled = command != "quit" && command != "restart"
                if self.cancelled, let tool = self.tool { kill(tool, SIGKILL) }
            }
            self.received.signal()
        }
    }

    func start(_ process: PreparationTool) throws -> pid_t {
        try lock.withLock {
            guard !cancelled else { throw InstallError("Update preparation was cancelled.") }
            let pid = try process.spawn()
            tool = pid
            return pid
        }
    }

    func checked() throws {
        try lock.withLock {
            tool = nil
            guard !cancelled else { throw InstallError("Update preparation was cancelled.") }
        }
    }

    func decision() -> String? {
        received.wait()
        return lock.withLock { cancelled ? nil : action }
    }
}

func run(_ executable: String, _ arguments: [String], environment: [String: String]? = nil, input: InstallerInput? = nil) throws {
    let process = PreparationTool(executable: executable, arguments: arguments, environment: environment)
    let pid = try input?.start(process) ?? process.spawn()
    defer { while waitpid(pid, nil, 0) == -1 && errno == EINTR {} }
    var result = siginfo_t()
    // Keep the PID reserved until cancellation releases it, even if the tool has exited.
    var waited: Int32
    repeat { waited = waitid(P_PID, id_t(pid), &result, WEXITED | WNOWAIT) } while waited == -1 && errno == EINTR
    try input?.checked()
    guard waited == 0, result.si_code == CLD_EXITED, result.si_status == 0 else {
        throw InstallError("\(executable) could not complete the app update.")
    }
}
