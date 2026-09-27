import SwiftUI

// Sections shown in the patient chart's segments. Each view's body is one or more `Section`s
// placed directly inside the chart's `List`; presentation state lives in `PatientCareViewModel`.

// MARK: - Milestones

/// Hospice milestones with completion state and complete / reopen actions.
struct PatientMilestonesSection: View {
    @Environment(OrgStore.self) private var org
    let patient: Patient
    let milestones: Milestones
    let care: PatientCareViewModel
    let canEdit: Bool

    var body: some View {
        let items = MilestoneLogic.items(for: milestones, today: Date(), leadDays: org.leadDays)
        let completions = patient.completions
        Section {
            if items.isEmpty {
                Text("No milestones computed").foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                let completion = completions[item.completionKey]
                MilestoneRow(item: item,
                             completion: completion,
                             onTime: completion.map { MilestoneCompletionLogic.isOnTime($0, dueDate: item.dueDate, timeZoneId: org.org?.timezone) } ?? true,
                             isWorking: care.workingMilestoneKey == item.completionKey)
                    .swipeActions(edge: .trailing) {
                        if canEdit {
                            if completion == nil {
                                Button {
                                    care.requestComplete(item)
                                } label: {
                                    Label("Complete", systemImage: "checkmark")
                                }
                                .tint(.green)
                            } else {
                                Button {
                                    Task { await care.reopenMilestone(item) }
                                } label: {
                                    Label("Reopen", systemImage: "arrow.uturn.backward")
                                }
                                .tint(.orange)
                            }
                        }
                    }
                    .contextMenu {
                        if canEdit {
                            if completion == nil {
                                Button {
                                    care.requestComplete(item)
                                } label: {
                                    Label("Mark complete", systemImage: "checkmark.circle")
                                }
                            } else {
                                Button {
                                    Task { await care.reopenMilestone(item) }
                                } label: {
                                    Label("Reopen", systemImage: "arrow.uturn.backward.circle")
                                }
                            }
                        }
                    }
            }
        } header: {
            Text("Hospice milestones")
        } footer: {
            Text(canEdit
                 ? "Swipe a milestone to mark it complete or reopen it. Computed from CMS hospice rules at admission; verify with your compliance team."
                 : "Computed from CMS hospice rules at admission. Verify with your compliance team.")
        }
    }
}

private struct MilestoneRow: View {
    @Environment(OrgStore.self) private var org
    let item: MilestoneItem
    let completion: MilestoneCompletion?
    let onTime: Bool
    let isWorking: Bool

    private var color: Color {
        guard completion != nil else { return item.status.color }
        return onTime ? .green : .orange
    }

    private var symbol: String {
        guard completion != nil else { return item.status.symbol }
        return onTime ? "checkmark.seal.fill" : "checkmark.seal"
    }

