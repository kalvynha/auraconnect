import SwiftUI
import Observation

@MainActor
@Observable
final class VisitDetailViewModel {
    let orgId: String
    let visitId: String
    private(set) var visit: Visit?
    private(set) var isLoading = true
    var completing: Visit?
    var cancelling: Visit?
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
}

/// One visit with its patient context (address, code status, allergies, caregiver, last note)
/// and complete / cancel actions.
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
        .sheet(item: $model.completing) { visit in
            CompleteVisitView(visit: visit)
                .environment(org)
        }
        .sheet(item: $model.cancelling) { visit in
            CancelVisitView(visit: visit)
                .environment(org)
        }
    }

    private func canComplete(_ visit: Visit) -> Bool {
        let status = visit.visitStatus
        guard status == .scheduled || status == .missed else { return false }
        return org.role.canManageCare || visit.assignedUid == org.uid
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

            let completable = canComplete(visit)
            let cancellable = org.role.canManageCare && visit.visitStatus == .scheduled
            if completable || cancellable {
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
                    if cancellable {
                        Button(role: .destructive) {
                            model.cancelling = visit
                        } label: {
                            Label("Cancel visit", systemImage: "xmark.circle")
                        }
                    }
                } footer: {
                    if visit.visitStatus == .missed {
                        Text("Missed visits can still be documented as completed (late documentation).")
                    }
                }
            }

            if let note = visit.note?.nilIfBlank {
                Section(visit.visitStatus == .completed ? "Visit note" : "Note") {
                    Text(note).textSelection(.enabled)
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
