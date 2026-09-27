import Foundation
import FirebaseFirestore

struct LastMessage: Codable, Hashable {
    var text: String
    var senderUid: String?
    var senderName: String?
    var priority: Priority
    var at: Date?

    enum CodingKeys: String, CodingKey {
        case text, senderUid, senderName, priority, at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.lenient(.text) ?? ""
        senderUid = c.lenient(.senderUid)
        senderName = c.lenient(.senderName)
        priority = c.lenient(.priority) ?? .normal
        at = c.lenient(.at)
    }
}

/// `orgs/{orgId}/channels/{channelId}` — created by Cloud Functions only.
struct Channel: Codable, Identifiable {
    @DocumentID var id: String?
    var type: ChannelType?
    /// Display name; null for direct channels (clients show the other member's name).
    var name: String?
    var memberUids: [String]?
    var patientId: String?
    var teamId: String?
    var createdBy: String?
    var createdAt: Date?
    var lastMessage: LastMessage?
    var lastMessageAt: Date?
    var archived: Bool?
    // v4 (server-written; optional on read)
    /// Pinned messages (max 10), newest first.
    var pinned: [PinnedMessage]?
    /// Broadcast channels only: recipients must acknowledge with `acks/{uid}`.
    var requireAck: Bool?
    /// Short description shown in the channel info sheet.
    var description: String?

    var members: [String] { memberUids ?? [] }
    var channelType: ChannelType { type ?? .group }
    /// Only the creator may post in a broadcast channel.
    var isBroadcast: Bool { channelType == .broadcast }
}

struct Attachment: Codable, Hashable {
    /// `orgs/{orgId}/channels/{channelId}/attachments/{fileName}`
    var storagePath: String
    var contentType: String
    var name: String
    var size: Int

    enum CodingKeys: String, CodingKey {
        case storagePath, contentType, name, size
    }

    init(storagePath: String, contentType: String, name: String, size: Int) {
        self.storagePath = storagePath
        self.contentType = contentType
        self.name = name
        self.size = size
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        storagePath = c.lenient(.storagePath) ?? ""
        contentType = c.lenient(.contentType) ?? "application/octet-stream"
        name = c.lenient(.name) ?? "Attachment"
        size = c.lenient(.size) ?? 0
    }

    var isImage: Bool { contentType.hasPrefix("image/") }
    var isPDF: Bool { contentType == "application/pdf" }

    var firestoreData: [String: Any] {
        ["storagePath": storagePath, "contentType": contentType, "name": name, "size": size]
    }
}

/// `orgs/{orgId}/channels/{channelId}/messages/{messageId}` — written directly by clients.
struct Message: Codable, Identifiable {
    @DocumentID var id: String?
    var senderUid: String?
    var senderName: String?
    var body: String?
    var priority: Priority?
    var attachments: [Attachment]?
    var roleTarget: String?
    var createdAt: Date?
    var alertId: String?
    // v2 (optional on read; older messages lack them)
    /// Thread replies point at their parent message id. Channel timelines hide replies.
    var threadParentId: String?
    /// Backend-maintained on parent messages.
    var replyCount: Int?
    /// Backend-maintained on parent messages.
    var lastReplyAt: Date?
    /// Set by `recallMessage`; body and attachments are then empty.
    var recalledAt: Date?
    // v4 (backend-written; the client create shape is unchanged)
    /// Member uids @mentioned in the body (includes resolved on-call roles).
    var mentions: [String]?
    /// On-call role keys @mentioned.
    var mentionRoles: [String]?
    /// Set by `editMessage`.
    var editedAt: Date?
    /// Set by `onMessageCreated` from a leading `[[tpl:{id}]]` marker.
    var templateId: String?
    /// Aggregate reaction counts, e.g. ["👍": 3].
    var reactionCounts: [String: Int]?

    var text: String { body ?? "" }
    var messagePriority: Priority { priority ?? .normal }
    var files: [Attachment] { attachments ?? [] }
    var isRecalled: Bool { recalledAt != nil }
    var isThreadReply: Bool { threadParentId?.nilIfBlank != nil }
    var replies: Int { replyCount ?? 0 }
    var isEdited: Bool { editedAt != nil }
    /// Text to show: a template marker not yet stripped by the backend is hidden.
    var displayText: String { MessageTemplate.strippingMarker(text) }
    /// Non-zero reaction counts in `ALLOWED_REACTIONS` order (unknown emoji last).
    var sortedReactions: [ReactionCount] {
        let counts = (reactionCounts ?? [:]).filter { $0.value > 0 }
        return counts.keys
            .sorted { (ALLOWED_REACTIONS.firstIndex(of: $0) ?? 99, $0) < (ALLOWED_REACTIONS.firstIndex(of: $1) ?? 99, $1) }
            .map { ReactionCount(emoji: $0, count: counts[$0] ?? 0) }
    }
    func isMentioning(_ uid: String) -> Bool { (mentions ?? []).contains(uid) }
}

/// `orgs/{orgId}/channels/{channelId}/reads/{uid}` (document id == uid).
struct ReadReceipt: Codable, Identifiable {
    @DocumentID var id: String?
    var lastReadAt: Date?
}