    private var pillText: String {
        guard completion != nil else { return item.status.label }
        return onTime ? "Completed" : "Completed late"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                if let start = item.windowStart {
                    Text("Window \(ISODate.display(start)) – \(ISODate.display(item.dueDate))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Due \(ISODate.display(item.dueDate))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let completion {
                    Text("Completed \(RelativeTime.full(completion.completedAt)) by \(org.name(for: completion.completedBy))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let note = completion.note?.nilIfBlank {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if isWorking {
                ProgressView()
            } else {
                StatusPill(text: pillText, color: color)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Outcome (discharge / death)

/// Discharge or death details, when recorded.
struct PatientOutcomeSection: View {
    let patient: Patient

    var body: some View {
        if let death = patient.death {
            Section("Death") {
                InfoRow(label: "Date", value: death.date.map { ISODate.display($0) })
                InfoRow(label: "Time", value: death.time)
                InfoRow(label: "Pronounced by", value: death.pronouncedBy)
                InfoRow(label: "Location", value: death.location)
                InfoRow(label: "Notes", value: death.notes)
                if let planId = patient.bereavementPlanId?.nilIfBlank {
                    NavigationLink(value: Route.bereavementPlan(planId)) {
                        Label("Bereavement plan", systemImage: "heart.circle")
                    }
                }
            }
        } else if patient.dischargeDate != nil || patient.dischargeReason != nil {
            Section("Discharge") {
                InfoRow(label: "Date", value: patient.dischargeDate.map { ISODate.display($0) })
                InfoRow(label: "Reason", value: patient.dischargeReason?.label)
            }
        }
    }
}

// MARK: - Visits

struct PatientVisitsSections: View {
    @Environment(OrgStore.self) private var org
    let patient: Patient
    let care: PatientCareViewModel

    private var canAct: Bool { org.role.canManageCare }
    private var canSchedule: Bool { canAct && patient.patientStatus == .admitted }

    var body: some View {
        Section {
            let frequencies = patient.frequencies
            if frequencies.isEmpty {
                Text("No visit frequencies set").foregroundStyle(.secondary)
            }
            ForEach(Array(frequencies.enumerated()), id: \.offset) { _, frequency in
                VStack(alignment: .leading, spacing: 2) {
                    LabeledContent(frequency.discipline.label, value: frequency.summary)
                    if let notes = frequency.notes?.nilIfBlank {
                        Text(notes).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if canSchedule {
                Button {
                    care.sheet = .frequencies
                } label: {
                    Label("Edit frequencies", systemImage: "slider.horizontal.3")
                }
            }
        } header: {
            Text("Planned frequency")
        }

        Section {
            if canSchedule {
                Button {
                    care.sheet = .scheduleVisit
                } label: {
                    Label("Schedule visit", systemImage: "calendar.badge.plus")
                }
            }
            let scheduled = care.scheduledVisits
            if scheduled.isEmpty {
                Text(care.visitsLoaded ? "No scheduled visits" : "Loading…").foregroundStyle(.secondary)
            }
            ForEach(scheduled) { visit in
                Button {
                    if canAct { care.sheet = .editVisit(visit) }
                } label: {
                    VisitRow(visit: visit)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .leading) {
                    if canAct {
                        Button {
                            care.sheet = .completeVisit(visit)
                        } label: {
                            Label("Complete", systemImage: "checkmark")
                        }
                        .tint(.green)
                    }
                }
                .swipeActions(edge: .trailing) {
                    if canAct {
                        Button {
                            care.sheet = .cancelVisit(visit)
                        } label: {
                            Label("Cancel", systemImage: "xmark")
                        }
                        .tint(.red)
                    }
                }
                .contextMenu {
                    if canAct {
                        Button {
                            care.sheet = .completeVisit(visit)
                        } label: {
                            Label("Complete visit", systemImage: "checkmark.circle")
                        }
                        Button {
                            care.sheet = .editVisit(visit)
                        } label: {
                            Label("Edit visit", systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            care.sheet = .cancelVisit(visit)
                        } label: {
                            Label("Cancel visit", systemImage: "xmark.circle")
                        }
                    }
                }
            }
        } header: {
            Text("Scheduled")
        } footer: {
            if canAct && !care.scheduledVisits.isEmpty {
                Text("Tap a visit to edit it; swipe to complete or cancel.")
            }
        }

        let past = care.pastVisits
        if !past.isEmpty {
            Section {
                ForEach(past.prefix(50)) { visit in
                    let canDocument = visit.visitStatus == .missed && (canAct || visit.assignedUid == org.uid)
                    VisitRow(visit: visit)
                        .swipeActions(edge: .leading) {
                            if canDocument {
                                Button {
                                    care.sheet = .completeVisit(visit)
                                } label: {
                                    Label("Document", systemImage: "checkmark")
                                }
                                .tint(.green)
                            }
                        }
                        .contextMenu {
                            if canDocument {
                                Button {
                                    care.sheet = .completeVisit(visit)
                                } label: {
                                    Label("Document missed visit", systemImage: "checkmark.circle")
                                }
                            }
                        }
                }
            } header: {
                Text("History")
            } footer: {
                if past.contains(where: { $0.visitStatus == .missed }) && canAct {
                    Text("Swipe a missed visit to document it late.")
                }
            }
        }
    }
}

// MARK: - Tasks

struct PatientTasksSections: View {
    @Environment(OrgStore.self) private var org
    let patient: Patient
    let care: PatientCareViewModel

    private var canEdit: Bool { org.role.canSendMessages }

    var body: some View {
        Section {
            if canEdit {
                Button {
                    care.sheet = .newTask
                } label: {
                    Label("New task", systemImage: "plus.circle")
                }
            }
            let open = care.openTasks
            if open.isEmpty {
                Text(care.tasksLoaded ? "No open tasks" : "Loading…").foregroundStyle(.secondary)
            }
            ForEach(open) { task in
                taskButton(task)
                    .swipeActions(edge: .leading) {
                        if canEdit {
                            Button {
                                Task { await care.setStatus(task, .done) }
                            } label: {
                                Label("Done", systemImage: "checkmark")
                            }
                            .tint(.green)
                        }
                    }
            }
        } header: {
            Text("Open tasks")
        }

        let closed = care.closedTasks
        if !closed.isEmpty {
            Section("Completed and cancelled") {
                ForEach(closed.prefix(50)) { task in
                    taskButton(task)
                }
            }
        }
    }

    private func taskButton(_ task: CareTask) -> some View {
        Button {
            if canEdit { care.sheet = .editTask(task) }
        } label: {
            HStack {
                TaskRow(task: task, showPatient: false)
                if care.workingTaskId != nil && care.workingTaskId == task.id {
                    ProgressView()
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Documents

struct PatientDocumentsSections: View {
    @Environment(OrgStore.self) private var org
    let patient: Patient
    let care: PatientCareViewModel

    var body: some View {
        Section {
            if org.role.canManageCare {
                Button {
                    care.sheet = .uploadDocument
                } label: {
                    Label("Upload document", systemImage: "square.and.arrow.up")
                }
            }
            if care.documents.isEmpty {
                Text(care.documentsLoaded ? "No documents" : "Loading…").foregroundStyle(.secondary)
            }
            ForEach(care.documents) { document in
                Button {
                    Task { await care.open(document) }
                } label: {
                    PatientDocumentRow(document: document,
                                       isOpening: care.openingDocumentId != nil && care.openingDocumentId == document.id)
                }
                .buttonStyle(.plain)
                .disabled(care.openingDocumentId != nil)
            }
        } header: {
            Text("Documents")
        } footer: {
            Text("Documents open in a protected preview and are removed from this device when you close them.")
        }
    }
}

struct PatientDocumentRow: View {
    @Environment(OrgStore.self) private var org
    let document: PatientDocument
    let isOpening: Bool

    private var detail: String {
        var parts = [document.documentCategory.label]
        if let createdAt = document.createdAt { parts.append(RelativeTime.short(createdAt)) }
        if let uploader = document.uploadedBy { parts.append(org.name(for: uploader)) }
        if let size = document.size, size > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if isOpening {
                    ProgressView()
                } else {
                    Image(systemName: document.isPDF ? "doc.richtext" : (document.isImage ? "photo" : document.documentCategory.symbol))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(document.displayName)
                    .lineLimit(2)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens a preview")
    }
}

// MARK: - Timeline

struct PatientTimelineSection: View {
    @Environment(OrgStore.self) private var org
    let care: PatientCareViewModel

    var body: some View {
        Section {
            let events = care.sortedEvents
            if events.isEmpty {
                Text(care.eventsLoaded ? "No events recorded yet" : "Loading…").foregroundStyle(.secondary)
            }
            ForEach(events) { event in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: event.eventType.symbol)
                        .foregroundStyle(event.eventType.color)
                        .frame(width: 24, height: 24)
                        .background(event.eventType.color.opacity(0.15), in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.displaySummary)
                        Text([ISODate.display(event.date), event.eventType.label, event.recordedBy.map { org.name(for: $0) }]
                            .compactMap { $0 }
                            .joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Timeline")
        }
    }
}
