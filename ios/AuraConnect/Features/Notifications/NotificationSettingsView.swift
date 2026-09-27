import SwiftUI
import UserNotifications

/// v4 notification settings: quiet hours and off-shift quiet (`member.notificationSettings`),
/// plus the device's push permission.
struct NotificationSettingsView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var quietHoursOn = false
    @State private var quietStart = QuietTime.parse("22:00") ?? Date()
    @State private var quietEnd = QuietTime.parse("07:00") ?? Date()
    @State private var offShiftQuiet = false
    @State private var didLoad = false
    @State private var isSaving = false
    @State private var saveMessage: String?
    @State private var errorMessage: String?
    @State private var authorization: UNAuthorizationStatus = .notDetermined

    private var draft: NotificationSettings {
        NotificationSettings(
            quietHours: quietHoursOn
                ? NotificationSettings.QuietHours(start: QuietTime.string(from: quietStart), end: QuietTime.string(from: quietEnd))
                : nil,
            offShiftQuiet: offShiftQuiet
        )
    }

    private var saved: NotificationSettings {
        org.me?.notificationSettings ?? NotificationSettings(quietHours: nil, offShiftQuiet: false)
    }

    private var hasChanges: Bool { draft != saved }

    private var quietHoursInvalid: Bool {
        quietHoursOn && QuietTime.string(from: quietStart) == QuietTime.string(from: quietEnd)
    }

    var body: some View {
        Form {
            permissionSection

            Section {
                Toggle("Quiet hours", isOn: $quietHoursOn)
                if quietHoursOn {
                    DatePicker("From", selection: $quietStart, displayedComponents: .hourAndMinute)
                    DatePicker("To", selection: $quietEnd, displayedComponents: .hourAndMinute)
                    if quietHoursInvalid {
                        Text("Start and end must be different.").font(.footnote).foregroundStyle(.red)
                    }
                }
            } header: {
                Text("Quiet hours")
            } footer: {
                Text(quietHoursFooter)
            }

            Section {
                Toggle("Quiet when off shift", isOn: $offShiftQuiet)
            } footer: {
                Text("If you hold on-call shifts, normal-priority messages don't notify you outside them.")
            }

            Section {
                Label {
                    Text("Urgent and critical messages and alerts always come through, even during quiet hours, when you're off shift, or when a conversation is muted.")
                } icon: {
                    Image(systemName: "exclamationmark.bubble.fill").foregroundStyle(.red)
                }
                .font(.subheadline)
                Text("Direct messages notify you unless you mute that conversation. Per-conversation settings are in each conversation's info.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }
                if let saveMessage {
                    Text(saveMessage).font(.footnote).foregroundStyle(.green)
                }
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Save") }
                }
                .disabled(isSaving || !hasChanges || quietHoursInvalid || org.me == nil)
            }
        }
        .navigationTitle("Notifications")
        .task {
            loadIfNeeded()
            await refreshAuthorization()
        }
        .onChange(of: org.membersLoaded) { _, _ in
            loadIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            // Returning from the iOS Settings app.
            if phase == .active {
                Task { await refreshAuthorization() }
            }
        }
    }

    @ViewBuilder
    private var permissionSection: some View {
        switch authorization {
        case .denied:
            Section {
                Label("Notifications are turned off for AuraConnect.", systemImage: "bell.slash.fill")
                    .foregroundStyle(.orange)
                Button("Open iOS Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        openURL(url)
                    }
                }
            } footer: {
                Text("Turn on Allow Notifications so you don't miss urgent messages and alerts.")
            }
        case .notDetermined:
            Section {
                Button("Allow notifications") {
                    Task {
                        await PushTokenRegistrar.requestAuthorizationAndRegister()
                        await refreshAuthorization()
                    }
                }
            }
        default:
            EmptyView()
        }
    }

    private var quietHoursFooter: String {
        let zone = org.org?.timezone?.nilIfBlank
        let zoneText = zone.map { " Times are in your organization's time zone (\($0))." } ?? ""
        return "Normal-priority messages in group, team and patient conversations don't notify you during quiet hours." + zoneText
    }

    private func loadIfNeeded() {
        guard !didLoad, let me = org.me else { return }
        didLoad = true
        let settings = me.notificationSettings
        if let hours = settings?.quietHours {
            quietHoursOn = true
            quietStart = QuietTime.parse(hours.start) ?? quietStart
            quietEnd = QuietTime.parse(hours.end) ?? quietEnd
        }
        offShiftQuiet = settings?.offShiftQuiet ?? false
    }

    private func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        saveMessage = nil
        defer { isSaving = false }
        do {
            try await MemberSelfRepository(orgId: org.orgId).setNotificationSettings(uid: org.uid, settings: draft)
            saveMessage = "Saved"
        } catch {
            errorMessage = error.userMessage
        }
    }
}
