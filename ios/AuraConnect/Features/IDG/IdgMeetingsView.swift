import SwiftUI
import Observation

@MainActor
@Observable
final class IdgMeetingsViewModel {
    let orgId: String
    private(set) var meetings: [IdgMeeting] = []
    private(set) var isLoading = true
    var errorMessage: String?

    init(orgId: String) {
        self.orgId = orgId
    }

    /// Scheduled meetings, soonest first.
    var scheduled: [IdgMeeting] {
        meetings.filter { !$0.isCompleted }
            .sorted { ($0.scheduledAt ?? .distantFuture) < ($1.scheduledAt ?? .distantFuture) }
    }

    /// Completed meetings, newest first.
    var completed: [IdgMeeting] {
        meetings.filter { $0.isCompleted }
    }

    func run() async {
        do {
            for try await list in IdgRepository(orgId: orgId).meetings() {
                meetings = list
                isLoading = false
                errorMessage = nil
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}

/// Interdisciplinary group meetings.
struct IdgMeetingsView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        IdgMeetingsContent(orgId: org.orgId)
    }
}

private struct IdgMeetingsContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: IdgMeetingsViewModel
    @State private var showNew = false

    init(orgId: String) {
        _model = State(initialValue: IdgMeetingsViewModel(orgId: orgId))
    }

    private var canCreate: Bool { org.role.canManageReferrals }

