import Foundation
import FirebaseFirestore

// v4 messaging models (docs/DATA_MODEL.md "v4: messaging"; types.ts "v4 — messaging").
// Presence / out-of-office / global notification settings live on `Member` (Org.swift).
// Every model decodes leniently so one malformed field never drops a document.

// MARK: - Templates

/// `TemplateCategory` in types.ts. Unknown values decode as `logistics`.
enum TemplateCategory: String, Codable, CaseIterable, Identifiable, Hashable {
    case escalation
    case clinical
    case visit
    case endOfLife = "end_of_life"
    case orders
    case family
    case logistics
    case quickReply = "quick_reply"

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .logistics)
    }

    var label: String {
        switch self {
        case .escalation: return "Escalation"
        case .clinical: return "Clinical"
        case .visit: return "Visits"
        case .endOfLife: return "End of life"
        case .orders: return "Orders"
        case .family: return "Family"
        case .logistics: return "Logistics"
        case .quickReply: return "Quick replies"
        }
    }

    /// Display order of the category sections.
    var sortIndex: Int {
        TemplateCategory.allCases.firstIndex(of: self) ?? 0
    }
}

enum TemplateFieldKind: String, Codable, CaseIterable, Hashable {
    case text, multiline, choice, number

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .text)
    }
}

/// A form input of a template; its value replaces `{{key}}` in the body.
struct TemplateField: Codable, Hashable, Identifiable {
    var key: String
    var label: String
    var kind: TemplateFieldKind
    var options: [String]?
    var required: Bool

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, label, kind, options, required
    }

    init(key: String, label: String, kind: TemplateFieldKind = .text, options: [String]? = nil, required: Bool = false) {
        self.key = key
        self.label = label
        self.kind = kind
        self.options = options
        self.required = required
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(.key) ?? ""
        label = c.lenient(.label) ?? key
        kind = c.lenient(.kind) ?? .text
        options = c.lenient(.options)
        required = c.lenient(.required) ?? false
    }

    /// Callable shape: `options` only on choice fields (the server rejects them elsewhere).
    var dictionary: [String: Any] {
        var value: [String: Any] = ["key": key, "label": label, "kind": kind.rawValue, "required": required]
        if kind == .choice, let options, !options.isEmpty { value["options"] = options }
        return value
    }
}

enum TemplateScope: String, Hashable {
    case org, personal
}

/// `orgs/{orgId}/messageTemplates/{id}` (admin-managed) and
/// `orgs/{orgId}/members/{uid}/templates/{id}` (personal). `id` and `scope` come from the
/// document path (set by `TemplateRepository`), not from the data.
struct MessageTemplate: Codable, Identifiable, Hashable {
    var id: String = ""
    var scope: TemplateScope = .org
    var title: String
    var category: TemplateCategory
    var body: String
    var fields: [TemplateField]
    /// Priority preselected in the composer.
    var defaultPriority: Priority
    /// Shown only in patient channels when true.
    var patientContext: Bool
    /// Sort order within the category.
    var order: Int
    var active: Bool
    var createdBy: String?
    var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case title, category, body, fields, defaultPriority, patientContext, order, active, createdBy, updatedAt
    }

    init(
        title: String,
        category: TemplateCategory,
        body: String,
        fields: [TemplateField] = [],
        defaultPriority: Priority = .normal,
        patientContext: Bool = false,
        order: Int = 0,
        active: Bool = true
    ) {
        self.title = title
        self.category = category
        self.body = body
        self.fields = fields
        self.defaultPriority = defaultPriority
        self.patientContext = patientContext
        self.order = order
        self.active = active
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.lenient(.title) ?? "Untitled"
        category = c.lenient(.category) ?? .logistics
        body = c.lenient(.body) ?? ""
        fields = (c.lenient(.fields) as [TemplateField]?)?.filter { !$0.key.isEmpty } ?? []
        defaultPriority = c.lenient(.defaultPriority) ?? .normal
        patientContext = c.lenient(.patientContext) ?? false
        order = c.lenient(.order) ?? 0
        active = c.lenient(.active) ?? true
        createdBy = c.lenient(.createdBy)
        updatedAt = c.lenient(.updatedAt)
    }

    var isPersonal: Bool { scope == .personal }

    /// `SaveTemplateRequest.template` (everything except `createdBy` / `updatedAt`).
    var requestDictionary: [String: Any] {
        [
            "title": title.trimmed,
            "category": category.rawValue,
            "body": body,
            "fields": fields.map { $0.dictionary },
            "defaultPriority": defaultPriority.rawValue,
            "patientContext": patientContext,
            "order": order,
            "active": active,
        ]
    }

    /// The marker `onMessageCreated` strips from the start of a message to set `templateId`.
    static func marker(for templateId: String) -> String { "[[tpl:\(templateId)]]" }

    /// Removes a leading `[[tpl:{id}]]` marker (for showing local, not-yet-processed copies).
    static func strippingMarker(_ text: String) -> String {
        guard text.hasPrefix("[[tpl:"), let end = text.range(of: "]]") else { return text }
        return String(text[end.upperBound...])
    }
}

/// Mirrors `DEFAULT_QUICK_REPLIES` in types.ts.
let DEFAULT_QUICK_REPLIES: [String] = [
    "Acknowledged", "On my way", "Call me", "Will visit within 1 hour", "Calling the family now", "Please call the MD",
]

/// Mirrors `ALLOWED_REACTIONS` in types.ts (the rules reject anything else).
let ALLOWED_REACTIONS: [String] = ["👍", "✅", "❤️", "🙏", "👀", "❗"]

