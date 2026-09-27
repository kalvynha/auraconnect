import SwiftUI
import Observation

@MainActor
@Observable
final class VolunteerViewModel {
    let orgId: String
    let uid: String
    private(set) var assignments: [VolunteerAssignment] = []
    private(set) var logs: [VolunteerLog] = []
    private(set) var assignmentsLoaded = false
    private(set) var logsLoaded = false
    var showLogTime = false
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    private var repository: VolunteerRepository { VolunteerRepository(orgId: orgId) }

    func runAssignments() async {
        do {
            for try await list in repository.assignments(volunteerUid: uid) {
                assignments = list
                assignmentsLoaded = true
            }
        } catch {
            assignmentsLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runLogs() async {
        do {
            for try await list in repository.logs(volunteerUid: uid) {
                logs = list
                logsLoaded = true
            }
        } catch {
            logsLoaded = true
            errorMessage = error.userMessage
        }
    }

    /// Active assignments first, then most recent start.
    var sortedAssignments: [VolunteerAssignment] {
        assignments.sorted { lhs, rhs in
            if lhs.assignmentStatus != rhs.assignmentStatus { return lhs.assignmentStatus == .active }
            return (lhs.startDate ?? "") > (rhs.startDate ?? "")
        }
    }

    var activeAssignments: [VolunteerAssignment] {
        sortedAssignments.filter { $0.assignmentStatus == .active }
    }

    /// Newest date first.
    var sortedLogs: [VolunteerLog] {
        logs.sorted { lhs, rhs in
            let l = lhs.date ?? ""
            let r = rhs.date ?? ""
            if l != r { return l > r }
            return (lhs.createdAt ?? .distantPast) > (rhs.createdAt ?? .distantPast)
        }
    }

    /// Minutes logged in the last 30 days (including today).
    func minutesLast30Days(today: Date) -> Int {
        logs.reduce(0) { total, log in
            guard let date = log.date, let days = ISODate.daysFrom(today, to: date), days <= 0, days > -30 else { return total }
            return total + (log.minutes ?? 0)
        }
    }

    func patientName(for patientId: String?) -> String? {
        guard let patientId else { return nil }
        return assignments.first { $0.patientId == patientId }?.patientName?.nilIfBlank
    }
}

/// Volunteering: my assignments, "Log my time", and my recent logs.
struct VolunteerView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        VolunteerContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct VolunteerContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: VolunteerViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: VolunteerViewModel(orgId: orgId, uid: uid))
    }

    var body: some View {
        @Bindable var model = model
        let total = model.minutesLast30Days(today: Date())
        List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            Section {
                Button {
                    model.showLogTime = true
                } label: {
                    Label("Log my time", systemImage: "clock.badge.checkmark")
                        .font(.body.weight(.semibold))
                }
                LabeledContent("Last 30 days", value: VolunteerTime.format(minutes: total))
            }

            Section("My assignments") {
                let assignments = model.sortedAssignments
                if assignments.isEmpty {
                    Text(model.assignmentsLoaded ? "No assignments yet." : "Loading…")
                        .foregroundStyle(.secondary)
                }
                ForEach(assignments) { assignment in
                    VolunteerAssignmentRow(assignment: assignment)
                }
            }

            Section("Recent time") {
                let logs = model.sortedLogs
                if logs.isEmpty {
                    Text(model.logsLoaded ? "No time logged yet." : "Loading…")
                        .foregroundStyle(.secondary)
                }
                ForEach(logs.prefix(100)) { log in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(log.activity?.label ?? "Volunteer time")
                            Spacer()
                            Text(VolunteerTime.format(minutes: log.minutes ?? 0))
                                .foregroundStyle(.secondary)
                        }
                        Text([ISODate.display(log.date), model.patientName(for: log.patientId)]
                            .compactMap { $0 }
                            .joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let note = log.note?.nilIfBlank {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .navigationTitle("Volunteering")
        .sheet(isPresented: $model.showLogTime) {
            LogVolunteerTimeView(assignments: model.activeAssignments)
                .environment(org)
        }
        .task { await model.runAssignments() }
        .task { await model.runLogs() }
    }
}

enum VolunteerTime {
    /// "1 h 30 min", "45 min"
    static func format(minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest) min" }
        if rest == 0 { return "\(hours) h" }
        return "\(hours) h \(rest) min"
    }
}

struct VolunteerAssignmentRow: View {
    let assignment: VolunteerAssignment

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(assignment.displayPatientName).font(.headline)
                Spacer()
                StatusPill(text: assignment.assignmentStatus == .active ? "Active" : "Ended",
                           color: assignment.assignmentStatus == .active ? .green : .secondary)
            }
            let range = [assignment.startDate.map { "From \(ISODate.display($0))" },
                         assignment.endDate.map { "to \(ISODate.display($0))" }]
                .compactMap { $0 }
                .joined(separator: " ")
            Text([assignment.activity?.label, range.nilIfBlank].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let notes = assignment.notes?.nilIfBlank {
                Text(notes).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Logs volunteer time directly to Firestore (`volunteerLogs`, exact `VolunteerLog` shape).
struct LogVolunteerTimeView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    /// Active assignments offered in the patient picker.
    let assignments: [VolunteerAssignment]

    @State private var date = Date()
    @State private var hours = 1
    @State private var minutes = 0
    @State private var activity: VolunteerActivity = .companionship
    @State private var patientId: String?
    @State private var note = ""
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var totalMinutes: Int { hours * 60 + minutes }
    private var isValid: Bool { (1...1440).contains(totalMinutes) }

    private struct PatientOption: Hashable {
        let id: String
        let name: String
    }

    /// One entry per patient among the active assignments.
    private var patientOptions: [PatientOption] {
        var seen = Set<String>()
        var options: [PatientOption] = []
        for assignment in assignments {
            guard let id = assignment.patientId?.nilIfBlank, !seen.contains(id) else { continue }
            seen.insert(id)
            options.append(PatientOption(id: id, name: assignment.displayPatientName))
        }
        return options
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    DatePicker("Date", selection: $date, in: ...Date(), displayedComponents: .date)
                    Stepper(value: $hours, in: 0...24) {
                        LabeledContent("Hours", value: "\(hours)")
                    }
                    Stepper(value: $minutes, in: 0...45, step: 15) {
                        LabeledContent("Minutes", value: "\(minutes)")
                    }
                    if !isValid {
                        Text("Log between 1 minute and 24 hours.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Picker("Activity", selection: $activity) {
                        ForEach(VolunteerActivity.allCases) { activity in
                            Text(activity.label).tag(activity)
                        }
                    }
                    Picker("Patient", selection: $patientId) {
                        Text("None").tag(String?.none)
                        ForEach(patientOptions, id: \.self) { option in
                            Text(option.name).tag(String?.some(option.id))
                        }
                    }
                }
                Section("Note") {
                    TextField("Optional note", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .navigationTitle("Log my time")
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
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                if patientOptions.count == 1 { patientId = patientOptions.first?.id }
            }
        }
    }

    private func submit() async {
        guard isValid, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await VolunteerRepository(orgId: org.orgId).logTime(
                volunteerUid: org.uid,
                patientId: patientId,
                date: ISODate.string(from: date),
                minutes: min(totalMinutes, 1440),
                activity: activity,
                note: note
            )
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
