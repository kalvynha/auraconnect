import SwiftUI
import PhotosUI
import QuickLook
import UniformTypeIdentifiers

struct ChatView: View {
    @Environment(OrgStore.self) private var org
    let channelId: String

    var body: some View {
        ChatContent(orgId: org.orgId, uid: org.uid, channelId: channelId)
    }
}

private struct ChatContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model: ChatViewModel
    @State private var photoItem: PhotosPickerItem? = nil
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var showFileImporter = false
    @State private var showSummary = false
    @State private var showRecallConfirm = false
    @State private var recallTarget: Message?
    @State private var coverageReason = ""
    // v4
    @State private var showInfo = false
    @State private var showTemplates = false
    @State private var showSaveTemplate = false
    @State private var readStatusTarget: ChatMessageRef?
    @State private var ackReportTarget: ChatMessageRef?
    @State private var editTarget: ChatEditTarget?

    init(orgId: String, uid: String, channelId: String) {
        _model = State(initialValue: ChatViewModel(orgId: orgId, channelId: channelId, uid: uid))
    }

    private var title: String {
        guard let channel = model.channel else { return "Conversation" }
        return org.title(for: channel)
    }

    private var canCompose: Bool {
        model.canPost(role: org.role)
    }

    /// Why the composer is hidden (nil while the channel is loading).
    private var readOnlyReason: String? {
        guard let channel = model.channel else { return nil }
        if !org.role.canSendMessages { return "Read-only access" }
        if channel.archived == true { return "This conversation is archived" }
        if channel.isBroadcast { return "Broadcast · replies are turned off" }
        return nil
    }

    /// Placeholder values for templates and quick replies.
    private var templateContext: TemplateContext {
        TemplateContext(patient: model.patient, myName: org.myName, myDiscipline: org.me?.discipline)
    }

    /// "Read by N of M" caption for one of my sent messages ("Read" in a direct message).
    private func readByText(_ message: Message) -> String? {
        guard message.senderUid == org.uid, message.id != nil, !message.isRecalled, !model.isPending(message) else { return nil }
        let counts = model.readCount(for: message)
        guard counts.total > 0 else { return nil }
        if counts.total == 1 { return counts.read == 1 ? "Read" : nil }
        if counts.read == counts.total { return "Read by everyone" }
        return "Read by \(counts.read) of \(counts.total)"
    }

    var body: some View {
        v4Presentations(chatBody)
    }

    private var chatBody: some View {
        @Bindable var model = model
        return messageList
            .safeAreaInset(edge: .bottom) {
                if canCompose {
                    composer
                } else if let reason = readOnlyReason {
                    Label(reason, systemImage: model.channel?.isBroadcast == true ? "megaphone" : "lock")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(10)
                        .background(.bar)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    titleButton
                }
                if let patientId = model.channel?.patientId {
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink(value: Route.patient(patientId)) {
                            Label("Patient", systemImage: "person.text.rectangle")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSummary = true
                    } label: {
                        Label("Summarize", systemImage: "sparkles")
                    }
                    .disabled(model.channel == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showInfo = true
                    } label: {
                        Label("Info and members", systemImage: "info.circle")
                    }
                    .disabled(model.channel == nil)
                }
            }
            .sheet(isPresented: $showSummary) {
                ChannelSummarySheet(orgId: org.orgId, channelId: channelId)
            }
            .confirmationDialog("Recall this message?",
                                isPresented: $showRecallConfirm,
                                titleVisibility: .visible,
                                presenting: recallTarget) { message in
                Button("Recall message", role: .destructive) {
                    Task { await model.recall(message) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("The text and attachments are removed for everyone. Recipients see \"Message recalled\".")
            }
            .task(id: model.listenerGeneration) { await model.runChannel() }
            .task(id: model.listenerGeneration) { await model.runMessages() }
            .task(id: model.listenerGeneration) { await model.runReads() }
            .task { await model.runMyOpenAlerts() }
            .onAppear { model.setVisible(scenePhase == .active) }
            .onDisappear { model.setVisible(false) }
            .onChange(of: scenePhase) { _, phase in
                model.setVisible(phase == .active)
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                photoItem = nil
                Task { await loadPhoto(item) }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .image]) { result in
                handleImport(result)
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker(
                    onCapture: { image in
                        showCamera = false
                        Task { await attachCameraPhoto(image) }
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            }
            .quickLookPreview($model.previewURL)
            .onChange(of: model.previewURL) { oldValue, newValue in
                if newValue == nil { ChatViewModel.removeTemporaryFile(oldValue) }
            }
            .alert("Message", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
    }

    // MARK: v4 sheets and listeners

    /// Key for the ack listener: restarts after coverage joins and when `requireAck` flips.
    private var ackListenerKey: String {
        "\(model.listenerGeneration)-\(model.requiresAck)"
    }

    private func v4Presentations<Content: View>(_ content: Content) -> some View {
        content
            .sheet(isPresented: $showInfo) {
                ChannelInfoSheet(
                    model: model,
                    onLeft: { dismiss() },
                    onOpenPatient: { patientId in router.push(.patient(patientId)) }
                )
                .environment(org)
            }
            .sheet(isPresented: $showTemplates) {
                TemplatePickerSheet(
                    templates: model.allTemplates,
                    context: templateContext,
                    canSeedDefaults: org.role == .admin,
                    onSeedDefaults: { await model.seedDefaultTemplates() },
                    onDeletePersonal: { template in await model.deletePersonalTemplate(template) },
                    onInsert: { template, text in model.applyTemplate(template, text: text) }
                )
            }
            .sheet(isPresented: $showSaveTemplate) {
                SaveTemplateSheet(
                    initialBody: model.draft.trimmed,
                    initialPriority: model.priority,
                    onSave: { template in try await model.savePersonalTemplate(template) }
                )
            }
            .sheet(item: $readStatusTarget) { target in
                ReadStatusSheet(orgId: org.orgId, channelId: channelId, messageId: target.id)
            }
            .sheet(item: $ackReportTarget) { target in
                AckReportSheet(orgId: org.orgId, channelId: channelId, messageId: target.id)
            }
            .sheet(item: $editTarget) { target in
                EditMessageSheet(originalText: target.text) { body in
                    try await model.edit(target.message, body: body)
                }
            }
            .task { await model.runOrgTemplates() }
            .task { await model.runPersonalTemplates() }
            .task { await model.runOnCallRoles() }
            .task(id: model.listenerGeneration) { await model.runPrefs() }
            .task(id: model.listenerGeneration) { await model.runReminders() }
            .task(id: ackListenerKey) {
                if model.requiresAck { await model.runMyAck() }
            }
            .task(id: model.channel?.patientId) { await model.runPatient(id: model.channel?.patientId) }
            .task(id: model.notice) {
                guard model.notice != nil else { return }
                try? await Task.sleep(for: .seconds(3))
                model.notice = nil
            }
    }

    /// The chat title; tapping it opens the channel info sheet.
    private var titleButton: some View {
        Button {
            showInfo = true
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                if model.isMuted {
                    Image(systemName: "bell.slash.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(Color.primary)
        }
        .disabled(model.channel == nil)
        .accessibilityLabel(model.isMuted ? "\(title), muted" : title)
        .accessibilityHint("Shows conversation info and members")
    }

    // MARK: Messages

    private var channelId: String { model.channelId }

    private var messageList: some View {
        let timeline = model.timeline
        let quickReplyIds = canCompose ? model.quickReplyTargetIds : []
        let quickReplies = quickReplyIds.isEmpty ? [] : model.quickReplies(context: templateContext)
        let mentionTokens = model.mentionTokens(members: org.members)
        let ackTargetId = model.ackTargetMessage?.id
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.channelMissing, let patient = model.coveragePatient {
                        coverageJoinCard(patientName: patient.name)
                    } else if model.channelMissing {
                        ContentUnavailableView("Conversation unavailable",
                                               systemImage: "lock.slash",
                                               description: Text("It may have been removed, or you are no longer a member."))
                    } else if !model.isLoading && timeline.isEmpty {
                        ContentUnavailableView("No messages yet",
                                               systemImage: "bubble.left",
                                               description: Text("Messages are encrypted in transit and at rest."))
                    }
                    ForEach(Array(timeline.enumerated()), id: \.element.id) { index, message in
                        let previous: Message? = index > 0 ? timeline[index - 1] : nil
                        let offersQuickReplies = message.id.map { quickReplyIds.contains($0) } ?? false
                        messageRow(
                            message,
                            showSender: previous?.senderUid != message.senderUid,
                            quickReplies: offersQuickReplies ? quickReplies : [],
                            mentionTokens: mentionTokens,
                            isAckTarget: ackTargetId != nil && message.id == ackTargetId
                        )
                    }
                    ForEach(model.failedMessages) { failed in
                        FailedMessageBubble(
                            failed: failed,
                            onRetry: { model.retry(failed, senderName: org.myName) },
                            onDiscard: { model.discard(failed) }
                        )
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .top) {
                if !model.pins.isEmpty {
                    pinnedBanner(proxy: proxy, timeline: timeline)
                }
            }
            .overlay {
                if model.isLoading { ProgressView() }
            }
            .overlay(alignment: .bottom) {
                if let notice = model.notice {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 8)
                        .transition(.opacity)
                }
            }
            .onChange(of: timeline.last?.id) { _, lastId in
                guard let lastId else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
        }
    }

    /// One timeline message: the bubble, plus the broadcast ack row and quick replies when they apply.
    @ViewBuilder
    private func messageRow(_ message: Message, showSender: Bool, quickReplies: [QuickReply],
                            mentionTokens: [String], isAckTarget: Bool) -> some View {
        let isMine = message.senderUid == org.uid
        VStack(alignment: isMine ? .trailing : .leading, spacing: 6) {
            MessageBubble(
                message: message,
                isMine: isMine,
                senderName: message.senderName?.nilIfBlank ?? org.name(for: message.senderUid),
                showSender: showSender,
                readByText: readByText(message),
                isPending: model.isPending(message),
                openingPath: model.openingAttachmentPath,
                onOpenAttachment: { attachment in
                    Task { await model.open(attachment) }
                },
                onOpenThread: { openThread(message) },
                showAcknowledge: model.canAcknowledge(message),
                isAcknowledging: model.acknowledgingAlertId != nil && model.acknowledgingAlertId == message.alertId,
                onAcknowledge: { Task { await model.acknowledge(message) } },
                mentionTokens: mentionTokens,
                myMentionTokens: model.myMentionTokens(in: message, myName: org.myName),
                isMentioningMe: !isMine && message.isMentioning(org.uid),
                onTapReadBy: readStatusAction(message),
                myReaction: message.id.flatMap { model.myReactions[$0] },
                onToggleReaction: reactionAction(message),
                isPinned: model.isPinned(message)
            )
            .contextMenu { messageMenu(message) }
            if isAckTarget {
                broadcastAckRow(message)
            }
            if !quickReplies.isEmpty {
                quickReplyBar(quickReplies)
            }
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
        .id(message.id ?? "")
        .task(id: reactionKey(message)) { await model.refreshMyReaction(message) }
    }

    private func reactionKey(_ message: Message) -> String {
        let total = message.sortedReactions.reduce(0) { $0 + $1.count }
        return "\(message.id ?? ""):\(total)"
    }

    /// My sent messages open the read-status sheet (with "Nudge unread") from their caption.
    private func readStatusAction(_ message: Message) -> (() -> Void)? {
        guard message.senderUid == org.uid, let messageId = message.id, !message.isRecalled,
              !model.isPending(message), model.readCount(for: message).total > 0 else { return nil }
        return { readStatusTarget = ChatMessageRef(id: messageId) }
    }

    private func reactionAction(_ message: Message) -> ((String) -> Void)? {
        guard model.canReact(message, role: org.role) else { return nil }
        return { emoji in model.toggleReaction(message, emoji: emoji) }
    }

    // MARK: v4 broadcast acks, quick replies, pins

    @ViewBuilder
    private func broadcastAckRow(_ message: Message) -> some View {
        let canReport = model.canViewAckReport(me: org.me, isAdmin: org.role == .admin)
        if model.needsMyAck || model.myAck != nil || canReport {
            HStack(spacing: 8) {
                if model.needsMyAck {
                    Button {
                        model.acknowledgeBroadcast(message)
                    } label: {
                        if model.isAckingBroadcast {
                            ProgressView()
                        } else {
                            Label("Acknowledge", systemImage: "checkmark.seal")
                                .font(.caption.weight(.semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(model.isAckingBroadcast)
                    .accessibilityHint("Confirms you have read this broadcast")
                } else if let ackedAt = model.myAck?.ackedAt {
                    Label("Acknowledged \(ackedAt.formatted(date: .omitted, time: .shortened))", systemImage: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else if model.myAck != nil {
                    Label("Acknowledged", systemImage: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
                if canReport, let messageId = message.id {
                    Button {
                        ackReportTarget = ChatMessageRef(id: messageId)
                    } label: {
                        Label("Acknowledgements", systemImage: "list.bullet.clipboard")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    private func quickReplyBar(_ replies: [QuickReply]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(replies) { reply in
                    Button {
                        model.sendQuickReply(reply, senderName: org.myName)
                    } label: {
                        Text(reply.text)
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityHint("Sends this reply now")
                }
            }
        }
    }

    private func pinnedBanner(proxy: ScrollViewProxy, timeline: [Message]) -> some View {
        let pins = model.pins
        return Menu {
            ForEach(pins, id: \.messageId) { pin in
                Button {
                    if timeline.contains(where: { $0.id == pin.messageId }) {
                        withAnimation { proxy.scrollTo(pin.messageId, anchor: .center) }
                    } else {
                        model.notice = "That message is older than the loaded history."
                    }
                } label: {
                    Text(pin.snippet.nilIfBlank ?? "Pinned message")
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "pin.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 1) {
                    Text(pins.count == 1 ? "Pinned" : "\(pins.count) pinned")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(pins.first?.snippet.nilIfBlank ?? "Pinned message")
                        .font(.subheadline)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
        .accessibilityLabel(pins.count == 1 ? "Pinned message" : "\(pins.count) pinned messages")
        .accessibilityHint("Shows pinned messages")
    }

    // MARK: O5 on-call coverage

    /// Shown when I open a patient's care-team channel I'm not in. On-call staff on shift (and
    /// admins) can join until the shift ends; the server checks this and audits the reason.
    @ViewBuilder
    private func coverageJoinCard(patientName: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Not on the care team", systemImage: "person.crop.circle.badge.questionmark")
                .font(.headline)
            Text("You're not a member of the care-team channel for \(patientName). If you're on call now, you can join it for the rest of your shift. The access and your reason are recorded in the audit log, and you're removed when the shift ends.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("Reason (e.g. after-hours call from family)", text: $coverageReason, axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.roundedBorder)
            Button {
                Task {
                    if await model.joinForCoverage(reason: coverageReason) { coverageReason = "" }
                }
            } label: {
                if model.isJoiningCoverage {
                    ProgressView()
                } else {
                    Label("Join for on-call coverage", systemImage: "person.badge.clock")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isJoiningCoverage || coverageReason.trimmed.count < 3)
        }
        .padding()
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: Message actions

    private func openThread(_ message: Message) {
        guard let messageId = message.id else { return }
        router.push(.messageThread(channelId: channelId, messageId: messageId))
    }

    @ViewBuilder
    private func messageMenu(_ message: Message) -> some View {
        if model.canReact(message, role: org.role) {
            // Reaction bar: choosing my current reaction again removes it.
            ControlGroup {
                ForEach(ALLOWED_REACTIONS, id: \.self) { emoji in
                    Button {
                        model.toggleReaction(message, emoji: emoji)
                    } label: {
                        Text(emoji)
                    }
                    .accessibilityLabel(model.myReactions[message.id ?? ""] == emoji ? "Remove reaction \(emoji)" : "React \(emoji)")
                }
            }
            .controlGroupStyle(.palette)
        }
        if !message.isRecalled && !message.displayText.isEmpty {
            Button {
                SecurePasteboard.copy(message.displayText)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
        if message.id != nil && !message.isRecalled && (canCompose || message.replies > 0) {
            Button {
                openThread(message)
            } label: {
                Label(canCompose ? "Reply in thread" : "View thread", systemImage: "arrowshape.turn.up.left")
            }
        }
        if model.canEdit(message) {
            Button {
                editTarget = ChatEditTarget(message: message)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
        }
        if let messageId = message.id, !message.isRecalled, !model.isPending(message), canCompose {
            let pinned = model.isPinned(message)
            Button {
                Task { await model.setPinned(messageId: messageId, pinned: !pinned) }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
            }
            .disabled(model.pinningMessageId != nil)
        }
        if let action = readStatusAction(message) {
            Button(action: action) {
                Label("Read status", systemImage: "eye")
            }
        }
        if message.senderUid == org.uid, message.id != nil, !message.isRecalled, !model.isPending(message) {
            if let reminder = model.reminder(for: message) {
                Button {
                    Task { await model.cancelReminder(reminder) }
                } label: {
                    Label("Cancel no-reply reminder", systemImage: "bell.slash")
                }
            } else {
                Menu {
                    ForEach([15, 30, 60, 120], id: \.self) { minutes in
                        Button(minutes < 60 ? "\(minutes) minutes" : (minutes == 60 ? "1 hour" : "\(minutes / 60) hours")) {
                            Task { await model.remindIfNoReply(message, minutes: minutes) }
                        }
                    }
                } label: {
                    Label("Remind me if no reply", systemImage: "bell.badge")
                }
            }
        }
        if model.canRecall(message, isAdmin: org.role == .admin) {
            Button(role: .destructive) {
                recallTarget = message
                showRecallConfirm = true
            } label: {
                Label("Recall", systemImage: "arrow.uturn.backward.circle")
            }
        }
    }

    // MARK: Composer

    private var mentionSuggestions: [MentionCandidate] {
        guard let query = MentionLogic.activeQuery(in: model.draft) else { return [] }
        return MentionLogic.suggestions(for: query, in: model.mentionCandidates(members: org.members))
    }

    @ViewBuilder
    private var composer: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            let suggestions = mentionSuggestions
            if !suggestions.isEmpty {
                MentionSuggestionList(suggestions: suggestions) { candidate in
                    model.draft = MentionLogic.apply(candidate, to: model.draft)
                }
            }
            if !model.pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(model.pendingAttachments, id: \.storagePath) { attachment in
                            HStack(spacing: 4) {
                                Image(systemName: attachment.isImage ? "photo" : "doc.fill")
                                Text(attachment.name).lineLimit(1)
                                Button {
                                    model.removePending(attachment)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                                .accessibilityLabel("Remove \(attachment.name)")
                            }
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                        }
                    }
                }
            }
            if model.isUploading {
                ProgressView("Uploading attachment…")
                    .font(.caption)
            }
            if model.priority != .normal {
                Label("Sends as \(model.priority.label.lowercased()) and alerts recipients until acknowledged",
                      systemImage: model.priority.symbol)
                    .font(.caption)
                    .foregroundStyle(model.priority.color)
            }
            if model.appliedTemplateId != nil {
                Label("From a template", systemImage: "text.badge.checkmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                Menu {
                    if CameraPicker.isAvailable {
                        Button {
                            showCamera = true
                        } label: {
                            Label("Camera", systemImage: "camera")
                        }
                    }
                    Button {
                        showPhotoPicker = true
                    } label: {
                        Label("Photo", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showFileImporter = true
                    } label: {
                        Label("PDF or image file", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "paperclip")
                        .font(.title3)
                        .frame(minWidth: 32, minHeight: 36)
                }
                .accessibilityLabel("Attach")
                .disabled(model.isUploading)

                Menu {
                    Picker("Priority", selection: $model.priority) {
                        ForEach(Priority.allCases) { priority in
                            Label(priority.label, systemImage: priority.symbol).tag(priority)
                        }
                    }
                } label: {
                    Image(systemName: model.priority == .normal ? "flag" : "flag.fill")
                        .font(.title3)
                        .foregroundStyle(model.priority == .normal ? Color.accentColor : model.priority.color)
                        .frame(minWidth: 32, minHeight: 36)
                }
                .accessibilityLabel("Priority: \(model.priority.label)")

                templateMenu

                TextField("Message", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    .onChange(of: model.draft) { oldValue, newValue in
                        // "/" at the start of an empty draft opens the template picker.
                        if newValue == "/" && oldValue.isEmpty {
                            model.draft = ""
                            showTemplates = true
                        }
                        model.draftChanged()
                    }

                Button {
                    model.send(senderName: org.myName)
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(sendButtonColor)
                }
                .disabled(!model.canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// Tap: template picker. Long press: also "Save as personal template".
    private var templateMenu: some View {
        Menu {
            Button {
                showTemplates = true
            } label: {
                Label("Insert template", systemImage: "text.badge.plus")
            }
            Button {
                showSaveTemplate = true
            } label: {
                Label("Save as personal template", systemImage: "square.and.arrow.down")
            }
            .disabled(model.draft.trimmed.isEmpty)
        } label: {
            Image(systemName: "text.badge.plus")
                .font(.title3)
                .frame(minWidth: 32, minHeight: 36)
        } primaryAction: {
            showTemplates = true
        }
        .accessibilityLabel("Templates")
        .accessibilityHint("Opens message templates. Long press to save the draft as a template.")
    }

    private var sendButtonColor: Color {
        guard model.canSend else { return .secondary }
        return model.priority == .normal ? Color.accentColor : model.priority.color
    }

    // MARK: Attachment import

    private func loadPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.8) ?? data
            let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
            await model.attach(data: jpeg, fileName: name, contentType: "image/jpeg")
        } catch {
            model.errorMessage = error.userMessage
        }
    }

    /// Camera photos are encoded in memory and uploaded directly; they are never saved to the
    /// photo library. Re-encoding as JPEG also drops EXIF metadata such as location.
    private func attachCameraPhoto(_ image: UIImage) async {
        guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
            model.errorMessage = "Couldn't process the photo."
            return
        }
        let name = "camera-\(Int(Date().timeIntervalSince1970)).jpg"
        await model.attach(data: jpeg, fileName: name, contentType: "image/jpeg")
    }

    private func handleImport(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            let hasAccess = url.startAccessingSecurityScopedResource()
            defer {
                if hasAccess { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url)
                let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let name = url.lastPathComponent
                Task { await model.attach(data: data, fileName: name, contentType: contentType) }
            } catch {
                model.errorMessage = error.userMessage
            }
        case .failure(let error):
            model.errorMessage = error.userMessage
        }
    }
}

struct MessageBubble: View {
    let message: Message
    let isMine: Bool
    let senderName: String
    let showSender: Bool
    let readByText: String?
    /// Written locally but not yet on the server (e.g. offline).
    var isPending: Bool = false
    let openingPath: String?
    let onOpenAttachment: (Attachment) -> Void
    /// When set, parents with replies show a "N replies" chip that calls this.
    var onOpenThread: (() -> Void)? = nil
    /// O2: urgent/critical message whose open alert targets me.
    var showAcknowledge: Bool = false
    var isAcknowledging: Bool = false
    var onAcknowledge: (() -> Void)? = nil
    // v4
    /// Display names and role keys highlighted after "@".
    var mentionTokens: [String] = []
    /// Lower-cased tokens that refer to me (extra emphasis).
    var myMentionTokens: Set<String> = []
    /// The message @mentions me (server-parsed `mentions`).
    var isMentioningMe: Bool = false
    /// Makes the "Read by …" caption open the read-status sheet.
    var onTapReadBy: (() -> Void)? = nil
    var myReaction: String? = nil
    /// Tapping a reaction count toggles that reaction (nil when I can't react).
    var onToggleReaction: ((String) -> Void)? = nil
    var isPinned: Bool = false

    private var priority: Priority { message.messagePriority }

    private var reactions: [ReactionCount] { message.isRecalled ? [] : message.sortedReactions }

    private var bodyText: AttributedString {
        MentionFormatter.attributed(message.displayText, tokens: mentionTokens, myTokens: myMentionTokens)
    }

    /// Recalled messages show no attachments (the backend deletes them).
    private var visibleFiles: [Attachment] { message.isRecalled ? [] : message.files }

    private var replyLabel: String {
        message.replies == 1 ? "1 reply" : "\(message.replies) replies"
    }

    private var bubbleColor: Color {
        if isMine { return Color.accentColor.opacity(0.16) }
        if isMentioningMe && !message.isRecalled { return Color.orange.opacity(0.12) }
        return Color(uiColor: .secondarySystemBackground)
    }

    var body: some View {
        HStack(alignment: .bottom) {
            if isMine { Spacer(minLength: 48) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                if (showSender && !isMine) || isPinned || (isMentioningMe && !message.isRecalled) {
                    HStack(spacing: 6) {
                        if showSender && !isMine {
                            Text(senderName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        if isMentioningMe && !message.isRecalled {
                            Label("Mentioned you", systemImage: "at")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.orange)
                        }
                        if isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                                .accessibilityLabel("Pinned")
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    if message.isRecalled {
                        Label("Message recalled", systemImage: "arrow.uturn.backward.circle")
                            .font(.body.italic())
                            .foregroundStyle(.secondary)
                    }
                    if priority != .normal && !message.isRecalled {
                        PriorityBadge(priority: priority)
                    }
                    if let role = message.roleTarget?.nilIfBlank {
                        Label("To on-call: \(role)", systemImage: "person.badge.clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !message.isRecalled && !message.displayText.isEmpty {
                        // L4: no system text selection on PHI; the context menu copies via SecurePasteboard.
                        Text(bodyText)
                            .font(.body)
                            .foregroundStyle(Color.primary)
                    }
                    ForEach(visibleFiles, id: \.storagePath) { attachment in
                        Button {
                            onOpenAttachment(attachment)
                        } label: {
                            HStack(spacing: 8) {
                                if openingPath == attachment.storagePath {
                                    ProgressView()
                                } else {
                                    Image(systemName: attachment.isImage ? "photo" : (attachment.isPDF ? "doc.richtext" : "doc"))
                                }
                                Text(attachment.name)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 0)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                            .padding(8)
                            .background(Color(uiColor: .systemBackground).opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open attachment \(attachment.name)")
                    }
                }
                .padding(10)
                .background(bubbleColor, in: RoundedRectangle(cornerRadius: 16))
                .overlay {
                    if priority != .normal && !message.isRecalled {
                        RoundedRectangle(cornerRadius: 16).strokeBorder(priority.color, lineWidth: 1.5)
                    } else if isMentioningMe && !message.isRecalled {
                        RoundedRectangle(cornerRadius: 16).strokeBorder(Color.orange.opacity(0.7), lineWidth: 1)
                    }
                }
                if !reactions.isEmpty {
                    reactionRow
                }
                if showAcknowledge, let onAcknowledge {
                    Button(action: onAcknowledge) {
                        if isAcknowledging {
                            ProgressView()
                        } else {
                            Label("Acknowledge", systemImage: "hand.raised.fill")
                                .font(.caption.weight(.semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(priority.color)
                    .controlSize(.small)
                    .disabled(isAcknowledging)
                    .accessibilityHint("Acknowledges the alert for this message and stops escalation")
                }
                if let onOpenThread, message.replies > 0 {
                    Button(action: onOpenThread) {
                        Label(replyLabel, systemImage: "bubble.left.and.bubble.right")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHint("Opens the thread")
                }
                HStack(spacing: 6) {
                    if isPending {
                        Image(systemName: "clock")
                            .accessibilityLabel("Waiting to send")
                    }
                    Text(message.createdAt.map { $0.formatted(date: .omitted, time: .shortened) } ?? "Sending…")
                    if message.isEdited && !message.isRecalled {
                        Text("· edited")
                    }
                    if isPending {
                        Text("· Waiting to send")
                    } else if let readByText {
                        if let onTapReadBy {
                            Button(action: onTapReadBy) {
                                Text("· \(readByText)")
                                    .underline()
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Shows who has read this message")
                        } else {
                            Text("· \(readByText)")
                        }
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if !isMine { Spacer(minLength: 48) }
        }
        .accessibilityElement(children: .contain)
    }

    /// Reaction counts under the bubble; mine is highlighted and tapping toggles.
    private var reactionRow: some View {
        HStack(spacing: 4) {
            ForEach(reactions, id: \.emoji) { item in
                let isMineReaction = myReaction == item.emoji
                Button {
                    onToggleReaction?(item.emoji)
                } label: {
                    Text("\(item.emoji) \(item.count)")
                        .font(.caption)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(isMineReaction ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12), in: Capsule())
                        .overlay {
                            if isMineReaction {
                                Capsule().strokeBorder(Color.accentColor, lineWidth: 1)
                            }
                        }
                }
                .buttonStyle(.plain)
                .disabled(onToggleReaction == nil)
                .accessibilityLabel("\(item.emoji) \(item.count)\(isMineReaction ? ", including you" : "")")
            }
        }
    }
}

/// A message the server rejected, with Retry / Delete. Shown after the timeline.
struct FailedMessageBubble: View {
    let failed: FailedMessage
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        HStack(alignment: .bottom) {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                VStack(alignment: .leading, spacing: 6) {
                    if failed.priority != .normal {
                        PriorityBadge(priority: failed.priority)
                    }
                    if !failed.body.isEmpty {
                        Text(MessageTemplate.strippingMarker(failed.body))
                            .font(.body)
                            .foregroundStyle(Color.primary)
                    }
                    if !failed.attachments.isEmpty {
                        Label(failed.attachments.count == 1 ? "1 attachment" : "\(failed.attachments.count) attachments",
                              systemImage: "paperclip")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                .overlay {
                    RoundedRectangle(cornerRadius: 16).strokeBorder(Color.red.opacity(0.6), lineWidth: 1)
                }
                HStack(spacing: 10) {
                    Label("Not sent", systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Button("Retry", action: onRetry)
                        .fontWeight(.semibold)
                    Button("Delete", role: .destructive, action: onDiscard)
                }
                .font(.caption)
                .buttonStyle(.borderless)
                Text(failed.reason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Sheet target for a message id (read status, ack report).
struct ChatMessageRef: Identifiable, Hashable {
    let id: String
}

/// Sheet target for editing one of my messages.
struct ChatEditTarget: Identifiable {
    let message: Message
    var id: String { message.id ?? "" }
    var text: String { message.displayText }
}
