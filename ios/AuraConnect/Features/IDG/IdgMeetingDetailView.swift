import SwiftUI
import Observation

/// Editable copy of an `IdgPatientNote`.
struct IdgNoteDraft: Equatable {
    var summary: String
    var planOfCareChanges: String
    var goalsOfCare: String
    var actionItems: [IdgActionItem]
    var reviewed: Bool

    init(note: IdgPatientNote?) {
        summary = note?.summary ?? ""
        planOfCareChanges = note?.planOfCareChanges ?? ""
        goalsOfCare = note?.goalsOfCare ?? ""
        actionItems = note?.items ?? []
        reviewed = note?.isReviewed ?? false
    }
}

@MainActor
@Observable
final class IdgMeetingDetailViewModel {
    let orgId: String
    let meetingId: String
    private(set) var meeting: IdgMeeting?
    private(set) var isLoading = true
    private(set) var isWorking = false
    /// Patient id being prepped, or `""` for the whole agenda.
    private(set) var generatingPrepFor: String?
    var errorMessage: String?

    init(orgId: String, meetingId: String) {
        self.orgId = orgId
        self.meetingId = meetingId
    }

    private var functions: FunctionsClient { FunctionsClient() }

    func run() async {
        do {
            for try await value in IdgRepository(orgId: orgId).meeting(id: meetingId) {
                meeting = value
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Writes AI prep into `aiPrep`; the listener shows it.
    func generatePrep(patientId: String? = nil) async {
        guard generatingPrepFor == nil else { return }
        generatingPrepFor = patientId ?? ""
        errorMessage = nil
        defer { generatingPrepFor = nil }
        do {
            try await functions.generateIdgPrep(orgId: orgId, meetingId: meetingId, patientId: patientId)
        } catch {
            errorMessage = error.userMessage
        }
    }

    func isGeneratingPrep(for patientId: String?) -> Bool {
        generatingPrepFor == (patientId ?? "")
    }

    @discardableResult
    func saveNote(patientId: String, draft: IdgNoteDraft) async -> Bool {
        await perform {
            try await self.functions.saveIdgNote(
                orgId: self.orgId,
                meetingId: self.meetingId,
                patientId: patientId,
                summary: draft.summary,
                planOfCareChanges: draft.planOfCareChanges.nilIfBlank,
                goalsOfCare: draft.goalsOfCare.nilIfBlank,
                actionItems: draft.actionItems,
                reviewed: draft.reviewed
            )
        }
    }

    @discardableResult
    func update(title: String, scheduledAt: Date, attendeeUids: [String]) async -> Bool {
        await perform {
            try await self.functions.updateIdgMeeting(
                orgId: self.orgId,
                meetingId: self.meetingId,
                title: title,
                scheduledAt: scheduledAt,
                attendeeUids: attendeeUids
            )
        }
    }

    @discardableResult
    func removeFromAgenda(_ patientId: String) async -> Bool {
        guard let agenda = meeting?.agenda else { return false }
        return await perform {
            try await self.functions.updateIdgMeeting(
                orgId: self.orgId,
                meetingId: self.meetingId,
                patientIds: agenda.filter { $0 != patientId }
            )
        }
    }

    func complete() async {
        await perform {
            try await self.functions.completeIdgMeeting(orgId: self.orgId, meetingId: self.meetingId)
        }
    }

    @discardableResult
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

/// Identifies the agenda patient whose note is being edited.
struct IdgEditingPatient: Identifiable, Hashable {
    let id: String
}

struct IdgMeetingDetailView: View {
    @Environment(OrgStore.self) private var org
    let meetingId: String

    var body: some View {
        IdgMeetingDetailContent(orgId: org.orgId, meetingId: meetingId)
    }
}

private struct IdgMeetingDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: IdgMeetingDetailViewModel
    @State private var editing: IdgEditingPatient?
    @State private var showEdit = false
    @State private var showCompleteConfirm = false

    init(orgId: String, meetingId: String) {
        _model = State(initialValue: IdgMeetingDetailViewModel(orgId: orgId, meetingId: meetingId))
    }

    /// IDG mutations require a clinical role.
    private var canAct: Bool { org.role.canManageReferrals }

    var body: some View {
        Group {
            if let meeting = model.meeting {
                details(meeting)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Meeting unavailable",
                                       systemImage: "person.3",
                                       description: Text(model.errorMessage ?? "This meeting could not be found."))
            }
        }
        .navigationTitle(model.meeting?.displayTitle ?? "IDG meeting")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canAct && model.meeting?.isCompleted == false {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { showEdit = true }
                }
            }
        }
        .sheet(item: $editing) { item in
            IdgNoteEditorSheet(model: model, patientId: item.id, readOnly: !canAct || model.meeting?.isCompleted == true)
                .environment(org)
        }
        .sheet(isPresented: $showEdit) {
            if let meeting = model.meeting {
                IdgEditMeetingSheet(model: model, meeting: meeting)
                    .environment(org)
            }
        }
        .confirmationDialog("Complete this meeting?", isPresented: $showCompleteConfirm, titleVisibility: .visible) {
            Button("Complete meeting") {
                Task { await model.complete() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("For every reviewed patient this updates the next IDG due date and creates tasks for the action items. The meeting is then locked.")
        }
        .task { await model.run() }
    }

    @ViewBuilder
    private func details(_ meeting: IdgMeeting) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        StatusPill(text: meeting.isCompleted ? "Completed" : "Scheduled",
                                   color: meeting.isCompleted ? .green : .blue)
                        Text("\(meeting.reviewedCount) of \(meeting.agenda.count) reviewed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(meeting.displayTitle)
                        .font(.title3.weight(.semibold))
                    Text(RelativeTime.full(meeting.scheduledAt))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                InfoRow(label: "Attendees", value: org.names(for: meeting.attendees))
                if meeting.isCompleted {
                    InfoRow(label: "Completed", value: meeting.completedAt.map { RelativeTime.full($0) })
                    InfoRow(label: "Completed by", value: meeting.completedBy.map { org.name(for: $0) })
                }
            }

            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            if canAct && !meeting.isCompleted {
                Section {
                    Button {
                        Task { await model.generatePrep() }
                    } label: {
                        HStack {
                            Label("Generate AI prep for all patients", systemImage: "sparkles")
                            Spacer()
                            if model.isGeneratingPrep(for: nil) { ProgressView() }
                        }
                    }
                    .disabled(model.generatingPrepFor != nil || meeting.agenda.isEmpty)
                    Button {
                        showCompleteConfirm = true
                    } label: {
                        Label("Complete meeting", systemImage: "checkmark.seal.fill")
                    }
                    .disabled(model.isWorking)
                } footer: {
                    Text("AI prep summarizes the last 15 days of activity per patient. A clinician must verify it.")
                }
            }

            Section {
                if meeting.agenda.isEmpty {
                    Text("No patients on the agenda.")
                        .foregroundStyle(.secondary)
                }
                ForEach(meeting.agenda, id: \.self) { patientId in
                    Button {
                        editing = IdgEditingPatient(id: patientId)
                    } label: {
                        IdgAgendaRow(meeting: meeting, patientId: patientId)
                    }
                    .swipeActions(edge: .trailing) {
                        if canAct && !meeting.isCompleted {
                            Button(role: .destructive) {
                                Task { await model.removeFromAgenda(patientId) }
                            } label: {
                                Label("Remove", systemImage: "minus.circle")
                            }
                        }
                    }
                }
            } header: {
                Text("Agenda")
            }
        }
    }
}

