import SwiftUI
import Observation

@MainActor
@Observable
final class AdmitWizardViewModel {
    enum Step: Int, CaseIterable {
        case demographics, consents, admission, careTeam, confirm

        var title: String {
            switch self {
            case .demographics: return "Patient details"
            case .consents: return "Consents"
            case .admission: return "Admission"
            case .careTeam: return "Care team"
            case .confirm: return "Confirm"
            }
        }
    }

    let orgId: String
    /// Existing patient (e.g. from an accepted referral); nil creates a new patient.
    let patientId: String?

    var step: Step = .demographics
    var input: PatientInput
    var consents = Consents()
    var admissionDate = Date()
    var levelOfCare: LevelOfCare = .routine
    var startingBenefitPeriod = 1
    var careTeam: Set<String>
    private(set) var isSubmitting = false
    var errorMessage: String?

    init(orgId: String, patientId: String?, input: PatientInput, currentUid: String) {
        self.orgId = orgId
        self.patientId = patientId
        self.input = input
        self.careTeam = [currentUid]
    }

    var admissionDateString: String { ISODate.string(from: admissionDate) }

    var canAdvance: Bool {
        switch step {
        case .demographics: return input.hasRequiredNames
        case .consents: return consents.requiredComplete
        case .admission: return startingBenefitPeriod >= 1
        case .careTeam: return !careTeam.isEmpty
        case .confirm: return !isSubmitting
        }
    }

    /// Hint shown when the current step can't advance.
    var blockingReason: String? {
        guard !canAdvance else { return nil }
        switch step {
        case .demographics: return "First and last name are required."
        case .consents: return "The election statement and HIPAA notice are required."
        case .admission: return "Choose a starting benefit period."
        case .careTeam: return "Select at least one care team member."
        case .confirm: return nil
        }
    }

    func next() {
        guard canAdvance, let nextStep = Step(rawValue: step.rawValue + 1) else { return }
        step = nextStep
    }

    func back() {
        guard let previous = Step(rawValue: step.rawValue - 1) else { return }
        step = previous
    }

