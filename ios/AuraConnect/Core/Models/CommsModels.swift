import Foundation
import FirebaseFirestore

// v2 communication & coordination models (see the "v2" sections of
// `functions/src/shared/types.ts`). Like the other models, every field is optional or
// decoded leniently so one malformed document never breaks a list.

// MARK: - Enums

enum TriageUrgency: String, Codable, CaseIterable, Identifiable, Hashable {
    case routine, urgent, emergent

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .routine)
    }

    var label: String {
        switch self {
        case .routine: return "Routine"
        case .urgent: return "Urgent"
        case .emergent: return "Emergent"
        }
    }

    /// Sort weight, higher is more severe.
    var severity: Int {
        switch self {
        case .routine: return 0
        case .urgent: return 1
        case .emergent: return 2
        }
    }
}

enum TriageDisposition: String, Codable, CaseIterable, Identifiable, Hashable {
    case adviceGiven = "advice_given"
    case visitScheduled = "visit_scheduled"
    case visitMade = "visit_made"
    case mdContacted = "md_contacted"
    case ems911 = "ems_911"
    case other

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .adviceGiven: return "Advice given"
        case .visitScheduled: return "Visit scheduled"
        case .visitMade: return "Visit made"
        case .mdContacted: return "MD contacted"
        case .ems911: return "EMS / 911"
        case .other: return "Other"
        }
    }
}

// MARK: - IDG meetings

struct IdgActionItem: Codable, Hashable {
    var title: String
    var assigneeUid: String?
    /// `YYYY-MM-DD`
    var dueDate: String?

    enum CodingKeys: String, CodingKey {
        case title, assigneeUid, dueDate
    }

    init(title: String = "", assigneeUid: String? = nil, dueDate: String? = nil) {
        self.title = title
        self.assigneeUid = assigneeUid
        self.dueDate = dueDate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.lenient(.title) ?? ""
        assigneeUid = c.lenient(.assigneeUid)
        dueDate = c.lenient(.dueDate)
    }

    var dictionary: [String: Any] {
        [
            "title": title.trimmed,
            "assigneeUid": orNull(assigneeUid?.nilIfBlank),
            "dueDate": orNull(dueDate?.nilIfBlank),
        ]
    }
}

struct IdgPatientNote: Codable, Hashable {
    var summary: String?
    var planOfCareChanges: String?
    var goalsOfCare: String?
    var actionItems: [IdgActionItem]?
    var reviewed: Bool?
    var updatedBy: String?
    var updatedAt: Date?

    var isReviewed: Bool { reviewed ?? false }
    var items: [IdgActionItem] { actionItems ?? [] }
}

struct IdgAiPrep: Codable, Hashable {
    var text: String?
    var model: String?
    var generatedAt: Date?
}

/// `orgs/{orgId}/idgMeetings/{meetingId}` — written only by Cloud Functions.
struct IdgMeeting: Codable, Identifiable {
    @DocumentID var id: String?
    var title: String?
    var teamId: String?
    var scheduledAt: Date?
    /// `scheduled` or `completed`.
    var status: String?
    var attendeeUids: [String]?
    var patientIds: [String]?
    var patientNames: [String: String]?
    var notes: [String: IdgPatientNote]?
    var aiPrep: [String: IdgAiPrep]?
    var createdBy: String?
    var createdAt: Date?
    var completedAt: Date?
    var completedBy: String?

    static let completedStatus = "completed"

    var isCompleted: Bool { status == Self.completedStatus }
    var displayTitle: String { title?.nilIfBlank ?? "IDG meeting" }
    var agenda: [String] { patientIds ?? [] }
    var attendees: [String] { attendeeUids ?? [] }

    func patientName(_ patientId: String) -> String {
        patientNames?[patientId]?.nilIfBlank ?? "Patient"
    }

    func note(for patientId: String) -> IdgPatientNote? { notes?[patientId] }
    func prep(for patientId: String) -> IdgAiPrep? { aiPrep?[patientId] }

    var reviewedCount: Int {
        agenda.filter { notes?[$0]?.isReviewed == true }.count
    }
}

// MARK: - Triage

/// `orgs/{orgId}/triageCalls/{callId}` — written only by Cloud Functions.
struct TriageCall: Codable, Identifiable {
    @DocumentID var id: String?
    var patientId: String?
    var patientName: String?
    var callerName: String?
    var callerRelationship: String?
    var callerPhone: String?
    var reason: String?
    var symptoms: [String]?
    var urgency: TriageUrgency?
    /// `open` or `resolved`.
    var status: String?
    var assignedUid: String?
    var roleKey: String?
    var alertId: String?
    var disposition: TriageDisposition?
    var dispositionNote: String?
    var receivedAt: Date?
    var receivedBy: String?
    var resolvedAt: Date?
    var resolvedBy: String?

    static let resolvedStatus = "resolved"

    var isOpen: Bool { status != Self.resolvedStatus }
    var callUrgency: TriageUrgency { urgency ?? .routine }
    var displayCaller: String { callerName?.nilIfBlank ?? "Unknown caller" }
    var symptomList: [String] { symptoms ?? [] }
}

/// Response of `logTriageCall`.
struct TriageLogResult: Hashable {
    var callId: String
    var assignedUid: String?
    var alertId: String?
}

/// Optional follow-up task for `resolveTriageCall`.
struct TriageFollowUpTask: Hashable {
    var title: String
    var assigneeUid: String?
    /// `YYYY-MM-DD`
    var dueDate: String?

    var dictionary: [String: Any] {
        var value: [String: Any] = ["title": title.trimmed]
        if let assigneeUid = assigneeUid?.nilIfBlank { value["assigneeUid"] = assigneeUid }
        if let dueDate = dueDate?.nilIfBlank { value["dueDate"] = dueDate }
        return value
    }
}

