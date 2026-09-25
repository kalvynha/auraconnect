import Foundation
import Observation

@MainActor
@Observable
final class InboxViewModel {
    let orgId: String
    let uid: String

    private(set) var channels: [Channel] = []
    /// My `reads/{uid}.lastReadAt` per channel id.
    private(set) var lastRead: [String: Date] = [:]
    /// Channels whose read receipt has loaded at least once (avoids a flash of "unread").
    private(set) var readLoaded: Set<String> = []
    private(set) var isLoading = true
    var errorMessage: String?

    @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    private var repository: ChannelRepository { ChannelRepository(orgId: orgId) }

    func run() async {
        defer { stopReadListeners() }
        do {
            for try await items in repository.myChannels(uid: uid) {
                channels = items.filter { $0.archived != true }
                isLoading = false
                errorMessage = nil
                syncReadListeners()
            }
        } catch {
            errorMessage = error.userMessage
            isLoading = false
        }
    }

    func isUnread(_ channel: Channel) -> Bool {
        guard let id = channel.id, readLoaded.contains(id) else { return false }
        return ChannelLogic.isUnread(channel, lastReadAt: lastRead[id], myUid: uid)
    }

    var unreadCount: Int { channels.filter { isUnread($0) }.count }

    /// One document listener per channel for my read receipt.
    private func syncReadListeners() {
        let ids = Set(channels.compactMap { $0.id })
        for (id, task) in readTasks where !ids.contains(id) {
            task.cancel()
            readTasks[id] = nil
        }
        for id in ids where readTasks[id] == nil {
            let stream = repository.readReceipt(channelId: id, uid: uid)
            readTasks[id] = Task { [weak self] in
                do {
                    for try await receipt in stream {
                        self?.lastRead[id] = receipt?.lastReadAt
                        self?.readLoaded.insert(id)
                    }
                } catch {
                    self?.readLoaded.insert(id)
                }
            }
        }
    }

    private func stopReadListeners() {
        for task in readTasks.values { task.cancel() }
        readTasks = [:]
    }
}
