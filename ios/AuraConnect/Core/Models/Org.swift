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

    /// The member's uid (document id, falling back to the `uid` field).
    var memberUid: String { id ?? uid ?? "" }

    var name: String {
        if let displayName = displayName?.nilIfBlank { return displayName }
        if let email = email?.nilIfBlank { return email }
        return "Unknown member"
    }

    var isActive: Bool { active ?? true }

    /// e.g. "RN · Case Manager"
    var subtitle: String {
        [discipline?.label, title?.nilIfBlank].compactMap { $0 }.joined(separator: " · ")
    }

    var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map { String($0) }.joined()
        return letters.isEmpty ? "?" : letters.uppercased()
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
