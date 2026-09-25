import SwiftUI

/// Covers the UI whenever the scene is not active so PHI never appears in the
/// app switcher snapshot or over a system prompt.
struct PrivacyShieldView: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThickMaterial)
            VStack(spacing: 12) {
                Image(systemName: "cross.case.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.accentColor)
                Text("AuraConnect")
                    .font(.title2.weight(.semibold))
            }
            .accessibilityElement(children: .combine)
        }
        .ignoresSafeArea()
    }
}

/// Full-screen lock shown until the user authenticates.
struct LockScreenView: View {
    @Environment(AppLockManager.self) private var lock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
                Text("AuraConnect is locked")
                    .font(.title2.weight(.semibold))
                Text("Authenticate to view messages and patient information.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let error = lock.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
                Button {
                    Task { await lock.unlock() }
                } label: {
                    Label("Unlock with \(lock.biometryLabel)", systemImage: "faceid")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(lock.isAuthenticating)
            }
            .padding(32)
            .frame(maxWidth: 480)
        }
        .task(id: scenePhase) {
            if scenePhase == .active {
                await lock.autoUnlockIfNeeded()
            }
        }
    }
}
