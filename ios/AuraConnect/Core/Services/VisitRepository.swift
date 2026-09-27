import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/visits` — read-only for clients (mutations go through callables).
struct VisitRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("visits")
    }

    /// A patient's visits, newest `scheduledStart` first, so the limit drops the oldest ones
    /// (callers re-sort). Composite index: visits (patientId ASC, scheduledStart DESC).
    func visits(patientId: String, limit: Int = 300) -> AsyncThrowingStream<[Visit], Error> {
        collection
            .whereField("patientId", isEqualTo: patientId)
            .order(by: "scheduledStart", descending: true)
            .limit(to: limit)
            .decodedStream(Visit.self)
    }

    /// One-shot read of a patient's most recent visits (newest first), e.g. for the last visit note.
    /// Same index as `visits(patientId:)`.
    func fetchRecentVisits(patientId: String, limit: Int = 10) async throws -> [Visit] {
        let snapshot = try await collection
            .whereField("patientId", isEqualTo: patientId)
            .order(by: "scheduledStart", descending: true)
            .limit(to: limit)
            .getDocuments()
        return snapshot.documents.compactMap { try? $0.data(as: Visit.self) }
    }

    /// A single visit.
    func visit(id: String) -> AsyncThrowingStream<Visit?, Error> {
        collection.document(id).decodedStream(Visit.self)
    }

    /// Visits assigned to `uid` starting in `[start, end)`, soonest first.
    /// Composite index: visits (assignedUid ASC, scheduledStart ASC).
    func visits(assignedTo uid: String, from start: Date, to end: Date, limit: Int = 500) -> AsyncThrowingStream<[Visit], Error> {
        collection
            .whereField("assignedUid", isEqualTo: uid)
            .whereField("scheduledStart", isGreaterThanOrEqualTo: Timestamp(date: start))
            .whereField("scheduledStart", isLessThan: Timestamp(date: end))
            .order(by: "scheduledStart")
            .limit(to: limit)
            .decodedStream(Visit.self)
    }

    /// Visits starting in `[start, end)` for the whole org, soonest first (single-field index on
    /// `scheduledStart`). At ~900 visits/week the limit truncates a 7-day range; prefer
    /// `visits(assignedTo:from:to:)` for per-user lists.
    func visits(from start: Date, to end: Date, limit: Int = 500) -> AsyncThrowingStream<[Visit], Error> {
        collection
            .whereField("scheduledStart", isGreaterThanOrEqualTo: Timestamp(date: start))
            .whereField("scheduledStart", isLessThan: Timestamp(date: end))
            .order(by: "scheduledStart")
            .limit(to: limit)
            .decodedStream(Visit.self)
    }
}
