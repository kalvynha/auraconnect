import SwiftUI

// MARK: - Callables (L1)

/// `offboardMember` result (dry run or real). Counts are keyed like `OffboardCounts`.
struct OffboardSummary {
    var dryRun: Bool
    var counts: [String: Int]
    var unassigned: [String: Int]
    var escalationPolicyNames: [String]
    var deactivated: Bool

    struct CountLabel: Identifiable {
        let key: String
        let label: String
        var id: String { key }
    }

    static let countLabels: [CountLabel] = [
        CountLabel(key: "careTeams", label: "Patient care teams"),
        CountLabel(key: "tasks", label: "Open tasks"),
        CountLabel(key: "visits", label: "Future visits"),
        CountLabel(key: "bereavementPlans", label: "Bereavement plans"),
        CountLabel(key: "triageCalls", label: "Open triage calls"),
        CountLabel(key: "shifts", label: "Future on-call shifts"),
        CountLabel(key: "onCallRoles", label: "On-call fallback lists"),
        CountLabel(key: "teams", label: "Teams"),
        CountLabel(key: "volunteerAssignments", label: "Volunteer assignments (ended)"),
    ]
}

extension FunctionsClient {
    /// Adds/removes care-team members; the patient channel follows. Returns the new care team.
    @discardableResult
    func updateCareTeam(orgId: String, patientId: String, add: [String], remove: [String]) async throws -> [String] {
        var payload: [String: Any] = ["orgId": orgId, "patientId": patientId]
        if !add.isEmpty { payload["add"] = add }
        if !remove.isEmpty { payload["remove"] = remove }
        let response = try await call("updateCareTeam", payload)
        return response["careTeamUids"] as? [String] ?? []
    }

