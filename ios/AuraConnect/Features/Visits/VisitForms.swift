import SwiftUI

/// One visit in a list: discipline, time, assignee and status.
struct VisitRow: View {
    @Environment(OrgStore.self) private var org
    let visit: Visit
    var showPatient = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if showPatient {
                    Text(visit.displayPatientName).font(.headline)
                } else {
                    Text(visit.discipline.map { "\($0.label) visit" } ?? "Visit").font(.headline)
                }
                Spacer()
                StatusPill(text: visit.visitStatus.label, color: visit.visitStatus.color)
            }
            Text(visit.timeRange)
                .font(.subheadline)
            let assignee = visit.assignedUid.map { org.name(for: $0) } ?? "Unassigned"
            Text(showPatient ? "\(visit.discipline?.label ?? "Visit") · \(assignee)" : assignee)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = visit.cancelledReason?.nilIfBlank, visit.visitStatus == .cancelled {
                Text("Cancelled: \(reason)").font(.caption).foregroundStyle(.secondary)
            } else if let note = visit.note?.nilIfBlank {
                Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Schedule / edit

/// Defaults for new visits (a plain enum so it can be used in property initializers).
enum VisitDefaults {
    /// The top of the next hour.
    static func start(now: Date = Date()) -> Date {
        let calendar = Calendar.current
        let nextHour = calendar.date(byAdding: .hour, value: 1, to: now) ?? now
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: nextHour)
        return calendar.date(from: components) ?? nextHour
    }
}

