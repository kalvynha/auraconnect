import Foundation
import FirebaseFirestore

/// v4 self-written channel documents (docs/DATA_MODEL.md "v4: messaging", Access). Each write
/// uses exactly the keys the rules allow, with `request.time` server timestamps.
struct ChannelExtrasRepository {
    let orgId: String

    private func channel(_ channelId: String) -> DocumentReference {
        FirebaseService.orgRef(orgId).collection("channels").document(channelId)
    }

    // MARK: Per-channel notification prefs

    func prefs(channelId: String, uid: String) -> AsyncThrowingStream<ChannelPrefs?, Error> {
        channel(channelId).collection("prefs").document(uid)
            .decodedStream(ChannelPrefs.self, serverTimestamps: .estimate)
    }

    /// Rules require exactly `{mode, mutedUntil, updatedAt == request.time}` (caller must be a member).
    func setPrefs(channelId: String, uid: String, mode: ChannelNotifyMode, mutedUntil: Date?,
                  onError: (@MainActor (Error) -> Void)? = nil) {
        let data: [String: Any] = [
            "mode": mode.rawValue,
            "mutedUntil": orNull(mutedUntil.map { Timestamp(date: $0) }),
            "updatedAt": FieldValue.serverTimestamp(),
        ]
        channel(channelId).collection("prefs").document(uid).setData(data) { error in
            guard let error else { return }
            if let onError {
                Task { @MainActor in onError(error) }
            } else {
                print("[Chat] prefs write failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Broadcast acknowledgements

    func ack(channelId: String, uid: String) -> AsyncThrowingStream<BroadcastAck?, Error> {
        channel(channelId).collection("acks").document(uid)
            .decodedStream(BroadcastAck.self, serverTimestamps: .estimate)
    }

    /// Create only: exactly `{messageId, ackedAt == request.time}`; the channel must have `requireAck`.
    func acknowledge(channelId: String, uid: String, messageId: String,
                     onError: (@MainActor (Error) -> Void)? = nil) {
        channel(channelId).collection("acks").document(uid).setData([
            "messageId": messageId,
            "ackedAt": FieldValue.serverTimestamp(),
        ]) { error in
            guard let error else { return }
            if let onError {
                Task { @MainActor in onError(error) }
            } else {
                print("[Chat] ack write failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Reactions

    private func reaction(channelId: String, messageId: String, uid: String) -> DocumentReference {
        channel(channelId).collection("messages").document(messageId).collection("reactions").document(uid)
    }

    /// My reaction to a message (nil when none).
    func myReaction(channelId: String, messageId: String, uid: String) async throws -> String? {
        let snapshot = try await reaction(channelId: channelId, messageId: messageId, uid: uid).getDocument()
        guard snapshot.exists else { return nil }
        return try snapshot.data(as: Reaction.self).emoji
    }

    /// Exactly `{emoji in ALLOWED_REACTIONS, at == request.time}`; `emoji == nil` deletes my reaction.
    func setReaction(channelId: String, messageId: String, uid: String, emoji: String?,
                     onError: (@MainActor (Error) -> Void)? = nil) {
        let ref = reaction(channelId: channelId, messageId: messageId, uid: uid)
        let completion: (Error?) -> Void = { error in
            guard let error else { return }
            if let onError {
                Task { @MainActor in onError(error) }
            } else {
                print("[Chat] reaction write failed: \(error.localizedDescription)")
            }
        }
        if let emoji {
            ref.setData(["emoji": emoji, "at": FieldValue.serverTimestamp()], completion: completion)
        } else {
            ref.delete(completion: completion)
        }
    }

    // MARK: No-reply reminders (server-written, owner-readable)

    /// My pending reminders in a channel. Equality filters only (no composite index needed).
    func pendingReminders(channelId: String, uid: String) -> AsyncThrowingStream<[NoReplyReminder], Error> {
        FirebaseService.orgRef(orgId).collection("reminders")
            .whereField("ownerUid", isEqualTo: uid)
            .whereField("channelId", isEqualTo: channelId)
            .whereField("status", isEqualTo: NoReplyReminder.pendingStatus)
            .limit(to: 100)
            .decodedStream(NoReplyReminder.self)
    }
}
