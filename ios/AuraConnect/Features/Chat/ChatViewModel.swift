import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    let orgId: String
    let channelId: String
    let uid: String

    private(set) var channel: Channel?
    private(set) var channelMissing = false
    /// Oldest first, at most the newest 200.
    private(set) var messages: [Message] = []
    /// Read receipts by uid.
    private(set) var reads: [String: Date] = [:]
    private(set) var isLoading = true

    var draft = ""
    var priority: Priority = .normal
    private(set) var pendingAttachments: [Attachment] = []
    private(set) var isUploading = false
    /// Storage path of the attachment currently being downloaded.
    private(set) var openingAttachmentPath: String?
    /// Local (file-protected) copy of an attachment being previewed with QuickLook.
    var previewURL: URL?
    var errorMessage: String?

    @ObservationIgnored private var isVisible = false
    @ObservationIgnored private var lastMarkedMessageId: String?

    init(orgId: String, channelId: String, uid: String) {
        self.orgId = orgId
        self.channelId = channelId
        self.uid = uid
    }

    private var channelRepository: ChannelRepository { ChannelRepository(orgId: orgId) }
    private var messageRepository: MessageRepository { MessageRepository(orgId: orgId) }

    var canSend: Bool {
        let body = draft.trimmed
        return (!body.isEmpty || !pendingAttachments.isEmpty)
            && body.count <= AppConfig.maxMessageLength
            && !isUploading
    }

    // MARK: Listeners

    func runChannel() async {
        do {
            for try await value in channelRepository.channel(id: channelId) {
                channel = value
                channelMissing = value == nil
            }
        } catch {
            channelMissing = channel == nil
            errorMessage = error.userMessage
        }
    }

    func runMessages() async {
        do {
            for try await newestFirst in messageRepository.recentMessages(channelId: channelId, limit: 200) {
                messages = Array(newestFirst.reversed())
                isLoading = false
                markReadIfNeeded()
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    func runReads() async {
        do {
            for try await receipts in channelRepository.readReceipts(channelId: channelId) {
                var map: [String: Date] = [:]
                for receipt in receipts {
                    if let id = receipt.id, let date = receipt.lastReadAt { map[id] = date }
                }
                reads = map
            }
        } catch {
            // Read receipts are informational; ignore failures.
        }
    }

    // MARK: Read state

    func setVisible(_ visible: Bool) {
        isVisible = visible
        if visible { markReadIfNeeded(force: true) }
    }

    /// Writes `reads/{uid}.lastReadAt` when the chat is on screen and a new message arrived.
    private func markReadIfNeeded(force: Bool = false) {
        guard isVisible, let latest = messages.last else { return }
        if !force && latest.id == lastMarkedMessageId { return }
        lastMarkedMessageId = latest.id
        channelRepository.markRead(channelId: channelId, uid: uid)
    }

    /// Names of members who have read my most recent message.
    func readersOfMyLastMessage() -> (messageId: String, readers: [String])? {
        guard let mine = messages.last(where: { $0.senderUid == uid }), let id = mine.id else { return nil }
        return (id, ChannelLogic.readers(of: mine.createdAt, senderUid: uid, reads: reads))
    }

    // MARK: Sending

    func send(senderName: String) {
        let body = draft.trimmed
        guard canSend else { return }
        messageRepository.send(
            channelId: channelId,
            senderUid: uid,
            senderName: senderName,
            body: body,
            priority: priority,
            attachments: pendingAttachments
        )
        draft = ""
        priority = .normal
        pendingAttachments = []
    }

    func attach(data: Data, fileName: String, contentType: String) async {
        guard data.count < AppConfig.maxUploadBytes else {
            errorMessage = "Attachments must be smaller than 25 MB."
            return
        }
        guard pendingAttachments.count < 10 else {
            errorMessage = "A message can have at most 10 attachments."
            return
        }
        isUploading = true
        defer { isUploading = false }
        do {
            let attachment = try await messageRepository.uploadAttachment(
                channelId: channelId, data: data, fileName: fileName, contentType: contentType
            )
            pendingAttachments.append(attachment)
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// Removes an attachment from the draft. (Storage objects are create-only for clients,
    /// so the uploaded file itself stays until a server-side cleanup removes it.)
    func removePending(_ attachment: Attachment) {
        pendingAttachments.removeAll { $0.storagePath == attachment.storagePath }
    }

    // MARK: Viewing attachments

    func open(_ attachment: Attachment) async {
        guard openingAttachmentPath == nil else { return }
        openingAttachmentPath = attachment.storagePath
        defer { openingAttachmentPath = nil }
        do {
            previewURL = try await SecureDownload.fetchToTemporaryFile(
                storagePath: attachment.storagePath,
                fileName: attachment.name,
                contentType: attachment.contentType
            )
        } catch {
            errorMessage = "Couldn't open \(attachment.name): \(error.userMessage)"
        }
    }

    static func removeTemporaryFile(_ url: URL?) {
        SecureDownload.remove(url)
    }
}
