import Foundation
import Observation

/// Segments of the patient chart.
enum PatientDetailTab: String, CaseIterable, Identifiable {
    case overview, visits, tasks, documents, timeline

    var id: String { rawValue }

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .visits: return "Visits"
        case .tasks: return "Tasks"
        case .documents: return "Docs"
        case .timeline: return "Timeline"
        }
    }
}

/// Every sheet the patient chart can present (one `.sheet(item:)` avoids competing presentations).
enum PatientCareSheet: Identifiable {
    case scheduleVisit
    case editVisit(Visit)
    case completeVisit(Visit)
    case cancelVisit(Visit)
    case frequencies
    case newTask
    case editTask(CareTask)
    case uploadDocument
    case changeLevelOfCare
    case recertify
    case discharge
    case recordDeath
    /// O1: record death from the visit in progress (the visit is completed, not cancelled).
    case recordDeathFromVisit(Visit)
    /// S2: edit code status, allergies, medications, contacts, physicians, diagnoses.
    case editClinical

    var id: String {
        switch self {
        case .scheduleVisit: return "scheduleVisit"
        case .editVisit(let visit): return "editVisit-\(visit.id ?? "")"
        case .completeVisit(let visit): return "completeVisit-\(visit.id ?? "")"
        case .cancelVisit(let visit): return "cancelVisit-\(visit.id ?? "")"
        case .frequencies: return "frequencies"
        case .newTask: return "newTask"
        case .editTask(let task): return "editTask-\(task.id ?? "")"
        case .uploadDocument: return "uploadDocument"
        case .changeLevelOfCare: return "changeLevelOfCare"
        case .recertify: return "recertify"
        case .discharge: return "discharge"
        case .recordDeath: return "recordDeath"
        case .recordDeathFromVisit(let visit): return "recordDeath-\(visit.id ?? "")"
        case .editClinical: return "editClinical"
        }
    }
}

/// Care-workflow state for one patient chart: visits, tasks, documents and timeline listeners,
/// plus milestone / task actions and document previews.
@MainActor
@Observable
final class PatientCareViewModel {
    let orgId: String
    let patientId: String

    private(set) var visits: [Visit] = []
    private(set) var tasks: [CareTask] = []
    private(set) var documents: [PatientDocument] = []
    private(set) var events: [PatientEvent] = []
    private(set) var visitsLoaded = false
    private(set) var tasksLoaded = false
    private(set) var documentsLoaded = false
    private(set) var eventsLoaded = false

    /// Milestone key / task id / document id with a request in flight.
    private(set) var workingMilestoneKey: String?
    private(set) var workingTaskId: String?
    private(set) var openingDocumentId: String?

    var sheet: PatientCareSheet?
    /// Milestone awaiting the "complete" confirmation (with an optional note).
    var milestoneToComplete: MilestoneItem?
    var milestoneNote = ""
    /// S5: the actual filing date for the milestone being completed (defaults to today).
    var milestoneEffectiveDate = Date()
    /// Local (file-protected) copy of a document being previewed with QuickLook.
    var previewURL: URL?
    var errorMessage: String?

    private let functions = FunctionsClient()

    init(orgId: String, patientId: String) {
        self.orgId = orgId
        self.patientId = patientId
    }

    // MARK: Listeners

