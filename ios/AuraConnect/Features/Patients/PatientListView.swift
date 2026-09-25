import SwiftUI
import Observation

@MainActor
@Observable
final class PatientsViewModel {
    enum Filter: String, CaseIterable, Identifiable {
        case admitted = "Admitted"
        case referral = "Referrals"
        case discharged = "Discharged"
        case all = "All"
        var id: String { rawValue }

        func matches(_ status: PatientStatus) -> Bool {
            switch self {
            case .admitted: return status == .admitted
            case .referral: return status == .referral
            case .discharged: return status == .discharged || status == .deceased
            case .all: return true
            }
        }
    }

    let orgId: String
    private(set) var patients: [Patient] = []
    private(set) var isLoading = true
    var errorMessage: String?
    var filter: Filter = .admitted
    var searchText = ""

    init(orgId: String) {
        self.orgId = orgId
    }

    var visiblePatients: [Patient] {
        let query = searchText.nilIfBlank
        return patients
            .filter { filter.matches($0.patientStatus) }
            .filter { patient in
                guard let query else { return true }
                return patient.sortName.localizedCaseInsensitiveContains(query)
                    || (patient.mrn?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.sortName.localizedCaseInsensitiveCompare($1.sortName) == .orderedAscending }
    }

    func run() async {
        do {
            for try await list in PatientRepository(orgId: orgId).patients() {
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
        PatientListContent(orgId: org.orgId)
    }
}

private struct PatientListContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: PatientsViewModel
    @State private var showAdmitNew = false

    init(orgId: String) {
        _model = State(initialValue: PatientsViewModel(orgId: orgId))
    }

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                Picker("Status", selection: $model.filter) {
                    ForEach(PatientsViewModel.Filter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
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
                                           description: Text("No \(model.filter == .all ? "" : model.filter.rawValue.lowercased() + " ")patients yet."))
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
        .task { await model.run() }
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