private struct IdgAgendaRow: View {
    let meeting: IdgMeeting
    let patientId: String

    var body: some View {
        let note = meeting.note(for: patientId)
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: note?.isReviewed == true ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(note?.isReviewed == true ? Color.green : Color.secondary)
                .font(.title3)
                .accessibilityLabel(note?.isReviewed == true ? "Reviewed" : "Not reviewed")
            VStack(alignment: .leading, spacing: 3) {
                Text(meeting.patientName(patientId))
                    .foregroundStyle(Color.primary)
                if let summary = note?.summary?.nilIfBlank {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    if meeting.prep(for: patientId) != nil {
                        Label("AI prep", systemImage: "sparkles")
                    }
                    if let count = note?.items.count, count > 0 {
                        Label("\(count)", systemImage: "checklist")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Note editor

private struct IdgNoteEditorSheet: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let model: IdgMeetingDetailViewModel
    let patientId: String
    let readOnly: Bool
    @State private var draft: IdgNoteDraft

    init(model: IdgMeetingDetailViewModel, patientId: String, readOnly: Bool) {
        self.model = model
        self.patientId = patientId
        self.readOnly = readOnly
        _draft = State(initialValue: IdgNoteDraft(note: model.meeting?.note(for: patientId)))
    }

    private var patientName: String {
        model.meeting?.patientName(patientId) ?? "Patient"
    }

    private var assignees: [Member] {
        org.activeMembers.filter { $0.role != .viewer }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                prepSection

                Group {
                    Section("Summary") {
                        TextField("Interdisciplinary summary", text: $draft.summary, axis: .vertical)
                            .lineLimit(3...10)
                    }
                    Section("Plan of care changes") {
                        TextField("Changes (optional)", text: $draft.planOfCareChanges, axis: .vertical)
                            .lineLimit(2...8)
                    }
                    Section("Goals of care") {
                        TextField("Goals (optional)", text: $draft.goalsOfCare, axis: .vertical)
                            .lineLimit(2...8)
                    }
                    actionItemsSection
                    Section {
                        Toggle("Reviewed", isOn: $draft.reviewed)
                    } footer: {
                        Text("Only reviewed patients have their IDG review date updated and action items turned into tasks when the meeting is completed.")
                    }
                }
                .disabled(readOnly || model.isWorking)
            }
            .navigationTitle(patientName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(readOnly ? "Done" : "Cancel") { dismiss() }
                }
                if !readOnly {
                    ToolbarItem(placement: .confirmationAction) {
                        if model.isWorking {
                            ProgressView()
                        } else {
                            Button("Save") {
                                Task {
                                    if await model.saveNote(patientId: patientId, draft: draft) { dismiss() }
                                }
                            }
                        }
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
        }
    }

    @ViewBuilder
    private var prepSection: some View {
        let prep = model.meeting?.prep(for: patientId)
        Section {
            if let prep, let text = prep.text?.nilIfBlank {
                Label(AiTextResult.defaultDisclaimer, systemImage: "exclamationmark.shield")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                Text(text)
                    .font(.callout)
                    .textSelection(.enabled)
            } else {
                Text("No AI prep yet.")
                    .foregroundStyle(.secondary)
            }
            if !readOnly {
                Button {
                    Task { await model.generatePrep(patientId: patientId) }
                } label: {
                    HStack {
                        Label(prep == nil ? "Generate AI prep" : "Regenerate AI prep", systemImage: "sparkles")
                        Spacer()
                        if model.isGeneratingPrep(for: patientId) { ProgressView() }
                    }
                }
                .disabled(model.generatingPrepFor != nil)
            }
        } header: {
            Text("AI prep")
        } footer: {
            if let prep {
                Text([prep.model?.nilIfBlank, prep.generatedAt.map { RelativeTime.full($0) }]
                    .compactMap { $0 }
                    .joined(separator: " · "))
            }
        }
    }

    @ViewBuilder
    private var actionItemsSection: some View {
        Section {
            ForEach(Array(draft.actionItems.indices), id: \.self) { index in
                IdgActionItemEditor(
                    item: elementBinding($draft.actionItems, index, default: IdgActionItem()),
                    assignees: assignees
                )
            }
            .onDelete { offsets in
                draft.actionItems.remove(atOffsets: offsets)
            }
            if !readOnly {
                Button {
                    draft.actionItems.append(IdgActionItem())
                } label: {
                    Label("Add action item", systemImage: "plus.circle")
                }
                .disabled(draft.actionItems.count >= 50)
            }
        } header: {
            Text("Action items")
        } footer: {
            Text("Action items become tasks when the meeting is completed. Items without a title are skipped.")
        }
    }
}

private struct IdgActionItemEditor: View {
    @Binding var item: IdgActionItem
    let assignees: [Member]

    private var hasDueDate: Binding<Bool> {
        Binding<Bool>(
            get: { item.dueDate != nil },
            set: { item.dueDate = $0 ? (item.dueDate ?? ISODate.string(from: Date())) : nil }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Action item", text: $item.title)
            Picker("Assignee", selection: $item.assigneeUid) {
                Text("Unassigned").tag(String?.none)
                ForEach(assignees) { member in
                    Text(member.name).tag(String?.some(member.memberUid))
                }
            }
            Toggle("Due date", isOn: hasDueDate)
            if item.dueDate != nil {
                DatePicker("Due", selection: isoDateBinding($item.dueDate), displayedComponents: .date)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Edit meeting

private struct IdgEditMeetingSheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: IdgMeetingDetailViewModel
    @State private var title: String
    @State private var scheduledAt: Date
    @State private var attendees: Set<String>

    init(model: IdgMeetingDetailViewModel, meeting: IdgMeeting) {
        self.model = model
        _title = State(initialValue: meeting.displayTitle)
        _scheduledAt = State(initialValue: meeting.scheduledAt ?? Date())
        _attendees = State(initialValue: Set(meeting.attendees))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }
                Section("Meeting") {
                    TextField("Title", text: $title)
                    DatePicker("When", selection: $scheduledAt)
                }
                IdgAttendeeSection(selection: $attendees)
            }
            .disabled(model.isWorking)
            .navigationTitle("Edit meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task {
                                if await model.update(title: title, scheduledAt: scheduledAt, attendeeUids: attendees.sorted()) {
                                    dismiss()
                                }
                            }
                        }
                        .disabled(title.nilIfBlank == nil)
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
        }
    }
}
