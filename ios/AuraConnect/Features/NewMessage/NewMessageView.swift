import SwiftUI
import Observation

@MainActor
@Observable
final class NewMessageViewModel {
    enum Mode: String, CaseIterable, Identifiable {
        case people = "People"
        case role = "On-call role"
        var id: String { rawValue }
    }

    let orgId: String
    var mode: Mode = .people
    var selectedUids: Set<String> = []
    var groupName = ""
    var selectedRoleKey: String?
    var roleBody = ""
    var rolePriority: Priority = .normal
    private(set) var roles: [OnCallRole] = []
    private(set) var isWorking = false
    var errorMessage: String?

    private let functions = FunctionsClient()

    init(orgId: String) {
        self.orgId = orgId
    }

    var canStart: Bool {
        guard !isWorking else { return false }
        switch mode {
        case .people:
            return !selectedUids.isEmpty
        case .role:
            return selectedRoleKey != nil && roleBody.nilIfBlank != nil && roleBody.count <= AppConfig.maxMessageLength
        }
    }

    func runRoles() async {
        do {
            for try await list in ScheduleRepository(orgId: orgId).onCallRoles() {
                roles = list.sorted { $0.displayLabel.localizedCaseInsensitiveCompare($1.displayLabel) == .orderedAscending }
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func toggle(_ uid: String) {
        if selectedUids.contains(uid) {
            selectedUids.remove(uid)
        } else {
            selectedUids.insert(uid)
        }
    }

    /// Creates (or reuses) the channel, or sends the role message. Returns the channel id.
    func start() async -> String? {
        guard canStart else { return nil }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            switch mode {
            case .people:
                let uids = Array(selectedUids).sorted()
                let type: ChannelType = uids.count == 1 ? .direct : .group
                return try await functions.createChannel(
                    orgId: orgId,
                    type: type,
                    memberUids: uids,
                    name: type == .group ? groupName.nilIfBlank : nil
                )
            case .role:
                guard let roleKey = selectedRoleKey, let body = roleBody.nilIfBlank else { return nil }
                return try await functions.sendRoleMessage(orgId: orgId, roleKey: roleKey, body: body, priority: rolePriority)
            }
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

/// Pick colleagues (direct / group) or an on-call role, then open the resulting channel.
struct NewMessageView: View {
    @Environment(OrgStore.self) private var org
    let onOpenChannel: (String) -> Void

    var body: some View {
        NewMessageContent(orgId: org.orgId, onOpenChannel: onOpenChannel)
    }
}

private struct NewMessageContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    @State private var model: NewMessageViewModel
    @State private var search = ""
    let onOpenChannel: (String) -> Void

    init(orgId: String, onOpenChannel: @escaping (String) -> Void) {
        _model = State(initialValue: NewMessageViewModel(orgId: orgId))
        self.onOpenChannel = onOpenChannel
    }

    private var candidates: [Member] {
        let others = org.activeMembers.filter { $0.memberUid != org.uid }
        guard let query = search.nilIfBlank else { return others }
        return others.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                Section {
                    Picker("Send to", selection: $model.mode) {
                        ForEach(NewMessageViewModel.Mode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                switch model.mode {
                case .people:
                    peopleSections
                case .role:
                    roleSections
                }
            }
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button(model.mode == .people ? "Start" : "Send") {
                            Task {
                                if let channelId = await model.start() {
                                    onOpenChannel(channelId)
                                }
                            }
                        }
                        .disabled(!model.canStart)
                    }
                }
            }
            .task { await model.runRoles() }
        }
    }

    @ViewBuilder
    private var peopleSections: some View {
        @Bindable var model = model
        if model.selectedUids.count > 1 {
            Section("Group name (optional)") {
                TextField("e.g. North team huddle", text: $model.groupName)
            }
        }
        Section {
            TextField("Search people", text: $search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if candidates.isEmpty {
                Text(org.membersLoaded ? "No matching colleagues." : "Loading colleagues…")
                    .foregroundStyle(.secondary)
            }
            ForEach(candidates) { member in
                Button {
                    model.toggle(member.memberUid)
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(initials: member.initials)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.name).foregroundStyle(Color.primary)
                            if !member.subtitle.isEmpty {
                                Text(member.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: model.selectedUids.contains(member.memberUid) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.selectedUids.contains(member.memberUid) ? Color.accentColor : Color.secondary)
                            .font(.title3)
                    }
                }
                .accessibilityAddTraits(model.selectedUids.contains(member.memberUid) ? .isSelected : [])
            }
        } header: {
            Text(model.selectedUids.count <= 1 ? "Direct message" : "Group (\(model.selectedUids.count) people)")
        }
    }

    @ViewBuilder
    private var roleSections: some View {
        @Bindable var model = model
        Section {
            if model.roles.isEmpty {
                Text("No on-call roles are configured for your organization.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.roles) { role in
                Button {
                    model.selectedRoleKey = role.roleKey
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(role.displayLabel).foregroundStyle(Color.primary)
                            if let discipline = role.discipline {
                                Text(discipline.label).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if model.selectedRoleKey == role.roleKey {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
        } header: {
            Text("On-call role")
        } footer: {
            Text("The message goes to whoever is on duty for the role right now (or the role's fallback staff).")
        }

        Section("Message") {
            Picker("Priority", selection: $model.rolePriority) {
                ForEach(Priority.allCases) { priority in
                    Text(priority.label).tag(priority)
                }
            }
            TextField("Message", text: $model.roleBody, axis: .vertical)
                .lineLimit(3...8)
        }
    }
}
