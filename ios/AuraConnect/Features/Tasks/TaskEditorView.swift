import SwiftUI

/// One task in a list: title, patient, due date, assignee and priority.
struct TaskRow: View {
    @Environment(OrgStore.self) private var org
    let task: CareTask
    var showPatient = true

    private var dueText: String? {
        guard let due = task.dueDate?.nilIfBlank else { return nil }
        return "Due \(ISODate.display(due))"
    }

    private var isOverdue: Bool {
        guard task.taskStatus == .open, let due = task.dueDate,
              let days = ISODate.daysFrom(Date(), to: due) else { return false }
        return days < 0
    }

    private var assigneeText: String {
        if let uid = task.assigneeUid { return org.name(for: uid) }
        if let discipline = task.discipline { return "Unassigned · \(discipline.label)" }
        return "Unassigned"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: task.taskStatus == .done ? "checkmark.circle.fill" : (task.taskStatus == .cancelled ? "xmark.circle" : "circle"))
                .foregroundStyle(task.taskStatus.color)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(task.displayTitle)
                        .font(.body.weight(.medium))
                        .strikethrough(task.taskStatus == .cancelled)
                        .foregroundStyle(task.taskStatus == .open ? Color.primary : Color.secondary)
                    Spacer()
                    PriorityBadge(priority: task.taskPriority)
                }
                if showPatient, let name = task.patientName?.nilIfBlank {
                    Text(name).font(.subheadline)
                }
                HStack(spacing: 6) {
                    if let dueText {
                        Text(dueText)
                            .foregroundStyle(isOverdue ? Color.red : Color.secondary)
                            .fontWeight(isOverdue ? .semibold : .regular)
                    }
                    Text(assigneeText).foregroundStyle(.secondary)
                }
                .font(.caption)
                if let source = task.source?.label {
                    Text(source).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(task.taskStatus.label)
    }
}

/// Creates a task (`createTask`) or edits one (`updateTask`), including status changes.
struct TaskEditorView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    /// nil creates a new task.
    let task: CareTask?
    /// Fixed patient for new tasks created from a patient's chart.
    var patientId: String? = nil
    var patientName: String? = nil

    @State private var title = ""
    @State private var details = ""
    @State private var selectedPatientId: String?
    @State private var assigneeUid: String?
    @State private var discipline: Discipline?
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var priority: Priority = .normal
    @State private var patients: [Patient] = []
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var isEditing: Bool { task != nil }
    private var isValid: Bool {
        guard let value = title.nilIfBlank else { return false }
        return value.count <= 200
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    TextField("Title", text: $title)
                    TextField("Description", text: $details, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    patientField
                    CareMemberPicker(title: "Assigned to", selection: $assigneeUid, members: org.activeMembers)
                    Picker("Discipline", selection: $discipline) {
                        Text("Any").tag(Discipline?.none)
                        ForEach(Discipline.allCases) { discipline in
                            Text(discipline.label).tag(Discipline?.some(discipline))
                        }
                    }
                    .disabled(isEditing)
                } footer: {
                    if !isEditing {
                        Text("Unassigned tasks can be picked up by anyone on the care team with the chosen discipline.")
                    }
                }
                Section {
                    Toggle("Due date", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(Priority.allCases) { priority in
                            Text(priority.label).tag(priority)
                        }
                    }
                }
                if let task, task.id != nil {
                    statusSection(task)
                }
            }
            .navigationTitle(isEditing ? "Edit task" : "New task")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: isEditing ? "Save" : "Create", isWorking: isSubmitting, isEnabled: isValid) {
                        Task { await submit() }
                    }
                }
            }
            .onAppear(perform: load)
            .task { await loadPatients() }
        }
    }

    @ViewBuilder
    private var patientField: some View {
        if let task {
            LabeledContent("Patient", value: task.patientName?.nilIfBlank ?? "None")
        } else if patientId != nil {
            LabeledContent("Patient", value: patientName?.nilIfBlank ?? "Patient")
        } else {
            Picker("Patient", selection: $selectedPatientId) {
                Text("None").tag(String?.none)
                ForEach(patients.filter { $0.id != nil }) { patient in
                    Text(patient.sortName).tag(patient.id)
                }
            }
        }
    }

    @ViewBuilder
    private func statusSection(_ task: CareTask) -> some View {
        Section("Status") {
            LabeledContent("Status") {
                StatusPill(text: task.taskStatus.label, color: task.taskStatus.color)
            }
            if let completedAt = task.completedAt, task.taskStatus == .done {
                LabeledContent("Completed", value: "\(RelativeTime.full(completedAt)) by \(org.name(for: task.completedBy))")
            }
            if task.taskStatus == .open {
                Button {
                    Task { await setStatus(.done) }
                } label: {
                    Label("Mark done", systemImage: "checkmark.circle")
                }
                .disabled(isSubmitting)
                Button(role: .destructive) {
                    Task { await setStatus(.cancelled) }
                } label: {
                    Label("Cancel task", systemImage: "xmark.circle")
                }
                .disabled(isSubmitting)
            } else {
                Button {
                    Task { await setStatus(.open) }
                } label: {
                    Label("Reopen", systemImage: "arrow.uturn.backward.circle")
                }
                .disabled(isSubmitting)
            }
        }
    }

    private func load() {
        guard !didLoad else { return }
        didLoad = true
        if let task {
            title = task.title ?? ""
            details = task.description ?? ""
            assigneeUid = task.assigneeUid
            discipline = task.discipline
            priority = task.taskPriority
            if let due = ISODate.parse(task.dueDate) {
                hasDueDate = true
                dueDate = due
            }
        } else {
            selectedPatientId = patientId
        }
    }

    private func loadPatients() async {
        guard task == nil, patientId == nil else { return }
        do {
            for try await list in PatientRepository(orgId: org.orgId).patients() {
                patients = list
                    .filter { $0.patientStatus == .admitted }
                    .sorted { $0.sortName.localizedCaseInsensitiveCompare($1.sortName) == .orderedAscending }
            }
        } catch {
            // The patient picker is optional; a task can be created without a patient.
        }
    }

    private func submit() async {
        guard isValid, !isSubmitting, let cleanTitle = title.nilIfBlank else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        let due: String? = hasDueDate ? ISODate.string(from: dueDate) : nil
        do {
            if let taskId = task?.id {
                try await FunctionsClient().updateTask(orgId: org.orgId, taskId: taskId, title: cleanTitle,
                                                       description: details, assigneeUid: assigneeUid,
                                                       dueDate: due, priority: priority)
            } else {
                _ = try await FunctionsClient().createTask(orgId: org.orgId, title: cleanTitle, description: details,
                                                           patientId: selectedPatientId ?? patientId,
                                                           assigneeUid: assigneeUid, discipline: discipline,
                                                           dueDate: due, priority: priority)
            }
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func setStatus(_ status: TaskStatus) async {
        guard let taskId = task?.id, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().updateTaskStatus(orgId: org.orgId, taskId: taskId, status: status)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