// MARK: - Per-channel notification preferences

/// `ChannelNotifyMode` in types.ts. Unknown values decode as `all`.
enum ChannelNotifyMode: String, Codable, CaseIterable, Identifiable, Hashable {
    case all
    case mentions
    case urgentOnly = "urgent_only"

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .all)
    }

    var label: String {
        switch self {
        case .all: return "All messages"
        case .mentions: return "Mentions only"
        case .urgentOnly: return "Urgent only"
        }
    }

    var detail: String {
        switch self {
        case .all: return "Push for every message."
        case .mentions: return "Push only when you're @mentioned (urgent and critical always push)."
        case .urgentOnly: return "Push only for urgent and critical messages."
        }
    }
}

/// `orgs/{orgId}/channels/{channelId}/prefs/{uid}` — self-written; rules require exactly
/// `{mode, mutedUntil, updatedAt == request.time}`.
struct ChannelPrefs: Codable, Hashable {
    var mode: ChannelNotifyMode
    /// Normal-priority pushes are suppressed until this instant.
    var mutedUntil: Date?
    var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case mode, mutedUntil, updatedAt
    }

    init(mode: ChannelNotifyMode = .all, mutedUntil: Date? = nil, updatedAt: Date? = nil) {
        self.mode = mode
        self.mutedUntil = mutedUntil
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.lenient(.mode) ?? .all
        mutedUntil = c.lenient(.mutedUntil)
        updatedAt = c.lenient(.updatedAt)
    }

    func isMuted(at now: Date = Date()) -> Bool {
        guard let mutedUntil else { return false }
        return mutedUntil > now
    }
}

// MARK: - Acks, reactions, pins, reminders

/// `orgs/{orgId}/channels/{channelId}/acks/{uid}` — `{messageId, ackedAt}`.
struct BroadcastAck: Codable, Hashable {
    var messageId: String?
    var ackedAt: Date?

    enum CodingKeys: String, CodingKey {
        case messageId, ackedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = c.lenient(.messageId)
        ackedAt = c.lenient(.ackedAt)
    }
}

/// `orgs/{orgId}/channels/{channelId}/messages/{messageId}/reactions/{uid}` — `{emoji, at}`.
struct Reaction: Codable, Hashable {
    var emoji: String?
    var at: Date?

    enum CodingKeys: String, CodingKey {
        case emoji, at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emoji = c.lenient(.emoji)
        at = c.lenient(.at)
    }
}

/// One entry of `message.reactionCounts` for display.
struct ReactionCount: Hashable {
    let emoji: String
    let count: Int
}

/// An entry of `channel.pinned` (max 10, newest first).
struct PinnedMessage: Codable, Hashable {
    var messageId: String
    var snippet: String
    var pinnedBy: String?
    var pinnedAt: Date?

    enum CodingKeys: String, CodingKey {
        case messageId, snippet, pinnedBy, pinnedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = c.lenient(.messageId) ?? ""
        snippet = c.lenient(.snippet) ?? ""
        pinnedBy = c.lenient(.pinnedBy)
        pinnedAt = c.lenient(.pinnedAt)
    }
}

/// `orgs/{orgId}/reminders/{id}` — "remind me if no reply" (written by functions; owner-readable).
struct NoReplyReminder: Codable, Identifiable {
    @DocumentID var id: String?
    var channelId: String?
    var messageId: String?
    var ownerUid: String?
    var dueAt: Date?
    /// `pending`, `fired` or `cancelled`.
    var status: String?

    static let pendingStatus = "pending"
}

// MARK: - Callable responses

/// `messageReadStatus` response.
struct MessageReadStatus {
    struct Reader: Identifiable, Hashable {
        var uid: String
        var name: String
        var at: Date?
        var id: String { uid }
    }

    var read: [Reader]
    var unread: [Reader]

    var total: Int { read.count + unread.count }

    init(read: [Reader], unread: [Reader]) {
        self.read = read
        self.unread = unread
    }

    init(dictionary: [String: Any]) {
        read = (dictionary["read"] as? [[String: Any]] ?? []).compactMap { item in
            guard let uid = item["uid"] as? String else { return nil }
            return Reader(uid: uid, name: item["name"] as? String ?? "Member", at: CallableValue.date(item["at"]))
        }
        unread = (dictionary["unread"] as? [[String: Any]] ?? []).compactMap { item in
            guard let uid = item["uid"] as? String else { return nil }
            return Reader(uid: uid, name: item["name"] as? String ?? "Member", at: nil)
        }
    }
}

/// `broadcastAckReport` response.
struct BroadcastAckReport {
    struct Entry: Identifiable, Hashable {
        var uid: String
        var name: String
        var ackedAt: Date?
        var id: String { uid }
    }

    var total: Int
    var acked: [Entry]
    var pending: [Entry]

    init(dictionary: [String: Any]) {
        acked = (dictionary["acked"] as? [[String: Any]] ?? []).compactMap { item in
            guard let uid = item["uid"] as? String else { return nil }
            return Entry(uid: uid, name: item["name"] as? String ?? "Member", ackedAt: CallableValue.date(item["ackedAt"]))
        }
        pending = (dictionary["pending"] as? [[String: Any]] ?? []).compactMap { item in
            guard let uid = item["uid"] as? String else { return nil }
            return Entry(uid: uid, name: item["name"] as? String ?? "Member", ackedAt: nil)
        }
        total = CallableValue.int(dictionary["total"]) ?? (acked.count + pending.count)
    }
}