    func submit() async -> AdmitResult? {
        guard !isSubmitting, input.hasRequiredNames, consents.requiredComplete, !careTeam.isEmpty else { return nil }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            return try await FunctionsClient().admitPatient(
                orgId: orgId,
                patientId: patientId,
                patient: input,
                admissionDate: admissionDateString,
                startingBenefitPeriod: startingBenefitPeriod,
                levelOfCare: levelOfCare,
                careTeamUids: Array(careTeam).sorted(),
                consents: consents
            )
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

/// Multi-step admission: details → consents → admission → care team → confirm → `admitPatient`.
struct AdmitWizardView: View {
    @Environment(OrgStore.self) private var org
    let patientId: String?
    let initialInput: PatientInput
    let onComplete: (AdmitResult) -> Void

    var body: some View {
        AdmitWizardContent(orgId: org.orgId, uid: org.uid, patientId: patientId,
                           initialInput: initialInput, onComplete: onComplete)
    }
}

private struct AdmitWizardContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    @State private var model: AdmitWizardViewModel
    let onComplete: (AdmitResult) -> Void

    init(orgId: String, uid: String, patientId: String?, initialInput: PatientInput, onComplete: @escaping (AdmitResult) -> Void) {
        _model = State(initialValue: AdmitWizardViewModel(orgId: orgId, patientId: patientId, input: initialInput, currentUid: uid))
        self.onComplete = onComplete
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: Double(model.step.rawValue + 1), total: Double(AdmitWizardViewModel.Step.allCases.count))
                        Text("Step \(model.step.rawValue + 1) of \(AdmitWizardViewModel.Step.allCases.count): \(model.step.title)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if let error = model.errorMessage {
                    Section { ErrorBanner(message: error) }
                }

                switch model.step {
                case .demographics:
                    PatientInputSections(input: $model.input)
                case .consents:
                    consentsStep
                case .admission:
                    admissionStep
                case .careTeam:
                    careTeamStep
                case .confirm:
                    confirmStep
                }

                if let reason = model.blockingReason {
                    Section {
                        Label(reason, systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(model.patientId == nil ? "Admit new patient" : "Admit patient")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSubmitting)
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Back") { model.back() }
                        .disabled(model.step == .demographics || model.isSubmitting)
                    Spacer()
                    if model.step == .confirm {
                        Button {
                            Task {
                                if let result = await model.submit() {
                                    onComplete(result)
                                    dismiss()
                                }
                            }
                        } label: {
                            if model.isSubmitting {
                                ProgressView()
                            } else {
                                Text("Admit").bold()
                            }
                        }
                        .disabled(!model.canAdvance)
                    } else {
                        Button("Next") { model.next() }
                            .bold()
                            .disabled(!model.canAdvance)
                    }
                }
            }
        }
    }

    // MARK: Steps

    @ViewBuilder
    private var consentsStep: some View {
        @Bindable var model = model
        Section {
            Toggle("Hospice election statement signed", isOn: $model.consents.electionStatement)
            Toggle("HIPAA notice of privacy practices", isOn: $model.consents.hipaaNotice)
        } header: {
            Text("Required")
        }
        Section {
            Toggle("Release of information", isOn: $model.consents.releaseOfInformation)
            Toggle("Patient rights acknowledged", isOn: $model.consents.patientRights)
            Toggle("POLST / DNR form on file", isOn: $model.consents.polstOnFile)
        } header: {
            Text("Additional")
        } footer: {
            Text("Record only consents that are signed and on file.")
        }
    }

    @ViewBuilder
    private var admissionStep: some View {
        @Bindable var model = model
        Section {
            DatePicker("Admission (election) date", selection: $model.admissionDate, displayedComponents: .date)
            Picker("Level of care", selection: $model.levelOfCare) {
                ForEach(LevelOfCare.allCases) { level in
                    Text(level.label).tag(level)
                }
            }
            Stepper("Starting benefit period: \(model.startingBenefitPeriod)",
                    value: $model.startingBenefitPeriod, in: 1...50)
        } footer: {
            Text("The admission date is day 1 of the election. Use a starting benefit period above 1 only for patients transferring from another hospice.")
        }
    }

    @ViewBuilder
    private var careTeamStep: some View {
        Section {
            ForEach(org.activeMembers) { member in
                let uid = member.memberUid
                Button {
                    if model.careTeam.contains(uid) {
                        model.careTeam.remove(uid)
                    } else {
                        model.careTeam.insert(uid)
                    }
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(initials: member.initials, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(uid == org.uid ? "\(member.name) (you)" : member.name)
                                .foregroundStyle(Color.primary)
                            if !member.subtitle.isEmpty {
                                Text(member.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: model.careTeam.contains(uid) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.careTeam.contains(uid) ? Color.accentColor : Color.secondary)
                    }
                }
                .accessibilityAddTraits(model.careTeam.contains(uid) ? .isSelected : [])
            }
        } header: {
            Text("Care team (\(model.careTeam.count) selected)")
        } footer: {
            Text("A care team channel is created with these members.")
        }
    }

    @ViewBuilder
    private var confirmStep: some View {
        Section("Patient") {
            LabeledContent("Name", value: model.input.sortName)
            LabeledContent("Date of birth", value: ISODate.display(model.input.dob))
            LabeledContent("Code status", value: model.input.codeStatus.label)
            if let diagnosis = model.input.primaryDiagnosis, !diagnosis.isEmpty {
                LabeledContent("Primary diagnosis", value: diagnosis.formatted)
            }
        }
        Section("Admission") {
            LabeledContent("Admission date", value: ISODate.display(model.admissionDateString))
            LabeledContent("Level of care", value: model.levelOfCare.label)
            LabeledContent("Starting benefit period", value: "\(model.startingBenefitPeriod)")
        }
        Section("Care team") {
            Text(model.careTeam.map { org.name(for: $0) }.sorted().joined(separator: ", "))
        }
        Section {
            Text("Admitting computes NOE, recertification, face-to-face and HOPE deadlines, and creates the care team channel.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
