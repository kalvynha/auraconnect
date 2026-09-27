import SwiftUI
import Observation

/// A pending contact together with its plan, for the "due" list.
struct DueBereavementContact: Identifiable {
    let plan: BereavementPlan
    let planId: String
    let contact: BereavementContact
    var id: String { "\(planId)/\(contact.id)" }
    var ref: BereavementContactRef { BereavementContactRef(planId: planId, contactId: contact.id) }
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
    private(set) var closedPlans: [BereavementPlan] = []
    private(set) var isLoading = true
    private(set) var closedLoading = false
    private(set) var isBulkWorking = false
    var onlyMine = false
    var showClosed = false
    /// Closed plans are paged: the listener limit grows by `closedPageSize`.
    var closedLimit = BereavementRepository.closedPageSize
    var isSelecting = false
    var selection: Set<String> = []
    var errorMessage: String?
    var bulkResult: String?

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

    func runClosed(limit: Int) async {
        closedLoading = true
        do {
            for try await list in BereavementRepository(orgId: orgId).closedPlans(limit: limit) {
                closedPlans = list
                closedLoading = false
            }
        } catch {
            closedLoading = false
            errorMessage = error.userMessage
        }
    }

    var hitActiveLimit: Bool { plans.count >= BereavementRepository.activeLimit }
    var hasMoreClosed: Bool { closedPlans.count >= closedLimit }

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

    func toggle(_ item: DueBereavementContact) {
        if selection.contains(item.id) {
            selection.remove(item.id)
        } else {
            selection.insert(item.id)
        }
    }

    /// Marks the selected contacts done or skipped (`updateBereavementContacts`).
    func applyBulk(_ status: BereavementContactStatus, due: [DueBereavementContact]) async {
        let refs = due.filter { selection.contains($0.id) }.map(\.ref)
        guard !refs.isEmpty, !isBulkWorking else { return }
        isBulkWorking = true
        defer { isBulkWorking = false }
        do {
            let result = try await FunctionsClient().updateBereavementContacts(orgId: orgId, items: refs, status: status, note: nil)
            selection = []
            isSelecting = false
            let verb = status == .done ? "marked done" : "skipped"
            bulkResult = result.failed == 0
                ? "\(result.updated) contact\(result.updated == 1 ? "" : "s") \(verb)."
                : "\(result.updated) \(verb); \(result.failed) could not be updated (plan closed or not yours)."
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Active bereavement plans and the family contacts that are due.
struct BereavementListView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        if org.isVolunteerMember {
            ContentUnavailableView("Not available",
                                   systemImage: "heart.circle",
                                   description: Text("Bereavement plans are not available to volunteers."))
        } else {
            BereavementListContent(orgId: org.orgId, uid: org.uid)
        }
    }
}

private struct BereavementListContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: BereavementListViewModel
    @State private var action: BereavementContactAction?

    init(orgId: String, uid: String) {
        _model = State(initialValue: BereavementListViewModel(orgId: orgId, uid: uid))
    }

    var body: some View {
        @Bindable var model = model
        let due = model.dueContacts(today: Date())
        let workable = due.filter { org.canWorkBereavementPlan($0.plan) }
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
                    dueRow(item)
                }
            } header: {
                Text("Contacts due")
            } footer: {
                if model.isSelecting {
                    Text("Tap contacts to select them, then mark them done or skipped together.")
                } else if !workable.isEmpty {
                    Text("Swipe right to mark a contact done, left to skip it, or tap Select to update several at once.")
                }
            }
            Section {
                ForEach(plans) { plan in
                    planLink(plan)
                }
            } header: {
                Text("Active plans (\(plans.count))")
            } footer: {
                if model.hitActiveLimit {
                    Text("Showing the first \(BereavementRepository.activeLimit) active plans.")
                }
            }
            Section {
                Toggle("Show closed plans", isOn: $model.showClosed)
                if model.showClosed {
                    ForEach(model.closedPlans) { plan in
                        planLink(plan)
                    }
                    if model.closedLoading {
                        ProgressView()
                    } else if model.hasMoreClosed {
                        Button("Load more") { model.closedLimit += BereavementRepository.closedPageSize }
                    } else if model.closedPlans.isEmpty {
                        Text("No closed plans.").foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Closed plans")
            }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            }
        }
        .navigationTitle("Bereavement")
        .toolbar {
            if !workable.isEmpty || model.isSelecting {
                ToolbarItem(placement: .primaryAction) {
                    Button(model.isSelecting ? "Cancel" : "Select") {
                        model.isSelecting.toggle()
                        model.selection = []
                    }
                }
            }
            if model.isSelecting {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Skip (\(model.selection.count))") {
                        Task { await model.applyBulk(.skipped, due: workable) }
                    }
                    .disabled(model.selection.isEmpty || model.isBulkWorking)
                    Spacer()
                    if model.isBulkWorking {
                        ProgressView()
                    }
                    Spacer()
                    Button("Mark done (\(model.selection.count))") {
                        Task { await model.applyBulk(.done, due: workable) }
                    }
                    .fontWeight(.semibold)
                    .disabled(model.selection.isEmpty || model.isBulkWorking)
                }
            }
        }
        .alert("Bereavement", isPresented: Binding(
            get: { model.bulkResult != nil },
            set: { if !$0 { model.bulkResult = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.bulkResult ?? "")
        }
        .sheet(item: $action) { action in
            BereavementContactUpdateView(action: action)
                .environment(org)
        }
        .task { await model.run() }
        .task(id: model.showClosed ? model.closedLimit : 0) { [limit = model.showClosed ? model.closedLimit : 0] in
            if limit > 0 { await model.runClosed(limit: limit) }
        }
    }

    @ViewBuilder
    private func planLink(_ plan: BereavementPlan) -> some View {
        if let id = plan.id {
            NavigationLink(value: Route.bereavementPlan(id)) {
                BereavementPlanRow(plan: plan)
            }
        }
    }

    @ViewBuilder
    private func dueRow(_ item: DueBereavementContact) -> some View {
        let canEdit = org.canWorkBereavementPlan(item.plan)
        if model.isSelecting {
            Button {
                if canEdit { model.toggle(item) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: model.selection.contains(item.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(canEdit ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                    BereavementContactRow(contact: item.contact, patientName: item.plan.displayPatientName)
                }
            }
            .buttonStyle(.plain)
            .disabled(!canEdit)
            .accessibilityAddTraits(model.selection.contains(item.id) ? .isSelected : [])
        } else {
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
                if plan.needsReview == true && plan.planStatus == .active {
                    StatusPill(text: "Needs review", color: .orange)
                }
                if plan.planStatus == .closed {
                    StatusPill(text: "Closed", color: .secondary)
                } else {
                    StatusPill(text: plan.risk.label, color: plan.risk.color)
                }
            }
            Text("Died \(ISODate.display(plan.deathDate)) · closes \(ISODate.display(plan.closesOn))")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(plan.assignedUid.map { org.name(for: $0) } ?? "Unassigned")
                if dueCount > 0 && plan.planStatus == .active {
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

    private var title: String {
        switch action.status {
        case .done: return "Mark done"
        case .skipped: return "Skip contact"
        case .pending: return "Mark pending"
        }
    }

    private var notePrompt: String { action.status == .done ? "How did it go? (optional)" : "Why? (optional)" }

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
                    CareSubmitButton(title: action.status == .done ? "Done" : action.status == .skipped ? "Skip" : "Save",
                                     isWorking: isSubmitting, isEnabled: true) {
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
