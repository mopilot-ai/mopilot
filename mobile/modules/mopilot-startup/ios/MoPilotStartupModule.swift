// Creates Expo's shared AppContext services once, while native modules register and before JS can call any of them, so concurrent async functions never race their lazy initialization (#4338).
import ExpoModulesCore

public final class MoPilotStartupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MoPilotStartup")

    // AppContext.fileSystem and .permissions are Swift lazy vars, which are not thread-safe. expo-sqlite opens databases on the
    // Swift cooperative pool (@JS(.concurrent)), and the phone opens four at launch: racing first reads each created a
    // FileSystemManager and released one another thread was still using (EXC_BAD_ACCESS in ensureDirExists). OnCreate runs
    // synchronously during module registration, so after it every later access is a plain read of an already-set value.
    OnCreate {
      _ = self.appContext?.fileSystem
      _ = self.appContext?.permissions
    }
  }
}
