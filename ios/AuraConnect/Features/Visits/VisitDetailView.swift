import SwiftUI
import Observation

@MainActor
@Observable
final class VisitDetailViewModel {
    let orgId: String
    let visitId: String
    private(set) var visit: Visit?
    /// The visit's patient (care team for permissions; status for "Record death").
    private(set) var patient: Patient?
    private(set) var isLoading = true
    var completing: Visit?
    var cancelling: Visit?
    var rescheduling: Visit?
    var recordingDeath = false
    var errorMessage: String?

    init(orgId: String, visitId: String) {
        self.orgId = orgId
        self.visitId = visitId
    }

    func run() async {
        do {
            for try await value in VisitRepository(orgId: orgId).visit(id: visitId) {
                visit = value
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Streams the patient once the visit's patient id is known (restart when it changes).
    func runPatient(id: String?) async {
        guard let id = id?.nilIfBlank else { return }
        do {
            for try await value in PatientRepository(orgId: orgId).patient(id: id) {
                patient = value
            }
        } catch {
            // The visit stays usable without the patient; the server re-checks every action.
        }
    }
}

/// One visit with its patient context (address, code status, allergies, caregiver, last note)
/// and complete / reschedule / cancel actions, plus "Record death" for licensed staff (O1).
struct VisitDetailView: View {
    @Environment(OrgStore.self) private var org
    let visitId: String

    var body: some View {
        VisitDetailContent(orgId: org.orgId, visitId: visitId)
    }
}

private struct VisitDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: VisitDetailViewModel

    init(orgId: String, visitId: String) {
        _model = State(initialValue: VisitDetailViewModel(orgId: orgId, visitId: visitId))
    }

    var body: some View {
        @Bindable var model = model
        Group {
            if let visit = model.visit {
                details(visit)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Visit unavailable",
                                       systemImage: "calendar.badge.exclamationmark",
                                       description: Text(model.errorMessage ?? "This visit may have been removed."))
            }
        }
        .navigationTitle("Visit")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.run() }
        .task(id: model.visit?.patientId) { await model.runPatient(id: model.visit?.patientId) }
        .sheet(item: $model.completing) { visit in
            CompleteVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.cancelling) { visit in
            CancelVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.rescheduling) { visit in
            RescheduleVisitView(visit: visit)
                .environment(org)
        }
        .sheet(isPresented: $model.recordingDeath) {
            if let patient = model.patient {
                RecordDeathView(patient: patient, visitId: model.visit?.id)
                    .environment(org)
            }
        }
    }

    private var careTeam: [String]? { model.patient?.careTeamUids }

    /// O1: licensed staff (RN/NP/MD/admin) at a scheduled or in-progress visit of an admitted patient.
    private func canRecordDeath(_ visit: Visit) -> Bool {
        guard org.role.canManageCare, org.isLicensed, model.patient?.patientStatus == .admitted else { return false }
        let status = visit.visitStatus
        guard status == .scheduled || status == .missed else { return false }
        // In progress, or starting within the hour.
        guard let start = visit.scheduledStart else { return true }
        return start <= Date().addingTimeInterval(3600)
    }

    @ViewBuilder
    private func details(_ visit: Visit) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(visit.displayPatientName).font(.title3.weight(.semibold))
                        Spacer()
                        StatusPill(text: visit.visitStatus.label, color: visit.visitStatus.color)
                    }
                    Text(visit.timeRange).font(.subheadline)
                    Text("\(visit.discipline?.label ?? "Visit") · \(visit.assignedUid.map { org.name(for: $0) } ?? "Unassigned")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let type = visit.type?.nilIfBlank, type != "routine" {
                        Text(type.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                if let patientId = visit.patientId?.nilIfBlank {
                    NavigationLink(value: Route.patient(patientId)) {
                        Label("Open patient chart", systemImage: "person.text.rectangle")
                    }
                }
            }

            if let error = model.errorMessage {
                Section { ErrorBanner(message: error) }
            }

            let completable = org.canComplete(visit: visit, careTeamUids: careTeam)
            let reschedulable = org.canReschedule(visit: visit, careTeamUids: careTeam)
            let cancellable = org.canCancel(visit: visit, careTeamUids: careTeam)
            let death = canRecordDeath(visit)
            if completable || reschedulable || cancellable || death {
                Section {
                    if completable {
                        Button {
                            model.completing = visit
                        } label: {
                            Label(visit.visitStatus == .missed ? "Document missed visit" : "Complete visit",
                                  systemImage: "checkmark.circle.fill")
                                .font(.body.weight(.semibold))
                        }
                    }
                    if reschedulable {
                        Button {
                            model.rescheduling = visit
                        } label: {
                            Label("Reschedule", systemImage: "calendar.badge.clock")
                        }
                    }
                    if cancellable {
                        Button(role: .destructive) {
                            model.cancelling = visit
                        } label: {
                            Label("Cancel visit", systemImage: "xmark.circle")
                        }
                    }
                    if death {
                        Button(role: .destructive) {
                            model.recordingDeath = true
                        } label: {
                            Label("Record death", systemImage: "heart.slash")
                        }
                    }
                } footer: {
                    if visit.visitStatus == .missed {
                        Text("Missed visits can be rescheduled to a future time or documented as completed (late documentation).")
                    } else if death {
                        Text("Recording a death from this visit completes the visit at the time of death.")
                    }
                }
            }

            if let note = visit.note?.nilIfBlank {
                Section(visit.visitStatus == .completed ? "Visit note" : "Note") {
                    Text(note)
                }
            }
            if visit.visitStatus == .cancelled, let reason = visit.cancelledReason?.nilIfBlank {
                Section("Cancelled") {
                    Text(reason)
                }
            }
            if visit.visitStatus == .completed {
                Section {
                    InfoRow(label: "Completed", value: visit.completedAt.map { RelativeTime.full($0) })
                    InfoRow(label: "Completed by", value: visit.completedBy.map { org.name(for: $0) })
                }
            }

            if let patientId = visit.patientId?.nilIfBlank {
                VisitContextSection(patientId: patientId, excludingVisitId: visit.id)
            }
        }
    }
}
