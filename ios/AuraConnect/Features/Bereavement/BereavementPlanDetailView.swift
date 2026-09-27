import SwiftUI
import Observation

@MainActor
@Observable
final class BereavementPlanViewModel {
    let orgId: String
    let planId: String
    private(set) var plan: BereavementPlan?
    private(set) var isLoading = true
    private(set) var isSaving = false
    var errorMessage: String?

    init(orgId: String, planId: String) {
        self.orgId = orgId
        self.planId = planId
    }

    func run() async {
        do {
            for try await value in BereavementRepository(orgId: orgId).plan(id: planId) {
                plan = value
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Sends the full editable state (`updateBereavementPlan`).
    func save(assignedUid: String?, risk: BereavementRisk, status: BereavementPlanStatus) async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await FunctionsClient().updateBereavementPlan(orgId: orgId, planId: planId, assignedUid: assignedUid,
                                                              riskLevel: risk, status: status)
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// One bereavement plan: family contact, risk, coordinator and the 13-month contact schedule.
struct BereavementPlanDetailView: View {
    @Environment(OrgStore.self) private var org
    let planId: String

    var body: some View {
        if org.isVolunteerMember {
            ContentUnavailableView("Not available",
                                   systemImage: "heart.slash",
                                   description: Text("Bereavement plans are not available to volunteers."))
        } else {
            BereavementPlanDetailContent(orgId: org.orgId, planId: planId)
        }
    }
}

private struct BereavementPlanDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: BereavementPlanViewModel
    @State private var action: BereavementContactAction?
    @State private var confirmClose = false

    init(orgId: String, planId: String) {
        _model = State(initialValue: BereavementPlanViewModel(orgId: orgId, planId: planId))
    }

    /// Coordinator, SW/Chaplain, `bereavement` capability or admin (server enforces the same).
    private var canEdit: Bool { model.plan.map { org.canWorkBereavementPlan($0) } ?? false }

    var body: some View {
        Group {
            if let plan = model.plan {
                details(plan)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Plan not found",
                                       systemImage: "heart.slash",
                                       description: Text(model.errorMessage ?? "This bereavement plan is unavailable."))
            }
        }
        .navigationTitle(model.plan?.displayPatientName ?? "Bereavement plan")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $action) { action in
            BereavementContactUpdateView(action: action)
                .environment(org)
        }
        .confirmationDialog("Close this bereavement plan?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close plan", role: .destructive) {
                guard let plan = model.plan else { return }
                Task { await model.save(assignedUid: plan.assignedUid, risk: plan.risk, status: .closed) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Bereavement", isPresented: Binding(
            get: { model.errorMessage != nil && model.plan != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .task { await model.run() }
    }

    private func details(_ plan: BereavementPlan) -> some View {
        List {
            Section {
                HStack {
                    Text(plan.displayPatientName).font(.title3.weight(.semibold))
                    Spacer()
                    StatusPill(text: plan.planStatus.label, color: plan.planStatus == .active ? .blue : .secondary)
                }
                InfoRow(label: "Date of death", value: ISODate.display(plan.deathDate))
                InfoRow(label: "Plan closes", value: ISODate.display(plan.closesOn))
                if let patientId = plan.patientId?.nilIfBlank {
                    NavigationLink(value: Route.patient(patientId)) {
                        Label("Open patient chart", systemImage: "person.text.rectangle")
                    }
                }
            }

            if plan.needsReview == true && plan.planStatus == .active {
                Section {
                    Label("This plan passed its close date with contacts still pending. Mark them done or skipped; it then closes automatically.",
                          systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }

            BereavementSurvivorsSection(survivors: plan.survivorList)

            Section {
                if canEdit && plan.planStatus == .active {
                    Picker("Risk", selection: Binding(
                        get: { plan.risk },
                        set: { newRisk in
                            Task { await model.save(assignedUid: plan.assignedUid, risk: newRisk, status: plan.planStatus) }
                        }
                    )) {
                        ForEach(BereavementRisk.allCases) { risk in
                            Text(risk.label).tag(risk)
                        }
                    }
                    CareMemberPicker(title: "Coordinator", selection: Binding(
                        get: { plan.assignedUid },
                        set: { newUid in
                            Task { await model.save(assignedUid: newUid, risk: plan.risk, status: plan.planStatus) }
                        }
                    ), members: org.activeMembers)
                } else {
                    LabeledContent("Risk") {
                        StatusPill(text: plan.risk.label, color: plan.risk.color)
                    }
                    LabeledContent("Coordinator", value: plan.assignedUid.map { org.name(for: $0) } ?? "Unassigned")
                }
                if model.isSaving {
                    ProgressView()
                }
            } header: {
                Text("Plan")
            }

            Section {
                ForEach(plan.sortedContacts) { contact in
                    BereavementContactRow(contact: contact)
                        .swipeActions(edge: .leading) {
                            if canEdit && contact.status == .pending, let id = plan.id {
                                Button {
                                    action = BereavementContactAction(planId: id, contact: contact, status: .done)
                                } label: {
                                    Label("Done", systemImage: "checkmark")
                                }
                                .tint(.green)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if canEdit && contact.status == .pending, let id = plan.id {
                                Button {
                                    action = BereavementContactAction(planId: id, contact: contact, status: .skipped)
                                } label: {
                                    Label("Skip", systemImage: "forward")
                                }
                                .tint(.gray)
                            }
                        }
                        .contextMenu {
                            if canEdit, let id = plan.id {
                                if contact.status == .pending {
                                    Button {
                                        action = BereavementContactAction(planId: id, contact: contact, status: .done)
                                    } label: {
                                        Label("Mark done", systemImage: "checkmark.circle")
                                    }
                                    Button {
                                        action = BereavementContactAction(planId: id, contact: contact, status: .skipped)
                                    } label: {
                                        Label("Skip", systemImage: "forward")
                                    }
                                } else {
                                    Button {
                                        action = BereavementContactAction(planId: id, contact: contact, status: .pending)
                                    } label: {
                                        Label("Mark pending again", systemImage: "arrow.uturn.backward")
                                    }
                                }
                            }
                        }
                }
            } header: {
                Text("Contact schedule")
            } footer: {
                if canEdit {
                    Text("Swipe a pending contact to mark it done or skip it.")
                }
            }

            if canEdit && plan.planStatus == .active {
                Section {
                    Button("Close plan", role: .destructive) {
                        confirmClose = true
                    }
                    .disabled(model.isSaving)
                }
            }
        }
    }
}
