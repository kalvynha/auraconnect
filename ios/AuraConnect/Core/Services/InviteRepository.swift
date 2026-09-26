import Foundation
import FirebaseFirestore

struct InviteRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("invites")
    }

    /// Admin-only (rules). Needs the composite index (status asc, createdAt desc).
    func pendingInvites() -> AsyncThrowingStream<[Invite], Error> {
        collection
            .whereField("status", isEqualTo: Invite.pendingStatus)
            .order(by: "createdAt", descending: true)
            .limit(to: 200)
            .decodedStream(Invite.self)
    }
}
