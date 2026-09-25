import SwiftUI
import Observation

@MainActor
@Observable
final class OrgOnboardingViewModel {
    private(set) var invites: [InviteSummary] = []
    private(set) var isLoadingInvites = false
    private(set) var isWorking = false
    var errorMessage: String?

    var orgName = ""
    var displayName = ""
    var discipline: Discipline = .rn
    var timezone = TimeZone.current.identifier

    private let functions = FunctionsClient()

    var canCreate: Bool { orgName.nilIfBlank != nil && displayName.nilIfBlank != nil && !isWorking }

    func loadInvites() async {
        isLoadingInvites = true
        defer { isLoadingInvites = false }
        do {
            invites = try await functions.listMyInvites()
        } catch {
            errorMessage = error.userMessage
        }
    }

    func accept(_ invite: InviteSummary) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            try await functions.acceptInvite(orgId: invite.orgId, inviteId: invite.inviteId)
            return true
        } catch {
            errorMessage = error.userMessage
            return false
        }
    }

    func createOrg() async -> Bool {
        guard let name = orgName.nilIfBlank, let person = displayName.nilIfBlank else { return false }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await functions.createOrg(name: name, timezone: timezone, displayName: person, discipline: discipline)
            return true
        } catch {
            errorMessage = error.userMessage
            return false
        }
    }
}

/// Signed in, but no org yet: accept a pending invite or create a new organization.
struct OrgOnboardingView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = OrgOnboardingViewModel()
    @State private var verificationInfo: String? = nil
    @State private var isCheckingVerification = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    Text("You're signed in as \(session.email ?? "your account"). Join your hospice's organization to start messaging your care team.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                if !session.isEmailVerified {
                    verifyEmailSection
                } else {
                    invitesSection
                }

                Section {
                    TextField("Organization name", text: $model.orgName)
                        .textInputAutocapitalization(.words)
                    TextField("Your name", text: $model.displayName)
                        .textContentType(.name)
                    Picker("Your discipline", selection: $model.discipline) {
                        ForEach(Discipline.allCases) { discipline in
                            Text(discipline.label).tag(discipline)
                        }
                    }
                    LabeledContent("Time zone", value: model.timezone)
                    Button {
                        Task {
                            if await model.createOrg() {
                                await session.didJoinOrg()
                            }
                        }
                    } label: {
                        if model.isWorking {
                            ProgressView()
                        } else {
                            Text("Create organization")
                        }
                    }
                    .disabled(!model.canCreate)
                } header: {
                    Text("New organization")
                } footer: {
                    Text("You'll be the organization's administrator and can invite your team from the web console.")
                }

                Section {
                    Button("Sign out", role: .destructive) {
                        Task { await session.signOut() }
                    }
                }
            }
            .navigationTitle("Welcome")
            .task {
                if model.displayName.isEmpty, let name = session.authDisplayName {
                    model.displayName = name
                }
                if session.isEmailVerified {
                    await model.loadInvites()
                }
            }
            .refreshable {
                if session.isEmailVerified {
                    await model.loadInvites()
                }
            }
        }
    }

    @ViewBuilder
    private var invitesSection: some View {
        Section("Pending invitations") {
            if model.isLoadingInvites && model.invites.isEmpty {
                ProgressView()
            } else if model.invites.isEmpty {
                Text("No invitations for this email address. Ask your administrator to invite you, or create a new organization below.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.invites) { invite in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invite.orgName).font(.headline)
                            Text(invite.role.label).font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Join") {
                            Task {
                                if await model.accept(invite) {
                                    await session.didJoinOrg()
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isWorking)
                    }
                }
            }
            Button("Refresh invitations") {
                Task { await model.loadInvites() }
            }
            .disabled(model.isLoadingInvites)
        }
    }

    /// Accepting an invite requires a verified email address.
    @ViewBuilder
    private var verifyEmailSection: some View {
        Section {
            Label("Verify your email", systemImage: "envelope.badge")
                .font(.headline)
            Text("To join an organization you were invited to, confirm \(session.email ?? "your email address") by tapping the link we send you. You can still create a new organization without verifying.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let info = verificationInfo {
                Text(info).font(.footnote).foregroundStyle(.secondary)
            }
            Button("Send verification email") {
                Task {
                    do {
                        try await session.sendEmailVerification()
                        verificationInfo = "Verification email sent. Check your inbox, then tap \"I've verified\"."
                    } catch {
                        model.errorMessage = error.userMessage
                    }
                }
            }
            .disabled(isCheckingVerification)
            Button {
                Task {
                    isCheckingVerification = true
                    defer { isCheckingVerification = false }
                    do {
                        let verified = try await session.reloadEmailVerification()
                        if verified {
                            verificationInfo = nil
                            await model.loadInvites()
                        } else {
                            verificationInfo = "Your email isn't verified yet. Open the link in the email, then try again."
                        }
                    } catch {
                        model.errorMessage = error.userMessage
                    }
                }
            } label: {
                if isCheckingVerification {
                    ProgressView()
                } else {
                    Text("I've verified")
                }
            }
            .disabled(isCheckingVerification)
        } header: {
            Text("Pending invitations")
        }
    }
}
