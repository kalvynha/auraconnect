import Foundation
import Observation

/// Per-org state shared across features: the org document and a live members cache
/// (used for display names, pickers and "read by").
@MainActor
@Observable
final class OrgStore {
    let context: OrgContext
    private(set) var org: Org?
    private(set) var members: [String: Member] = [:]
    private(set) var membersLoaded = false
    var error: String?

    init(context: OrgContext) {
        self.context = context
    }

    var orgId: String { context.orgId }
    var uid: String { context.uid }
    var role: Role { me?.role ?? context.role }

    var me: Member? { members[context.uid] }

    /// Name written into `senderName` (rules require 1–200 characters).
    var myName: String {
        let name = me?.displayName?.nilIfBlank ?? context.email?.nilIfBlank ?? "Team member"
        return String(name.prefix(200))
    }

    var leadDays: Int { org?.deadlineLeadDays ?? AppConfig.defaultDeadlineLeadDays }

    /// Active members sorted by name.
    var activeMembers: [Member] {
        members.values.filter { $0.isActive }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func name(for uid: String?) -> String {
        guard let uid else { return "Unknown" }
        if uid == context.uid { return "You" }
        return members[uid]?.name ?? "Unknown member"
    }

    func names(for uids: [String]) -> String {
        uids.map { name(for: $0) }.joined(separator: ", ")
    }

    /// Direct channels show the other member's name; others use the channel name.
    func title(for channel: Channel) -> String {
        if let name = channel.name?.nilIfBlank { return name }
        let others = channel.members.filter { $0 != context.uid }
        switch channel.channelType {
        case .direct:
            if let other = others.first { return members[other]?.name ?? "Direct message" }
            return "Notes to self"
        default:
            if others.isEmpty { return "Conversation" }
            return others.prefix(3).map { members[$0]?.name ?? "Member" }.joined(separator: ", ")
                + (others.count > 3 ? " +\(others.count - 3)" : "")
        }
    }

    // MARK: Listeners

    func runMembers() async {
        do {
            for try await list in MemberRepository(orgId: orgId).members() {
                var map: [String: Member] = [:]
                for member in list where !member.memberUid.isEmpty {
                    map[member.memberUid] = member
                }
                members = map
                membersLoaded = true
            }
        } catch {
            self.error = error.userMessage
            membersLoaded = true
        }
    }

    func runOrg() async {
        do {
            for try await value in MemberRepository(orgId: orgId).org() {
                org = value
            }
        } catch {
            // Non-fatal: defaults are used for org settings.
        }
    }
}
