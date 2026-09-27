import SwiftUI
import Observation
import FirebaseFirestore

/// How long a status lasts before it clears itself (`status.until`).
enum StatusDuration: String, CaseIterable, Identifiable {
    case oneHour, fourHours, endOfDay, never

    var id: String { rawValue }

    var label: String {
        switch self {
        case .oneHour: return "1 hour"
        case .fourHours: return "4 hours"
        case .endOfDay: return "End of day"
        case .never: return "Never"
        }
    }

    /// nil = never clears.
    func until(from now: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .oneHour: return now.addingTimeInterval(3600)
        case .fourHours: return now.addingTimeInterval(4 * 3600)
        case .endOfDay:
            let startOfToday = calendar.startOfDay(for: now)
            return calendar.date(byAdding: .day, value: 1, to: startOfToday)
        case .never: return nil
        }
    }
}

@MainActor
@Observable
final class MyStatusViewModel {
    let orgId: String
    let uid: String

    // Status draft
    var state: PresenceState = .available
    var text = ""
    var duration: StatusDuration = .never
    /// Scheduled end of a visit happening now, when the status isn't "In visit" yet.
    private(set) var currentVisitEnd: Date?

    // Out-of-office draft
    var outOfOfficeOn = false
    var outOfOfficeUntil = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    var delegateUid: String?
    var outOfOfficeNote = ""

    private(set) var didLoad = false
    private(set) var isSavingStatus = false
    private(set) var isSavingOutOfOffice = false
    var statusMessage: String?
    var outOfOfficeMessage: String?
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    private var repository: MemberSelfRepository { MemberSelfRepository(orgId: orgId) }

    var statusTextTooLong: Bool { text.count > MemberSelfRepository.maxStatusTextLength }
    var noteTooLong: Bool { outOfOfficeNote.count > MemberSelfRepository.maxOutOfOfficeNoteLength }

    /// Seeds the drafts from the member doc once.
    func load(from me: Member?) {
        guard !didLoad, let me else { return }
        didLoad = true
        if let status = me.currentStatus() {
            state = status.state ?? .available
            text = status.text ?? ""
            duration = .never
        }
        if let ooo = me.activeOutOfOffice(), let until = ooo.until {
            outOfOfficeOn = true
            outOfOfficeUntil = until
            delegateUid = ooo.delegateUid
            outOfOfficeNote = ooo.note ?? ""
        }
    }

    func saveStatus() async {
        guard !statusTextTooLong else { return }
        isSavingStatus = true
        errorMessage = nil
        statusMessage = nil
        defer { isSavingStatus = false }
        let status = MemberStatus(state: state, text: text.nilIfBlank, until: duration.until(from: Date()))
        do {
            try await repository.setStatus(uid: uid, status: status)
            statusMessage = "Status updated"
        } catch {
            errorMessage = error.userMessage
        }
    }

