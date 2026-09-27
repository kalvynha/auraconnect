import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/bereavementPlans` — read-only for clients (mutations go through callables).
/// Staff only: the rules deny volunteers, so callers must not subscribe for them.
struct BereavementRepository {
    let orgId: String

    /// About 450 active plans at a census of 100; the cap keeps the listener bounded.
    static let activeLimit = 1000
    static let closedPageSize = 50

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("bereavementPlans")
    }

    /// Active plans. Equality filter only; callers sort.
    func activePlans(limit: Int = BereavementRepository.activeLimit) -> AsyncThrowingStream<[BereavementPlan], Error> {
        collection
            .whereField("status", isEqualTo: BereavementPlanStatus.active.rawValue)
            .limit(to: limit)
            .decodedStream(BereavementPlan.self)
    }

    /// Closed plans, most recent death first, paged by growing `limit`.
    /// Composite index: bereavementPlans (status ASC, deathDate DESC).
    func closedPlans(limit: Int) -> AsyncThrowingStream<[BereavementPlan], Error> {
        collection
            .whereField("status", isEqualTo: BereavementPlanStatus.closed.rawValue)
            .order(by: "deathDate", descending: true)
            .limit(to: limit)
            .decodedStream(BereavementPlan.self)
    }

    func plan(id: String) -> AsyncThrowingStream<BereavementPlan?, Error> {
        collection.document(id).decodedStream(BereavementPlan.self)
    }
}

extension OrgStore {
    /// Admin, the `bereavement` capability, or an SW / Chaplain: may work every plan
    /// (mirrors `canWorkAllBereavementPlans` in functions/src/domain/bereavement.ts).
    var canWorkAllBereavementPlans: Bool {
        if role == .admin { return true }
        guard let me else { return false }
        return me.has(capability: "bereavement") || me.discipline == .sw || me.discipline == .chaplain
    }

    /// May the caller change `plan` (all-plans access, or the plan's coordinator)?
    func canWorkBereavementPlan(_ plan: BereavementPlan) -> Bool {
        canWorkAllBereavementPlans || (plan.assignedUid != nil && plan.assignedUid == uid)
    }
}
