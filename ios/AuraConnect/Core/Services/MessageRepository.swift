import Foundation
import FirebaseFirestore
import FirebaseStorage

/// One snapshot of a channel's messages plus which of them are still local-only
/// (`hasPendingWrites`, e.g. sent while offline).
struct MessageSnapshot {
    /// Newest first.
    var messages: [Message]
    var pendingIds: Set<String>
}

struct MessageRepository {
    let orgId: String

    private func messages(_ channelId: String) -> CollectionReference {
        FirebaseService.orgRef(orgId).collection("channels").document(channelId).collection("messages")
    }

    /// The newest `limit` messages, newest first (callers reverse for display).
    /// Pending server timestamps are estimated so locally-sent messages sort correctly.
    func recentMessages(channelId: String, limit: Int = 200) -> AsyncThrowingStream<[Message], Error> {
        messages(channelId)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .decodedStream(Message.self, serverTimestamps: .estimate)
    }

    /// Like `recentMessages`, but also reports which messages have not reached the server yet.
    /// Listens with metadata changes so a message flips from pending to sent when it syncs.
    func recentMessagesWithPending(channelId: String, limit: Int = 200) -> AsyncThrowingStream<MessageSnapshot, Error> {
        let query = messages(channelId)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
        return AsyncThrowingStream { continuation in
            let registration = query.addSnapshotListener(includeMetadataChanges: true) { snapshot, error in
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                guard let snapshot else { return }
                var items: [Message] = []
                var pending: Set<String> = []
                items.reserveCapacity(snapshot.documents.count)
                for document in snapshot.documents {
                    do {
                        items.append(try document.data(as: Message.self, with: .estimate))
                        if document.metadata.hasPendingWrites {
                            pending.insert(document.documentID)
                        }
                    } catch {
                        #if DEBUG
                        print("[Firestore] Skipping \(document.reference.path): \(error)")
                        #endif
                    }
                }
                continuation.yield(MessageSnapshot(messages: items, pendingIds: pending))
            }
            continuation.onTermination = { _ in
                registration.remove()
            }
        }
    }

    /// A single message (e.g. a thread's parent), with pending timestamps estimated.
    func message(channelId: String, messageId: String) -> AsyncThrowingStream<Message?, Error> {
        messages(channelId).document(messageId).decodedStream(Message.self, serverTimestamps: .estimate)
    }

    /// Replies in a thread. Equality filter only (no composite index); callers sort by `createdAt`.
    func threadReplies(channelId: String, parentId: String, limit: Int = 500) -> AsyncThrowingStream<[Message], Error> {
        messages(channelId)
            .whereField("threadParentId", isEqualTo: parentId)
            .limit(to: limit)
            .decodedStream(Message.self, serverTimestamps: .estimate)
    }

    /// Writes a message directly (works offline; appears instantly via latency compensation).
    /// Shape must match firestore.rules exactly: 8 keys, explicit nulls, server timestamp,
    /// plus `threadParentId` for thread replies only.
    /// `onError` runs on the main actor if the server rejects the write (the local copy is
    /// then rolled back by Firestore, so callers should keep the content for a retry).
    @discardableResult
    func send(
        channelId: String,
        senderUid: String,
        senderName: String,
        body: String,
        priority: Priority,
        attachments: [Attachment],
        threadParentId: String? = nil,
        onError: (@MainActor (Error) -> Void)? = nil
    ) -> String {
        let ref = messages(channelId).document()
        var data: [String: Any] = [
            "senderUid": senderUid,
            "senderName": senderName,
            "body": body,
            "priority": priority.rawValue,
            "attachments": attachments.map { $0.firestoreData },
            "roleTarget": NSNull(),
            "createdAt": FieldValue.serverTimestamp(),
            "alertId": NSNull(),
        ]
        if let threadParentId = threadParentId?.nilIfBlank {
            data["threadParentId"] = threadParentId
        }
        ref.setData(data) { error in
            guard let error else { return }
            if let onError {
                Task { @MainActor in onError(error) }
            } else {
                print("[Chat] send failed: \(error.localizedDescription)")
            }
        }
        return ref.documentID
    }

    /// Uploads to `orgs/{orgId}/channels/{channelId}/attachments/{uuid}-{name}` (create-only path).
    func uploadAttachment(channelId: String, data: Data, fileName: String, contentType: String) async throws -> Attachment {
        let safeName = Self.sanitizedFileName(fileName)
        let path = "orgs/\(orgId)/channels/\(channelId)/attachments/\(UUID().uuidString.lowercased())-\(safeName)"
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        _ = try await FirebaseService.storage.reference(withPath: path).putDataAsync(data, metadata: metadata)
        return Attachment(storagePath: path, contentType: contentType, name: safeName, size: data.count)
    }

    static func sanitizedFileName(_ name: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let mapped = name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        let result = String(mapped).trimmingCharacters(in: CharacterSet(charactersIn: "._"))
        let trimmed = String(result.suffix(100))
        return trimmed.isEmpty ? "file" : trimmed
    }
}
