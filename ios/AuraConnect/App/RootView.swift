import SwiftUI

/// Chooses between setup error, sign-in, org onboarding and the main app, and layers the
/// app lock and privacy shield on top.
struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppLockManager.self) private var lock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            content
            if session.isSignedIn && lock.isLocked {
                LockScreenView()
                    .transition(.opacity)
                    .zIndex(1)
            }
            if scenePhase != .active {
                PrivacyShieldView()
                    .zIndex(2)
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            lock.handleScenePhase(newPhase)
        }
    }

    @ViewBuilder
    private var content: some View {
        if !FirebaseService.isConfigured {
            SetupErrorView()
        } else {
            switch session.phase {
            case .loading:
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signedOut:
                SignInView()
            case .needsOrg:
                OrgOnboardingView()
            case .ready(let context):
                MainTabView(context: context)
                    .id(context)
            case .failed(let message):
                SessionErrorView(message: message)
            }
        }
    }
}

/// Shown when GoogleService-Info.plist is missing from the bundle.
struct SetupErrorView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Firebase is not configured", systemImage: "wrench.and.screwdriver")
        } description: {
            Text("Add GoogleService-Info.plist to ios/AuraConnect/Resources, run `xcodegen generate`, and rebuild. To use local emulators instead, run the AuraConnect-Emulators scheme (USE_FIREBASE_EMULATORS=1).")
        }
    }
}

struct SessionErrorView: View {
    @Environment(SessionStore.self) private var session
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't load your organization", systemImage: "exclamationmark.icloud")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") {
                Task { await session.loadOrg() }
            }
            .buttonStyle(.borderedProminent)
            Button("Sign out", role: .destructive) {
                Task { await session.signOut() }
            }
        }
    }
}
