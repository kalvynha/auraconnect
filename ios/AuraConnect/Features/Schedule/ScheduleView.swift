import SwiftUI
import Observation

@MainActor
@Observable
final class ScheduleViewModel {
    let orgId: String
    let uid: String
    private(set) var roles: [OnCallRole] = []
    private(set) var shifts: [Shift] = []
    private(set) var isLoading = true
    var errorMessage: String?

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    private var repository: ScheduleRepository { ScheduleRepository(orgId: orgId) }

    func runRoles() async {
        do {
            for try await list in repository.onCallRoles() {
                roles = list.sorted { $0.displayLabel.localizedCaseInsensitiveCompare($1.displayLabel) == .orderedAscending }
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func runShifts() async {
        do {
            for try await list in repository.currentAndUpcomingShifts(from: Date()) {
                shifts = list
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Shifts active at `now` for a role (`start <= now < end`).
    func onCall(for role: OnCallRole, at now: Date) -> [Shift] {
        shifts.filter { $0.roleKey == role.roleKey && $0.isActive(at: now) }
    }

    /// My shifts that haven't ended, soonest first.
    func myShifts(at now: Date) -> [Shift] {
        shifts
            .filter { $0.uid == uid && ($0.end ?? .distantPast) > now }
            .sorted { ($0.start ?? .distantPast) < ($1.start ?? .distantPast) }
    }

    func roleLabel(for key: String?) -> String {
        guard let key else { return "Shift" }
        return roles.first { $0.roleKey == key }?.displayLabel ?? key
    }
}

struct ScheduleView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        ScheduleContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct ScheduleContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: ScheduleViewModel

    init(orgId: String, uid: String) {
        _model = State(initialValue: ScheduleViewModel(orgId: orgId, uid: uid))
    }

    var body: some View {
        // Re-evaluate "now" every minute so shift boundaries roll over on screen.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            list(now: context.date)
        }
        .navigationTitle("Schedule")
        .task { await model.runRoles() }
        .task { await model.runShifts() }
    }

    private func list(now: Date) -> some View {
        List {
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }

            Section("On call now") {
                if model.roles.isEmpty && !model.isLoading {
                    Text("No on-call roles are configured.").foregroundStyle(.secondary)
                }
                ForEach(model.roles) { role in
                    let active = model.onCall(for: role, at: now)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(role.displayLabel).font(.headline)
                        if active.isEmpty {
                            let fallback = role.fallbackUids ?? []
                            let message: String = fallback.isEmpty
                                ? "Nobody scheduled"
                                : "Nobody scheduled · fallback: \(org.names(for: fallback))"
                            Text(message)
                                .font(.subheadline)
                                .foregroundStyle(.orange)
                        } else {
                            ForEach(active) { shift in
                                HStack {
                                    Text(org.name(for: shift.uid))
                                    Spacer()
                                    if let end = shift.end {
                                        Text("until \(end.formatted(date: .omitted, time: .shortened))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .font(.subheadline)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                }
            }

            Section("My shifts") {
                let mine = model.myShifts(at: now)
                if mine.isEmpty {
                    Text(model.isLoading ? String("Loading…") : String("No upcoming shifts."))
                        .foregroundStyle(.secondary)
                }
                ForEach(mine) { shift in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(model.roleLabel(for: shift.roleKey)).font(.headline)
                            if shift.isActive(at: now) {
                                StatusPill(text: "On now", color: .green)
                            }
                        }
                        Text(shiftRange(shift))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let notes = shift.notes?.nilIfBlank {
                            Text(notes).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .overlay {
            if model.isLoading && model.roles.isEmpty { ProgressView() }
        }
    }

    private func shiftRange(_ shift: Shift) -> String {
        guard let start = shift.start, let end = shift.end else { return "—" }
        let startText = start.formatted(date: .abbreviated, time: .shortened)
        let sameDay = Calendar.current.isDate(start, inSameDayAs: end)
        let endText = sameDay ? end.formatted(date: .omitted, time: .shortened) : end.formatted(date: .abbreviated, time: .shortened)
        return "\(startText) – \(endText)"
    }
}
