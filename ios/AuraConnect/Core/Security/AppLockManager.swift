import Foundation
import Observation
import SwiftUI
import LocalAuthentication

/// Face ID / Touch ID (falling back to the device passcode) lock on launch and after
/// `AppConfig.autoLockInterval` in the background.
@MainActor
@Observable
final class AppLockManager {
    private static let enabledKey = "appLockEnabled"

    private(set) var isEnabled: Bool
    private(set) var isLocked: Bool
    private(set) var isAuthenticating = false
    /// Set when the device has no passcode / biometrics, so the lock cannot be enforced.
    private(set) var unavailableReason: String?
    var lastError: String?

    @ObservationIgnored private var backgroundedAt: Date?
    /// The lock screen prompts automatically once per lock; afterwards the user taps Unlock.
    @ObservationIgnored private var didAutoPrompt = false

    init() {
        let enabled = (UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool) ?? true
        isEnabled = enabled
        isLocked = enabled
    }

    var biometryLabel: String {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Passcode"
        }
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        if !enabled { isLocked = false }
    }

    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = Date() }
        case .active:
            if let since = backgroundedAt, isEnabled,
               Date().timeIntervalSince(since) >= AppConfig.autoLockInterval {
                lock()
            }
            backgroundedAt = nil
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// Locks immediately (e.g. on sign-out so the next user must authenticate).
    func lockNow() {
        if isEnabled { lock() }
    }

    private func lock() {
        isLocked = true
        didAutoPrompt = false
    }

    /// The user just proved identity with their password; don't immediately ask for Face ID too.
    func didAuthenticateWithPassword() {
        isLocked = false
        backgroundedAt = nil
    }

    /// Prompts once automatically when the lock screen becomes visible and active.
    func autoUnlockIfNeeded() async {
        guard isLocked, !didAutoPrompt else { return }
        didAutoPrompt = true
        await unlock()
    }

    func unlock() async {
        guard isLocked, !isAuthenticating else { return }
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            // No passcode is set on this device: the lock cannot be enforced.
            unavailableReason = "Set a device passcode to protect patient information with \(biometryLabel)."
            isLocked = false
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            let success = try await context.evaluatePolicy(.deviceOwnerAuthentication,
                                                           localizedReason: "Unlock AuraConnect to view patient information.")
            if success {
                isLocked = false
                lastError = nil
            }
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}
