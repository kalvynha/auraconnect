import Foundation

/// FCM data payload (see `PushData` in types.ts). Never contains PHI; the app
/// fetches the actual content after the user authenticates.
struct PushData: Equatable {
    enum Kind: String {
        case message, alert
    }

    var type: Kind
    var orgId: String
    var channelId: String?
    var alertId: String?
    var priority: Priority

    init(type: Kind, orgId: String, channelId: String? = nil, alertId: String? = nil, priority: Priority = .normal) {
        self.type = type
        self.orgId = orgId
        self.channelId = channelId
        self.alertId = alertId
        self.priority = priority
    }

    /// Parses the `userInfo` of a remote notification. FCM puts data keys at the top level.
    init?(userInfo: [AnyHashable: Any]) {
        func string(_ key: String) -> String? {
            (userInfo[key] as? String)?.nilIfBlank
        }
        guard let rawType = string("type"), let kind = Kind(rawValue: rawType) else { return nil }
        self.type = kind
        self.orgId = string("orgId") ?? ""
        self.channelId = string("channelId")
        self.alertId = string("alertId")
        self.priority = string("priority").flatMap { Priority(rawValue: $0) } ?? .normal
        switch kind {
        case .message where channelId == nil: return nil
        case .alert where alertId == nil && channelId == nil: return nil
        default: break
        }
    }
}
