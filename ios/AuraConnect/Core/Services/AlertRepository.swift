import Foundation
import FirebaseFirestore

struct AlertRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("alerts")
    }

    /// Rules require the `targetUids array-contains uid` filter on list queries (even for admins).
    /// Needs the composite index (targetUids array-contains, createdAt desc).
    func myAlerts(uid: String) -> AsyncThrowingStream<[AuraAlert], Error> {
        collection
            .whereField("targetUids", arrayContains: uid)
            .order(by: "createdAt", descending: true)
            .limit(to: 200)
            .decodedStream(AuraAlert.self)
    }

    func alert(id: String) -> AsyncThrowingStream<AuraAlert?, Error> {
        collection.document(id).decodedStream(AuraAlert.self)
    }
}
