import SwiftUI

@main
struct AuraConnectApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var session = SessionStore()
    @State private var lock = AppLockManager()
    @State private var router = Router.shared

    init() {
        // Also called from AppDelegate; configure() is idempotent. Doing it here guarantees
        // Firebase is ready before the first view reads `FirebaseService.isConfigured`.
        FirebaseService.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(lock)
                .environment(router)
                .task {
                    session.start()
                }
        }
    }
}
