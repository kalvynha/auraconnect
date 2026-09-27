import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/tasks` — read-only for clients (mutations go through callables).
/// Queries use equality filters only, which Firestore serves by merging single-field
/// indexes (no composite index needed); callers sort client-side.
struct TaskRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("tasks")
    }

    /// Open tasks assigned to `uid`.
    func openTasks(assignedTo uid: String, limit: Int = 500) -> AsyncThrowingStream<[CareTask], Error> {
        collection
            .whereField("assigneeUid", isEqualTo: uid)
            .whereField("status", isEqualTo: TaskStatus.open.rawValue)
            .limit(to: limit)
            .decodedStream(CareTask.self)
    }

    /// Open, unassigned tasks for a discipline (anyone on the care team with it may pick them up).
    func openUnassignedTasks(discipline: Discipline, limit: Int = 500) -> AsyncThrowingStream<[CareTask], Error> {
        collection
            .whereField("assigneeUid", isEqualTo: NSNull())
            .whereField("discipline", isEqualTo: discipline.rawValue)
            .whereField("status", isEqualTo: TaskStatus.open.rawValue)
            .limit(to: limit)
            .decodedStream(CareTask.self)
    }

    /// Every task for a patient (open and closed).
    func tasks(patientId: String, limit: Int = 300) -> AsyncThrowingStream<[CareTask], Error> {
        collection
            .whereField("patientId", isEqualTo: patientId)
            .limit(to: limit)
            .decodedStream(CareTask.self)
    }
}
