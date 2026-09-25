import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/onCallRoles/{roleKey}` — addressable roles such as `oncall-rn-north`.
struct OnCallRole: Codable, Identifiable {
    @DocumentID var id: String?
    var label: String?
    var discipline: Discipline?
    var teamId: String?
    /// Used when nobody is scheduled for this role.
    var fallbackUids: [String]?

    var roleKey: String { id ?? "" }
    var displayLabel: String { label?.nilIfBlank ?? roleKey }
}

/// `orgs/{orgId}/shifts/{shiftId}` — who holds a role for a time range.
struct Shift: Codable, Identifiable {
    @DocumentID var id: String?
    var roleKey: String?
    var uid: String?
    var start: Date?
    var end: Date?
    var notes: String?

    /// `start <= now < end`
    func isActive(at now: Date) -> Bool {
        guard let start, let end else { return false }
        return start <= now && now < end
    }
}
