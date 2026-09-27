import Foundation
import FirebaseFirestore

// Read-only listeners for v2 coordination collections. All writes go through callables
// (FunctionsClient+Comms). Queries use single-field ordering only, so no composite index is needed.

struct TriageRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("triageCalls")
    }

    /// Most recent calls first (open and resolved; callers split them).
    func recentCalls(limit: Int = 200) -> AsyncThrowingStream<[TriageCall], Error> {
        collection
            .order(by: "receivedAt", descending: true)
            .limit(to: limit)
            .decodedStream(TriageCall.self)
    }

    func call(id: String) -> AsyncThrowingStream<TriageCall?, Error> {
        collection.document(id).decodedStream(TriageCall.self)
    }

    /// `org.triageRoleKey` (v2 org setting; null/absent means the caller picks a role).
    func triageRoleKey() async -> String? {
        guard let snapshot = try? await FirebaseService.orgRef(orgId).getDocument() else { return nil }
        return (snapshot.data()?["triageRoleKey"] as? String)?.nilIfBlank
    }
}

struct IdgRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("idgMeetings")
    }

    /// Latest scheduled first.
    func meetings(limit: Int = 100) -> AsyncThrowingStream<[IdgMeeting], Error> {
        collection
            .order(by: "scheduledAt", descending: true)
            .limit(to: limit)
            .decodedStream(IdgMeeting.self)
    }

    func meeting(id: String) -> AsyncThrowingStream<IdgMeeting?, Error> {
        collection.document(id).decodedStream(IdgMeeting.self)
    }
}

struct MetricsRepository {
    let orgId: String

    /// The most recent `metrics/{YYYY-MM-DD}` document (admin read).
    func latest() -> AsyncThrowingStream<[DailyMetrics], Error> {
        FirebaseService.orgRef(orgId).collection("metrics")
            .order(by: "date", descending: true)
            .limit(to: 1)
            .decodedStream(DailyMetrics.self)
    }
}
