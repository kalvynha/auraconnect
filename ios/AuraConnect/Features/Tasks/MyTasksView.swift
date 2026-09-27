import SwiftUI
import Observation
import FirebaseFirestore

@MainActor
@Observable
final class MyTasksViewModel {
    enum Scope: String, CaseIterable, Identifiable {
        case mine = "Mine"
        case unassigned = "Unassigned"
        var id: String { rawValue }
    }

    let orgId: String
    let uid: String
    var scope: Scope = .mine
    private(set) var mine: [CareTask] = []
    private(set) var unassigned: [CareTask] = []
    /// Patients whose care team includes me (unassigned tasks are limited to these for non-admins).
    private(set) var myPatientIds: Set<String> = []
    private(set) var mineLoaded = false
    private(set) var unassignedLoaded = false
    private(set) var workingTaskId: String?
    var editingTask: CareTask?
    var showNewTask = false
    var errorMessage: String?

    private let functions = FunctionsClient()

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    private var repository: TaskRepository { TaskRepository(orgId: orgId) }

    func runMine() async {
        do {
            for try await list in repository.openTasks(assignedTo: uid) {
                mine = list
                mineLoaded = true
            }
        } catch {
            mineLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runUnassigned(discipline: Discipline) async {
        unassignedLoaded = false
        do {
            for try await list in repository.openUnassignedTasks(discipline: discipline) {
                unassigned = list
                unassignedLoaded = true
            }
        } catch {
            unassignedLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runMyPatients() async {
        let query = FirebaseService.orgRef(orgId).collection("patients")
            .whereField("careTeamUids", arrayContains: uid)
            .limit(to: 500)
        do {
            for try await list in query.decodedStream(Patient.self) {
                myPatientIds = Set(list.compactMap { $0.id })
            }
        } catch {
            // Non-fatal: the unassigned list is simply not narrowed to my patients.
        }
    }

    func visibleTasks(isAdmin: Bool) -> [CareTask] {
        switch scope {
        case .mine:
            return mine
        case .unassigned:
            if isAdmin { return unassigned }
            return unassigned.filter { task in
                guard let patientId = task.patientId else { return true }
                return myPatientIds.contains(patientId)
            }
        }
    }

    var isLoading: Bool {
        scope == .mine ? !mineLoaded : !unassignedLoaded
    }

    /// Tasks grouped by due-date bucket, most urgent first within each bucket.
    func grouped(_ tasks: [CareTask], today: Date) -> [DueGroup<CareTask>] {
        let groups = Dictionary(grouping: tasks) { DueBucket.bucket(for: $0.dueDate, today: today) }
        return DueBucket.allCases.compactMap { bucket in
            guard let items = groups[bucket], !items.isEmpty else { return nil }
            let sorted = items.sorted { lhs, rhs in
                let l = lhs.dueDate ?? "9999-12-31"
                let r = rhs.dueDate ?? "9999-12-31"
                if l != r { return l < r }
                if lhs.taskPriority.severity != rhs.taskPriority.severity {
                    return lhs.taskPriority.severity > rhs.taskPriority.severity
                }
                return lhs.displayTitle.localizedCaseInsensitiveCompare(rhs.displayTitle) == .orderedAscending
            }
            return DueGroup(bucket: bucket, items: sorted)
        }
    }

    func complete(_ task: CareTask) async {
        await perform(task) { id in
            try await self.functions.updateTaskStatus(orgId: self.orgId, taskId: id, status: .done)
        }
    }

    func assignToMe(_ task: CareTask) async {
        await perform(task) { id in
            try await self.functions.updateTaskAssignee(orgId: self.orgId, taskId: id, assigneeUid: self.uid)
        }
    }

    private func perform(_ task: CareTask, _ action: (String) async throws -> Void) async {
        guard let id = task.id, workingTaskId == nil else { return }
        workingTaskId = id
        defer { workingTaskId = nil }
        do {
            try await action(id)
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// "My Tasks": open tasks assigned to me, plus unassigned tasks for my discipline.
struct MyTasksView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        MyTasksContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct MyTasksContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: MyTasksViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: MyTasksViewModel(orgId: orgId, uid: uid))
    }

    private var canEdit: Bool { org.role.canSendMessages }

    var body: some View {
        @Bindable var model = model
        let tasks = model.visibleTasks(isAdmin: org.role == .admin)
        let groups = model.grouped(tasks, today: Date())
        List {
            Section {
                Picker("Show", selection: $model.scope) {
                    ForEach(MyTasksViewModel.Scope.allCases) { scope in
                        Text(scope == .unassigned ? unassignedTitle : scope.rawValue).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.items) { task in
                        row(task)
                    }
                } header: {
                    Text("\(group.bucket.title) (\(group.items.count))")
                        .foregroundStyle(group.bucket.color)
                }
            }
        }
        .overlay {
            if model.scope == .unassigned && org.membersLoaded && org.me?.discipline == nil {
                ContentUnavailableView("No discipline",
                                       systemImage: "person.crop.circle.badge.questionmark",
                                       description: Text("Your profile has no discipline, so there are no unassigned tasks to show."))
            } else if model.isLoading && tasks.isEmpty {
                ProgressView()
            } else if tasks.isEmpty {
                ContentUnavailableView("No open tasks",
                                       systemImage: "checklist.checked",
                                       description: Text(model.scope == .mine
                                                         ? "Tasks assigned to you appear here."
                                                         : "Unassigned tasks for your discipline appear here."))
            }
        }
        .navigationTitle("My Tasks")
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.showNewTask = true
                    } label: {
                        Label("New task", systemImage: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $model.showNewTask) {
            TaskEditorView(task: nil)
                .environment(org)
        }
        .sheet(item: $model.editingTask) { task in
            TaskEditorView(task: task)
                .environment(org)
        }
        .alert("Tasks", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .task { await model.runMine() }
        .task { await model.runMyPatients() }
        .task(id: org.me?.discipline) {
            if let discipline = org.me?.discipline {
                await model.runUnassigned(discipline: discipline)
            }
        }
    }

    private var unassignedTitle: String {
        if let discipline = org.me?.discipline { return "Unassigned \(discipline.label)" }
        return "Unassigned"
    }

    @ViewBuilder
    private func row(_ task: CareTask) -> some View {
        let isWorking = model.workingTaskId != nil && model.workingTaskId == task.id
        Button {
            if canEdit { model.editingTask = task }
        } label: {
            HStack {
                TaskRow(task: task)
                if isWorking { ProgressView() }
            }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading) {
            if canEdit && task.assigneeUid == org.uid {
                Button {
                    Task { await model.complete(task) }
                } label: {
                    Label("Done", systemImage: "checkmark")
                }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if canEdit && task.assigneeUid == nil {
                Button {
                    Task { await model.assignToMe(task) }
                } label: {
                    Label("Take", systemImage: "person.crop.circle.badge.checkmark")
                }
                .tint(.blue)
            }
        }
        .contextMenu {
            if canEdit {
                if task.assigneeUid == nil {
                    Button {
                        Task { await model.assignToMe(task) }
                    } label: {
                        Label("Assign to me", systemImage: "person.crop.circle.badge.checkmark")
                    }
                }
                Button {
                    Task { await model.complete(task) }
                } label: {
                    Label("Mark done", systemImage: "checkmark.circle")
                }
                Button {
                    model.editingTask = task
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
            }
        }
    }
}
