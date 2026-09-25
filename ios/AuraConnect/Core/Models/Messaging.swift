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

    var members: [String] { memberUids ?? [] }
    var channelType: ChannelType { type ?? .group }
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

    var text: String { body ?? "" }
    var messagePriority: Priority { priority ?? .normal }
    var files: [Attachment] { attachments ?? [] }
}

/// `orgs/{orgId}/channels/{channelId}/reads/{uid}` (document id == uid).
struct ReadReceipt: Codable, Identifiable {
    @DocumentID var id: String?
    var lastReadAt: Date?
}
