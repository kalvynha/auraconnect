import Foundation
import FirebaseFirestore

struct TeamRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("teams")
    }

    /// Readable by any active member; sorted client-side by name.
    func teams() -> AsyncThrowingStream<[Team], Error> {
        collection.decodedStream(Team.self)
    }
}
