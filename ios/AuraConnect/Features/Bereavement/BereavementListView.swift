import SwiftUI
import Observation

/// A pending contact together with its plan, for the "due" list.
struct DueBereavementContact: Identifiable {
    let plan: BereavementPlan
    let planId: String
    let contact: BereavementContact
    var id: String { "\(planId)/\(contact.id)" }
}

/// Contact being marked done / skipped with an optional note.
struct BereavementContactAction: Identifiable {
    let planId: String
    let contact: BereavementContact
    let status: BereavementContactStatus
    var id: String { "\(planId)/\(contact.id)/\(status.rawValue)" }
}

@MainActor
@Observable
final class BereavementListViewModel {
    let orgId: String
    let uid: String
    private(set) var plans: [BereavementPlan] = []
    private(set) var isLoading = true
    var onlyMine = false
    var errorMessage: String?

    /// Contacts due within this many days are listed under "Due".
    static let dueWindowDays = 7

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    func run() async {
        do {
            for try await list in BereavementRepository(orgId: orgId).activePlans() {
                plans = list
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    var visiblePlans: [BereavementPlan] {
        plans
            .filter { !onlyMine || $0.assignedUid == uid }
            .sorted { ($0.deathDate ?? "") > ($1.deathDate ?? "") }
    }

    /// Pending contacts due (or overdue) within the window, soonest first.
    func dueContacts(today: Date) -> [DueBereavementContact] {
        visiblePlans
            .flatMap { plan -> [DueBereavementContact] in
                guard let planId = plan.id else { return [] }
                return plan.dueContacts(today: today, withinDays: Self.dueWindowDays).map {
                    DueBereavementContact(plan: plan, planId: planId, contact: $0)
                }
            }
            .sorted { $0.contact.dueDate < $1.contact.dueDate }
    }
}

/// Active bereavement plans and the family contacts that are due.
struct BereavementListView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        BereavementListContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct BereavementListContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: BereavementListViewModel
    @State private var action: BereavementContactAction?

    init(orgId: String, uid: String) {
        _model = State(initialValue: BereavementListViewModel(orgId: orgId, uid: uid))
    }

    private var canEdit: Bool { org.role.canSendMessages }

    var body: some View {
        @Bindable var model = model
        let due = model.dueContacts(today: Date())
        let plans = model.visiblePlans
        List {
            Section {
                Toggle("Only plans assigned to me", isOn: $model.onlyMine)
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            Section {
                if due.isEmpty && !model.isLoading {
                    Text("No contacts due in the next \(BereavementListViewModel.dueWindowDays) days.")
                        .foregroundStyle(.secondary)
                }
                ForEach(due) { item in
                    BereavementContactRow(contact: item.contact, patientName: item.plan.displayPatientName)
                        .swipeActions(edge: .leading) {
                            if canEdit {
                                Button {
                                    action = BereavementContactAction(planId: item.planId, contact: item.contact, status: .done)
                                } label: {
                                    Label("Done", systemImage: "checkmark")
                                }
                                .tint(.green)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if canEdit {
                                Button {
                                    action = BereavementContactAction(planId: item.planId, contact: item.contact, status: .skipped)
                                } label: {
                                    Label("Skip", systemImage: "forward")
                                }
                                .tint(.gray)
                            }
                        }
                }
            } header: {
                Text("Contacts due")
            } footer: {
                if canEdit && !due.isEmpty {
                    Text("Swipe right to mark a contact done, left to skip it.")
                }
            }
            Section("Active plans (\(plans.count))") {
                ForEach(plans) { plan in
                    if let id = plan.id {
                        NavigationLink(value: Route.bereavementPlan(id)) {
                            BereavementPlanRow(plan: plan)
                        }
                    }
                }
            }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.plans.isEmpty && model.errorMessage == nil {
                ContentUnavailableView("No active plans",
                                       systemImage: "heart.circle",
                                       description: Text("Bereavement plans are created when a patient's death is recorded."))
            }
        }
        .navigationTitle("Bereavement")
        .sheet(item: $action) { action in
            BereavementContactUpdateView(action: action)
                .environment(org)
        }
        .task { await model.run() }
    }
}

struct BereavementPlanRow: View {
    @Environment(OrgStore.self) private var org
    let plan: BereavementPlan

    var body: some View {
        let dueCount = plan.dueContacts(today: Date(), withinDays: BereavementListViewModel.dueWindowDays).count
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(plan.displayPatientName).font(.headline)
                Spacer()
                StatusPill(text: plan.risk.label, color: plan.risk.color)
            }
            Text("Died \(ISODate.display(plan.deathDate)) · closes \(ISODate.display(plan.closesOn))")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(plan.assignedUid.map { org.name(for: $0) } ?? "Unassigned")
                if dueCount > 0 {
                    Text("· \(dueCount) due").foregroundStyle(.orange)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct BereavementContactRow: View {
    @Environment(OrgStore.self) private var org
    let contact: BereavementContact
    var patientName: String? = nil

    private var isOverdue: Bool {
        guard contact.status == .pending, let days = ISODate.daysFrom(Date(), to: contact.dueDate) else { return false }
        return days < 0
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: contact.type.symbol)
                .foregroundStyle(contact.status.color)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(contact.label)
                if let patientName {
                    Text(patientName).font(.subheadline).foregroundStyle(.secondary)
                }
                Text("\(contact.type.label) · due \(ISODate.display(contact.dueDate))")
                    .font(.caption)
                    .foregroundStyle(isOverdue ? Color.red : Color.secondary)
                if contact.status != .pending {
                    Text("\(contact.status.label) \(RelativeTime.full(contact.completedAt)) by \(org.name(for: contact.completedBy))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let note = contact.note?.nilIfBlank {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if isOverdue {
                StatusPill(text: "Overdue", color: .red)
            } else if contact.status != .pending {
                StatusPill(text: contact.status.label, color: contact.status.color)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Marks a bereavement contact done or skipped (`updateBereavementContact`) with an optional note.
struct BereavementContactUpdateView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let action: BereavementContactAction

    @State private var note = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var title: String { action.status == .done ? "Mark done" : "Skip contact" }
    private var notePrompt: String { action.status == .done ? "How did it go? (optional)" : "Why skipped? (optional)" }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Contact", value: action.contact.label)
                    LabeledContent("Due", value: ISODate.display(action.contact.dueDate))
                }
                Section("Note") {
                    TextField(notePrompt, text: $note, axis: .vertical)
                        .lineLimit(2...6)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: action.status == .done ? "Done" : "Skip", isWorking: isSubmitting, isEnabled: true) {
                        Task { await submit() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        guard !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().updateBereavementContact(orgId: org.orgId, planId: action.planId,
                                                                 contactId: action.contact.id, status: action.status,
                                                                 note: note)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
