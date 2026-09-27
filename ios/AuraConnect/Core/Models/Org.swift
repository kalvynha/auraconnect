import Foundation
import FirebaseFirestore

/// `userOrgs/{uid}` — lets a signed-in user find their org before claims refresh.
struct UserOrg: Codable {
    var orgId: String?
    var role: Role?
}

/// `orgs/{orgId}`
struct Org: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String?
    var timezone: String?
    var deadlineLeadDays: Int?
    /// v3 (V1): reminder lead days per milestone kind (raw kind → days). Missing kinds use the defaults.
    var deadlineLeadDaysByKind: [String: Int]?
    var defaultEscalationPolicyId: String?
    var createdBy: String?
    var createdAt: Date?
}

/// `orgs/{orgId}/members/{uid}` (document id == uid).
struct Member: Codable, Identifiable {
    @DocumentID var id: String?
    var uid: String?
    var email: String?
    var displayName: String?
    var role: Role?
    var discipline: Discipline?
    var title: String?
    var phone: String?
    var teamIds: [String]?
    var active: Bool?
    var fcmTokens: [String]?
    var createdAt: Date?
    /// v3 extra permissions (`reports`, `audit`, `staffing`, `scheduling`, `volunteers`,
    /// `bereavement`). Raw strings so unknown values never break decoding. Admins hold all implicitly.
    var capabilities: [String]?
    // --- v4 messaging (self-writable; see `MemberSelfRepository`) ---
    /// Presence set by the member; ignore it once `until` has passed (see `currentStatus(at:)`).
    var status: MemberStatus?
    var outOfOffice: OutOfOffice?
    var notificationSettings: NotificationSettings?

    /// The member's uid (document id, falling back to the `uid` field).
    var memberUid: String { id ?? uid ?? "" }

    var name: String {
        if let displayName = displayName?.nilIfBlank { return displayName }
        if let email = email?.nilIfBlank { return email }
        return "Unknown member"
    }

    var isActive: Bool { active ?? true }

    /// True when the member holds `capability` explicitly or is an admin.
    func has(capability: String) -> Bool {
        role == .admin || (capabilities ?? []).contains(capability)
    }

    /// e.g. "RN · Case Manager"
    var subtitle: String {
        [discipline?.label, title?.nilIfBlank].compactMap { $0 }.joined(separator: " · ")
    }

    var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map { String($0) }.joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    /// v4: the member's status unless it has expired (`until <= now`) or has no state.
    func currentStatus(at now: Date = Date()) -> MemberStatus? {
        guard let status, status.state != nil else { return nil }
        if let until = status.until, until <= now { return nil }
        return status
    }

    /// v4: presence to show (nil when the member has not set one or it expired).
    func presence(at now: Date = Date()) -> PresenceState? {
        currentStatus(at: now)?.state
    }

    /// v4: the out-of-office entry while it is still in effect (`until > now`).
    func activeOutOfOffice(at now: Date = Date()) -> OutOfOffice? {
        guard let outOfOffice, let until = outOfOffice.until, until > now else { return nil }
        return outOfOffice
    }
}

// MARK: - v4 presence and notification settings (types.ts "v4 messaging")

/// `PresenceState` in types.ts. Unknown values decode as `available`.
enum PresenceState: String, Codable, CaseIterable, Identifiable, Hashable {
    case available
    case inVisit = "in_visit"
    case busy
    case off

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .available)
    }

    var label: String {
        switch self {
        case .available: return "Available"
        case .inVisit: return "In visit"
        case .busy: return "Busy"
        case .off: return "Off"
        }
    }
}

/// `members/{uid}.status` — `{state, text, until}`.
struct MemberStatus: Codable, Hashable {
    var state: PresenceState?
    var text: String?
    /// The status auto-clears after this instant (nil = until changed).
    var until: Date?

    enum CodingKeys: String, CodingKey {
        case state, text, until
    }

    init(state: PresenceState?, text: String?, until: Date?) {
        self.state = state
        self.text = text
        self.until = until
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = c.lenient(.state)
        text = c.lenient(.text)
        until = c.lenient(.until)
    }

    /// "In visit · Back at 3" (state label plus custom text).
    var summary: String {
        [state?.label, text?.nilIfBlank].compactMap { $0 }.joined(separator: " · ")
    }
}

/// `members/{uid}.outOfOffice` — `{until, delegateUid, note}`.
struct OutOfOffice: Codable, Hashable {
    var until: Date?
    var delegateUid: String?
    var note: String?

    enum CodingKeys: String, CodingKey {
        case until, delegateUid, note
    }

    init(until: Date?, delegateUid: String?, note: String?) {
        self.until = until
        self.delegateUid = delegateUid
        self.note = note
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        until = c.lenient(.until)
        delegateUid = c.lenient(.delegateUid)
        note = c.lenient(.note)
    }
}

/// `members/{uid}.notificationSettings` — `{quietHours: {start, end} | null, offShiftQuiet}`.
struct NotificationSettings: Codable, Hashable {
    struct QuietHours: Codable, Hashable {
        /// "HH:mm" in the org time zone.
        var start: String
        var end: String

        enum CodingKeys: String, CodingKey {
            case start, end
        }

        init(start: String, end: String) {
            self.start = start
            self.end = end
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            start = c.lenient(.start) ?? "22:00"
            end = c.lenient(.end) ?? "07:00"
        }
    }

    var quietHours: QuietHours?
    var offShiftQuiet: Bool

    enum CodingKeys: String, CodingKey {
        case quietHours, offShiftQuiet
    }

    init(quietHours: QuietHours?, offShiftQuiet: Bool) {
        self.quietHours = quietHours
        self.offShiftQuiet = offShiftQuiet
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        quietHours = c.lenient(.quietHours)
        offShiftQuiet = c.lenient(.offShiftQuiet) ?? false
    }
}

/// One entry of the `listMyInvites` callable response.
struct InviteSummary: Identifiable, Hashable {
    var orgId: String
    var inviteId: String
    var orgName: String
    var role: Role

    var id: String { "\(orgId)/\(inviteId)" }
}

/// `orgs/{orgId}/invites/{inviteId}` — written only by `inviteMember` / `acceptInvite`; readable by admins.
struct Invite: Codable, Identifiable {
    @DocumentID var id: String?
    /// Lower-cased email the invite is bound to.
    var email: String?
    var displayName: String?
    var role: Role?
    var discipline: Discipline?
    var teamIds: [String]?
    /// `pending`, `accepted` or `revoked`.
    var status: String?
    var createdBy: String?
    var createdAt: Date?
    var acceptedBy: String?
    var acceptedAt: Date?

    static let pendingStatus = "pending"

    var name: String {
        displayName?.nilIfBlank ?? email?.nilIfBlank ?? "Invitee"
    }
}

/// `orgs/{orgId}/teams/{teamId}`
struct Team: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String?
    var description: String?
    var memberUids: [String]?
    var createdAt: Date?

    var displayName: String { name?.nilIfBlank ?? "Unnamed team" }
}
