import SwiftUI
import Observation

@MainActor
@Observable
final class InviteMemberViewModel {
    let orgId: String
    var email = ""
    var displayName = ""
    var role: Role = .clinician
    var discipline: Discipline = .rn
    var selectedTeamIds: Set<String> = []
    private(set) var teams: [Team] = []
    private(set) var teamsError: String?
    private(set) var isWorking = false
    /// Set after the first submit attempt so field errors only show once the user tries.
    private(set) var didAttemptSubmit = false
    var errorMessage: String?
    /// Share text for the invite that was just created; non-nil means success.
    private(set) var shareText: String?

    private let functions = FunctionsClient()

    init(orgId: String) {
        self.orgId = orgId
    }

    /// Lower-cased and trimmed, matching how the backend binds invites.
    var normalizedEmail: String { email.trimmed.lowercased() }

    static func isPlausibleEmail(_ value: String) -> Bool {
        guard value.count <= 254 else { return false }
        return value.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"#, options: .regularExpression) != nil
    }

    var emailError: String? {
        if normalizedEmail.isEmpty { return "Enter an email address." }
        if !Self.isPlausibleEmail(normalizedEmail) { return "Enter a valid email address." }
        return nil
    }

    var nameError: String? {
        guard let name = displayName.nilIfBlank else { return "Enter the person's name." }
        if name.count > 200 { return "Name must be 200 characters or fewer." }
        return nil
    }

    var isValid: Bool { emailError == nil && nameError == nil }

    func toggleTeam(_ id: String) {
        if selectedTeamIds.contains(id) {
            selectedTeamIds.remove(id)
        } else {
            selectedTeamIds.insert(id)
        }
    }

    func runTeams() async {
        do {
            for try await list in TeamRepository(orgId: orgId).teams() {
                teams = list
                    .filter { $0.id != nil }
                    .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
                teamsError = nil
            }
        } catch {
            teamsError = error.userMessage
        }
    }

    /// Calls `inviteMember`; on success sets `shareText`.
    func submit(orgName: String) async {
        didAttemptSubmit = true
        errorMessage = nil
        guard isValid, !isWorking, let name = displayName.nilIfBlank else { return }
        let address = normalizedEmail
        // Only send team ids that still exist.
        let validTeamIds = Set(teams.compactMap { $0.id })
        let teamIds = selectedTeamIds.filter { validTeamIds.contains($0) }.sorted()
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await functions.inviteMember(
                orgId: orgId,
                email: address,
                displayName: name,
                role: role,
                discipline: discipline,
                teamIds: teamIds
            )
            shareText = Self.shareMessage(orgName: orgName, email: address)
        } catch {
            errorMessage = error.userMessage
        }
    }

    static func shareMessage(orgName: String, email: String) -> String {
        "You're invited to join \(orgName) on AuraConnect. Sign up in the AuraConnect app with this email: \(email). After verifying your email, accept the invitation on the welcome screen."
    }
}

/// Admin form: invite a person by email, then share the sign-up instructions.
struct InviteMemberView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        InviteMemberContent(orgId: org.orgId)
    }
}

private struct InviteMemberContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    @State private var model: InviteMemberViewModel

    init(orgId: String) {
        _model = State(initialValue: InviteMemberViewModel(orgId: orgId))
    }

    private var orgName: String {
        org.org?.name?.nilIfBlank ?? "your organization"
    }

    var body: some View {
        NavigationStack {
            Group {
                if let shareText = model.shareText {
                    successForm(shareText: shareText)
                } else {
                    inviteForm
                }
            }
            .navigationTitle("Invite member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.shareText != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if model.isWorking {
                            ProgressView()
                        } else {
                            Button("Invite") {
                                Task { await model.submit(orgName: orgName) }
                            }
                        }
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
            .task { await model.runTeams() }
        }
    }

    private var inviteForm: some View {
        @Bindable var model = model
        return Form {
            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            Section {
                TextField("Email", text: $model.email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if model.didAttemptSubmit, let error = model.emailError {
                    FieldError(message: error)
                }
                TextField("Name", text: $model.displayName)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                if model.didAttemptSubmit, let error = model.nameError {
                    FieldError(message: error)
                }
            } header: {
                Text("Person")
            }

            Section {
                Picker("Role", selection: $model.role) {
                    ForEach(Role.allCases) { role in
                        Text(role.label).tag(role)
                    }
                }
                Picker("Discipline", selection: $model.discipline) {
                    ForEach(Discipline.allCases) { discipline in
                        Text(discipline.label).tag(discipline)
                    }
                }
            } header: {
                Text("Access")
            } footer: {
                Text("Viewers are read-only. Intake staff and clinicians can manage referrals. Admins can manage members.")
            }

            Section {
                if let error = model.teamsError {
                    ErrorBanner(message: error)
                } else if model.teams.isEmpty {
                    Text("No teams yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.teams) { team in
                    if let teamId = team.id {
                        Button {
                            model.toggleTeam(teamId)
                        } label: {
                            HStack {
                                Text(team.displayName).foregroundStyle(Color.primary)
                                Spacer()
                                Image(systemName: model.selectedTeamIds.contains(teamId) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(model.selectedTeamIds.contains(teamId) ? Color.accentColor : Color.secondary)
                                    .font(.title3)
                            }
                        }
                        .accessibilityAddTraits(model.selectedTeamIds.contains(teamId) ? .isSelected : [])
                    }
                }
            } header: {
                Text("Teams (optional)")
            }
        }
        .disabled(model.isWorking)
    }

    private func successForm(shareText: String) -> some View {
        Form {
            Section {
                Label("Invitation created", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text("\(model.displayName.trimmed) can join once they sign up with \(model.normalizedEmail) and verify their email. Share these instructions with them.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section {
                ShareLink(item: shareText, subject: Text("Join \(orgName) on AuraConnect")) {
                    Label("Share invitation", systemImage: "square.and.arrow.up")
                }
                Button("Done") { dismiss() }
            } footer: {
                Text(shareText)
            }
        }
    }
}

/// Inline validation message under a form field.
private struct FieldError: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.red)
    }
}
