import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/visits` — read-only for clients (mutations go through callables).
struct VisitRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("visits")
    }

    /// All visits for a patient. Equality filter only (no composite index); callers sort.
    func visits(patientId: String, limit: Int = 300) -> AsyncThrowingStream<[Visit], Error> {
        collection
            .whereField("patientId", isEqualTo: patientId)
            .limit(to: limit)
            .decodedStream(Visit.self)
    }

    /// Visits starting in `[start, end)`, soonest first (single-field index on `scheduledStart`).
    /// Callers filter by assignee client-side.
    func visits(from start: Date, to end: Date, limit: Int = 500) -> AsyncThrowingStream<[Visit], Error> {
        collection
            .whereField("scheduledStart", isGreaterThanOrEqualTo: Timestamp(date: start))
            .whereField("scheduledStart", isLessThan: Timestamp(date: end))
            .order(by: "scheduledStart")
            .limit(to: limit)
            .decodedStream(Visit.self)
    }
}
