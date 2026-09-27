import SwiftUI
import Observation

@MainActor
@Observable
final class TodayViewModel {
    let orgId: String
    let uid: String

    /// My visits from 7 days ago through the end of today (one `assignedUid` + `scheduledStart`
    /// range query; composite index visits (assignedUid ASC, scheduledStart ASC)).
    private(set) var visits: [Visit] = []
    /// My open tasks (all due dates; filtered to today / overdue for display).
    private(set) var tasks: [CareTask] = []
    private(set) var visitsLoaded = false
    private(set) var tasksLoaded = false
    private(set) var workingAlertId: String?
    private(set) var workingTaskId: String?
    var completing: Visit?
    var rescheduling: Visit?
    var editingTask: CareTask?
    var errorMessage: String?

    private let functions = FunctionsClient()

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    // MARK: Listeners

    /// Restart when the calendar day changes (see `TodayView`).
    func runVisits(day: Date) async {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: day)
        let start = calendar.date(byAdding: .day, value: -7, to: today) ?? today.addingTimeInterval(-7 * 86_400)
        let end = calendar.date(byAdding: .day, value: 1, to: today) ?? today.addingTimeInterval(86_400)
        do {
            for try await list in VisitRepository(orgId: orgId).visits(assignedTo: uid, from: start, to: end) {
                visits = list
                visitsLoaded = true
            }
        } catch {
            visitsLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runTasks() async {
        do {
            for try await list in TaskRepository(orgId: orgId).openTasks(assignedTo: uid) {
                tasks = list
                tasksLoaded = true
            }
        } catch {
            tasksLoaded = true
            errorMessage = error.userMessage
        }
    }

    // MARK: Derived lists

    /// Today's visits in time order. Missed ones are listed under "Overdue / missed" instead,
    /// and cancelled ones are hidden.
    func todayVisits(day: Date) -> [Visit] {
        let calendar = Calendar.current
        return visits
            .filter { visit in
                guard let start = visit.scheduledStart, calendar.isDate(start, inSameDayAs: day) else { return false }
                return visit.visitStatus != .missed && visit.visitStatus != .cancelled
            }
            .sorted { ($0.scheduledStart ?? .distantPast) < ($1.scheduledStart ?? .distantPast) }
    }

    /// My missed visits from the last 7 days (including today), newest first.
    var missedVisits: [Visit] {
        visits
            .filter { $0.visitStatus == .missed }
            .sorted { ($0.scheduledStart ?? .distantPast) > ($1.scheduledStart ?? .distantPast) }
    }

    /// Open tasks due today or overdue, oldest due date first, then priority.
    func dueTasks(day: Date) -> [CareTask] {
        let today = ISODate.string(from: day)
        return tasks
            .filter { task in
                guard let due = task.dueDate?.nilIfBlank else { return false }
                return due <= today
            }
            .sorted { lhs, rhs in
                let l = lhs.dueDate ?? ""
                let r = rhs.dueDate ?? ""
                if l != r { return l < r }
                return lhs.taskPriority.severity > rhs.taskPriority.severity
            }
    }

    // MARK: Actions

    func acknowledge(_ alert: AuraAlert) async {
        guard let id = alert.id, workingAlertId == nil else { return }
        workingAlertId = id
        defer { workingAlertId = nil }
        do {
            try await functions.ackAlert(orgId: orgId, alertId: id)
        } catch {
            errorMessage = error.userMessage
        }
    }

    func complete(_ task: CareTask) async {
        guard let id = task.id, workingTaskId == nil else { return }
        workingTaskId = id
        defer { workingTaskId = nil }
        do {
            try await functions.updateTaskStatus(orgId: orgId, taskId: id, status: .done)
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// "Today": my open alerts, my visits today (plus missed visits from the last week) and my
/// tasks due today or overdue.
struct TodayView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        TodayContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct TodayContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(AlertsStore.self) private var alertsStore
    @Environment(PatientNameCache.self) private var patientNames
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: TodayViewModel
    /// Local calendar day (`YYYY-MM-DD`); listeners restart when it changes.
    @State private var dayKey = ISODate.string(from: Date())

    init(orgId: String, uid: String) {
        _model = State(initialValue: TodayViewModel(orgId: orgId, uid: uid))
    }

    private var day: Date { ISODate.parse(dayKey) ?? Date() }

    private var openAlerts: [AuraAlert] {
        alertsStore.alerts.filter { $0.alertStatus == .open }
    }

    private var alertPatientIds: [String] {
        openAlerts.compactMap { $0.source?.patientId?.nilIfBlank }
    }

    private var canAct: Bool { org.role.canManageCare }

    /// v3 (V4): my own visits — Aide/LPN viewers may complete them too.
    private func canComplete(_ visit: Visit) -> Bool { org.canComplete(visit: visit) }

    var body: some View {
        @Bindable var model = model
        List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            alertsSection
            // Volunteers cannot read visits or tasks (firestore.rules); they see alerts only.
            if !org.isVolunteerMember {
                visitsSection
                missedSection
                tasksSection
            }
        }
        .navigationTitle("Today")
        .task(id: "\(dayKey)|\(org.canReadStaffCollections)") { [allowed = org.canReadStaffCollections] in
            if allowed { await model.runVisits(day: day) }
        }
        .task(id: org.canReadStaffCollections) { [allowed = org.canReadStaffCollections] in
            if allowed { await model.runTasks() }
        }
        .task(id: alertPatientIds) { await patientNames.load(alertPatientIds) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshDay() }
        }
        .onAppear(perform: refreshDay)
        .sheet(item: $model.completing) { visit in
            CompleteVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.rescheduling) { visit in
            RescheduleVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.editingTask) { task in
            TaskEditorView(task: task)
                .environment(org)
        }
    }

    private func refreshDay() {
        let key = ISODate.string(from: Date())
        if key != dayKey { dayKey = key }
    }

    // MARK: Alerts

    @ViewBuilder
    private var alertsSection: some View {
        let alerts = openAlerts
        Section {
            if alerts.isEmpty {
                Text(alertsStore.isLoading ? "Loading…" : "No open alerts")
                    .foregroundStyle(.secondary)
            }
            ForEach(alerts) { alert in
                if let id = alert.id {
                    NavigationLink(value: Route.alert(id)) {
                        AlertRow(alert: alert, patientName: patientNames.name(for: alert.source?.patientId))
                    }
                    .swipeActions(edge: .trailing) {
                        if org.role.canSendMessages {
                            Button {
                                Task { await model.acknowledge(alert) }
                            } label: {
                                Label("Acknowledge", systemImage: "hand.raised.fill")
                            }
                            .tint(.orange)
                            .disabled(model.workingAlertId != nil)
                        }
                    }
                }
            }
        } header: {
            Text("My open alerts")
        } footer: {
            if !alerts.isEmpty && org.role.canSendMessages {
                Text("Swipe left to acknowledge.")
            }
        }
    }

    // MARK: Visits

    @ViewBuilder
    private var visitsSection: some View {
        let visits = model.todayVisits(day: day)
        Section {
            if visits.isEmpty {
                Text(model.visitsLoaded ? "No visits scheduled today" : "Loading…")
                    .foregroundStyle(.secondary)
            }
            ForEach(visits) { visit in
                visitRow(visit)
            }
            NavigationLink(value: Route.myVisits) {
                Label("All my visits", systemImage: "calendar.badge.clock")
            }
        } header: {
            Text("My visits today · \(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))")
        }
    }

    @ViewBuilder
    private var missedSection: some View {
        let missed = model.missedVisits
        if !missed.isEmpty {
            Section {
                ForEach(missed) { visit in
                    visitRow(visit)
                }
            } header: {
                Label("Overdue / missed", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red)
            } footer: {
                Text("Missed visits from the last 7 days. Swipe right to document a visit late, or left to reschedule it.")
            }
        }
    }

    @ViewBuilder
    private func visitRow(_ visit: Visit) -> some View {
        let completable = canComplete(visit)
        Group {
            if let id = visit.id {
                NavigationLink(value: Route.visit(id)) {
                    VisitRow(visit: visit, showPatient: true)
                }
            } else {
                VisitRow(visit: visit, showPatient: true)
            }
        }
        .swipeActions(edge: .leading) {
            if completable {
                Button {
                    model.completing = visit
                } label: {
                    Label(visit.visitStatus == .missed ? "Document" : "Complete", systemImage: "checkmark")
                }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if org.canReschedule(visit: visit) {
                Button {
                    model.rescheduling = visit
                } label: {
                    Label("Reschedule", systemImage: "calendar.badge.clock")
                }
                .tint(.blue)
            }
        }
        .contextMenu {
            if completable {
                Button {
                    model.completing = visit
                } label: {
                    Label(visit.visitStatus == .missed ? "Document missed visit" : "Complete visit", systemImage: "checkmark.circle")
                }
            }
            if org.canReschedule(visit: visit) {
                Button {
                    model.rescheduling = visit
                } label: {
                    Label("Reschedule", systemImage: "calendar.badge.clock")
                }
            }
        }
    }

    // MARK: Tasks

    @ViewBuilder
    private var tasksSection: some View {
        let tasks = model.dueTasks(day: day)
        Section {
            if tasks.isEmpty {
                Text(model.tasksLoaded ? "Nothing due today" : "Loading…")
                    .foregroundStyle(.secondary)
            }
            ForEach(tasks) { task in
                taskRow(task)
            }
            NavigationLink(value: Route.myTasks) {
                Label("All my tasks", systemImage: "checklist")
            }
        } header: {
            Text("My tasks due")
        }
    }

    @ViewBuilder
    private func taskRow(_ task: CareTask) -> some View {
        Group {
            if let patientId = task.patientId?.nilIfBlank {
                NavigationLink(value: Route.patient(patientId)) {
                    TaskRow(task: task)
                }
            } else {
                Button {
                    model.editingTask = task
                } label: {
                    TaskRow(task: task)
                }
                .buttonStyle(.plain)
            }
        }
        .swipeActions(edge: .leading) {
            if org.role.canSendMessages {
                Button {
                    Task { await model.complete(task) }
                } label: {
                    Label("Done", systemImage: "checkmark")
                }
                .tint(.green)
                .disabled(model.workingTaskId != nil)
            }
        }
        .contextMenu {
            if org.role.canSendMessages {
                Button {
                    model.editingTask = task
                } label: {
                    Label("Edit task", systemImage: "pencil")
                }
            }
        }
    }
}
