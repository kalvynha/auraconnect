// Repositories wrap Firestore / Storage. Listeners are exposed as `AsyncThrowingStream`s
// (see `decodedStream` in FirebaseService.swift) that remove the Firestore listener when the
// consuming task is cancelled (e.g. SwiftUI `.task`). Paths and write shapes follow
// docs/DATA_MODEL.md and firestore.rules.

import Foundation
import FirebaseFirestore

struct ChannelRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("channels")
    }

    /// Channels I belong to, most recent activity first.
    /// Needs the composite index (memberUids array-contains, lastMessageAt desc).
    func myChannels(uid: String) -> AsyncThrowingStream<[Channel], Error> {
        collection
            .whereField("memberUids", arrayContains: uid)
            .order(by: "lastMessageAt", descending: true)
            .limit(to: 300)
            .decodedStream(Channel.self)
    }

    func channel(id: String) -> AsyncThrowingStream<Channel?, Error> {
        collection.document(id).decodedStream(Channel.self)
    }

    func readReceipt(channelId: String, uid: String) -> AsyncThrowingStream<ReadReceipt?, Error> {
        collection.document(channelId).collection("reads").document(uid)
            .decodedStream(ReadReceipt.self, serverTimestamps: .estimate)
    }

    /// All members' read receipts for a channel (document id == uid).
    func readReceipts(channelId: String) -> AsyncThrowingStream<[ReadReceipt], Error> {
        collection.document(channelId).collection("reads").decodedStream(ReadReceipt.self, serverTimestamps: .estimate)
    }

    /// Rules require exactly `{ lastReadAt: request.time }`.
    func markRead(channelId: String, uid: String) {
        collection.document(channelId).collection("reads").document(uid)
            .setData(["lastReadAt": FieldValue.serverTimestamp()]) { error in
                if let error { print("[Chat] markRead failed: \(error.localizedDescription)") }
            }
    }
}
