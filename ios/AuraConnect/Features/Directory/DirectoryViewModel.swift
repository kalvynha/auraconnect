import Foundation
import Observation

/// Live on-call roles and shifts, for "on call now" labels in the directory and profiles.
/// (Same listeners as the on-call schedule; roles and shifts are readable by every active member.)
@MainActor
@Observable
final class OnCallNowModel {
    let orgId: String
    private(set) var roles: [OnCallRole] = []
    private(set) var shifts: [Shift] = []

    init(orgId: String) {
        self.orgId = orgId
    }

    private var repository: ScheduleRepository { ScheduleRepository(orgId: orgId) }

    func runRoles() async {
        do {
            for try await list in repository.onCallRoles() {
                roles = list
            }
        } catch {
            // Non-fatal: the directory simply shows no on-call roles.
        }
    }

    func runShifts() async {
        do {
            for try await list in repository.currentAndUpcomingShifts(from: Date()) {
                shifts = list
            }
        } catch {
            // Non-fatal.
        }
    }

    func roleLabel(for key: String?) -> String {
        guard let key else { return "On call" }
        return roles.first { $0.roleKey == key }?.displayLabel ?? key
    }

    /// Labels of the roles `uid` holds at `now`, sorted.
    func onCallRoles(for uid: String, at now: Date) -> [String] {
        let labels = shifts
            .filter { $0.uid == uid && $0.isActive(at: now) }
            .map { roleLabel(for: $0.roleKey) }
        return Array(Set(labels)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// Uids on call at `now`.
    func onCallUids(at now: Date) -> Set<String> {
        Set(shifts.filter { $0.isActive(at: now) }.compactMap { $0.uid })
    }
}

/// Staff directory: search, discipline filter, and the "Message" action.
@MainActor
@Observable
final class DirectoryViewModel {
    let orgId: String
    let uid: String
    let onCall: OnCallNowModel
    var searchText = ""
    /// nil = all disciplines.
    var discipline: Discipline?
    var onCallOnly = false
    private(set) var openingUid: String?
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
        self.onCall = OnCallNowModel(orgId: orgId)
    }

    /// Active members visible to the viewer. Volunteers see only staff (no other volunteers);
    /// the directory never shows patient data.
    func visibleMembers(from org: OrgStore, now: Date) -> [Member] {
        let viewerIsVolunteer = org.isVolunteerMember
        let query = searchText.nilIfBlank
        let onCallUids = onCallOnly ? onCall.onCallUids(at: now) : []
        return org.activeMembers.filter { member in
            if viewerIsVolunteer && member.discipline == .volunteer && member.memberUid != uid {
                return false
            }
            if let discipline, member.discipline != discipline { return false }
            if onCallOnly && !onCallUids.contains(member.memberUid) { return false }
            guard let query else { return true }
            return member.name.localizedCaseInsensitiveContains(query)
                || member.subtitle.localizedCaseInsensitiveContains(query)
                || onCall.onCallRoles(for: member.memberUid, at: now)
                    .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    /// Disciplines present among the given members, in declaration order.
    func disciplines(in members: [Member]) -> [Discipline] {
        let present = Set(members.compactMap { $0.discipline })
        return Discipline.allCases.filter { present.contains($0) }
    }

    /// Creates (or reuses — idempotent server-side) the direct channel. Returns its id.
    func openDirectMessage(with otherUid: String) async -> String? {
        guard openingUid == nil else { return nil }
        openingUid = otherUid
        errorMessage = nil
        defer { openingUid = nil }
        do {
            return try await FunctionsClient().createChannel(orgId: orgId, type: .direct, memberUids: [otherUid])
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}