    func runVisits() async {
        do {
            for try await list in VisitRepository(orgId: orgId).visits(patientId: patientId) {
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
            for try await list in TaskRepository(orgId: orgId).tasks(patientId: patientId) {
                tasks = list
                tasksLoaded = true
            }
        } catch {
            tasksLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runDocuments() async {
        do {
            for try await list in PatientDocumentRepository(orgId: orgId).documents(patientId: patientId) {
                documents = list
                documentsLoaded = true
            }
        } catch {
            documentsLoaded = true
            errorMessage = error.userMessage
        }
    }

    func runEvents() async {
        do {
            for try await list in PatientEventRepository(orgId: orgId).events(patientId: patientId) {
                events = list
                eventsLoaded = true
            }
        } catch {
            eventsLoaded = true
            errorMessage = error.userMessage
        }
    }

    // MARK: Derived lists

    /// Scheduled visits, soonest first.
    var scheduledVisits: [Visit] {
        visits
            .filter { $0.visitStatus == .scheduled }
            .sorted { ($0.scheduledStart ?? .distantFuture) < ($1.scheduledStart ?? .distantFuture) }
    }

    /// Completed, missed and cancelled visits, newest first.
    var pastVisits: [Visit] {
        visits
            .filter { $0.visitStatus != .scheduled }
            .sorted { ($0.scheduledStart ?? .distantPast) > ($1.scheduledStart ?? .distantPast) }
    }

    /// Open tasks by due date (undated last), then priority.
    var openTasks: [CareTask] {
        tasks
            .filter { $0.taskStatus == .open }
            .sorted { lhs, rhs in
                let l = lhs.dueDate ?? "9999-12-31"
                let r = rhs.dueDate ?? "9999-12-31"
                if l != r { return l < r }
                return lhs.taskPriority.severity > rhs.taskPriority.severity
            }
    }

    /// Done / cancelled tasks, most recently updated first.
    var closedTasks: [CareTask] {
        tasks
            .filter { $0.taskStatus != .open }
            .sorted { ($0.completedAt ?? $0.updatedAt ?? .distantPast) > ($1.completedAt ?? $1.updatedAt ?? .distantPast) }
    }

    /// Newest effective date first; ties broken by record time.
    var sortedEvents: [PatientEvent] {
        events.sorted { lhs, rhs in
            let l = lhs.date ?? ""
            let r = rhs.date ?? ""
            if l != r { return l > r }
            return (lhs.createdAt ?? .distantPast) > (rhs.createdAt ?? .distantPast)
        }
    }

    // MARK: Milestones

    func requestComplete(_ item: MilestoneItem) {
        milestoneNote = ""
        milestoneEffectiveDate = Date()
        milestoneToComplete = item
    }

    func completeMilestone(_ item: MilestoneItem, note: String, effectiveDate: Date) async {
        let key = item.completionKey
        guard workingMilestoneKey == nil else { return }
        workingMilestoneKey = key
        defer { workingMilestoneKey = nil }
        do {
            try await functions.completeMilestone(orgId: orgId, patientId: patientId, key: key, note: note,
                                                  effectiveDate: ISODate.string(from: min(effectiveDate, Date())))
        } catch {
            errorMessage = error.userMessage
        }
    }

    func reopenMilestone(_ item: MilestoneItem, reason: String? = nil) async {
        let key = item.completionKey
        guard workingMilestoneKey == nil else { return }
        workingMilestoneKey = key
        defer { workingMilestoneKey = nil }
        do {
            try await functions.reopenMilestone(orgId: orgId, patientId: patientId, key: key, reason: reason)
        } catch {
            errorMessage = error.userMessage
        }
    }

    // MARK: Tasks

    func setStatus(_ task: CareTask, _ status: TaskStatus) async {
        guard let id = task.id, workingTaskId == nil else { return }
        workingTaskId = id
        defer { workingTaskId = nil }
        do {
            try await functions.updateTaskStatus(orgId: orgId, taskId: id, status: status)
        } catch {
            errorMessage = error.userMessage
        }
    }

    // MARK: Documents

    func open(_ document: PatientDocument) async {
        guard openingDocumentId == nil, let id = document.id, let path = document.storagePath?.nilIfBlank else { return }
        openingDocumentId = id
        defer { openingDocumentId = nil }
        do {
            previewURL = try await SecureDownload.fetchToTemporaryFile(
                storagePath: path,
                fileName: document.fileName?.nilIfBlank ?? document.displayName,
                contentType: document.mimeType
            )
        } catch {
            errorMessage = "Couldn't open \(document.displayName): \(error.userMessage)"
        }
    }

    static func removeTemporaryFile(_ url: URL?) {
        SecureDownload.remove(url)
    }
}
