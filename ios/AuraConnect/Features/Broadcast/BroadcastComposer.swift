import SwiftUI
import Observation

/// Admin-only broadcast (`sendBroadcast`): pick recipients by team, on-call role, discipline or
/// everyone. Recipients can read but not reply.
@MainActor
@Observable
final class BroadcastDraft {
    enum TargetKind: String, CaseIterable, Identifiable {
        case team = "Team"
        case role = "Role"
        case discipline = "Discipline"
        case all = "Everyone"
        var id: String { rawValue }
    }

    let orgId: String
    var targetKind: TargetKind = .team
    var teamId: String?
    var roleKey: String?
    var discipline: Discipline = .rn
    var name = ""
    var body = ""
    var priority: Priority = .normal
    /// v4: recipients must acknowledge the broadcast.
    var requireAck = false
    private(set) var teams: [Team] = []
    private(set) var isWorking = false
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    var target: BroadcastTarget? {
        switch targetKind {
        case .team: return teamId.map { BroadcastTarget.team($0) }
        case .role: return roleKey.map { BroadcastTarget.role($0) }
        case .discipline: return .discipline(discipline)
        case .all: return .all
        }
    }

    var isValid: Bool {
        guard target != nil, let name = name.nilIfBlank, let body = body.nilIfBlank else { return false }
        return name.count <= 200 && body.count <= AppConfig.maxMessageLength
    }

    func runTeams() async {
        do {
            for try await list in TeamRepository(orgId: orgId).teams() {
                teams = list
                    .filter { $0.id != nil }
                    .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// Returns the new broadcast channel id.
    func send() async -> String? {
        guard isValid, !isWorking, let target, let name = name.nilIfBlank, let body = body.nilIfBlank else { return nil }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let result = try await FunctionsClient().sendBroadcast(
                orgId: orgId, name: name, target: target, body: body, priority: priority, requireAck: requireAck
            )
            return result.channelId
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

/// Form sections for a broadcast; embedded in `NewMessageView`.
struct BroadcastSections: View {
    @Environment(OrgStore.self) private var org
    @Bindable var draft: BroadcastDraft
    let roles: [OnCallRole]

    var body: some View {
        if let error = draft.errorMessage {
            Section { ErrorBanner(message: error) }
        }

        Section {
            Picker("Send to", selection: $draft.targetKind) {
                ForEach(BroadcastDraft.TargetKind.allCases) { kind in
                    Text(kind.rawValue).tag(kind)
                }
            }
            switch draft.targetKind {
            case .team:
                Picker("Team", selection: $draft.teamId) {
                    Text("Choose a team").tag(String?.none)
                    ForEach(draft.teams) { team in
                        Text(team.displayName).tag(team.id)
                    }
                }
            case .role:
                Picker("On-call role", selection: $draft.roleKey) {
                    Text("Choose a role").tag(String?.none)
                    ForEach(roles) { role in
                        Text(role.displayLabel).tag(String?.some(role.roleKey))
                    }
                }
            case .discipline:
                Picker("Discipline", selection: $draft.discipline) {
                    ForEach(Discipline.allCases) { discipline in
                        Text(discipline.label).tag(discipline)
                    }
                }
            case .all:
                Text("Every active member of your organization.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Recipients")
        } footer: {
            Text("Recipients are notified and can read the broadcast but cannot reply.")
        }

        Section("Broadcast") {
            TextField("Name, e.g. Weather closure", text: $draft.name)
            Picker("Priority", selection: $draft.priority) {
                // Critical broadcasts are admin-only (the server rejects them otherwise).
                ForEach(Priority.allCases.filter { $0 != .critical || org.role == .admin }) { priority in
                    Text(priority.label).tag(priority)
                }
            }
            TextField("Message", text: $draft.body, axis: .vertical)
                .lineLimit(3...8)
            Toggle("Require acknowledgement", isOn: $draft.requireAck)
        }
    }
}
