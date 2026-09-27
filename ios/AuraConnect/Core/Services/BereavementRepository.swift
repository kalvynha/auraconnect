import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/bereavementPlans` — read-only for clients (mutations go through callables).
struct BereavementRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("bereavementPlans")
    }

    /// Active plans. Equality filter only; callers sort.
    func activePlans(limit: Int = 300) -> AsyncThrowingStream<[BereavementPlan], Error> {
        collection
            .whereField("status", isEqualTo: BereavementPlanStatus.active.rawValue)
            .limit(to: limit)
            .decodedStream(BereavementPlan.self)
    }

    func plan(id: String) -> AsyncThrowingStream<BereavementPlan?, Error> {
        collection.document(id).decodedStream(BereavementPlan.self)
    }
}
