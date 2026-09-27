import SwiftUI

/// v3 (V4) visit permissions, mirroring `functions/src/visits/visits.ts` (the server re-checks):
///  - manage (reschedule / cancel / reassign): a clinical role or the `scheduling` capability, and
///    admin/`scheduling`, the patient's care team, the assignee or the visit's creator;
///  - complete: the same, or an Aide/LPN (any role) completing a visit assigned to them.
extension OrgStore {
    /// Admin or the `scheduling` capability.
    var isScheduler: Bool { role == .admin || (me?.has(capability: "scheduling") ?? false) }

    /// Aide/LPN (`FIELD_DISCIPLINES`): may complete their own visits even with role `viewer`.
    var isFieldStaff: Bool { me?.discipline == .aide || me?.discipline == .lpn }

    /// `careTeamUids` nil = unknown (lists across patients): the care-team check is left to the server.
    func canManage(visit: Visit, careTeamUids: [String]? = nil) -> Bool {
        guard role.canManageCare || isScheduler else { return false }
        if isScheduler { return true }
        if let careTeamUids, !careTeamUids.contains(uid), visit.assignedUid != uid, visit.createdBy != uid { return false }
        return true
    }

    func canComplete(visit: Visit, careTeamUids: [String]? = nil) -> Bool {
        let status = visit.visitStatus
        guard status == .scheduled || status == .missed else { return false }
        if visit.assignedUid == uid && (isFieldStaff || role.canManageCare) { return true }
        return canManage(visit: visit, careTeamUids: careTeamUids)
    }

    func canCancel(visit: Visit, careTeamUids: [String]? = nil) -> Bool {
        visit.visitStatus == .scheduled && canManage(visit: visit, careTeamUids: careTeamUids)
    }

    /// Missed visits go back to scheduled at a future time.
    func canReschedule(visit: Visit, careTeamUids: [String]? = nil) -> Bool {
        visit.visitStatus == .missed && canManage(visit: visit, careTeamUids: careTeamUids)
    }
}

extension FunctionsClient {
    /// Moves a missed (or scheduled) visit to a new time; the server requires a future start for a
    /// missed visit, sets it back to `scheduled` and resolves its missed-visit alert. The note is kept.
    func rescheduleVisit(orgId: String, visitId: String, assignedUid: String?, start: Date, end: Date) async throws {
        _ = try await call("updateVisit", [
            "orgId": orgId,
            "visitId": visitId,
            "assignedUid": orNull(assignedUid?.nilIfBlank),
            "start": ISOInstant.string(from: start),
            "end": ISOInstant.string(from: end),
        ])
    }

    /// Bulk-moves scheduled visits to one member (`scheduling` / `staffing`). Returns how many moved.
    func reassignVisits(orgId: String, visitIds: [String], assignedUid: String, reason: String) async throws -> Int {
        let response = try await call("reassignVisits", [
            "orgId": orgId,
            "visitIds": visitIds,
            "assignedUid": assignedUid,
            "reason": reason.trimmed,
        ])
        return response["reassigned"] as? Int ?? 0
    }
}

/// Reschedules a missed visit to a future time (it becomes scheduled again).
struct RescheduleVisitView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let visit: Visit

    @State private var assignedUid: String?
    @State private var start: Date = Date()
    @State private var end: Date = Date().addingTimeInterval(3600)
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var isValid: Bool { start > Date() && end > start }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Patient", value: visit.displayPatientName)
                    LabeledContent("Was scheduled", value: visit.timeRange)
                } footer: {
                    Text("The visit goes back to scheduled and its missed-visit alert is resolved.")
                }
                Section("New time") {
                    DatePicker("Starts", selection: $start, in: Date()...)
                    DatePicker("Ends", selection: $end, in: start...)
                    if !isValid {
                        Text("Choose a future start, and an end after it.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    CareMemberPicker(title: "Assigned to", selection: $assignedUid, members: org.activeMembers)
                }
            }
            .navigationTitle("Reschedule visit")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Reschedule", isWorking: isSubmitting, isEnabled: isValid && visit.id != nil) {
                        Task { await submit() }
                    }
                }
            }
            .onChange(of: start) { _, newValue in
                if end <= newValue { end = newValue.addingTimeInterval(3600) }
            }
            .onAppear(perform: load)
        }
        .presentationDetents([.medium, .large])
    }

    private func load() {
        guard !didLoad else { return }
        didLoad = true
        assignedUid = visit.assignedUid
        // Tomorrow at the original time of day, same length.
        let calendar = Calendar.current
        let original = visit.scheduledStart ?? Date()
        let length = max(900, (visit.scheduledEnd ?? original.addingTimeInterval(3600)).timeIntervalSince(original))
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date()) ?? Date().addingTimeInterval(86_400)
        let time = calendar.dateComponents([.hour, .minute], from: original)
        let proposed = calendar.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: tomorrow) ?? tomorrow
        start = proposed
        end = proposed.addingTimeInterval(length)
    }

    private func submit() async {
        guard let visitId = visit.id, isValid, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().rescheduleVisit(orgId: org.orgId, visitId: visitId, assignedUid: assignedUid, start: start, end: end)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