/// Schedules a new visit (`scheduleVisit`) or edits a scheduled one (`updateVisit`).
struct VisitEditorView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patientId: String
    /// nil schedules a new visit.
    let visit: Visit?
    /// Care-team uids are listed first in the assignee picker.
    var careTeamUids: [String] = []

    @State private var discipline: Discipline = .rn
    @State private var assignedUid: String?
    @State private var start: Date = VisitDefaults.start()
    @State private var end: Date = VisitDefaults.start().addingTimeInterval(3600)
    @State private var note = ""
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var isEditing: Bool { visit != nil }
    private var isValid: Bool { end > start }

    private var assigneeOptions: [Member] {
        let team = Set(careTeamUids)
        let active = org.activeMembers
        return active.filter { team.contains($0.memberUid) } + active.filter { !team.contains($0.memberUid) }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    Picker("Discipline", selection: $discipline) {
                        ForEach(Discipline.allCases) { discipline in
                            Text(discipline.label).tag(discipline)
                        }
                    }
                    .disabled(isEditing)
                    CareMemberPicker(title: "Assigned to", selection: $assignedUid, members: assigneeOptions)
                }
                Section("Time") {
                    DatePicker("Starts", selection: $start)
                    DatePicker("Ends", selection: $end, in: start...)
                    if !isValid {
                        Text("The visit must end after it starts.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section("Note") {
                    TextField("Optional note", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .navigationTitle(isEditing ? "Edit visit" : "Schedule visit")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: isEditing ? "Save" : "Schedule", isWorking: isSubmitting, isEnabled: isValid) {
                        Task { await submit() }
                    }
                }
            }
            .onChange(of: start) { _, newValue in
                // Keep the end after the start when the start moves past it.
                if end <= newValue { end = newValue.addingTimeInterval(3600) }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard !didLoad else { return }
        didLoad = true
        if let visit {
            discipline = visit.discipline ?? .other
            assignedUid = visit.assignedUid
            note = visit.note ?? ""
            if let visitStart = visit.scheduledStart { start = visitStart }
            if let visitEnd = visit.scheduledEnd {
                end = visitEnd
            } else {
                end = start.addingTimeInterval(3600)
            }
        } else {
            discipline = org.me?.discipline ?? .rn
            assignedUid = careTeamUids.contains(org.uid) ? org.uid : nil
        }
    }

    private func submit() async {
        guard isValid, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            if let visitId = visit?.id {
                try await FunctionsClient().updateVisit(orgId: org.orgId, visitId: visitId, assignedUid: assignedUid,
                                                        start: start, end: end, note: note)
            } else {
                _ = try await FunctionsClient().scheduleVisit(orgId: org.orgId, patientId: patientId, discipline: discipline,
                                                              assignedUid: assignedUid, start: start, end: end, note: note)
            }
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Complete / cancel

/// Marks a visit completed (`completeVisit`) with an optional note.
struct CompleteVisitView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let visit: Visit

    @State private var note = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Patient", value: visit.displayPatientName)
                    LabeledContent("Scheduled", value: visit.timeRange)
                }
                Section("Visit note") {
                    TextField("Optional note", text: $note, axis: .vertical)
                        .lineLimit(3...8)
                }
            }
            .navigationTitle("Complete visit")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Complete", isWorking: isSubmitting, isEnabled: visit.id != nil) {
                        Task { await submit() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        guard let visitId = visit.id, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().completeVisit(orgId: org.orgId, visitId: visitId, note: note)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Cancels a scheduled visit (`cancelVisit`); a reason is required.
struct CancelVisitView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let visit: Visit

    @State private var reason = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Patient", value: visit.displayPatientName)
                    LabeledContent("Scheduled", value: visit.timeRange)
                }
                Section("Reason") {
                    TextField("Why is this visit cancelled?", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .navigationTitle("Cancel visit")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Cancel visit", isWorking: isSubmitting,
                                     isEnabled: reason.nilIfBlank != nil && visit.id != nil) {
                        Task { await submit() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        guard let visitId = visit.id, let reason = reason.nilIfBlank, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().cancelVisit(orgId: org.orgId, visitId: visitId, reason: reason)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Frequencies

/// Edits the patient's planned visit frequencies (`setVisitFrequencies`).
struct VisitFrequenciesEditor: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patientId: String

    @State private var frequencies: [VisitFrequency]
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(patientId: String, initial: [VisitFrequency]) {
        self.patientId = patientId
        _frequencies = State(initialValue: initial)
    }

    /// One entry per discipline, each with a positive frequency.
    private var isValid: Bool {
        let disciplines = frequencies.map { $0.discipline }
        return Set(disciplines).count == disciplines.count && frequencies.allSatisfy { $0.perWeek > 0 }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                ForEach(Array(frequencies.indices), id: \.self) { index in
                    let binding = elementBinding($frequencies, index, default: VisitFrequency())
                    Section {
                        Picker("Discipline", selection: binding.discipline) {
                            ForEach(Discipline.allCases) { discipline in
                                Text(discipline.label).tag(discipline)
                            }
                        }
                        Stepper(value: binding.perWeek, in: 0.5...14, step: 0.5) {
                            LabeledContent("Frequency", value: binding.wrappedValue.summary)
                        }
                        TextField("Notes (e.g. PRN for pain)", text: binding.notes.orEmpty)
                        Button("Remove", role: .destructive) {
                            if index < frequencies.count { frequencies.remove(at: index) }
                        }
                    }
                }
                Section {
                    Button {
                        let used = Set(frequencies.map { $0.discipline })
                        let next = Discipline.allCases.first { !used.contains($0) } ?? .other
                        frequencies.append(VisitFrequency(discipline: next, perWeek: 1))
                    } label: {
                        Label("Add discipline", systemImage: "plus")
                    }
                } footer: {
                    if !isValid && !frequencies.isEmpty {
                        Text("Each discipline can appear only once.")
                    }
                }
            }
            .navigationTitle("Visit frequencies")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Save", isWorking: isSubmitting, isEnabled: isValid) {
                        Task { await submit() }
                    }
                }
            }
        }
    }

    private func submit() async {
        guard isValid, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().setVisitFrequencies(orgId: org.orgId, patientId: patientId, frequencies: frequencies)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
