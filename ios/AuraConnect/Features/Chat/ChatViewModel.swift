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

/// A one-tap reply offered on urgent/critical messages.
struct QuickReply: Identifiable, Hashable {
    let text: String
    /// Set for org `quick_reply` templates (sent with the `[[tpl:{id}]]` marker).
    let templateId: String?
    var id: String { (templateId ?? "default") + ":" + text }
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

    // v4 messaging
    /// Org templates (staff-readable) and my personal templates.
    private(set) var orgTemplates: [MessageTemplate] = []
    private(set) var personalTemplates: [MessageTemplate] = []
    /// Template the current draft came from; sent as a leading `[[tpl:{id}]]` marker.
    private(set) var appliedTemplateId: String?
    private(set) var onCallRoles: [OnCallRole] = []
    /// The patient of a patient channel (template placeholders and the info sheet header).
    private(set) var patient: Patient?
    /// My per-channel notification prefs (nil = defaults).
    private(set) var prefs: ChannelPrefs?
    /// My acknowledgement of an ack-required broadcast.
    private(set) var myAck: BroadcastAck?
    private(set) var isAckingBroadcast = false
    /// My reaction per message id (loaded for messages that have reactions, updated when I react).
    private(set) var myReactions: [String: String] = [:]
    /// My pending "remind me if no reply" reminders in this channel.
    private(set) var reminders: [NoReplyReminder] = []
    private(set) var pinningMessageId: String?
    /// Short confirmation shown briefly above the composer.
    var notice: String?

    @ObservationIgnored private var isVisible = false
    @ObservationIgnored private var lastMarkedMessageId: String?
    /// "messageId:totalReactions" keys already fetched for `myReactions`.
    @ObservationIgnored private var loadedReactionKeys: Set<String> = []

    init(orgId: String, channelId: String, uid: String) {
        self.orgId = orgId
        self.channelId = channelId
        self.uid = uid
    }

