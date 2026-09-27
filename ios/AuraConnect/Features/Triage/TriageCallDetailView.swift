import SwiftUI
import Observation

@MainActor
@Observable
final class TriageCallDetailViewModel {
    let orgId: String
    let callId: String
    private(set) var call: TriageCall?
    private(set) var isLoading = true
    private(set) var isWorking = false
    var errorMessage: String?

    init(orgId: String, callId: String) {
        self.orgId = orgId
        self.callId = callId
    }

    func run() async {
        do {
            for try await value in TriageRepository(orgId: orgId).call(id: callId) {
                call = value
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    @discardableResult
    func assign(to uid: String) async -> Bool {
        await perform {
            try await FunctionsClient().assignTriageCall(orgId: self.orgId, callId: self.callId, assignedUid: uid)
        }
    }

    @discardableResult
    func resolve(disposition: TriageDisposition, note: String?, followUpTask: TriageFollowUpTask?) async -> Bool {
        await perform {
            try await FunctionsClient().resolveTriageCall(
                orgId: self.orgId,
                callId: self.callId,
                disposition: disposition,
                dispositionNote: note,
                followUpTask: followUpTask
            )
        }
    }

    private func perform(_ action: () async throws -> Void) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await action()
            return true
        } catch {
            errorMessage = error.userMessage
            return false
        }
    }
}

struct TriageCallDetailView: View {
    @Environment(OrgStore.self) private var org
    let callId: String

    var body: some View {
        TriageCallDetailContent(orgId: org.orgId, callId: callId)
    }
}

private struct TriageCallDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: TriageCallDetailViewModel
    @State private var showAssign = false
    @State private var showResolve = false

    init(orgId: String, callId: String) {
        _model = State(initialValue: TriageCallDetailViewModel(orgId: orgId, callId: callId))
    }

    private var canAct: Bool { org.role.canManageReferrals }

    var body: some View {
        Group {
            if let call = model.call {
                details(call)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Call unavailable",
                                       systemImage: "phone.down",
                                       description: Text(model.errorMessage ?? "This triage call could not be found."))
            }
        }
        .navigationTitle("Triage call")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAssign) {
            TriageAssignSheet(model: model)
                .environment(org)
        }
        .sheet(isPresented: $showResolve) {
            TriageResolveSheet(model: model)
                .environment(org)
        }
        .task { await model.run() }
    }

    @ViewBuilder
    private func details(_ call: TriageCall) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        StatusPill(text: call.callUrgency.label, color: call.callUrgency.color)
                        StatusPill(text: call.isOpen ? "Open" : "Resolved", color: call.isOpen ? .red : .green)
                    }
                    Text(call.reason?.nilIfBlank ?? "No reason recorded")
                        .font(.title3.weight(.semibold))
                        .textSelection(.enabled)
                    Text("Received \(RelativeTime.full(call.receivedAt)) by \(org.name(for: call.receivedBy))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            Section("Caller") {
                LabeledContent("Name", value: call.displayCaller)
                InfoRow(label: "Relationship", value: call.callerRelationship)
                InfoRow(label: "Phone", value: call.callerPhone)
            }

            if !call.symptomList.isEmpty {
                Section("Symptoms") {
                    ForEach(call.symptomList, id: \.self) { symptom in
                        Text(symptom)
                    }
                }
            }

            Section("Links") {
                if let patientId = call.patientId {
                    NavigationLink(value: Route.patient(patientId)) {
                        Label(call.patientName?.nilIfBlank ?? "Open patient", systemImage: "person.text.rectangle")
                    }
                } else {
                    Text("Not linked to a patient").foregroundStyle(.secondary)
                }
                if let alertId = call.alertId {
                    NavigationLink(value: Route.alert(alertId)) {
                        Label("Open alert", systemImage: "bell.badge")
                    }
                }
            }

            Section {
                LabeledContent("Assigned to", value: call.assignedUid.map { org.name(for: $0) } ?? "Unassigned")
                InfoRow(label: "On-call role", value: call.roleKey)
                if canAct && call.isOpen {
                    Button {
                        showAssign = true
                    } label: {
                        Label(call.assignedUid == nil ? "Assign" : "Reassign", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .disabled(model.isWorking)
                }
            } header: {
                Text("Assignment")
            }

            if call.isOpen {
                if canAct {
                    Section {
                        Button {
                            showResolve = true
                        } label: {
                            Label("Resolve", systemImage: "checkmark.seal.fill")
                                .font(.body.weight(.semibold))
                        }
                        .disabled(model.isWorking)
                    } footer: {
                        Text("Resolving also resolves the linked alert.")
                    }
                }
            } else {
                Section("Resolution") {
                    InfoRow(label: "Disposition", value: call.disposition?.label)
                    InfoRow(label: "Note", value: call.dispositionNote)
                    InfoRow(label: "Resolved by", value: call.resolvedBy.map { org.name(for: $0) })
                    InfoRow(label: "Resolved at", value: call.resolvedAt.map { RelativeTime.full($0) })
                }
            }
        }
    }
}

private struct TriageAssignSheet: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let model: TriageCallDetailViewModel
    @State private var search = ""

    private var candidates: [Member] {
        let active = org.activeMembers.filter { $0.role != .viewer }
        guard let query = search.nilIfBlank else { return active }
        return active.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }
                ForEach(candidates) { member in
                    Button {
                        Task {
                            if await model.assign(to: member.memberUid) { dismiss() }
                        }
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
                            if model.call?.assignedUid == member.memberUid {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .disabled(model.isWorking)
                }
            }
            .searchable(text: $search, prompt: "Search people")
            .navigationTitle("Assign call")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if model.isWorking {
                    ToolbarItem(placement: .confirmationAction) { ProgressView() }
                }
            }
        }
    }
}

private struct TriageResolveSheet: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let model: TriageCallDetailViewModel
    @State private var disposition: TriageDisposition = .adviceGiven
    @State private var note = ""
    @State private var createTask = false
    @State private var taskTitle = ""
    @State private var taskAssignee: String?
    @State private var hasDueDate = false
    @State private var dueDate = Date()

    private var followUp: TriageFollowUpTask? {
        guard createTask, let title = taskTitle.nilIfBlank else { return nil }
        return TriageFollowUpTask(
            title: title,
            assigneeUid: taskAssignee,
            dueDate: hasDueDate ? ISODate.string(from: dueDate) : nil
        )
    }

    private var canSubmit: Bool {
        !model.isWorking && (!createTask || taskTitle.nilIfBlank != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }
                Section("Disposition") {
                    Picker("Disposition", selection: $disposition) {
                        ForEach(TriageDisposition.allCases) { value in
                            Text(value.label).tag(value)
                        }
                    }
                    TextField("Note (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    Toggle("Create follow-up task", isOn: $createTask)
                    if createTask {
                        TextField("Task title", text: $taskTitle)
                        Picker("Assignee", selection: $taskAssignee) {
                            Text("Unassigned").tag(String?.none)
                            ForEach(org.activeMembers.filter { $0.role != .viewer }) { member in
                                Text(member.name).tag(String?.some(member.memberUid))
                            }
                        }
                        Toggle("Due date", isOn: $hasDueDate)
                        if hasDueDate {
                            DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                        }
                    }
                } header: {
                    Text("Follow-up")
                }
            }
            .disabled(model.isWorking)
            .navigationTitle("Resolve call")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button("Resolve") {
                            Task {
                                if await model.resolve(disposition: disposition, note: note.nilIfBlank, followUpTask: followUp) {
                                    dismiss()
                                }
                            }
                        }
                        .disabled(!canSubmit)
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
        }
    }
}