    func offboardMember(orgId: String, uid: String, defaultReplacement: String?, shiftAction: String,
                        dryRun: Bool) async throws -> OffboardSummary {
        var reassignTo: [String: Any] = [:]
        if let defaultReplacement = defaultReplacement?.nilIfBlank { reassignTo["default"] = defaultReplacement }
        let response = try await call("offboardMember", [
            "orgId": orgId,
            "uid": uid,
            "reassignTo": reassignTo,
            "shiftAction": shiftAction,
            "dryRun": dryRun,
        ])
        func intMap(_ key: String) -> [String: Int] {
            var out: [String: Int] = [:]
            for (k, v) in response[key] as? [String: Any] ?? [:] {
                if let n = v as? Int { out[k] = n } else if let n = v as? NSNumber { out[k] = n.intValue }
            }
            return out
        }
        let policies = (response["escalationPolicies"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        return OffboardSummary(dryRun: response["dryRun"] as? Bool ?? dryRun,
                               counts: intMap("counts"),
                               unassigned: intMap("unassigned"),
                               escalationPolicyNames: policies,
                               deactivated: response["deactivated"] as? Bool ?? false)
    }
}

extension MemberRepository {
    /// Admin edit of role / capabilities / active (rules: admin may update any well-formed field).
    /// The server reverts a change that would leave no active admin, and audits every change.
    func adminUpdate(uid: String, fields: [String: Any]) async throws {
        try await FirebaseService.orgRef(orgId).collection("members").document(uid).updateData(fields)
    }
}

// MARK: - Care team editor (L1)

extension OrgStore {
    /// Mirrors `updateCareTeam`: admin, `staffing`, or an RN/NP/MD (not viewer) on the care team.
    func canEditCareTeam(of patient: Patient) -> Bool {
        let status = patient.patientStatus
        guard status == .admitted || status == .referral else { return false }
        if role == .admin || (me?.has(capability: "staffing") ?? false) { return true }
        return role != .viewer && isLicensed && (patient.careTeamUids ?? []).contains(uid)
    }
}

/// "Edit care team" row for the patient's care-team section; hidden when not permitted.
struct CareTeamEditRow: View {
    @Environment(OrgStore.self) private var org
    let patient: Patient
    @State private var editing = false

    var body: some View {
        if org.canEditCareTeam(of: patient) {
            Button {
                editing = true
            } label: {
                Label("Edit care team", systemImage: "person.2.badge.gearshape")
            }
            .sheet(isPresented: $editing) {
                CareTeamEditorView(patient: patient)
                    .environment(org)
            }
        }
    }
}

struct CareTeamEditorView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var selected: Set<String> = []
    @State private var didLoad = false
    @State private var searchText = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var original: [String] { patient.careTeamUids ?? [] }
    private var added: [String] { selected.filter { !original.contains($0) }.sorted() }
    private var removed: [String] { original.filter { !selected.contains($0) } }

    private var candidates: [Member] {
        let query = searchText.nilIfBlank
        return org.activeMembers
            .filter { member in
                guard let query else { return true }
                return member.name.localizedCaseInsensitiveContains(query)
                    || (member.discipline?.label.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { lhs, rhs in
                let l = selected.contains(lhs.memberUid)
                let r = selected.contains(rhs.memberUid)
                if l != r { return l }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    ForEach(candidates) { member in
                        let uid = member.memberUid
                        Button {
                            if selected.contains(uid) { selected.remove(uid) } else { selected.insert(uid) }
                        } label: {
                            HStack {
                                MemberRow(member: member)
                                Image(systemName: selected.contains(uid) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(uid) ? Color.accentColor : Color.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } footer: {
                    Text("Added members join the care-team conversation; removed members leave it. The change is recorded on the patient timeline.")
                }
            }
            .searchable(text: $searchText, prompt: "Name or discipline")
            .navigationTitle("Care team")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Save", isWorking: isSubmitting,
                                     isEnabled: !(added.isEmpty && removed.isEmpty) && patient.id != nil) {
                        Task { await submit() }
                    }
                }
            }
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                selected = Set(original)
            }
        }
    }

    private func submit() async {
        guard let patientId = patient.id, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().updateCareTeam(orgId: org.orgId, patientId: patientId, add: added, remove: removed)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Member admin (role, capabilities, active, offboard)

/// v3 capability keys and labels (mirror of `CAPABILITIES`).
enum CapabilityOption: String, CaseIterable, Identifiable {
    case reports, audit, staffing, scheduling, volunteers, bereavement
    var id: String { rawValue }
    var label: String {
        switch self {
        case .reports: return "Reports and dashboards"
        case .audit: return "Audit log"
        case .staffing: return "Staffing (care teams, offboarding)"
        case .scheduling: return "Scheduling (any visit, visit plans, shifts)"
        case .volunteers: return "Volunteer coordination"
        case .bereavement: return "Bereavement coordination"
        }
    }
}

struct MemberAdminView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let member: Member

    @State private var role: Role = .viewer
    @State private var active = true
    @State private var capabilities: Set<String> = []
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var offboarding = false

    private var uid: String { member.memberUid }
    private var isSelf: Bool { uid == org.uid }

    /// The only active admin cannot be demoted or deactivated (the server reverts it anyway).
    private var isLastAdmin: Bool {
        guard member.role == .admin, member.isActive else { return false }
        return org.activeMembers.filter { $0.role == .admin }.count <= 1
    }

    private var changes: [String: Any] {
        var out: [String: Any] = [:]
        if role != (member.role ?? .viewer) { out["role"] = role.rawValue }
        if active != member.isActive { out["active"] = active }
        let current = Set(member.capabilities ?? [])
        if capabilities != current {
            out["capabilities"] = CapabilityOption.allCases.map(\.rawValue).filter { capabilities.contains($0) }
        }
        return out
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Name", value: member.name)
                    if let email = member.email?.nilIfBlank { LabeledContent("Email", value: email) }
                    if let discipline = member.discipline { LabeledContent("Discipline", value: discipline.label) }
                }
                Section {
                    Picker("Role", selection: $role) {
                        ForEach(Role.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .disabled(isLastAdmin)
                    Toggle("Active", isOn: $active)
                        .disabled(isLastAdmin || isSelf)
                } footer: {
                    if isLastAdmin {
                        Text("This is the only active admin. Make someone else an admin first.")
                    } else if isSelf {
                        Text("You cannot deactivate yourself.")
                    }
                }
                Section {
                    ForEach(CapabilityOption.allCases) { option in
                        Toggle(option.label, isOn: Binding(
                            get: { capabilities.contains(option.rawValue) },
                            set: { on in
                                if on { capabilities.insert(option.rawValue) } else { capabilities.remove(option.rawValue) }
                            }
                        ))
                    }
                } header: {
                    Text("Capabilities")
                } footer: {
                    Text(role == .admin ? "Admins hold every capability; these matter only if the role changes." : "Grant specific permissions without making this member an admin.")
                }
                if member.isActive && !isSelf && !isLastAdmin {
                    Section {
                        Button(role: .destructive) {
                            offboarding = true
                        } label: {
                            Label("Offboard…", systemImage: "person.crop.circle.badge.xmark")
                        }
                    } footer: {
                        Text("Hands their care teams, tasks, visits, shifts and on-call duties to a replacement, then deactivates them. You see a preview first.")
                    }
                }
            }
            .navigationTitle("Member")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Save", isWorking: isSubmitting, isEnabled: !changes.isEmpty) {
                        Task { await submit() }
                    }
                }
            }
            .onAppear(perform: load)
            .sheet(isPresented: $offboarding) {
                OffboardMemberView(member: member) { dismiss() }
                    .environment(org)
            }
        }
    }

    private func load() {
        guard !didLoad else { return }
        didLoad = true
        role = member.role ?? .viewer
        active = member.isActive
        capabilities = Set(member.capabilities ?? [])
    }

    private func submit() async {
        let fields = changes
        guard !fields.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await MemberRepository(orgId: org.orgId).adminUpdate(uid: uid, fields: fields)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// L1 offboarding: choose a replacement, preview (dry run), then confirm.
struct OffboardMemberView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let member: Member
    var onFinished: () -> Void = {}

    @State private var replacement: String?
    @State private var deleteShifts = false
    @State private var preview: OffboardSummary?
    @State private var result: OffboardSummary?
    @State private var confirming = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    private var others: [Member] { org.activeMembers.filter { $0.memberUid != member.memberUid } }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if let result {
                    Section {
                        Label("\(member.name) was offboarded and deactivated.", systemImage: "checkmark.seal.fill")
                    }
                    summarySection(result)
                } else {
                    Section {
                        CareMemberPicker(title: "Replacement", selection: $replacement, members: others,
                                         noneLabel: "None (leave unassigned)")
                        Toggle("Delete future on-call shifts", isOn: $deleteShifts)
                    } footer: {
                        Text("Work goes to the replacement. Without one, items are left unassigned and shifts are deleted. Per-discipline mapping is available on the web console.")
                    }
                    .onChange(of: replacement) { _, _ in preview = nil }
                    .onChange(of: deleteShifts) { _, _ in preview = nil }
                    if let preview {
                        summarySection(preview)
                    }
                }
            }
            .navigationTitle("Offboard \(member.name)")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isWorking)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(result == nil ? "Cancel" : "Done") {
                        dismiss()
                        if result != nil { onFinished() }
                    }
                    .disabled(isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if result == nil {
                        if preview == nil {
                            CareSubmitButton(title: "Preview", isWorking: isWorking, isEnabled: true) {
                                Task { await run(dryRun: true) }
                            }
                        } else {
                            CareSubmitButton(title: "Offboard", isWorking: isWorking, isEnabled: true) {
                                confirming = true
                            }
                        }
                    }
                }
            }
            .confirmationDialog("Offboard and deactivate \(member.name)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Offboard and deactivate", role: .destructive) {
                    Task { await run(dryRun: false) }
                }
            } message: {
                Text("Their work is reassigned and their sign-in is revoked. Every change is audited.")
            }
        }
    }

    @ViewBuilder
    private func summarySection(_ summary: OffboardSummary) -> some View {
        Section(summary.dryRun ? "Preview (nothing changed yet)" : "Changed") {
            ForEach(OffboardSummary.countLabels) { item in
                let count = summary.counts[item.key] ?? 0
                let left = summary.unassigned[item.key] ?? 0
                HStack {
                    Text(item.label)
                    Spacer()
                    Text("\(count)").foregroundStyle(count == 0 ? Color.secondary : Color.primary)
                    if left > 0 {
                        StatusPill(text: item.key == "shifts" ? "\(left) deleted" : "\(left) unassigned", color: .orange)
                    }
                }
            }
        }
        if !summary.escalationPolicyNames.isEmpty {
            Section {
                Text(summary.escalationPolicyNames.joined(separator: ", "))
            } header: {
                Text("Escalation policies to edit by hand")
            } footer: {
                Text("These policies page \(member.name) directly and are not changed automatically.")
            }
        }
    }

    private func run(dryRun: Bool) async {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let summary = try await FunctionsClient().offboardMember(
                orgId: org.orgId,
                uid: member.memberUid,
                defaultReplacement: replacement,
                shiftAction: deleteShifts ? "delete" : "reassign",
                dryRun: dryRun
            )
            if dryRun { preview = summary } else { result = summary }
        } catch {
            errorMessage = error.userMessage
        }
    }
}
