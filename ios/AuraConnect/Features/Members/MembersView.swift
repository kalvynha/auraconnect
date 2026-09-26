import SwiftUI
import Observation

@MainActor
@Observable
final class MembersViewModel {
    let orgId: String
    private(set) var pendingInvites: [Invite] = []
    private(set) var isLoadingInvites = true
    var invitesError: String?
    var searchText = ""

    init(orgId: String) {
        self.orgId = orgId
    }

    /// All members (active and inactive), filtered by the search text and sorted by name.
    func visibleMembers(from members: [String: Member]) -> [Member] {
        let query = searchText.nilIfBlank
        return members.values
            .filter { member in
                guard let query else { return true }
                return member.name.localizedCaseInsensitiveContains(query)
                    || (member.email?.localizedCaseInsensitiveContains(query) ?? false)
                    || (member.discipline?.label.localizedCaseInsensitiveContains(query) ?? false)
                    || (member.role?.label.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var visibleInvites: [Invite] {
        guard let query = searchText.nilIfBlank else { return pendingInvites }
        return pendingInvites.filter { invite in
            invite.name.localizedCaseInsensitiveContains(query)
                || (invite.email?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    /// Pending invites listener (admin-only read). Ends when the view's task is cancelled.
    func runInvites() async {
        do {
            for try await list in InviteRepository(orgId: orgId).pendingInvites() {
                pendingInvites = list
                isLoadingInvites = false
                invitesError = nil
            }
        } catch {
            isLoadingInvites = false
            invitesError = error.userMessage
        }
    }
}

/// Admin screen: the org's members plus pending invites, with a "+" to invite someone.
struct MembersView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        if org.role == .admin {
            MembersContent(orgId: org.orgId)
        } else {
            ContentUnavailableView("Admins only",
                                   systemImage: "lock",
                                   description: Text("Only administrators can manage members."))
                .navigationTitle("Members")
        }
    }
}

private struct MembersContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: MembersViewModel
    @State private var showInvite = false

    init(orgId: String) {
        _model = State(initialValue: MembersViewModel(orgId: orgId))
    }

    var body: some View {
        @Bindable var model = model
        let members = model.visibleMembers(from: org.members)
        let invites = model.visibleInvites
        List {
            if let error = org.error {
                ErrorBanner(message: error)
            }

            Section {
                if let error = model.invitesError {
                    ErrorBanner(message: error)
                } else if model.isLoadingInvites {
                    ProgressView()
                } else if invites.isEmpty {
                    Text(model.searchText.isEmpty ? "No pending invites." : "No matching invites.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(invites) { invite in
                    InviteRow(invite: invite)
                }
            } header: {
                Text("Pending invites")
            }

            Section {
                if !org.membersLoaded {
                    ProgressView()
                } else if members.isEmpty {
                    Text(model.searchText.isEmpty ? "No members yet." : "No matching members.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(members) { member in
                    MemberRow(member: member)
                }
            } header: {
                Text("Members (\(members.count))")
            }
        }
        .searchable(text: $model.searchText, prompt: "Name, email or discipline")
        .navigationTitle("Members")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showInvite = true
                } label: {
                    Label("Invite member", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showInvite) {
            InviteMemberView()
                .environment(org)
        }
        .task { await model.runInvites() }
    }
}

struct MemberRow: View {
    let member: Member

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(initials: member.initials)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name)
                    .font(.body)
                    .lineLimit(1)
                    .foregroundStyle(member.isActive ? Color.primary : Color.secondary)
                if !member.subtitle.isEmpty {
                    Text(member.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                let role = member.role ?? .viewer
                StatusPill(text: role.label, color: role.color)
                if !member.isActive {
                    StatusPill(text: "Inactive", color: .red)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct InviteRow: View {
    let invite: Invite

    private var detail: String {
        var parts: [String] = []
        if let email = invite.email?.nilIfBlank { parts.append(email) }
        if let discipline = invite.discipline { parts.append(discipline.label) }
        if let createdAt = invite.createdAt { parts.append("Sent \(RelativeTime.short(createdAt))") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "envelope")
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(invite.name)
                    .lineLimit(1)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            let role = invite.role ?? .viewer
            StatusPill(text: role.label, color: role.color)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
