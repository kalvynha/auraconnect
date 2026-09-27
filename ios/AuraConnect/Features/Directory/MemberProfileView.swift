import SwiftUI

/// v4 directory profile: presence, status, out of office, on-call roles and contact actions.
struct MemberProfileView: View {
    @Environment(OrgStore.self) private var org
    let uid: String

    var body: some View {
        MemberProfileContent(orgId: org.orgId, viewerUid: org.uid, uid: uid)
    }
}

private struct MemberProfileContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var model: DirectoryViewModel
    let uid: String

    init(orgId: String, viewerUid: String, uid: String) {
        _model = State(initialValue: DirectoryViewModel(orgId: orgId, uid: viewerUid))
        self.uid = uid
    }

    private var member: Member? { org.members[uid] }
    private var isMe: Bool { uid == org.uid }

    /// Volunteers see only staff profiles (mirrors the directory list).
    private var isHidden: Bool {
        org.isVolunteerMember && member?.discipline == .volunteer && !isMe
    }

    var body: some View {
        Group {
            if let member, !isHidden {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    profile(member, now: context.date)
                }
            } else if !org.membersLoaded {
                ProgressView()
            } else {
                ContentUnavailableView("Member not found", systemImage: "person.crop.circle.badge.questionmark")
            }
        }
        .navigationTitle(member?.name ?? "Profile")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.onCall.runRoles() }
        .task { await model.onCall.runShifts() }
    }

    private func profile(_ member: Member, now: Date) -> some View {
        List {
            Section {
                VStack(spacing: 8) {
                    PresenceAvatar(member: member, size: 72, now: now)
                    Text(member.name).font(.title3.weight(.semibold))
                    if !member.subtitle.isEmpty {
                        Text(member.subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                    if !member.isActive {
                        StatusPill(text: "Inactive", color: .secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)

                if !isMe && member.isActive {
                    actionButtons(member)
                }
            }

            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            statusSection(member, now: now)

            outOfOfficeSection(member, now: now)

            let roles = model.onCall.onCallRoles(for: member.memberUid, at: now)
            if !roles.isEmpty {
                Section("On call now") {
                    ForEach(roles, id: \.self) { role in
                        Label(role, systemImage: "phone.fill")
                    }
                }
            }

            contactSection(member)
        }
    }

    @ViewBuilder
    private func outOfOfficeSection(_ member: Member, now: Date) -> some View {
        if let ooo = member.activeOutOfOffice(at: now) {
            Section("Out of office") {
                if let until = ooo.until {
                    LabeledContent("Until", value: until.formatted(date: .abbreviated, time: .shortened))
                }
                if let delegate = ooo.delegateUid?.nilIfBlank {
                    LabeledContent("Contact instead") {
                        if delegate != org.uid, org.members[delegate] != nil {
                            NavigationLink(value: Route.memberProfile(delegate)) {
                                Text(org.name(for: delegate))
                            }
                        } else {
                            Text(org.name(for: delegate))
                        }
                    }
                }
                if let note = ooo.note?.nilIfBlank {
                    Text(note).font(.subheadline)
                }
            }
        }
    }

    private func contactSection(_ member: Member) -> some View {
        Section("Contact") {
            InfoRow(label: "Phone", value: member.phone, url: ContactLinks.phone(member.phone))
            InfoRow(label: "Email", value: member.email, url: mailURL(member.email))
            if let discipline = member.discipline {
                LabeledContent("Discipline", value: discipline.label)
            }
            if let title = member.title?.nilIfBlank {
                LabeledContent("Title", value: title)
            }
        }
    }

    @ViewBuilder
    private func statusSection(_ member: Member, now: Date) -> some View {
        let status = member.currentStatus(at: now)
        if status != nil || isMe {
            Section("Status") {
                if let status {
                    HStack(spacing: 8) {
                        PresenceDot(state: status.state)
                        Text(status.summary)
                        Spacer()
                        if let until = status.until {
                            Text("until \(until.formatted(date: .omitted, time: .shortened))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if isMe {
                    NavigationLink(value: Route.myStatus) {
                        Label(status == nil ? "Set a status" : "Change status", systemImage: "person.crop.circle.badge.clock")
                    }
                }
            }
        }
    }

    private func mailURL(_ email: String?) -> URL? {
        guard let email = email?.nilIfBlank else { return nil }
        return URL(string: "mailto:\(email)")
    }

    private func actionButtons(_ member: Member) -> some View {
        HStack(spacing: 12) {
            Button {
                Task {
                    if let channelId = await model.openDirectMessage(with: member.memberUid) {
                        router.push(.channel(channelId))
                    }
                }
            } label: {
                Label("Message", systemImage: "bubble.left.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.openingUid != nil)

            if let url = ContactLinks.phone(member.phone) {
                Button {
                    openURL(url)
                } label: {
                    Label("Call", systemImage: "phone.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }
}