    func clearStatus() async {
        isSavingStatus = true
        errorMessage = nil
        statusMessage = nil
        defer { isSavingStatus = false }
        do {
            try await repository.setStatus(uid: uid, status: nil)
            state = .available
            text = ""
            duration = .never
            statusMessage = "Status cleared"
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// One tap from the "visit in progress" suggestion: In visit until the visit's scheduled end.
    func applyInVisitSuggestion() async {
        guard let end = currentVisitEnd else { return }
        state = .inVisit
        isSavingStatus = true
        errorMessage = nil
        statusMessage = nil
        defer { isSavingStatus = false }
        do {
            // No text: a status is visible org-wide and must never name the patient.
            try await repository.setStatus(uid: uid, status: MemberStatus(state: .inVisit, text: nil, until: end))
            currentVisitEnd = nil
            statusMessage = "Status set to In visit"
        } catch {
            errorMessage = error.userMessage
        }
    }

    func saveOutOfOffice() async {
        guard !noteTooLong else { return }
        isSavingOutOfOffice = true
        errorMessage = nil
        outOfOfficeMessage = nil
        defer { isSavingOutOfOffice = false }
        do {
            if outOfOfficeOn {
                try await repository.setOutOfOffice(
                    uid: uid,
                    until: outOfOfficeUntil,
                    delegateUid: delegateUid,
                    note: outOfOfficeNote
                )
                outOfOfficeMessage = "Out of office saved"
            } else {
                try await repository.setOutOfOffice(uid: uid, until: nil, delegateUid: nil, note: nil)
                outOfOfficeMessage = "Out of office turned off"
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// Looks for one of my scheduled visits whose time window includes now (staff only; the
    /// caller checks `canReadStaffCollections`). One-shot read using the existing
    /// visits (assignedUid ASC, scheduledStart ASC) index.
    func checkCurrentVisit(currentStatus: MemberStatus?) async {
        guard currentStatus?.state != .inVisit else { return }
        let now = Date()
        do {
            let snapshot = try await FirebaseService.orgRef(orgId).collection("visits")
                .whereField("assignedUid", isEqualTo: uid)
                .whereField("scheduledStart", isGreaterThanOrEqualTo: Timestamp(date: now.addingTimeInterval(-12 * 3600)))
                .whereField("scheduledStart", isLessThan: Timestamp(date: now.addingTimeInterval(60)))
                .order(by: "scheduledStart")
                .limit(to: 50)
                .getDocuments()
            let visits = snapshot.documents.compactMap { try? $0.data(as: Visit.self) }
            let current = visits.first { visit in
                guard visit.visitStatus == .scheduled,
                      let start = visit.scheduledStart, let end = visit.scheduledEnd else { return false }
                return start <= now && now < end
            }
            currentVisitEnd = current?.scheduledEnd
        } catch {
            // Non-fatal: no suggestion.
        }
    }
}

/// v4 "My status": presence, custom text, clear-after, and out of office.
struct MyStatusView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        MyStatusContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct MyStatusContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: MyStatusViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: MyStatusViewModel(orgId: orgId, uid: uid))
    }

    /// Active staff other than me (volunteers can't cover for staff).
    private var delegateCandidates: [Member] {
        org.activeMembers.filter { $0.memberUid != org.uid && $0.discipline != .volunteer }
    }

    var body: some View {
        @Bindable var model = model
        Form {
            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            if let end = model.currentVisitEnd {
                Section {
                    Button {
                        Task { await model.applyInVisitSuggestion() }
                    } label: {
                        Label("You have a visit in progress. Set status to In visit until \(end.formatted(date: .omitted, time: .shortened))?",
                              systemImage: "house.fill")
                    }
                    .disabled(model.isSavingStatus)
                }
            }

            statusSection
            outOfOfficeSection
        }
        .navigationTitle("My status")
        .task {
            model.load(from: org.me)
            if org.canReadStaffCollections {
                await model.checkCurrentVisit(currentStatus: org.me?.currentStatus())
            }
        }
        .onChange(of: org.membersLoaded) { _, _ in
            model.load(from: org.me)
        }
    }

    private var statusSection: some View {
        @Bindable var model = model
        return Section {
            Picker("Status", selection: $model.state) {
                ForEach(PresenceState.allCases) { state in
                    Label {
                        Text(state.label)
                    } icon: {
                        PresenceDot(state: state)
                    }
                    .tag(state)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()

            TextField("What's happening? (optional)", text: $model.text)
            if model.statusTextTooLong {
                Text("Keep it under \(MemberSelfRepository.maxStatusTextLength) characters.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Picker("Clear after", selection: $model.duration) {
                ForEach(StatusDuration.allCases) { duration in
                    Text(duration.label).tag(duration)
                }
            }
            if let message = model.statusMessage {
                Text(message).font(.footnote).foregroundStyle(.green)
            }
            Button {
                Task { await model.saveStatus() }
            } label: {
                if model.isSavingStatus { ProgressView() } else { Text("Save status") }
            }
            .disabled(model.isSavingStatus || model.statusTextTooLong)
            if org.me?.currentStatus() != nil {
                Button("Clear status", role: .destructive) {
                    Task { await model.clearStatus() }
                }
                .disabled(model.isSavingStatus)
            }
        } header: {
            Text("Status")
        } footer: {
            Text("Everyone in your organization can see your status. Don't include patient details.")
        }
    }

    private var outOfOfficeSection: some View {
        @Bindable var model = model
        return Section {
            Toggle("I'm out of office", isOn: $model.outOfOfficeOn)
            if model.outOfOfficeOn {
                DatePicker("Until", selection: $model.outOfOfficeUntil, in: Date()...)
                Picker("Contact instead", selection: $model.delegateUid) {
                    Text("Nobody").tag(String?.none)
                    ForEach(delegateCandidates) { member in
                        Text(member.name).tag(String?.some(member.memberUid))
                    }
                }
                TextField("Note (optional)", text: $model.outOfOfficeNote, axis: .vertical)
                    .lineLimit(2...5)
                if model.noteTooLong {
                    Text("Keep the note under \(MemberSelfRepository.maxOutOfOfficeNoteLength) characters.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if let message = model.outOfOfficeMessage {
                Text(message).font(.footnote).foregroundStyle(.green)
            }
            Button {
                Task { await model.saveOutOfOffice() }
            } label: {
                if model.isSavingOutOfOffice { ProgressView() } else { Text("Save out of office") }
            }
            .disabled(model.isSavingOutOfOffice || model.noteTooLong)
        } header: {
            Text("Out of office")
        } footer: {
            Text("People who message you directly are told when you're back and who to contact instead. Normal messages don't notify you while you're away unless you're mentioned.")
        }
    }
}

/// Compact "my status" row (More tab header): presence dot, status text and out-of-office.
struct MyStatusSummaryRow: View {
    let member: Member?

    var body: some View {
        // Re-evaluate every minute so an expired status disappears.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(now: context.date)
        }
    }

    private func content(now: Date) -> some View {
        let status = member?.currentStatus(at: now)
        let ooo = member?.activeOutOfOffice(at: now)
        return HStack(spacing: 8) {
            PresenceDot(state: status?.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(status.map { $0.summary } ?? "Set a status")
                    .foregroundStyle(status == nil ? Color.secondary : Color.primary)
                if let until = ooo?.until {
                    Text("Out of office until \(until.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens My status")
    }
}
