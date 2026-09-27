import SwiftUI
import Observation

@MainActor
@Observable
final class LogTriageCallViewModel {
    let orgId: String
    var patientId: String?
    var callerName = ""
    var callerRelationship = ""
    var callerPhone = ""
    var reason = ""
    /// Comma- or line-separated.
    var symptomsText = ""
    var urgency: TriageUrgency = .routine
    /// nil = org default (`triageRoleKey`) or none.
    var roleKey: String?
    private(set) var roles: [OnCallRole] = []
    private(set) var patients: [Patient] = []
    private(set) var orgDefaultRoleKey: String?
    private(set) var isWorking = false
    private(set) var didAttemptSubmit = false
    var errorMessage: String?

    @ObservationIgnored private var appliedDefaultRole = false

    init(orgId: String) {
        self.orgId = orgId
    }

    var symptoms: [String] {
        symptomsText
            .components(separatedBy: CharacterSet(charactersIn: ",;\n"))
            .compactMap { $0.nilIfBlank }
    }

    var callerError: String? { callerName.nilIfBlank == nil ? "Enter the caller's name." : nil }
    var reasonError: String? { reason.nilIfBlank == nil ? "Enter the reason for the call." : nil }
    var isValid: Bool { callerError == nil && reasonError == nil }

    func runRoles() async {
        do {
            for try await list in ScheduleRepository(orgId: orgId).onCallRoles() {
                roles = list.sorted { $0.displayLabel.localizedCaseInsensitiveCompare($1.displayLabel) == .orderedAscending }
                applyDefaultRole()
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
            // The patient is optional; the form still works without the list.
        }
    }

    func loadDefaultRole() async {
        orgDefaultRoleKey = await TriageRepository(orgId: orgId).triageRoleKey()
        applyDefaultRole()
    }

    /// Pre-selects `org.triageRoleKey` once, when both it and the role list are known.
    private func applyDefaultRole() {
        guard !appliedDefaultRole, roleKey == nil, let key = orgDefaultRoleKey,
              roles.contains(where: { $0.roleKey == key }) else { return }
        roleKey = key
        appliedDefaultRole = true
    }

    /// Returns the new call id.
    func submit() async -> String? {
        didAttemptSubmit = true
        errorMessage = nil
        guard isValid, !isWorking, let caller = callerName.nilIfBlank, let reasonText = reason.nilIfBlank else { return nil }
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await FunctionsClient().logTriageCall(
                orgId: orgId,
                patientId: patientId,
                callerName: caller,
                callerRelationship: callerRelationship.nilIfBlank,
                callerPhone: callerPhone.nilIfBlank,
                reason: reasonText,
                symptoms: symptoms,
                urgency: urgency,
                roleKey: roleKey
            )
            return result.callId
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

/// Form for logging an after-hours call (`logTriageCall`).
struct LogTriageCallView: View {
    @Environment(OrgStore.self) private var org
    let onLogged: (String) -> Void

    var body: some View {
        LogTriageCallContent(orgId: org.orgId, onLogged: onLogged)
    }
}

private struct LogTriageCallContent: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: LogTriageCallViewModel
    let onLogged: (String) -> Void

    init(orgId: String, onLogged: @escaping (String) -> Void) {
        _model = State(initialValue: LogTriageCallViewModel(orgId: orgId))
        self.onLogged = onLogged
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                Section("Caller") {
                    TextField("Caller name", text: $model.callerName)
                        .textContentType(.name)
                    if model.didAttemptSubmit, let error = model.callerError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    TextField("Relationship (optional)", text: $model.callerRelationship)
                    TextField("Phone (optional)", text: $model.callerPhone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                }

                Section {
                    Picker("Patient", selection: $model.patientId) {
                        Text("Not linked").tag(String?.none)
                        ForEach(model.patients) { patient in
                            Text(patient.sortName).tag(patient.id)
                        }
                    }
                    .pickerStyle(.navigationLink)
                } header: {
                    Text("Patient (optional)")
                }

                Section("Call") {
                    TextField("Reason for call", text: $model.reason, axis: .vertical)
                        .lineLimit(2...5)
                    if model.didAttemptSubmit, let error = model.reasonError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    TextField("Symptoms, separated by commas", text: $model.symptomsText, axis: .vertical)
                        .lineLimit(1...4)
                    Picker("Urgency", selection: $model.urgency) {
                        ForEach(TriageUrgency.allCases) { urgency in
                            Label(urgency.label, systemImage: urgency.symbol).tag(urgency)
                        }
                    }
                }

                Section {
                    Picker("On-call role", selection: $model.roleKey) {
                        Text("Organization default").tag(String?.none)
                        ForEach(model.roles) { role in
                            Text(role.displayLabel).tag(String?.some(role.roleKey))
                        }
                    }
                } header: {
                    Text("Route to")
                } footer: {
                    Text("Urgent and emergent calls raise an escalating alert to whoever is on call for this role.")
                }
            }
            .disabled(model.isWorking)
            .navigationTitle("Log call")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button("Log") {
                            Task {
                                if let callId = await model.submit() {
                                    onLogged(callId)
                                }
                            }
                        }
                    }
                }
            }
            .interactiveDismissDisabled(model.isWorking)
            .task { await model.runRoles() }
            .task { await model.runPatients() }
            .task { await model.loadDefaultRole() }
        }
    }
}
