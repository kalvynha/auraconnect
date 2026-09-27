import SwiftUI

/// v4 staff directory: active members with presence, status, out-of-office and "on call now".
/// Uses the shared members cache (`OrgStore`); no patient data.
struct DirectoryView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        DirectoryContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct DirectoryContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var model: DirectoryViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: DirectoryViewModel(orgId: orgId, uid: uid))
    }

    var body: some View {
        @Bindable var model = model
        // Re-evaluate every minute so expired statuses and shift boundaries roll over.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            list(now: context.date)
        }
        .navigationTitle("Directory")
        .searchable(text: $model.searchText, prompt: "Name, discipline or role")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                filterMenu
            }
        }
        .task { await model.onCall.runRoles() }
        .task { await model.onCall.runShifts() }
    }

    private var filterMenu: some View {
        @Bindable var model = model
        return Menu {
            Toggle("On call now", isOn: $model.onCallOnly)
            Picker("Discipline", selection: $model.discipline) {
                Text("All disciplines").tag(Discipline?.none)
                ForEach(model.disciplines(in: org.activeMembers)) { discipline in
                    Text(discipline.label).tag(Discipline?.some(discipline))
                }
            }
        } label: {
            let filtered = model.discipline != nil || model.onCallOnly
            Label("Filter", systemImage: filtered
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter directory")
    }

    private func list(now: Date) -> some View {
        let members = model.visibleMembers(from: org, now: now)
        return List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            if model.discipline != nil || model.onCallOnly {
                Section {
                    HStack {
                        Text(activeFilterText).font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            model.discipline = nil
                            model.onCallOnly = false
                        }
                        .font(.footnote)
                    }
                }
            }
            Section {
                ForEach(members) { member in
                    memberRow(member, now: now)
                }
            } footer: {
                if org.membersLoaded {
                    Text("\(members.count) \(members.count == 1 ? "person" : "people")")
                }
            }
        }
        .overlay {
            if !org.membersLoaded {
                ProgressView()
            } else if members.isEmpty {
                ContentUnavailableView.search(text: model.searchText)
            }
        }
    }

    private func memberRow(_ member: Member, now: Date) -> some View {
        NavigationLink(value: Route.memberProfile(member.memberUid)) {
            DirectoryRow(
                member: member,
                isMe: member.memberUid == org.uid,
                onCallRoles: model.onCall.onCallRoles(for: member.memberUid, at: now),
                now: now
            )
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if member.memberUid != org.uid {
                Button {
                    Task { await message(member) }
                } label: {
                    Label("Message", systemImage: "bubble.left.fill")
                }
                .tint(.accentColor)
                if let url = ContactLinks.phone(member.phone) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Call", systemImage: "phone.fill")
                    }
                    .tint(.green)
                }
            }
        }
        .contextMenu {
            Button {
                router.push(.memberProfile(member.memberUid))
            } label: {
                Label("View profile", systemImage: "person.crop.circle")
            }
            if member.memberUid != org.uid {
                Button {
                    Task { await message(member) }
                } label: {
                    Label("Message", systemImage: "bubble.left")
                }
                if let url = ContactLinks.phone(member.phone) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Call", systemImage: "phone")
                    }
                }
            }
        }
    }

    private var activeFilterText: String {
        let parts: [String?] = [model.discipline?.label, model.onCallOnly ? "On call now" : nil]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    private func message(_ member: Member) async {
        if let channelId = await model.openDirectMessage(with: member.memberUid) {
            router.push(.channel(channelId))
        }
    }
}

/// One directory entry: avatar with presence dot, name, discipline, status and badges.
struct DirectoryRow: View {
    let member: Member
    var isMe = false
    var onCallRoles: [String] = []
    var now: Date = Date()

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            PresenceAvatar(member: member, size: 40, now: now)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(member.name).font(.headline).lineLimit(1)
                    if isMe {
                        Text("(you)").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if !member.subtitle.isEmpty {
                    Text(member.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if let status = member.currentStatus(at: now) {
                    HStack(spacing: 4) {
                        PresenceDot(state: status.state, size: 7)
                        Text(status.summary).lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                if hasBadges {
                    HStack(spacing: 6) {
                        if let ooo = member.activeOutOfOffice(at: now) {
                            StatusPill(text: outOfOfficeText(ooo), color: .orange)
                        }
                        ForEach(onCallRoles, id: \.self) { role in
                            StatusPill(text: role, color: .green)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var hasBadges: Bool {
        member.activeOutOfOffice(at: now) != nil || !onCallRoles.isEmpty
    }

    private func outOfOfficeText(_ ooo: OutOfOffice) -> String {
        guard let until = ooo.until else { return "Out of office" }
        return "Out until \(until.formatted(.dateTime.month(.abbreviated).day()))"
    }
}
