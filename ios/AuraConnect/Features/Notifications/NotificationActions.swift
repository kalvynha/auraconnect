import Foundation
import UIKit
import UserNotifications
import FirebaseAuth
import FirebaseFirestore

/// v4 lock-screen actions. The backend sets `apns.payload.aps.category` (`notify.ts`) to
/// `AURA_ALERT` or `AURA_MESSAGE`; the payload's data keys (`orgId`, `alertId`, `channelId`,
/// `messageId`) sit at the top level of `userInfo`.
enum NotificationCategories {
    static let alert = "AURA_ALERT"
    static let message = "AURA_MESSAGE"

    static let acknowledgeAction = "AURA_ACKNOWLEDGE"
    static let replyAction = "AURA_REPLY"
    static let markReadAction = "AURA_MARK_READ"

    /// Registered once at launch (`AppDelegate`).
    static func register() {
        let acknowledge = UNNotificationAction(
            identifier: acknowledgeAction,
            title: "Acknowledge",
            options: [.authenticationRequired]
        )
        let reply = UNTextInputNotificationAction(
            identifier: replyAction,
            title: "Reply",
            options: [.authenticationRequired],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message"
        )
        // Also requires an unlocked device: the Firestore cache is protected with
        // NSFileProtectionComplete and cannot be opened while the device is locked.
        let markRead = UNNotificationAction(
            identifier: markReadAction,
            title: "Mark read",
            options: [.authenticationRequired]
        )
        let categories: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: alert, actions: [acknowledge], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: message, actions: [reply, markRead], intentIdentifiers: [], options: []),
        ]
        UNUserNotificationCenter.current().setNotificationCategories(categories)
    }
}

/// A lock-screen action, parsed synchronously from the `UNNotificationResponse` so only
/// plain strings cross into the async work.
struct NotificationActionRequest {
    enum Kind {
        case acknowledge
        case reply(String)
        case markRead
    }

    var kind: Kind
    var orgId: String?
    var alertId: String?
    var channelId: String?
    var messageId: String?
    /// For "open the app instead" (same deep link as a tap).
    var push: PushData?

    /// Nil for the default tap, dismiss, or unknown actions.
    init?(response: UNNotificationResponse) {
        let userInfo = response.notification.request.content.userInfo
        switch response.actionIdentifier {
        case NotificationCategories.acknowledgeAction:
            kind = .acknowledge
        case NotificationCategories.replyAction:
            let text = (response as? UNTextInputNotificationResponse)?.userText ?? ""
            kind = .reply(text)
        case NotificationCategories.markReadAction:
            kind = .markRead
        default:
            return nil
        }
        func string(_ key: String) -> String? {
            (userInfo[key] as? String)?.nilIfBlank
        }
        orgId = string("orgId")
        alertId = string("alertId")
        channelId = string("channelId")
        messageId = string("messageId")
        push = PushData(userInfo: userInfo)
    }
}

/// Performs lock-screen actions against Firebase. Never logs payload values or message text.
@MainActor
enum NotificationActionHandler {
    enum Outcome {
        case done
        /// Could not act in the background (signed out, missing ids, or the write failed).
        case openApp
    }

    static func perform(_ request: NotificationActionRequest) async -> Outcome {
        guard FirebaseService.isConfigured, let uid = Auth.auth().currentUser?.uid else {
            return .openApp
        }
        guard let orgId = request.orgId else { return .openApp }
        do {
            switch request.kind {
            case .acknowledge:
                guard let alertId = request.alertId else { return .openApp }
                try await FunctionsClient().ackAlert(orgId: orgId, alertId: alertId)
            case .reply(let text):
                guard let channelId = request.channelId else { return .openApp }
                guard let body = text.nilIfBlank else { return .done }
                try await reply(orgId: orgId, channelId: channelId, uid: uid, body: body)
                // Replying implies the conversation was read (best effort).
                try? await markRead(orgId: orgId, channelId: channelId, uid: uid)
            case .markRead:
                guard let channelId = request.channelId else { return .openApp }
                try await markRead(orgId: orgId, channelId: channelId, uid: uid)
            }
            return .done
        } catch {
            print("[Push] Notification action failed (code \((error as NSError).code))")
            return .openApp
        }
    }

    /// The app can't bring itself to the foreground from a background action, so a failed
    /// action posts a generic local notification (no PHI) whose tap opens the same deep link.
    static func postFallbackNotice(for request: NotificationActionRequest) async {
        let content = UNMutableNotificationContent()
        content.title = "AuraConnect"
        switch request.kind {
        case .acknowledge:
            content.body = "Open AuraConnect to acknowledge the alert."
        case .reply:
            content.body = "Your reply wasn't sent. Open AuraConnect to try again."
        case .markRead:
            content.body = "Open AuraConnect to view the conversation."
        }
        content.sound = .default
        if let push = request.push {
            var info: [String: String] = ["type": push.type.rawValue, "orgId": push.orgId, "priority": push.priority.rawValue]
            if let channelId = push.channelId { info["channelId"] = channelId }
            if let alertId = push.alertId { info["alertId"] = alertId }
            content.userInfo = info
        }
        let notice = UNNotificationRequest(identifier: "aura-action-fallback-\(UUID().uuidString)", content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(notice)
        } catch {
            print("[Push] Could not post fallback notice")
        }
    }

    private static func channelRef(orgId: String, channelId: String) -> DocumentReference {
        FirebaseService.orgRef(orgId).collection("channels").document(channelId)
    }

    /// Writes a normal message with the exact 8-field create shape (`MessageRepository.send`).
    /// The rules require `senderName == member.displayName`, so the member doc is read first.
    private static func reply(orgId: String, channelId: String, uid: String, body: String) async throws {
        let memberSnapshot = try await FirebaseService.orgRef(orgId).collection("members").document(uid).getDocument()
        guard let displayName = memberSnapshot.get("displayName") as? String, !displayName.isEmpty else {
            throw FunctionsClientError.badResponse("member")
        }
        let data: [String: Any] = [
            "senderUid": uid,
            "senderName": displayName,
            "body": String(body.prefix(AppConfig.maxMessageLength)),
            "priority": Priority.normal.rawValue,
            "attachments": [Any](),
            "roleTarget": NSNull(),
            "createdAt": FieldValue.serverTimestamp(),
            "alertId": NSNull(),
        ]
        // The async setData resumes once the server has accepted (or rejected) the write.
        try await channelRef(orgId: orgId, channelId: channelId).collection("messages").document().setData(data)
    }

    /// `reads/{uid}` = exactly `{lastReadAt: serverTimestamp}`.
    private static func markRead(orgId: String, channelId: String, uid: String) async throws {
        try await channelRef(orgId: orgId, channelId: channelId)
            .collection("reads").document(uid)
            .setData(["lastReadAt": FieldValue.serverTimestamp()])
    }
}

/// Keeps the app alive while a notification action finishes in the background.
@MainActor
final class BackgroundTaskToken {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    func begin(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // Called on the main thread when time runs out.
            let token = self
            MainActor.assumeIsolated {
                if let token {
                    token.end()
                }
            }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
