import SwiftUI
import Observation

@MainActor
@Observable
final class PatientsViewModel {
    /// "My patients" (care team includes me) or everyone in the org.
    enum Scope: String, CaseIterable, Identifiable {
        case mine = "My patients"
        case all = "All"
        var id: String { rawValue }
    }

    let orgId: String
    let uid: String
    private(set) var patients: [Patient] = []
    private(set) var isLoading = true
    var errorMessage: String?
    var scope: Scope = .mine
    /// Server-side filter for "All"; applied client-side to "My patients".
    var status: PatientStatus = .admitted
    var searchText = ""

    init(orgId: String, uid: String) {
        self.orgId = orgId
        self.uid = uid
    }

    /// Identifies the Firestore query; the listener restarts when it changes. "My patients"
    /// loads every status once (a care team is small) and filters locally.
    var queryKey: String {
        scope == .mine ? "mine" : "all-\(status.rawValue)"
    }

    var visiblePatients: [Patient] {
        let query = searchText.nilIfBlank
        return patients
            .filter { $0.patientStatus == status }
            .filter { patient in
                guard let query else { return true }
                return patient.sortName.localizedCaseInsensitiveContains(query)
                    || (patient.mrn?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.sortName.localizedCaseInsensitiveCompare($1.sortName) == .orderedAscending }
    }

    func run() async {
        isLoading = true
        errorMessage = nil
        let repository = PatientRepository(orgId: orgId)
        let stream = scope == .mine
            ? repository.patients(careTeamMember: uid)
            : repository.patients(status: status)
        do {
            for try await list in stream {
                patients = list
                isLoading = false
                errorMessage = nil
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}

struct PatientListView: View {
    @Environment(OrgStore.self) private var org

    var body: some View {
        PatientListContent(orgId: org.orgId, uid: org.uid)
    }
}

private struct PatientListContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: PatientsViewModel
    @State private var showAdmitNew = false

    init(orgId: String, uid: String) {
        _model = State(initialValue: PatientsViewModel(orgId: orgId, uid: uid))
    }

    private var emptyDescription: String {
        let status = model.status.label.lowercased()
        return model.scope == .mine
            ? "You are not on the care team of any \(status) patients."
            : "No \(status) patients."
    }

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                Picker("Patients", selection: $model.scope) {
                    ForEach(PatientsViewModel.Scope.allCases) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                Picker("Status", selection: $model.status) {
                    ForEach(PatientStatus.allCases) { status in
                        Text(status.label).tag(status)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            ForEach(model.visiblePatients) { patient in
                if let id = patient.id {
                    NavigationLink(value: Route.patient(id)) {
                        PatientRow(patient: patient)
                    }
                }
            }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.visiblePatients.isEmpty && model.errorMessage == nil {
                if model.searchText.isEmpty {
                    ContentUnavailableView("No patients",
                                           systemImage: "person.text.rectangle",
                                           description: Text(emptyDescription))
                } else {
                    ContentUnavailableView.search(text: model.searchText)
                }
            }
        }
        .searchable(text: $model.searchText, prompt: "Name or MRN")
        .navigationTitle("Patients")
        .toolbar {
            if org.role.canManageReferrals {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showAdmitNew = true
                    } label: {
                        Label("Admit patient", systemImage: "person.badge.plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showAdmitNew) {
            AdmitWizardView(patientId: nil, initialInput: PatientInput()) { result in
                showAdmitNew = false
                router.patientsPath.append(.patient(result.patientId))
            }
            .environment(org)
        }
        .task(id: model.queryKey) { await model.run() }
    }
}

struct PatientRow: View {
    let patient: Patient

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(patient.sortName)
                    .font(.headline)
                Spacer()
                StatusPill(text: patient.patientStatus.label, color: patient.patientStatus.color)
            }
            HStack(spacing: 8) {
                if let age = ISODate.age(fromDOB: patient.dob) {
                    Text("\(age) y")
                }
                if let diagnosis = patient.primaryDiagnosis?.description.nilIfBlank {
                    Text(diagnosis).lineLimit(1)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if let code = patient.codeStatus, code != .unknown {
                Text(code.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(code == .fullCode ? Color.secondary : Color.purple)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
