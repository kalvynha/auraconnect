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
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ChatViewModel
    @State private var photoItem: PhotosPickerItem? = nil
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var showMembers = false

    init(orgId: String, uid: String, channelId: String) {
        _model = State(initialValue: ChatViewModel(orgId: orgId, channelId: channelId, uid: uid))
    }

    private var title: String {
        guard let channel = model.channel else { return "Conversation" }
        return org.title(for: channel)
    }

    private var canCompose: Bool {
        org.role.canSendMessages && model.channel != nil && model.channel?.archived != true
    }

    /// "Read by …" caption for my most recent message.
    private var readReceipt: (messageId: String, text: String)? {
        guard let result = model.readersOfMyLastMessage(), !result.readers.isEmpty else { return nil }
        let others = (model.channel?.members ?? []).filter { $0 != org.uid }
        if !others.isEmpty && Set(others).isSubset(of: Set(result.readers)) {
            return (result.messageId, others.count == 1 ? "Read" : "Read by everyone")
        }
        return (result.messageId, "Read by " + result.readers.map { org.name(for: $0) }.joined(separator: ", "))
    }

    var body: some View {
        @Bindable var model = model
        messageList
            .safeAreaInset(edge: .bottom) {
                if canCompose {
                    composer
                } else if model.channel != nil && !org.role.canSendMessages {
                    Text("Read-only access")
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
                if let patientId = model.channel?.patientId {
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink(value: Route.patient(patientId)) {
                            Label("Patient", systemImage: "person.text.rectangle")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showMembers = true
                    } label: {
                        Label("Members", systemImage: "person.2")
                    }
                    .disabled(model.channel == nil)
                }
            }
            .sheet(isPresented: $showMembers) {
                ChannelMembersSheet(memberUids: model.channel?.members ?? [])
                    .environment(org)
            }
            .task { await model.runChannel() }
            .task { await model.runMessages() }
            .task { await model.runReads() }
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

    // MARK: Messages

    private var messageList: some View {
        let receipt = readReceipt
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.channelMissing {
                        ContentUnavailableView("Conversation unavailable",
                                               systemImage: "lock.slash",
                                               description: Text("It may have been removed, or you are no longer a member."))
                    } else if !model.isLoading && model.messages.isEmpty {
                        ContentUnavailableView("No messages yet",
                                               systemImage: "bubble.left",
                                               description: Text("Messages are encrypted in transit and at rest."))
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        let previous: Message? = index > 0 ? model.messages[index - 1] : nil
                        MessageBubble(
                            message: message,
                            isMine: message.senderUid == org.uid,
                            senderName: message.senderName?.nilIfBlank ?? org.name(for: message.senderUid),
                            showSender: previous?.senderUid != message.senderUid,
                            readByText: receipt?.messageId == message.id ? receipt?.text : nil,
                            openingPath: model.openingAttachmentPath,
                            onOpenAttachment: { attachment in
                                Task { await model.open(attachment) }
                            }
                        )
                        .id(message.id ?? "")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if model.isLoading { ProgressView() }
            }
            .onChange(of: model.messages.last?.id) { _, lastId in
                guard let lastId else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
        }
    }

    // MARK: Composer

    @ViewBuilder
    private var composer: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
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
            HStack(alignment: .bottom, spacing: 10) {
                Menu {
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

                TextField("Message", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))

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
    let openingPath: String?
    let onOpenAttachment: (Attachment) -> Void

    private var priority: Priority { message.messagePriority }

    private var bubbleColor: Color {
        isMine ? Color.accentColor.opacity(0.16) : Color(uiColor: .secondarySystemBackground)
    }

    var body: some View {
        HStack(alignment: .bottom) {
            if isMine { Spacer(minLength: 48) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                if showSender && !isMine {
                    Text(senderName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if priority != .normal {
                        PriorityBadge(priority: priority)
                    }
                    if let role = message.roleTarget?.nilIfBlank {
                        Label("To on-call: \(role)", systemImage: "person.badge.clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !message.text.isEmpty {
                        Text(message.text)
                            .font(.body)
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                    }
                    ForEach(message.files, id: \.storagePath) { attachment in
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
                    if priority != .normal {
                        RoundedRectangle(cornerRadius: 16).strokeBorder(priority.color, lineWidth: 1.5)
                    }
                }
                HStack(spacing: 6) {
                    Text(message.createdAt.map { $0.formatted(date: .omitted, time: .shortened) } ?? "Sending…")
                    if let readByText {
                        Text("· \(readByText)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if !isMine { Spacer(minLength: 48) }
        }
        .accessibilityElement(children: .contain)
    }
}

struct ChannelMembersSheet: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let memberUids: [String]

    var body: some View {
        NavigationStack {
            List(memberUids, id: \.self) { uid in
                HStack(spacing: 12) {
                    AvatarView(initials: org.members[uid]?.initials ?? "?")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(org.name(for: uid))
                        if let subtitle = org.members[uid]?.subtitle, !subtitle.isEmpty {
                            Text(subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