    var body: some View {
        List {
            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }
            Section("Scheduled") {
                if model.scheduled.isEmpty && !model.isLoading {
                    Text("No scheduled meetings.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.scheduled) { meeting in
                    if let id = meeting.id {
                        NavigationLink(value: Route.idgMeeting(id)) {
                            IdgMeetingRow(meeting: meeting)
                        }
                    }
                }
            }
            if !model.completed.isEmpty {
                Section("Completed") {
                    ForEach(model.completed) { meeting in
                        if let id = meeting.id {
                            NavigationLink(value: Route.idgMeeting(id)) {
                                IdgMeetingRow(meeting: meeting)
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if model.isLoading { ProgressView() }
        }
        .navigationTitle("IDG meetings")
        .toolbar {
            if canCreate {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showNew = true
                    } label: {
                        Label("New meeting", systemImage: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showNew) {
            NewIdgMeetingView { meetingId in
                showNew = false
                router.push(.idgMeeting(meetingId))
            }
            .environment(org)
        }
        .task { await model.run() }
    }
}

struct IdgMeetingRow: View {
    let meeting: IdgMeeting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(meeting.displayTitle)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if meeting.isCompleted {
                    StatusPill(text: "Completed", color: .green)
                }
            }
            Text(RelativeTime.full(meeting.scheduledAt))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("\(meeting.agenda.count) patients · \(meeting.reviewedCount) reviewed")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - New meeting

@MainActor
@Observable
final class NewIdgMeetingViewModel {
    let orgId: String
    var title = "IDG meeting"
    var scheduledAt: Date
    var teamId: String?
    var attendeeUids: Set<String>
    /// false = let the server fill the agenda with patients due for review.
    var choosePatients = false
    var patientIds: Set<String> = []
    private(set) var teams: [Team] = []
    private(set) var patients: [Patient] = []
    private(set) var isWorking = false
    var errorMessage: String?

    init(orgId: String, myUid: String) {
        self.orgId = orgId
        self.attendeeUids = [myUid]
        // Default: tomorrow at 09:00.
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
        self.scheduledAt = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    var isValid: Bool {
        title.nilIfBlank != nil && (!choosePatients || !patientIds.isEmpty)
    }

    func runTeams() async {
        do {
            for try await list in TeamRepository(orgId: orgId).teams() {
                teams = list
                    .filter { $0.id != nil }
                    .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func runPatients() async {
        do {
            for try await list in PatientRepository(orgId: orgId).patients() {
                patients = list
                    .filter { $0.id != nil && $0.patientStatus == .admitted }
                    .sorted { $0.sortName.localizedCaseInsensitiveCompare($1.sortName) == .orderedAscending }
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func togglePatient(_ id: String) {
        if patientIds.contains(id) {
            patientIds.remove(id)
        } else {
            patientIds.insert(id)
        }
    }

    /// Returns the new meeting id.
    func submit() async -> String? {
        guard isValid, !isWorking, let title = title.nilIfBlank else { return nil }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            return try await FunctionsClient().createIdgMeeting(
                orgId: orgId,
                title: title,
                scheduledAt: scheduledAt,
                teamId: teamId,
                attendeeUids: attendeeUids.sorted(),
                patientIds: choosePatients ? patientIds.sorted() : nil
            )
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

struct NewIdgMeetingView: View {
    @Environment(OrgStore.self) private var org
    let onCreated: (String) -> Void

    var body: some View {
        NewIdgMeetingContent(orgId: org.orgId, myUid: org.uid, onCreated: onCreated)
    }
}

private struct NewIdgMeetingContent: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: NewIdgMeetingViewModel
    let onCreated: (String) -> Void

    init(orgId: String, myUid: String, onCreated: @escaping (String) -> Void) {
        _model = State(initialValue: NewIdgMeetingViewModel(orgId: orgId, myUid: myUid))
        self.onCreated = onCreated
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }
                Section("Meeting") {
                    TextField("Title", text: $model.title)
                    DatePicker("When", selection: $model.scheduledAt)
                    Picker("Team", selection: $model.teamId) {
                        Text("None").tag(String?.none)
                        ForEach(model.teams) { team in
                            Text(team.displayName).tag(team.id)
                        }
                    }
                }

                IdgAttendeeSection(selection: $model.attendeeUids)

                Section {
                    Toggle("Choose patients", isOn: $model.choosePatients)
                    if model.choosePatients {
                        if model.patients.isEmpty {
                            Text("No admitted patients.").foregroundStyle(.secondary)
                        }
                        ForEach(model.patients) { patient in
                            if let id = patient.id {
                                Button {
                                    model.togglePatient(id)
                                } label: {
                                    HStack {
                                        Text(patient.sortName).foregroundStyle(Color.primary)
                                        Spacer()
                                        Image(systemName: model.patientIds.contains(id) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(model.patientIds.contains(id) ? Color.accentColor : Color.secondary)
                                    }
                                }
                                .accessibilityAddTraits(model.patientIds.contains(id) ? .isSelected : [])
                            }
                        }
                    }
                } header: {
                    Text("Agenda")
                } footer: {
                    if !model.choosePatients {
                        Text("The agenda is filled with admitted patients whose IDG review is due within 7 days of the meeting.")
                    }
                }
            }
            .disabled(model.isWorking)
            .navigationTitle("New IDG meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button("Create") {
                            Task {
                                if let id = await model.submit() { onCreated(id) }
                            }
                        }
                        .disabled(!model.isValid)
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
            .task { await model.runTeams() }
            .task { await model.runPatients() }
        }
    }
}

/// Multi-select of active members as meeting attendees.
struct IdgAttendeeSection: View {
    @Environment(OrgStore.self) private var org
    @Binding var selection: Set<String>

    var body: some View {
        Section {
            ForEach(org.activeMembers) { member in
                Button {
                    if selection.contains(member.memberUid) {
                        selection.remove(member.memberUid)
                    } else {
                        selection.insert(member.memberUid)
                    }
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(initials: member.initials, size: 30)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.name).foregroundStyle(Color.primary)
                            if !member.subtitle.isEmpty {
                                Text(member.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: selection.contains(member.memberUid) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selection.contains(member.memberUid) ? Color.accentColor : Color.secondary)
                    }
                }
                .accessibilityAddTraits(selection.contains(member.memberUid) ? .isSelected : [])
            }
        } header: {
            Text("Attendees (\(selection.count))")
        }
    }
}
