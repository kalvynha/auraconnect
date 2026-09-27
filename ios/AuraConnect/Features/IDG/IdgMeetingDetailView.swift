import SwiftUI
import Observation
import FirebaseFirestore

/// `idgMeetings/{id}/notes/{docId}` (v3, F5): a per-discipline note (`kind == "discipline"`, id
/// `{patientId}_{discipline}`) or AI prep (`kind == "ai_prep"`, id `{patientId}_aiPrep`).
/// Written only by Cloud Functions; staff read.
struct IdgNoteDoc: Codable, Identifiable {
    @DocumentID var id: String?
    var kind: String?
    var meetingId: String?
    var patientId: String?
    var discipline: Discipline?
    var text: String?
    var model: String?
    var updatedBy: String?
    var updatedAt: Date?
    var generatedBy: String?
    var generatedAt: Date?

    var isPrep: Bool { kind == "ai_prep" }
    var isDisciplineNote: Bool { kind == "discipline" }
}

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
    /// F5: AI prep by patient (notes subcollection).
    private(set) var prepDocs: [String: IdgNoteDoc] = [:]
    /// F5: discipline notes by patient.
    private(set) var disciplineNotes: [String: [IdgNoteDoc]] = [:]
    /// H3: patients whose care team I'm on (only they, or admins, may generate prep).
    private(set) var myPatientIds: Set<String> = []
    /// "Generate prep for all" progress, e.g. "12 of 40".
    private(set) var prepProgress: String?
    /// Warnings returned when the meeting was completed (e.g. missing disciplines).
    private(set) var completionWarnings: [String] = []
    private(set) var savingDisciplineNote = false

    /// Prep newer than this is skipped by "Generate prep for all".
    static let freshPrepHours: Double = 12
    /// Patients per `generateIdgPrep` call (the server's cap).
    static let prepBatchSize = 25

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

    /// F5: live notes subcollection (discipline notes and AI prep).
    func runNotes() async {
        let query = FirebaseService.orgRef(orgId).collection("idgMeetings").document(meetingId).collection("notes")
        do {
            for try await docs in query.decodedStream(IdgNoteDoc.self) {
                var prep: [String: IdgNoteDoc] = [:]
                var notes: [String: [IdgNoteDoc]] = [:]
                for doc in docs {
                    guard let patientId = doc.patientId else { continue }
                    if doc.isPrep {
                        prep[patientId] = doc
                    } else if doc.isDisciplineNote {
                        notes[patientId, default: []].append(doc)
                    }
                }
                prepDocs = prep
                disciplineNotes = notes.mapValues { list in
                    list.sorted { ($0.discipline?.rawValue ?? "") < ($1.discipline?.rawValue ?? "") }
                }
            }
        } catch {
            // Notes are supplementary; the meeting still works without them.
        }
    }

    /// H3: my care-team patients (single-field query, bounded).
    func runMyPatients(uid: String) async {
        do {
            for try await patients in PatientRepository(orgId: orgId).patients(careTeamMember: uid, limit: 300) {
                myPatientIds = Set(patients.compactMap { $0.id })
            }
        } catch {
            myPatientIds = []
        }
    }

    /// AI prep text for a patient: the notes subcollection (v3), else the legacy meeting map.
    func prepText(for patientId: String) -> (text: String, model: String?, generatedAt: Date?)? {
        if let doc = prepDocs[patientId], let text = doc.text?.nilIfBlank {
            return (text, doc.model, doc.generatedAt)
        }
        if let legacy = meeting?.prep(for: patientId), let text = legacy.text?.nilIfBlank {
            return (text, legacy.model, legacy.generatedAt)
        }
        return nil
    }

    func canPrep(_ patientId: String, isAdmin: Bool) -> Bool {
        isAdmin || myPatientIds.contains(patientId)
    }

    /// One patient's prep; the listener shows it.
    func generatePrep(patientId: String) async {
        guard generatingPrepFor == nil else { return }
        generatingPrepFor = patientId
        errorMessage = nil
        defer { generatingPrepFor = nil }
        do {
            try await functions.generateIdgPrep(orgId: orgId, meetingId: meetingId, patientId: patientId)
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// F5: prep for every agenda patient I may prep, 25 per call, skipping prep from the last 12 hours.
    func generatePrepForAll(isAdmin: Bool) async {
        guard generatingPrepFor == nil, let agenda = meeting?.agenda else { return }
        let freshSince = Date().addingTimeInterval(-Self.freshPrepHours * 3600)
        let pending = agenda.filter { patientId in
            guard canPrep(patientId, isAdmin: isAdmin) else { return false }
            guard let generatedAt = prepText(for: patientId)?.generatedAt else { return true }
            return generatedAt < freshSince
        }
        guard !pending.isEmpty else {
            prepProgress = "Every patient you can prep already has prep from the last 12 hours."
            return
        }
        generatingPrepFor = ""
        errorMessage = nil
        defer { generatingPrepFor = nil }
        var done = 0
        var failed = 0
        do {
            for start in stride(from: 0, to: pending.count, by: Self.prepBatchSize) {
                prepProgress = "Generating prep… \(done) of \(pending.count) done"
                let batch = Array(pending[start..<min(start + Self.prepBatchSize, pending.count)])
                let result = try await functions.generateIdgPrepBatch(orgId: orgId, meetingId: meetingId, patientIds: batch,
                                                                      skipFreshHours: Self.freshPrepHours)
                done += result.generated.count + result.skipped.count
                failed += result.failed.count
            }
            prepProgress = "Prep ready for \(done) of \(pending.count) patients" + (failed > 0 ? "; \(failed) failed (try again)." : ".")
        } catch {
            prepProgress = nil
            errorMessage = error.userMessage
        }
    }

    /// F5: saves one discipline's note for a patient (its own document, so saves never collide).
    @discardableResult
    func saveDisciplineNote(patientId: String, discipline: Discipline, text: String) async -> Bool {
        guard !savingDisciplineNote else { return false }
        savingDisciplineNote = true
        errorMessage = nil
        defer { savingDisciplineNote = false }
        do {
            try await functions.saveIdgDisciplineNote(orgId: orgId, meetingId: meetingId, patientId: patientId,
                                                      discipline: discipline, text: text)
            return true
        } catch {
            errorMessage = error.userMessage
            return false
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
            self.completionWarnings = try await self.functions.completeIdgMeetingWithWarnings(orgId: self.orgId, meetingId: self.meetingId)
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
    private var isAdmin: Bool { org.role == .admin }

    /// H3: attendee and agenda changes are limited to the meeting's creator or an admin.
    private var canEditMeeting: Bool {
        canAct && model.meeting?.isCompleted == false && (isAdmin || model.meeting?.createdBy == org.uid)
    }

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
            if canEditMeeting {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { showEdit = true }
                }
            }
        }
        .sheet(item: $editing) { item in
            IdgNoteEditorSheet(model: model, patientId: item.id, readOnly: !canAct || model.meeting?.isCompleted == true,
                               canPrep: model.canPrep(item.id, isAdmin: isAdmin), myDiscipline: org.me?.discipline)
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
        .task { await model.runNotes() }
        .task { await model.runMyPatients(uid: org.uid) }
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

            if !model.completionWarnings.isEmpty {
                Section {
                    ForEach(model.completionWarnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }

            if canAct && !meeting.isCompleted {
                Section {
                    Button {
                        Task { await model.generatePrepForAll(isAdmin: isAdmin) }
                    } label: {
                        HStack {
                            Label("Generate prep for all", systemImage: "sparkles")
                            Spacer()
                            if model.isGeneratingPrep(for: nil) { ProgressView() }
                        }
                    }
                    .disabled(model.generatingPrepFor != nil || !meeting.agenda.contains { model.canPrep($0, isAdmin: isAdmin) })
                    if let progress = model.prepProgress {
                        Text(progress)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        showCompleteConfirm = true
                    } label: {
                        Label("Complete meeting", systemImage: "checkmark.seal.fill")
                    }
                    .disabled(model.isWorking)
                } footer: {
                    Text("AI prep summarizes the last 15 days of activity per patient, for patients on your care team (admins: all). Prep from the last 12 hours is skipped. A clinician must verify it.")
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
                        IdgAgendaRow(meeting: meeting, patientId: patientId,
                                     hasPrep: model.prepText(for: patientId) != nil,
                                     disciplineNoteCount: model.disciplineNotes[patientId]?.count ?? 0)
                    }
                    .swipeActions(edge: .trailing) {
                        if canEditMeeting {
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
    let hasPrep: Bool
    let disciplineNoteCount: Int

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
                    if hasPrep {
                        Label("AI prep", systemImage: "sparkles")
                    }
                    if disciplineNoteCount > 0 {
                        Label("\(disciplineNoteCount)", systemImage: "person.3.sequence")
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
    let canPrep: Bool
    @State private var draft: IdgNoteDraft
    @State private var noteDiscipline: Discipline
    @State private var disciplineText: String
    @State private var disciplineDirty = false

    init(model: IdgMeetingDetailViewModel, patientId: String, readOnly: Bool, canPrep: Bool, myDiscipline: Discipline?) {
        self.model = model
        self.patientId = patientId
        self.readOnly = readOnly
        self.canPrep = canPrep
        _draft = State(initialValue: IdgNoteDraft(note: model.meeting?.note(for: patientId)))
        let discipline = myDiscipline ?? .rn
        _noteDiscipline = State(initialValue: discipline)
        _disciplineText = State(initialValue: model.disciplineNotes[patientId]?.first { $0.discipline == discipline }?.text ?? "")
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

                disciplineSection

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

    // MARK: Discipline notes (F5)

    @ViewBuilder
    private var disciplineSection: some View {
        let notes = model.disciplineNotes[patientId] ?? []
        Section {
            ForEach(notes) { note in
                VStack(alignment: .leading, spacing: 4) {
                    Text(note.discipline?.rawValue ?? "Note")
                        .font(.subheadline.weight(.semibold))
                    Text(note.text ?? "")
                        .font(.callout)
                        .contextMenu {
                            Button {
                                SecurePasteboard.copy(note.text ?? "")
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    Text("\(org.name(for: note.updatedBy)) · \(note.updatedAt.map { RelativeTime.full($0) } ?? "")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if notes.isEmpty && readOnly {
                Text("No discipline notes.").foregroundStyle(.secondary)
            }
            if !readOnly {
                Picker("Discipline", selection: $noteDiscipline) {
                    ForEach(Discipline.allCases, id: \.self) { discipline in
                        Text(discipline.rawValue).tag(discipline)
                    }
                }
                TextField("\(noteDiscipline.rawValue) update for the team", text: Binding(
                    get: { disciplineText },
                    set: { disciplineText = $0; disciplineDirty = true }
                ), axis: .vertical)
                    .lineLimit(2...8)
                Button {
                    Task {
                        if await model.saveDisciplineNote(patientId: patientId, discipline: noteDiscipline, text: disciplineText) {
                            disciplineDirty = false
                        }
                    }
                } label: {
                    HStack {
                        Label("Save \(noteDiscipline.rawValue) note", systemImage: "square.and.arrow.down")
                        Spacer()
                        if model.savingDisciplineNote { ProgressView() }
                    }
                }
                .disabled(model.savingDisciplineNote || !disciplineDirty)
            }
        } header: {
            Text("Discipline notes")
        } footer: {
            if !readOnly {
                Text("Each discipline's note is saved separately, so several people can write at once.")
            }
        }
        .onChange(of: noteDiscipline) { _, discipline in
            disciplineText = notes.first { $0.discipline == discipline }?.text ?? ""
            disciplineDirty = false
        }
    }

    @ViewBuilder
    private var prepSection: some View {
        let prep = model.prepText(for: patientId)
        Section {
            if let prep {
                Label(AiTextResult.defaultDisclaimer, systemImage: "exclamationmark.shield")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                // L4: no system text selection on PHI; copy is local-only and expires.
                Text(prep.text)
                    .font(.callout)
                Button {
                    SecurePasteboard.copy(prep.text)
                } label: {
                    Label("Copy prep", systemImage: "doc.on.doc")
                }
            } else {
                Text("No AI prep yet.")
                    .foregroundStyle(.secondary)
            }
            if !readOnly && canPrep {
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
            } else if !readOnly && !canPrep {
                Text("Only the patient's care team or an admin can generate prep.")
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
