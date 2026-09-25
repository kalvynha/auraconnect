import Foundation
import UIKit
import UserNotifications
import FirebaseMessaging

/// Stores this device's FCM token in `members/{uid}.fcmTokens` once the user's org is known,
/// and removes it again on sign-out.
@MainActor
final class PushTokenRegistrar {
    static let shared = PushTokenRegistrar()

    private(set) var token: String?
    private var orgId: String?
    private var uid: String?
    private var knownTokens: [String]?

    private init() {}

    /// Called by the Messaging delegate whenever FCM issues or rotates a token.
    func tokenDidChange(_ newToken: String?) {
        token = newToken
        persist()
    }

    /// Called once the org session is ready. `existingTokens` lets us respect the 20-token cap.
    func attach(orgId: String, uid: String, existingTokens: [String]?) {
        let changed = self.orgId != orgId || self.uid != uid
        self.orgId = orgId
        self.uid = uid
        self.knownTokens = existingTokens
        if changed { persist() }
    }

    /// Removes the token from the member doc (best effort) before signing out.
    func detach() async {
        if let token, let orgId, let uid {
            await MemberRepository(orgId: orgId).removeFCMToken(uid: uid, token: token)
        }
        orgId = nil
        uid = nil
        knownTokens = nil
    }

    private func persist() {
        guard let token, let orgId, let uid else { return }
        MemberRepository(orgId: orgId).addFCMToken(uid: uid, token: token, existing: knownTokens)
        var tokens = knownTokens ?? []
        if !tokens.contains(token) { tokens.append(token) }
        knownTokens = tokens
    }

    /// Asks for notification permission and registers with APNs.
    /// `.criticalAlert` is only requested when the entitlement has been approved.
    static func requestAuthorizationAndRegister() async {
        var options: UNAuthorizationOptions = [.alert, .badge, .sound]
        if AppConfig.criticalAlertsEnabled {
            options.insert(.criticalAlert)
        }
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: options)
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            print("[Push] Authorization failed: \(error.localizedDescription)")
        }
    }
}