// MARK: - Dashboard metrics

/// `orgs/{orgId}/metrics/{YYYY-MM-DD}` — computed by Cloud Functions; admin read.
/// Numbers decode as `Double` so integer and floating-point values both decode.
struct DailyMetrics: Codable, Identifiable {
    @DocumentID var id: String?
    var date: String?
    var census: CensusStats?
    /// Keyed by `LevelOfCare` raw value.
    var levelOfCare: [String: Double]?
    var alerts: AlertStats?
    var deadlines: DeadlineStats?
    var visits: VisitStats?
    var triage: TriageStats?
    var volunteers: VolunteerStats?
    var bereavement: BereavementStats?
    var computedAt: Date?

    struct CensusStats: Codable, Hashable {
        var admitted: Double?
        var referral: Double?
        var dischargedToday: Double?
        var deathsToday: Double?
    }

    struct AlertStats: Codable, Hashable {
        var created: Double?
        var acked: Double?
        var medianAckMinutes: Double?
        var exhausted: Double?
    }

    struct DeadlineStats: Codable, Hashable {
        var dueNext7Days: Double?
        var overdue: Double?
        var completedOnTime30d: Double?
        var completedLate30d: Double?
    }

    struct VisitStats: Codable, Hashable {
        var scheduled: Double?
        var completed: Double?
        var missed: Double?
        var cancelled: Double?
    }

    struct TriageStats: Codable, Hashable {
        var calls: Double?
        var emergent: Double?
        var medianResolveMinutes: Double?
    }

    struct VolunteerStats: Codable, Hashable {
        var minutesLast30d: Double?
        var activeAssignments: Double?
    }

    struct BereavementStats: Codable, Hashable {
        var activePlans: Double?
        var contactsDueNext7Days: Double?
        var contactsOverdue: Double?
    }
}

// MARK: - Messaging extras

/// One hit from the `searchMessages` callable.
struct MessageSearchHit: Codable, Identifiable, Hashable {
    var channelId: String
    var channelName: String?
    var messageId: String
    var senderName: String
    /// ~160 characters around the match.
    var snippet: String
    var createdAt: Date?

    var id: String { "\(channelId)/\(messageId)" }
}

extension MessageSearchHit {
    init?(dictionary: [String: Any]) {
        guard let channelId = dictionary["channelId"] as? String, !channelId.isEmpty,
              let messageId = dictionary["messageId"] as? String, !messageId.isEmpty else { return nil }
        self.init(
            channelId: channelId,
            channelName: (dictionary["channelName"] as? String)?.nilIfBlank,
            messageId: messageId,
            senderName: dictionary["senderName"] as? String ?? "",
            snippet: dictionary["snippet"] as? String ?? "",
            createdAt: CallableValue.date(dictionary["createdAt"])
        )
    }
}

struct MessageSearchResult: Hashable {
    var hits: [MessageSearchHit]
    var truncated: Bool
}

/// Response of `sendBroadcast`.
struct BroadcastResult: Hashable {
    var channelId: String
    var messageId: String?
    var recipientCount: Int
}

/// Output of `summarizeChannel` / `generateHandoff`. Never stored.
struct AiTextResult: Codable, Hashable {
    var text: String
    var model: String
    /// Always shown to users: AI output must be verified by a clinician.
    var disclaimer: String

    static let defaultDisclaimer = "AI-generated content may be incomplete or incorrect. A clinician must verify it before acting on it."
}

extension AiTextResult {
    init(dictionary: [String: Any]) {
        self.init(
            text: dictionary["text"] as? String ?? "",
            model: dictionary["model"] as? String ?? "",
            disclaimer: (dictionary["disclaimer"] as? String)?.nilIfBlank ?? AiTextResult.defaultDisclaimer
        )
    }
}

/// Recipients of `sendBroadcast` (the `BroadcastTarget` tagged union).
enum BroadcastTarget: Hashable {
    case team(String)
    case role(String)
    case discipline(Discipline)
    case all

    var kind: String {
        switch self {
        case .team: return "team"
        case .role: return "role"
        case .discipline: return "discipline"
        case .all: return "all"
        }
    }

    /// Encoded for callables, e.g. `{ kind: 'team', teamId }`.
    var dictionary: [String: Any] {
        switch self {
        case .team(let teamId): return ["kind": "team", "teamId": teamId]
        case .role(let roleKey): return ["kind": "role", "roleKey": roleKey]
        case .discipline(let discipline): return ["kind": "discipline", "discipline": discipline.rawValue]
        case .all: return ["kind": "all"]
        }
    }
}

// MARK: - Callable response parsing

enum CallableValue {
    /// Parses a timestamp returned by a callable: `{seconds, nanoseconds}` /
    /// `{_seconds, _nanoseconds}` objects, epoch milliseconds, or ISO 8601 strings.
    static func date(_ value: Any?) -> Date? {
        if let map = value as? [String: Any] {
            let seconds = (map["seconds"] as? NSNumber) ?? (map["_seconds"] as? NSNumber)
            let nanos = (map["nanoseconds"] as? NSNumber) ?? (map["_nanoseconds"] as? NSNumber)
            guard let seconds else { return nil }
            return Date(timeIntervalSince1970: seconds.doubleValue + (nanos?.doubleValue ?? 0) / 1_000_000_000)
        }
        if let number = value as? NSNumber {
            return Date(timeIntervalSince1970: number.doubleValue / 1000)
        }
        if let string = value as? String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: string) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: string)
        }
        return nil
    }

    static func int(_ value: Any?) -> Int? {
        (value as? NSNumber)?.intValue
    }

    /// ISO 8601 instant for callable requests (e.g. IDG `scheduledAt`).
    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