    private var channelRepository: ChannelRepository { ChannelRepository(orgId: orgId) }
    private var messageRepository: MessageRepository { MessageRepository(orgId: orgId) }
    private var extrasRepository: ChannelExtrasRepository { ChannelExtrasRepository(orgId: orgId) }

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
            && body.count + markerLength <= AppConfig.maxMessageLength
            && !isUploading
    }

    private var markerLength: Int {
        appliedTemplateId.map { MessageTemplate.marker(for: $0).count } ?? 0
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


    // MARK: Sending

    /// `senderName` must equal my member `displayName` (the rules enforce it); callers pass `org.myName`.
    func send(senderName: String) {
        var body = draft.trimmed
        guard canSend else { return }
        // v4: a message from a template starts with `[[tpl:{id}]]` (the backend strips it and sets templateId).
        if let templateId = appliedTemplateId, !body.isEmpty {
            body = MessageTemplate.marker(for: templateId) + body
        }
        write(body: body, priority: priority, attachments: pendingAttachments, senderName: senderName)
        draft = ""
        priority = .normal
        pendingAttachments = []
        appliedTemplateId = nil
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

    // MARK: v4 listeners

    func runOrgTemplates() async {
        do {
            for try await list in TemplateRepository(orgId: orgId).orgTemplateStream() {
                orgTemplates = list
            }
        } catch {
            // Volunteers can't read org templates; the picker then shows personal ones only.
            orgTemplates = []
        }
    }

    func runPersonalTemplates() async {
        do {
            for try await list in TemplateRepository(orgId: orgId).personalTemplateStream(uid: uid) {
                personalTemplates = list
            }
        } catch {
            personalTemplates = []
        }
    }

    func runOnCallRoles() async {
        do {
            for try await list in ScheduleRepository(orgId: orgId).onCallRoles() {
                onCallRoles = list
                    .filter { !$0.roleKey.isEmpty }
                    .sorted { $0.displayLabel.localizedCaseInsensitiveCompare($1.displayLabel) == .orderedAscending }
            }
        } catch {
            onCallRoles = []
        }
    }

    /// Listens to the channel's patient (patient channels only).
    func runPatient(id: String?) async {
        guard let id = id?.nilIfBlank else {
            patient = nil
            return
        }
        do {
            for try await value in PatientRepository(orgId: orgId).patient(id: id) {
                patient = value
            }
        } catch {
            patient = nil
        }
    }

    func runPrefs() async {
        do {
            for try await value in extrasRepository.prefs(channelId: channelId, uid: uid) {
                prefs = value
            }
        } catch {
            // Defaults apply when prefs can't be read.
        }
    }

    func runMyAck() async {
        do {
            for try await value in extrasRepository.ack(channelId: channelId, uid: uid) {
                myAck = value
                if value != nil { isAckingBroadcast = false }
            }
        } catch {
            // Informational; the Acknowledge button stays available.
        }
    }

    func runReminders() async {
        do {
            for try await list in extrasRepository.pendingReminders(channelId: channelId, uid: uid) {
                reminders = list
            }
        } catch {
            reminders = []
        }
    }

    // MARK: v4 templates and quick replies

    var allTemplates: [MessageTemplate] { orgTemplates + personalTemplates }

    /// Puts a filled template into the draft, preselects its priority and remembers its id
    /// for the `[[tpl:{id}]]` marker.
    func applyTemplate(_ template: MessageTemplate, text: String) {
        let existing = draft.trimmed
        draft = (existing.isEmpty || existing == "/") ? text : existing + "\n" + text
        priority = template.defaultPriority
        appliedTemplateId = template.id.nilIfBlank
    }

    /// Forgets the template when the draft is cleared by hand.
    func draftChanged() {
        if draft.trimmed.isEmpty { appliedTemplateId = nil }
    }

    /// `DEFAULT_QUICK_REPLIES`, then active org `quick_reply` templates (filled from `context`).
    func quickReplies(context: TemplateContext) -> [QuickReply] {
        var result = DEFAULT_QUICK_REPLIES.map { QuickReply(text: $0, templateId: nil) }
        let templates = TemplateRepository.sorted(orgTemplates).filter { $0.category == .quickReply }
        for template in templates {
            guard let raw = template.body.nilIfBlank ?? template.title.nilIfBlank else { continue }
            let text = TemplateFiller.fill(raw, context: context)
            if !result.contains(where: { $0.text.caseInsensitiveCompare(text) == .orderedSame }) {
                result.append(QuickReply(text: text, templateId: template.id.nilIfBlank))
            }
        }
        return result
    }

    /// Urgent/critical messages from others posted after my latest message (I haven't replied yet).
    var quickReplyTargetIds: Set<String> {
        let items = timeline
        let lastMine = items.lastIndex { $0.senderUid == uid } ?? -1
        var ids: Set<String> = []
        for index in items.indices where index > lastMine {
            let message = items[index]
            guard let id = message.id, message.senderUid != uid, !message.isRecalled,
                  message.messagePriority != .normal else { continue }
            ids.insert(id)
        }
        return ids
    }

    /// One tap: sends the reply as a normal-priority message.
    func sendQuickReply(_ reply: QuickReply, senderName: String) {
        var body = reply.text
        if let templateId = reply.templateId { body = MessageTemplate.marker(for: templateId) + body }
        guard body.count <= AppConfig.maxMessageLength else { return }
        write(body: body, priority: .normal, attachments: [], senderName: senderName)
    }

    func savePersonalTemplate(_ template: MessageTemplate) async throws {
        try await FunctionsClient().saveTemplate(orgId: orgId, scope: .personal, template: template)
        notice = "Saved to your templates."
    }

    func deletePersonalTemplate(_ template: MessageTemplate) async {
        guard template.isPersonal, let id = template.id.nilIfBlank else { return }
        do {
            try await FunctionsClient().deleteTemplate(orgId: orgId, templateId: id, scope: .personal)
        } catch {
            errorMessage = error.userMessage
        }
    }

    func seedDefaultTemplates() async {
        do {
            try await FunctionsClient().seedDefaultTemplates(orgId: orgId)
        } catch {
            errorMessage = error.userMessage
        }
    }

    // MARK: v4 mentions

    /// Channel members other than me (by display name), then on-call roles (by role key).
    func mentionCandidates(members: [String: Member]) -> [MentionCandidate] {
        let people = (channel?.members ?? [])
            .filter { $0 != uid }
            .compactMap { memberUid -> MentionCandidate? in
                guard let member = members[memberUid], let name = member.displayName?.nilIfBlank else { return nil }
                return MentionCandidate(id: memberUid, token: name, title: name, subtitle: member.subtitle, isRole: false)
            }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        let roles = onCallRoles.map { role in
            MentionCandidate(id: "role:" + role.roleKey, token: role.roleKey, title: role.displayLabel,
                             subtitle: "On call · @\(role.roleKey)", isRole: true)
        }
        return people + roles
    }

    /// Tokens highlighted in bubbles: channel members' display names and on-call role keys.
    func mentionTokens(members: [String: Member]) -> [String] {
        let names = (channel?.members ?? []).compactMap { members[$0]?.displayName?.nilIfBlank }
        return names + onCallRoles.map { $0.roleKey }
    }

    /// Lower-cased tokens that refer to me in `message`: my name, plus the roles through which it mentioned me.
    func myMentionTokens(in message: Message, myName: String) -> Set<String> {
        var tokens: Set<String> = [myName.lowercased()]
        if message.isMentioning(uid) {
            for role in message.mentionRoles ?? [] { tokens.insert(role.lowercased()) }
        }
        return tokens
    }

    // MARK: v4 delivery tracking

    /// Other members who have read one of my messages, and how many other members there are.
    func readCount(for message: Message) -> (read: Int, total: Int) {
        let others = (channel?.members ?? []).filter { $0 != uid }
        guard let createdAt = message.createdAt else { return (0, others.count) }
        let read = others.filter { other in
            guard let readAt = reads[other] else { return false }
            return readAt >= createdAt
        }.count
        return (read, others.count)
    }

    func reminder(for message: Message) -> NoReplyReminder? {
        guard let id = message.id else { return nil }
        return reminders.first { $0.messageId == id }
    }

    func remindIfNoReply(_ message: Message, minutes: Int) async {
        guard let messageId = message.id else { return }
        do {
            try await FunctionsClient().remindIfNoReply(orgId: orgId, channelId: channelId, messageId: messageId, minutes: minutes)
            notice = "You'll be reminded in \(minutes) minutes if nobody replies."
        } catch {
            errorMessage = error.userMessage
        }
    }

    func cancelReminder(_ reminder: NoReplyReminder) async {
        guard let id = reminder.id else { return }
        do {
            try await FunctionsClient().cancelReminder(orgId: orgId, reminderId: id)
            notice = "Reminder cancelled."
        } catch {
            errorMessage = error.userMessage
        }
    }

    // MARK: v4 ack-required broadcasts

    var requiresAck: Bool { channel?.isBroadcast == true && channel?.requireAck == true }

    /// The message recipients acknowledge: the creator's first message in the broadcast.
    var ackTargetMessage: Message? {
        guard requiresAck, let creator = channel?.createdBy else { return nil }
        return timeline.first { $0.senderUid == creator && $0.id != nil && !isPending($0) }
    }

    /// Recipients (not the sender) acknowledge once.
    var needsMyAck: Bool {
        guard requiresAck, let channel, channel.createdBy != uid, channel.members.contains(uid) else { return false }
        return myAck == nil
    }

    /// The sender, admins, and members with the `reports` capability see the ack report.
    func canViewAckReport(me: Member?, isAdmin: Bool) -> Bool {
        guard requiresAck, let channel else { return false }
        return channel.createdBy == uid || isAdmin || (me?.has(capability: "reports") ?? false)
    }

    /// Creates `acks/{uid}` = `{messageId, ackedAt: serverTimestamp}` (create only).
    func acknowledgeBroadcast(_ message: Message) {
        guard let messageId = message.id, needsMyAck, !isAckingBroadcast else { return }
        isAckingBroadcast = true
        extrasRepository.acknowledge(channelId: channelId, uid: uid, messageId: messageId) { [weak self] error in
            self?.isAckingBroadcast = false
            self?.errorMessage = "Couldn't acknowledge: \(error.userMessage)"
        }
    }

    // MARK: v4 reactions

    func canReact(_ message: Message, role: Role) -> Bool {
        message.id != nil && !message.isRecalled && !isPending(message) && canPost(role: role)
    }

    /// Loads my reaction for a message that has reactions (once per reaction total).
    func refreshMyReaction(_ message: Message) async {
        guard let messageId = message.id else { return }
        let total = message.sortedReactions.reduce(0) { $0 + $1.count }
        guard total > 0 else { return }
        let key = "\(messageId):\(total)"
        guard !loadedReactionKeys.contains(key) else { return }
        loadedReactionKeys.insert(key)
        do {
            myReactions[messageId] = try await extrasRepository.myReaction(channelId: channelId, messageId: messageId, uid: uid)
        } catch {
            loadedReactionKeys.remove(key)
        }
    }

    /// Sets `reactions/{uid}` = `{emoji, at}`; choosing my current reaction again deletes it.
    func toggleReaction(_ message: Message, emoji: String) {
        guard let messageId = message.id, ALLOWED_REACTIONS.contains(emoji) else { return }
        let previous = myReactions[messageId]
        let next: String? = previous == emoji ? nil : emoji
        myReactions[messageId] = next
        extrasRepository.setReaction(channelId: channelId, messageId: messageId, uid: uid, emoji: next) { [weak self] error in
            self?.myReactions[messageId] = previous
            self?.errorMessage = "Couldn't react: \(error.userMessage)"
        }
    }

    // MARK: v4 edits

    /// My own sent, non-recalled text messages within 15 minutes.
    func canEdit(_ message: Message, now: Date = Date()) -> Bool {
        guard message.senderUid == uid, message.id != nil, !message.isRecalled, !isPending(message),
              !message.text.isEmpty, let createdAt = message.createdAt else { return false }
        return now.timeIntervalSince(createdAt) < 15 * 60
    }

    func edit(_ message: Message, body: String) async throws {
        guard let messageId = message.id else { return }
        try await FunctionsClient().editMessage(orgId: orgId, channelId: channelId, messageId: messageId, body: body)
    }

    // MARK: v4 pins

    /// Pins, newest first.
    var pins: [PinnedMessage] { (channel?.pinned ?? []).filter { !$0.messageId.isEmpty } }

    func isPinned(_ message: Message) -> Bool {
        guard let id = message.id else { return false }
        return pins.contains { $0.messageId == id }
    }

    func setPinned(messageId: String, pinned: Bool) async {
        guard pinningMessageId == nil else { return }
        pinningMessageId = messageId
        defer { pinningMessageId = nil }
        do {
            try await FunctionsClient().pinMessage(orgId: orgId, channelId: channelId, messageId: messageId, pinned: pinned)
        } catch {
            errorMessage = error.userMessage
        }
    }

    // MARK: v4 channel management and prefs

    var isMuted: Bool { prefs?.isMuted() ?? false }
    var notifyMode: ChannelNotifyMode { prefs?.mode ?? .all }

    /// Group and team channels, for the creator or an admin.
    func canRename(isAdmin: Bool) -> Bool {
        guard let channel, channel.archived != true,
              channel.channelType == .group || channel.channelType == .team else { return false }
        return channel.createdBy == uid || isAdmin
    }

    /// Group and team channels, unless I'm the last member.
    var canLeave: Bool {
        guard let channel, channel.channelType == .group || channel.channelType == .team else { return false }
        return channel.members.count > 1 && channel.members.contains(uid)
    }

    /// Not direct or broadcast channels; not archived (the server also checks the care team for patient channels).
    func canManageMembers(role: Role) -> Bool {
        guard role.canSendMessages, let channel, channel.archived != true else { return false }
        switch channel.channelType {
        case .group, .team, .patient: return true
        case .direct, .broadcast: return false
        }
    }

    func rename(to name: String) async throws {
        try await FunctionsClient().renameChannel(orgId: orgId, channelId: channelId, name: name)
    }

    func leave() async throws {
        try await FunctionsClient().leaveChannel(orgId: orgId, channelId: channelId)
    }

    func updateMembers(add: [String], remove: [String]) async throws {
        guard !add.isEmpty || !remove.isEmpty else { return }
        try await FunctionsClient().updateChannelMembers(orgId: orgId, channelId: channelId, add: add, remove: remove)
    }

    /// Writes `prefs/{uid}` = `{mode, mutedUntil, updatedAt}`; an expired mute is written as null.
    func setNotifyMode(_ mode: ChannelNotifyMode) {
        let mutedUntil = isMuted ? prefs?.mutedUntil : nil
        writePrefs(mode: mode, mutedUntil: mutedUntil)
    }

    /// `until == nil` unmutes.
    func mute(until: Date?) {
        writePrefs(mode: notifyMode, mutedUntil: until)
    }

    private func writePrefs(mode: ChannelNotifyMode, mutedUntil: Date?) {
        extrasRepository.setPrefs(channelId: channelId, uid: uid, mode: mode, mutedUntil: mutedUntil) { [weak self] error in
            self?.errorMessage = "Couldn't save notification settings: \(error.userMessage)"
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
