import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(OrgStore.self) private var org
    @Environment(SessionStore.self) private var session
    @Environment(AppLockManager.self) private var lock
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL

    @State private var displayName = ""
    @State private var phone = ""
    @State private var title = ""
    @State private var didLoadProfile = false
    @State private var isSaving = false
    @State private var saveMessage: String? = nil
    @State private var errorMessage: String? = nil
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmSignOut = false

    private var profileChanged: Bool {
        guard let me = org.me else { return false }
        return displayName.trimmed != (me.displayName ?? "")
            || phone.trimmed != (me.phone ?? "")
            || title.trimmed != (me.title ?? "")
    }

    private var canSave: Bool {
        displayName.nilIfBlank != nil && displayName.count <= 200 && phone.count <= 50 && title.count <= 200
            && profileChanged && !isSaving
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = (info?["CFBundleShortVersionString"] as? String) ?? "?"
        let build = (info?["CFBundleVersion"] as? String) ?? "?"
        return "\(version) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                TextField("Display name", text: $displayName)
                    .textContentType(.name)
                TextField("Title (e.g. RN Case Manager)", text: $title)
                TextField("Phone", text: $phone)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }
                if let saveMessage {
                    Text(saveMessage).font(.footnote).foregroundStyle(.green)
                }
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Save profile") }
                }
                .disabled(!canSave)
            } header: {
                Text("Profile")
            } footer: {
                Text("Your role, discipline and teams are managed by your administrator.")
            }

            Section("Account") {
                LabeledContent("Email", value: org.me?.email ?? session.email ?? "—")
                LabeledContent("Role", value: org.role.label)
                if let discipline = org.me?.discipline {
                    LabeledContent("Discipline", value: discipline.label)
                }
                LabeledContent("Organization", value: org.org?.name ?? org.orgId)
            }

            Section {
                Toggle("Require \(lock.biometryLabel)", isOn: Binding(
                    get: { lock.isEnabled },
                    set: { lock.setEnabled($0) }
                ))
                if let reason = lock.unavailableReason {
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("Security")
            } footer: {
                Text("AuraConnect locks on launch and after 5 minutes in the background, and hides its content in the app switcher. Data stored on this device is encrypted with your device passcode.")
            }

            Section {
                LabeledContent("Status", value: notificationStatusText)
                Button("Open notification settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        openURL(url)
                    }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text("Notifications never include message text or patient details.")
            }

            Section {
                Button("Sign out", role: .destructive) {
                    confirmSignOut = true
                }
            }

            Section {
                LabeledContent("Version", value: appVersion)
                if FirebaseService.usingEmulators {
                    LabeledContent("Backend", value: "Local emulators")
                }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Sign out of AuraConnect?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task {
                    router.reset()
                    await session.signOut()
                }
            }
        }
        .task {
            loadProfileIfNeeded()
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            notificationStatus = settings.authorizationStatus
        }
        .onChange(of: org.membersLoaded) { _, _ in
            loadProfileIfNeeded()
        }
    }

    private var notificationStatusText: String {
        switch notificationStatus {
        case .authorized: return "Allowed"
        case .denied: return "Off"
        case .provisional: return "Provisional"
        case .ephemeral: return "Ephemeral"
        case .notDetermined: return "Not requested"
        @unknown default: return "Unknown"
        }
    }

    private func loadProfileIfNeeded() {
        guard !didLoadProfile, let me = org.me else { return }
        displayName = me.displayName ?? ""
        phone = me.phone ?? ""
        title = me.title ?? ""
        didLoadProfile = true
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        saveMessage = nil
        defer { isSaving = false }
        do {
            try await MemberRepository(orgId: org.orgId).updateProfile(
                uid: org.uid,
                displayName: displayName,
                phone: phone,
                title: title
            )
            saveMessage = "Saved"
        } catch {
            errorMessage = error.userMessage
        }
    }
}
