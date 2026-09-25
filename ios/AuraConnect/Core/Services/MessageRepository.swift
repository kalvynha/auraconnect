import Foundation
import FirebaseFirestore
import FirebaseStorage

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

    /// Writes a message directly (works offline; appears instantly via latency compensation).
    /// Shape must match firestore.rules exactly: 8 keys, explicit nulls, server timestamp.
    @discardableResult
    func send(
        channelId: String,
        senderUid: String,
        senderName: String,
        body: String,
        priority: Priority,
        attachments: [Attachment]
    ) -> String {
        let ref = messages(channelId).document()
        let data: [String: Any] = [
            "senderUid": senderUid,
            "senderName": senderName,
            "body": body,
            "priority": priority.rawValue,
            "attachments": attachments.map { $0.firestoreData },
            "roleTarget": NSNull(),
            "createdAt": FieldValue.serverTimestamp(),
            "alertId": NSNull(),
        ]
        ref.setData(data) { error in
            if let error { print("[Chat] send failed: \(error.localizedDescription)") }
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
