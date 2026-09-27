import SwiftUI

/// Channel info (opened from the chat title): patient header with call links, description,
/// my per-channel notification mode / mute (`prefs/{uid}`), members with presence,
/// add/remove members (`updateChannelMembers`), rename and leave.
struct ChannelInfoSheet: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let model: ChatViewModel
    /// Called after I leave the channel (the chat should close).
    let onLeft: () -> Void
    /// Opens the patient chart (the sheet is dismissed first).
    let onOpenPatient: (String) -> Void

    @State private var showAddMembers = false
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showLeaveConfirm = false
    @State private var removeTarget: String?
    @State private var isWorking = false
    @State private var errorMessage: String?

    private var channel: Channel? { model.channel }
    private var isAdmin: Bool { org.role == .admin }

    private var memberUids: [String] {
        (channel?.members ?? []).sorted { a, b in
            if a == org.uid { return true }
            if b == org.uid { return false }
            return org.name(for: a).localizedCaseInsensitiveCompare(org.name(for: b)) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if let patient = model.patient, let patientId = patient.id ?? channel?.patientId {
                    patientSection(patient, patientId: patientId)
                }
                if let description = channel?.description?.nilIfBlank {
                    Section("About") {
                        Text(description)
                    }
                }
                notificationSection
                membersSection
                actionsSection
            }
            .navigationTitle(channel.map { org.title(for: $0) } ?? "Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showAddMembers) {
                AddChannelMembersSheet(
                    candidates: org.activeMembers.filter { !(channel?.members ?? []).contains($0.memberUid) },
                    onAdd: { uids in try await model.updateMembers(add: uids, remove: []) }
                )
            }
            .alert("Rename conversation", isPresented: $showRename) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    let name = renameText.trimmed
                    guard !name.isEmpty, name.count <= 100 else { return }
                    run { try await model.rename(to: name) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Leave this conversation?", isPresented: $showLeaveConfirm, titleVisibility: .visible) {
                Button("Leave", role: .destructive) {
                    run {
                        try await model.leave()
                        dismiss()
                        onLeft()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll stop receiving its messages. A member can add you back.")
            }
            .confirmationDialog("Remove from this conversation?",
                                isPresented: Binding(get: { removeTarget != nil }, set: { if !$0 { removeTarget = nil } }),
                                titleVisibility: .visible,
                                presenting: removeTarget) { uid in
                Button("Remove \(org.name(for: uid))", role: .destructive) {
                    run { try await model.updateMembers(add: [], remove: [uid]) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .disabled(isWorking)
            .overlay {
                if isWorking { ProgressView() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: Sections

    @ViewBuilder
    private func patientSection(_ patient: Patient, patientId: String) -> some View {
        Section("Patient") {
            VStack(alignment: .leading, spacing: 4) {
                Text(patient.input.fullName)
                    .font(.headline)
                if let codeStatus = patient.codeStatus {
                    Text("Code status: \(codeStatus.label)")
                        .font(.subheadline)
                        .foregroundStyle(codeStatus == .fullCode ? Color.secondary : Color.red)
                }
            }
            if let phone = patient.phone?.nilIfBlank, let url = ContactLinks.phone(phone) {
                Link(destination: url) {
                    Label("Call patient · \(phone)", systemImage: "phone.fill")
                }
            }
            if let caregiver = patient.caregiver, !caregiver.isEmpty {
                let who = [caregiver.name.nilIfBlank, caregiver.relationship?.nilIfBlank].compactMap { $0 }.joined(separator: " · ")
                if let phone = caregiver.phone?.nilIfBlank, let url = ContactLinks.phone(phone) {
                    Link(destination: url) {
                        Label("Call caregiver · \(who.isEmpty ? phone : who)", systemImage: "phone.arrow.up.right")
                    }
                } else if !who.isEmpty {
                    Label("Caregiver · \(who)", systemImage: "person.2")
                }
            }
            if let url = patient.address?.mapsURL {
                Link(destination: url) {
                    Label("Directions", systemImage: "map")
                }
            }
            Button {
                dismiss()
                onOpenPatient(patientId)
            } label: {
                Label("Open patient chart", systemImage: "person.text.rectangle")
            }
        }
    }

    @ViewBuilder
    private var notificationSection: some View {
        if channel?.members.contains(org.uid) == true {
            Section {
                Picker("Notify me", selection: Binding(
                    get: { model.notifyMode },
                    set: { model.setNotifyMode($0) }
                )) {
                    ForEach(ChannelNotifyMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                if model.isMuted, let until = model.prefs?.mutedUntil {
                    HStack {
                        Label("Muted until \(until.formatted(date: .abbreviated, time: .shortened))", systemImage: "bell.slash")
                        Spacer()
                        Button("Unmute") { model.mute(until: nil) }
                            .buttonStyle(.borderless)
                    }
                } else {
                    Menu {
                        Button("1 hour") { model.mute(until: Date().addingTimeInterval(3600)) }
                        Button("8 hours") { model.mute(until: Date().addingTimeInterval(8 * 3600)) }
                        Button("24 hours") { model.mute(until: Date().addingTimeInterval(24 * 3600)) }
                        Button("1 week") { model.mute(until: Date().addingTimeInterval(7 * 24 * 3600)) }
                    } label: {
                        Label("Mute…", systemImage: "bell.slash")
                    }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text(model.notifyMode.detail + " Muting silences normal messages; urgent and critical messages always notify. Quiet hours and other global settings are under More › Notifications.")
            }
        }
    }

    private var membersSection: some View {
        Section {
            ForEach(memberUids, id: \.self) { uid in
                ChannelMemberRow(uid: uid)
                    .swipeActions {
                        if uid != org.uid && model.canManageMembers(role: org.role) {
                            Button(role: .destructive) {
                                removeTarget = uid
                            } label: {
                                Label("Remove", systemImage: "person.badge.minus")
                            }
                        }
                    }
            }
            if model.canManageMembers(role: org.role) {
                Button {
                    showAddMembers = true
                } label: {
                    Label("Add members", systemImage: "person.badge.plus")
                }
            }
        } header: {
            Text("Members (\(memberUids.count))")
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        if model.canRename(isAdmin: isAdmin) || model.canLeave {
            Section {
                if model.canRename(isAdmin: isAdmin) {
                    Button {
                        renameText = channel?.name ?? ""
                        showRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                }
                if model.canLeave {
                    Button(role: .destructive) {
                        showLeaveConfirm = true
                    } label: {
                        Label("Leave conversation", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await action()
            } catch {
                errorMessage = error.userMessage
            }
            isWorking = false
        }
    }
}

/// A member with presence (`member.status` when set and not expired) and out-of-office.
private struct ChannelMemberRow: View {
    @Environment(OrgStore.self) private var org
    let uid: String

    var body: some View {
        let member = org.members[uid]
        let status = member?.currentStatus()
        let outOfOffice = member?.activeOutOfOffice()
        HStack(spacing: 12) {
            PresenceAvatar(member: member)
            VStack(alignment: .leading, spacing: 2) {
                Text(uid == org.uid ? "\(org.myName) (you)" : org.name(for: uid))
                if let subtitle = member?.subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                if let status, !status.summary.isEmpty {
                    Text(status.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let until = outOfOffice?.until {
                    Label("Out of office until \(until.formatted(date: .abbreviated, time: .omitted))", systemImage: "airplane")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Multi-select of active members not yet in the channel.
struct AddChannelMembersSheet: View {
    @Environment(\.dismiss) private var dismiss
    let candidates: [Member]
    let onAdd: ([String]) async throws -> Void

    @State private var selected: Set<String> = []
    @State private var search = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var filtered: [Member] {
        guard let query = search.nilIfBlank else { return candidates }
        return candidates.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                ForEach(filtered) { member in
                    Button {
                        toggle(member.memberUid)
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
                            if selected.contains(member.memberUid) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search people")
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Add") { save() }
                            .disabled(selected.isEmpty)
                    }
                }
            }
        }
    }

    private func toggle(_ uid: String) {
        if selected.contains(uid) {
            selected.remove(uid)
        } else {
            selected.insert(uid)
        }
    }

    private func save() {
        guard !selected.isEmpty, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        let uids = Array(selected).sorted()
        Task {
            do {
                try await onAdd(uids)
                isSaving = false
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.userMessage
            }
        }
    }
}
