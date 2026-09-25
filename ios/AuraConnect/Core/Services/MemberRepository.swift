import Foundation
import FirebaseFirestore

struct MemberRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("members")
    }

    func members() -> AsyncThrowingStream<[Member], Error> {
        collection.decodedStream(Member.self)
    }

    func org() -> AsyncThrowingStream<Org?, Error> {
        FirebaseService.orgRef(orgId).decodedStream(Org.self)
    }

    /// Self-service profile update. Rules allow only displayName (non-empty), phone, title and fcmTokens.
    func updateProfile(uid: String, displayName: String, phone: String?, title: String?) async throws {
        try await collection.document(uid).updateData([
            "displayName": displayName.trimmed,
            "phone": blankToNull(phone),
            "title": blankToNull(title),
        ])
    }

    /// Adds an FCM token, keeping at most 20 (the rules' cap) by dropping the oldest.
    func addFCMToken(uid: String, token: String, existing: [String]?) {
        let ref = collection.document(uid)
        let current = existing ?? []
        if current.contains(token) { return }
        if current.count >= 20 {
            let trimmed = Array(current.suffix(19)) + [token]
            ref.updateData(["fcmTokens": trimmed]) { error in
                if let error { print("[Push] Could not save FCM token: \(error.localizedDescription)") }
            }
        } else {
            ref.updateData(["fcmTokens": FieldValue.arrayUnion([token])]) { error in
                if let error { print("[Push] Could not save FCM token: \(error.localizedDescription)") }
            }
        }
    }

    func removeFCMToken(uid: String, token: String) async {
        do {
            try await collection.document(uid).updateData(["fcmTokens": FieldValue.arrayRemove([token])])
        } catch {
            print("[Push] Could not remove FCM token: \(error.localizedDescription)")
        }
    }
}
