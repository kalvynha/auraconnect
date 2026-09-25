import SwiftUI

struct InboxView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        InboxContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct InboxContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: InboxViewModel
    @State private var searchText = ""
    @State private var showNewMessage = false

    init(orgId: String, uid: String) {
        _model = State(initialValue: InboxViewModel(orgId: orgId, uid: uid))
    }

    private var filtered: [Channel] {
        guard let query = searchText.nilIfBlank else { return model.channels }
        return model.channels.filter { channel in
            org.title(for: channel).localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(filtered) { channel in
                if let id = channel.id {
                    NavigationLink(value: Route.channel(id)) {
                        ChannelRow(channel: channel,
                                   title: org.title(for: channel),
                                   isUnread: model.isUnread(channel),
                                   myUid: org.uid)
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.channels.isEmpty && model.errorMessage == nil {
                ContentUnavailableView {
                    Label("No conversations", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start a secure conversation with a colleague or the on-call team.")
                } actions: {
                    if org.role.canSendMessages {
                        Button("New message") { showNewMessage = true }
                            .buttonStyle(.borderedProminent)
                    }
                }
            } else if filtered.isEmpty && !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            }
        }
        .searchable(text: $searchText, prompt: "Search conversations")
        .navigationTitle("Inbox")
        .toolbar {
            if org.role.canSendMessages {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showNewMessage = true
                    } label: {
                        Label("New message", systemImage: "square.and.pencil")
                    }
                }
            }
        }
        .sheet(isPresented: $showNewMessage) {
            NewMessageView { channelId in
                showNewMessage = false
                router.inboxPath.append(.channel(channelId))
            }
            .environment(org)
        }
        .task { await model.run() }
    }
}

struct ChannelRow: View {
    let channel: Channel
    let title: String
    let isUnread: Bool
    let myUid: String

    private var preview: String {
        guard let last = channel.lastMessage else { return "No messages yet" }
        let sender = last.senderUid == myUid ? "You" : (last.senderName?.nilIfBlank ?? "")
        let text = last.text.nilIfBlank ?? "Attachment"
        return sender.isEmpty ? text : "\(sender): \(text)"
    }

    private var icon: String {
        switch channel.channelType {
        case .direct: return "person.fill"
        case .group: return "person.3.fill"
        case .patient: return "cross.case.fill"
        case .team: return "person.2.badge.gearshape.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(Color.accentColor)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title)
                        .font(.body.weight(isUnread ? .bold : .regular))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(RelativeTime.short(channel.lastMessage?.at ?? channel.lastMessageAt))
                        .font(.caption)
                        .foregroundStyle(isUnread ? Color.accentColor : Color.secondary)
                }
                HStack(alignment: .top, spacing: 6) {
                    if let priority = channel.lastMessage?.priority, priority != .normal {
                        Circle()
                            .fill(priority.color)
                            .frame(width: 8, height: 8)
                            .padding(.top, 5)
                            .accessibilityLabel("\(priority.label) priority")
                    }
                    Text(preview)
                        .font(.subheadline.weight(isUnread ? .semibold : .regular))
                        .foregroundStyle(isUnread ? Color.primary : Color.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    if isUnread {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 10, height: 10)
                            .padding(.top, 4)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
