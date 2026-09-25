import Foundation

/// Pure messaging rules from docs/DATA_MODEL.md ("Messaging flow").
enum ChannelLogic {
    /// Direct channel ids are `dm_{minUid}_{maxUid}`.
    static func directChannelId(_ a: String, _ b: String) -> String {
        let sorted = [a, b].sorted()
        return "dm_\(sorted[0])_\(sorted[1])"
    }

    /// A channel is unread when its last message is newer than my `lastReadAt`
    /// and I did not send it. Channels with no messages are never unread.
    static func isUnread(lastMessageAt: Date?, lastSenderUid: String?, lastReadAt: Date?, myUid: String) -> Bool {
        guard let lastMessageAt else { return false }
        if lastSenderUid == myUid { return false }
        guard let lastReadAt else { return true }
        return lastMessageAt > lastReadAt
    }

    static func isUnread(_ channel: Channel, lastReadAt: Date?, myUid: String) -> Bool {
        guard let last = channel.lastMessage else { return false }
        return isUnread(lastMessageAt: last.at ?? channel.lastMessageAt,
                        lastSenderUid: last.senderUid,
                        lastReadAt: lastReadAt,
                        myUid: myUid)
    }

    /// Members (other than the sender) whose read receipt is at or after `messageDate`.
    static func readers(of messageDate: Date?, senderUid: String, reads: [String: Date]) -> [String] {
        guard let messageDate else { return [] }
        return reads
            .filter { uid, readAt in uid != senderUid && readAt >= messageDate }
            .map { $0.key }
            .sorted()
    }
}
