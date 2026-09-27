import Foundation
import Observation
import FirebaseFirestore

/// A message the server rejected. Firestore rolls back the local copy, so the content is kept
/// here to show a "Not sent" bubble with Retry / Delete.
struct FailedMessage: Identifiable {
    let id = UUID()
    let body: String
    let priority: Priority
    let attachments: [Attachment]
    let failedAt: Date
    let reason: String
}

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
    /// Ids of my messages that are only in the local cache so far (e.g. sent offline).
    private(set) var pendingMessageIds: Set<String> = []
    /// Messages the server rejected, oldest first.
    private(set) var failedMessages: [FailedMessage] = []
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
    /// Id of the message currently being recalled.
    private(set) var recallingMessageId: String?
    /// O2: ids of open alerts that target me (the Acknowledge button shows on their messages).
    private(set) var openAlertIdsForMe: Set<String> = []
    private(set) var acknowledgingAlertId: String?
    /// O5: the patient whose care-team channel this is, when I can't read the channel.
    private(set) var coveragePatient: (id: String, name: String)?
    private(set) var isJoiningCoverage = false
    private(set) var coverageUntil: Date?
    /// Bumped after joining for coverage so the listeners (which failed on permission) restart.
    private(set) var listenerGeneration = 0

    @ObservationIgnored private var isVisible = false
    @ObservationIgnored private var lastMarkedMessageId: String?

    init(orgId: String, channelId: String, uid: String) {
        self.orgId = orgId
        self.channelId = channelId
        self.uid = uid
    }

    private var channelRepository: ChannelRepository { ChannelRepository(orgId: orgId) }
    private var messageRepository: MessageRepository { MessageRepository(orgId: orgId) }

    /// The channel timeline: thread replies are hidden (their parents show a "N replies" chip).
    var timeline: [Message] { messages.filter { !$0.isThreadReply } }

    /// Viewers never post; archived channels accept nothing; in a broadcast channel only the creator posts.
    func canPost(role: Role) -> Bool {
        guard role.canSendMessages, let channel, channel.archived != true else { return false }
        if channel.isBroadcast { return channel.createdBy == uid }
        return true
    }

    /// The sender or an admin may recall a message that reached the server.
    func canRecall(_ message: Message, isAdmin: Bool) -> Bool {
        guard message.id != nil, !message.isRecalled else { return false }
        return message.senderUid == uid || isAdmin
    }

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
                if value != nil { coveragePatient = nil }
            }
        } catch {
            channelMissing = channel == nil
            if channelMissing {
                // Not a member: offer on-call coverage access if this is a patient care-team channel.
                await lookUpCoveragePatient()
                if coveragePatient == nil && !Self.isPermissionDenied(error) { errorMessage = error.userMessage }
            } else {
                errorMessage = error.userMessage
            }
        }
    }

    // MARK: O5 on-call coverage

    /// Finds the patient whose care-team channel this is (staff can read patients; the channel
    /// itself is readable only by members).
    private func lookUpCoveragePatient() async {
        do {
            let snapshot = try await FirebaseService.orgRef(orgId).collection("patients")
                .whereField("channelId", isEqualTo: channelId)
                .limit(to: 1)
                .getDocuments()
            guard let document = snapshot.documents.first,
                  let patient = try? document.data(as: Patient.self) else { return }
            let name = [patient.lastName?.nilIfBlank, patient.firstName?.nilIfBlank].compactMap { $0 }.joined(separator: ", ")
            coveragePatient = (document.documentID, name.isEmpty ? "this patient" : name)
        } catch {
            // Volunteers and others without patient access simply see "unavailable".
        }
    }

    /// Joins the care-team channel until the end of my on-call shift. The server checks the shift
    /// (or admin) and audits the access with `reason`.
    @discardableResult
    func joinForCoverage(reason: String) async -> Bool {
        guard let patient = coveragePatient, !isJoiningCoverage else { return false }
        isJoiningCoverage = true
        defer { isJoiningCoverage = false }
        do {
            let result = try await FunctionsClient().joinPatientChannelForCoverage(orgId: orgId, patientId: patient.id, reason: reason)
            coverageUntil = result.until
            channelMissing = false
            isLoading = true
            listenerGeneration += 1
            return true
        } catch {
            errorMessage = error.userMessage
            return false
        }
    }

    // MARK: O2 acknowledge from chat

    /// My open alerts (bounded: open, targeting me); messages whose `alertId` is in the set show Acknowledge.
    func runMyOpenAlerts() async {
        let query = FirebaseService.orgRef(orgId).collection("alerts")
            .whereField("targetUids", arrayContains: uid)
            .whereField("status", isEqualTo: "open")
            .limit(to: 100)
        do {
            for try await alerts in query.decodedStream(AuraAlert.self) {
                openAlertIdsForMe = Set(alerts.filter { $0.source?.channelId == channelId }.compactMap { $0.id })
            }
        } catch {
            openAlertIdsForMe = []
        }
    }

    func canAcknowledge(_ message: Message) -> Bool {
        guard let alertId = message.alertId, !message.isRecalled, message.messagePriority != .normal,
              message.senderUid != uid else { return false }
        return openAlertIdsForMe.contains(alertId)
    }

    func acknowledge(_ message: Message) async {
        guard let alertId = message.alertId, acknowledgingAlertId == nil else { return }
        acknowledgingAlertId = alertId
        defer { acknowledgingAlertId = nil }
        do {
            try await FunctionsClient().ackAlert(orgId: orgId, alertId: alertId)
            openAlertIdsForMe.remove(alertId)
        } catch {
            errorMessage = error.userMessage
        }
    }

    func runMessages() async {
        do {
            for try await snapshot in messageRepository.recentMessagesWithPending(channelId: channelId, limit: 200) {
                messages = Array(snapshot.messages.reversed())
                pendingMessageIds = snapshot.pendingIds
                isLoading = false
                markReadIfNeeded()
            }
        } catch {
            isLoading = false
            // Not a member: the channel listener handles it (and may offer coverage access).
            if !Self.isPermissionDenied(error) { errorMessage = error.userMessage }
        }
    }

    static func isPermissionDenied(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == FirestoreErrorDomain && nsError.code == FirestoreErrorCode.permissionDenied.rawValue
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
        guard let mine = timeline.last(where: { $0.senderUid == uid }), let id = mine.id else { return nil }
        return (id, ChannelLogic.readers(of: mine.createdAt, senderUid: uid, reads: reads))
    }

    // MARK: Sending

    func send(senderName: String) {
        let body = draft.trimmed
        guard canSend else { return }
        write(body: body, priority: priority, attachments: pendingAttachments, senderName: senderName)
        draft = ""
        priority = .normal
        pendingAttachments = []
    }

    func isPending(_ message: Message) -> Bool {
        guard let id = message.id else { return false }
        return pendingMessageIds.contains(id)
    }

    /// Sends a rejected message again (as a new document).
    func retry(_ failed: FailedMessage, senderName: String) {
        failedMessages.removeAll { $0.id == failed.id }
        write(body: failed.body, priority: failed.priority, attachments: failed.attachments, senderName: senderName)
    }

    func discard(_ failed: FailedMessage) {
        failedMessages.removeAll { $0.id == failed.id }
    }

    private func write(body: String, priority: Priority, attachments: [Attachment], senderName: String) {
        messageRepository.send(
            channelId: channelId,
            senderUid: uid,
            senderName: senderName,
            body: body,
            priority: priority,
            attachments: attachments,
            onError: { [weak self] error in
                self?.failedMessages.append(FailedMessage(body: body, priority: priority, attachments: attachments,
                                                          failedAt: Date(), reason: error.userMessage))
            }
        )
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

    // MARK: Recall

    func recall(_ message: Message) async {
        guard let messageId = message.id, recallingMessageId == nil else { return }
        recallingMessageId = messageId
        defer { recallingMessageId = nil }
        do {
            try await FunctionsClient().recallMessage(orgId: orgId, channelId: channelId, messageId: messageId)
        } catch {
            errorMessage = error.userMessage
        }
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
