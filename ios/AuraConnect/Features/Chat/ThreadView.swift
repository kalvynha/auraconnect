import SwiftUI
import Observation
import QuickLook

@MainActor
@Observable
final class ThreadViewModel {
    let orgId: String
    let channelId: String
    let parentId: String
    let uid: String

    private(set) var channel: Channel?
    private(set) var parent: Message?
    private(set) var parentMissing = false
    /// Oldest first.
    private(set) var replies: [Message] = []
    private(set) var isLoading = true
    private(set) var openingAttachmentPath: String?
    private(set) var recallingMessageId: String?
    var previewURL: URL?
    var draft = ""
    var errorMessage: String?

    init(orgId: String, channelId: String, parentId: String, uid: String) {
        self.orgId = orgId
        self.channelId = channelId
        self.parentId = parentId
        self.uid = uid
    }

    private var messageRepository: MessageRepository { MessageRepository(orgId: orgId) }

    var canSend: Bool {
        let body = draft.trimmed
        return !body.isEmpty && body.count <= AppConfig.maxMessageLength && parent?.isRecalled != true
    }

    /// Same rules as the channel: viewers, archived channels and non-creators of a broadcast can't post.
    func canPost(role: Role) -> Bool {
        guard role.canSendMessages, let channel, channel.archived != true else { return false }
        if channel.isBroadcast { return channel.createdBy == uid }
        return true
    }

    func canRecall(_ message: Message, isAdmin: Bool) -> Bool {
        guard message.id != nil, !message.isRecalled else { return false }
        return message.senderUid == uid || isAdmin
    }

    // MARK: Listeners

    func runChannel() async {
        do {
            for try await value in ChannelRepository(orgId: orgId).channel(id: channelId) {
                channel = value
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func runParent() async {
        do {
            for try await value in messageRepository.message(channelId: channelId, messageId: parentId) {
                parent = value
                parentMissing = value == nil
            }
        } catch {
            parentMissing = parent == nil
            errorMessage = error.userMessage
        }
    }

    func runReplies() async {
        do {
            for try await list in messageRepository.threadReplies(channelId: channelId, parentId: parentId) {
                replies = list.sorted { ($0.createdAt ?? .distantFuture) < ($1.createdAt ?? .distantFuture) }
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    // MARK: Actions

    /// Thread replies are always normal priority and carry `threadParentId`.
    func send(senderName: String) {
        let body = draft.trimmed
        guard canSend else { return }
        messageRepository.send(
            channelId: channelId,
            senderUid: uid,
            senderName: senderName,
            body: body,
            priority: .normal,
            attachments: [],
            threadParentId: parentId,
            onError: { [weak self] error in
                // The server rejected the reply (Firestore rolled back the local copy): put the
                // text back in the composer so it can be retried with Send.
                guard let self else { return }
                if self.draft.trimmed.isEmpty { self.draft = body }
                self.errorMessage = "Reply not sent: \(error.userMessage). Tap Send to retry."
            }
        )
        draft = ""
    }

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
}

/// A message and its thread replies.
struct ThreadView: View {
    @Environment(OrgStore.self) private var org
    let channelId: String
    let messageId: String

    var body: some View {
        ThreadContent(orgId: org.orgId, uid: org.uid, channelId: channelId, messageId: messageId)
    }
}

private struct ThreadContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: ThreadViewModel
    @State private var showRecallConfirm = false
    @State private var recallTarget: Message?

    init(orgId: String, uid: String, channelId: String, messageId: String) {
        _model = State(initialValue: ThreadViewModel(orgId: orgId, channelId: channelId, parentId: messageId, uid: uid))
    }

    private var canCompose: Bool { model.canPost(role: org.role) }

    private var replyCountText: String {
        model.replies.count == 1 ? "1 reply" : "\(model.replies.count) replies"
    }

    var body: some View {
        @Bindable var model = model
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if let parent = model.parent {
                        bubble(parent, showSender: true)
                        HStack {
                            Text(replyCountText)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            VStack { Divider() }
                        }
                        .padding(.vertical, 4)
                    } else if model.parentMissing {
                        ContentUnavailableView("Message unavailable",
                                               systemImage: "bubble.left",
                                               description: Text("It may have been removed, or you are no longer a member."))
                    }
                    ForEach(Array(model.replies.enumerated()), id: \.element.id) { index, reply in
                        let previous: Message? = index > 0 ? model.replies[index - 1] : nil
                        bubble(reply, showSender: previous?.senderUid != reply.senderUid)
                            .id(reply.id ?? "")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if model.isLoading && model.parent == nil { ProgressView() }
            }
            .onChange(of: model.replies.last?.id) { _, lastId in
                guard let lastId else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if canCompose && model.parent?.isRecalled != true {
                composer
            }
        }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.runChannel() }
        .task { await model.runParent() }
        .task { await model.runReplies() }
        .quickLookPreview($model.previewURL)
        .onChange(of: model.previewURL) { oldValue, newValue in
            if newValue == nil { ChatViewModel.removeTemporaryFile(oldValue) }
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
        .alert("Thread", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func bubble(_ message: Message, showSender: Bool) -> some View {
        MessageBubble(
            message: message,
            isMine: message.senderUid == org.uid,
            senderName: message.senderName?.nilIfBlank ?? org.name(for: message.senderUid),
            showSender: showSender,
            readByText: nil,
            openingPath: model.openingAttachmentPath,
            onOpenAttachment: { attachment in
                Task { await model.open(attachment) }
            }
        )
        .contextMenu {
            if !message.isRecalled && !message.displayText.isEmpty {
                Button {
                    SecurePasteboard.copy(message.displayText)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
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
    }

    private var composer: some View {
        @Bindable var model = model
        return HStack(alignment: .bottom, spacing: 10) {
            TextField("Reply in thread", text: $model.draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))

            Button {
                model.send(senderName: org.myName)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(model.canSend ? Color.accentColor : Color.secondary)
            }
            .disabled(!model.canSend)
            .accessibilityLabel("Send reply")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
