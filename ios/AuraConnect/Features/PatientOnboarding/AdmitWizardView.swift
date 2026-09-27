import SwiftUI
import Observation

@MainActor
@Observable
final class AdmitWizardViewModel {
    enum Step: Int, CaseIterable {
        case demographics, consents, admission, careTeam, frequencies, confirm

        var title: String {
            switch self {
            case .demographics: return "Patient details"
            case .consents: return "Consents"
            case .admission: return "Admission"
            case .careTeam: return "Care team"
            case .frequencies: return "Visit frequencies"
            case .confirm: return "Confirm"
            }
        }
    }

    /// `new` (new or referral patient), `update` (already admitted), `readmission` (discharged).
    enum Mode { case new, update, readmission }

    let orgId: String
    /// Existing patient (e.g. from an accepted referral); nil creates a new patient.
    let patientId: String?

    var step: Step = .demographics
    var input: PatientInput
    var consents = Consents()
    var admissionDate = Date()
    var levelOfCare: LevelOfCare = .routine
    var startingBenefitPeriod = 1
    /// Transfer from another hospice: continue the prior agency's benefit period.
    var isTransfer = false
    var benefitPeriodStart = Date()
    var careTeam: Set<String> = []
    var teamId: String?
    var joinChannel: Bool
    var frequencies: [VisitFrequency] = []
    var confirmReadmission = false
    private(set) var mode: Mode = .new
    private(set) var existingStatus: PatientStatus?
    private(set) var isLoadingPatient = false
    private(set) var isSubmitting = false
    var errorMessage: String?

    init(orgId: String, patientId: String?, input: PatientInput, joinChannelDefault: Bool) {
        self.orgId = orgId
        self.patientId = patientId
        self.input = input
        self.joinChannel = joinChannelDefault
    }

    var admissionDateString: String { ISODate.string(from: admissionDate) }
    var benefitPeriodStartString: String? { isTransfer ? ISODate.string(from: benefitPeriodStart) : nil }
    var cannotAdmit: Bool { existingStatus == .deceased || existingStatus == .nonAdmit }

    static func periodLength(_ number: Int) -> Int { number <= 2 ? 90 : 60 }

    /// I6: load the reviewed patient document (not the raw extraction) before admitting.
    func loadPatient() async {
        guard let patientId, existingStatus == nil else { return }
        isLoadingPatient = true
        defer { isLoadingPatient = false }
        do {
            guard let patient = try await PatientRepository(orgId: orgId).fetchPatient(id: patientId) else {
                errorMessage = "Patient not found."
                return
            }
            input = patient.input
            existingStatus = patient.patientStatus
            if let consents = patient.consents { self.consents = consents }
            switch patient.patientStatus {
            case .admitted:
                mode = .update
                careTeam = Set(patient.careTeamUids ?? [])
                if let date = ISODate.parse(patient.admissionDate) { admissionDate = date }
                levelOfCare = patient.levelOfCare ?? .routine
                startingBenefitPeriod = patient.startingBenefitPeriod ?? 1
                if let start = ISODate.parse(patient.benefitPeriodStart) {
                    isTransfer = true
                    benefitPeriodStart = start
                } else if startingBenefitPeriod > 1 {
                    isTransfer = true
                }
                frequencies = patient.frequencies
            case .discharged:
                mode = .readmission
                frequencies = patient.frequencies
            default:
                mode = .new
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// Fills the care team with a team's active members.
    func chooseTeam(_ team: Team, activeUids: Set<String>) {
        teamId = team.id
        careTeam = Set((team.memberUids ?? []).filter { activeUids.contains($0) })
    }

    /// Mirrors the server's validation (`admitPatient` schema and `benefitPeriodStartError`).
    func validationError(for step: Step) -> String? {
        switch step {
        case .demographics:
            if !input.hasRequiredNames { return "First and last name are required." }
            guard let dob = input.dob, let birth = ISODate.parse(dob) else { return "Date of birth is required." }
            if birth > Date() { return "Date of birth cannot be in the future." }
            return nil
        case .consents:
            return consents.requiredComplete ? nil : "The election statement and HIPAA notice are required."
        case .admission:
            if mode == .readmission && !confirmReadmission { return "Confirm that this is a readmission after discharge." }
            if !(1...100).contains(startingBenefitPeriod) { return "Choose a benefit period between 1 and 100." }
            if isTransfer {
                let calendar = Calendar.current
                let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: benefitPeriodStart),
                                                   to: calendar.startOfDay(for: admissionDate)).day ?? 0
                if days < 0 { return "The benefit period start cannot be after the admission date." }
                let length = Self.periodLength(startingBenefitPeriod)
                if days >= length { return "The admission date is outside benefit period \(startingBenefitPeriod) (\(length) days from its start)." }
            }
            return nil
        case .careTeam:
            return careTeam.isEmpty ? "Select at least one care team member." : nil
        case .frequencies:
            var seen = Set<Discipline>()
            for f in frequencies {
                if !(f.perWeek > 0 && f.perWeek <= 28) { return "\(f.discipline.label): visits per week must be more than 0 and at most 28." }
                if seen.contains(f.discipline) { return "\(f.discipline.label) is listed twice." }
                seen.insert(f.discipline)
            }
            return nil
        case .confirm:
            return nil
        }
    }

    var canAdvance: Bool { !isSubmitting && !isLoadingPatient && validationError(for: step) == nil }

    /// Hint shown when the current step can't advance.
    var blockingReason: String? { validationError(for: step) }

    func next() {
        guard canAdvance, let nextStep = Step(rawValue: step.rawValue + 1) else { return }
        step = nextStep
    }

    func back() {
        guard let previous = Step(rawValue: step.rawValue - 1) else { return }
        step = previous
    }

    func addFrequency() {
        let used = Set(frequencies.map(\.discipline))
        guard let discipline = Discipline.allCases.first(where: { !used.contains($0) }) else { return }
        frequencies.append(VisitFrequency(discipline: discipline, perWeek: 1, notes: nil))
    }

    func useTypicalFrequencies() {
        frequencies = [
            VisitFrequency(discipline: .rn, perWeek: 2, notes: nil),
            VisitFrequency(discipline: .aide, perWeek: 2, notes: nil),
            VisitFrequency(discipline: .sw, perWeek: 0.5, notes: nil),
            VisitFrequency(discipline: .chaplain, perWeek: 0.5, notes: nil),
        ]
    }

    func submit() async -> AdmitResult? {
        for s in Step.allCases where s != .confirm {
            if let problem = validationError(for: s) {
                step = s
                errorMessage = problem
                return nil
            }
        }
        guard !isSubmitting else { return nil }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            return try await FunctionsClient().admitPatient(
                orgId: orgId,
                patientId: patientId,
                patient: input,
                admissionDate: admissionDateString,
                startingBenefitPeriod: isTransfer || mode != .new ? startingBenefitPeriod : 1,
                benefitPeriodStart: benefitPeriodStartString,
                levelOfCare: levelOfCare,
                careTeamUids: Array(careTeam).sorted(),
                consents: consents,
                joinChannel: joinChannel,
                visitFrequencies: frequencies,
                update: mode == .update,
                readmission: mode == .readmission
            )
        } catch {
            errorMessage = error.userMessage
            return nil
        }
    }
}

/// Multi-step admission: details → consents → admission → care team → visit frequencies → confirm → `admitPatient`.
/// With a `patientId`, the patient document is loaded first (update / readmission modes follow its status).
struct AdmitWizardView: View {
    @Environment(OrgStore.self) private var org
    let patientId: String?
    let initialInput: PatientInput
    let onComplete: (AdmitResult) -> Void

    var body: some View {
        AdmitWizardContent(orgId: org.orgId, patientId: patientId, initialInput: initialInput,
                           joinChannelDefault: Self.joinChannelDefault(org.me), onComplete: onComplete)
    }

    /// Mirrors the server default: RN/NP/MD join the care-team channel; intake and others don't.
    static func joinChannelDefault(_ me: Member?) -> Bool {
        guard let me, me.role != .intake, let discipline = me.discipline else { return false }
        return [.rn, .np, .md].contains(discipline)
    }
}

private struct AdmitWizardContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    @State private var model: AdmitWizardViewModel
    @State private var teams: [Team] = []
    let onComplete: (AdmitResult) -> Void

    init(orgId: String, patientId: String?, initialInput: PatientInput, joinChannelDefault: Bool,
         onComplete: @escaping (AdmitResult) -> Void) {
        _model = State(initialValue: AdmitWizardViewModel(orgId: orgId, patientId: patientId, input: initialInput,
                                                          joinChannelDefault: joinChannelDefault))
        self.onComplete = onComplete
    }

    private var title: String {
        switch model.mode {
        case .update: return "Update admission"
        case .readmission: return "Readmit patient"
        case .new: return model.patientId == nil ? "Admit new patient" : "Admit patient"
        }
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                if model.isLoadingPatient {
                    Section { ProgressView("Loading patient…").frame(maxWidth: .infinity) }
                } else if model.cannotAdmit {
                    Section {
                        ErrorBanner(message: "This patient is \(model.existingStatus?.label.lowercased() ?? "closed") and can't be admitted.")
                    }
                } else {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            ProgressView(value: Double(model.step.rawValue + 1), total: Double(AdmitWizardViewModel.Step.allCases.count))
                            Text("Step \(model.step.rawValue + 1) of \(AdmitWizardViewModel.Step.allCases.count): \(model.step.title)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        if model.mode == .update {
                            Text("This patient is already admitted. Saving updates details, consents, admission dates and visit frequencies. Change the care team or level of care from the patient screen.")
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
                    case .frequencies:
                        frequenciesStep
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
            }
            .navigationTitle(title)
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
                                Text(model.mode == .update ? "Save" : model.mode == .readmission ? "Readmit" : "Admit").bold()
                            }
                        }
                        .disabled(!model.canAdvance || model.cannotAdmit)
                    } else {
                        Button("Next") { model.next() }
                            .bold()
                            .disabled(!model.canAdvance || model.cannotAdmit)
                    }
                }
            }
            .task { await model.loadPatient() }
            .task { await loadTeams() }
        }
    }

    private func loadTeams() async {
        do {
            for try await list in TeamRepository(orgId: model.orgId).teams() {
                teams = list.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
                // Default the care team to my team (when I'm on exactly one), not to me alone.
                if model.mode != .update, model.careTeam.isEmpty, model.teamId == nil {
                    let mine = teams.filter { team in (org.me?.teamIds ?? []).contains(team.id ?? "") }
                    if mine.count == 1, let team = mine.first {
                        model.chooseTeam(team, activeUids: activeUids)
                    }
                }
            }
        } catch {
            // Teams are a convenience; the member list below still works.
        }
    }

    private var activeUids: Set<String> { Set(org.activeMembers.map(\.memberUid)) }

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
        if model.mode == .readmission {
            Section {
                Toggle("Readmit after discharge", isOn: $model.confirmReadmission)
            } footer: {
                Text("A new admission starts. The prior stay's milestones are archived on the timeline.")
            }
        }
        Section {
            DatePicker("Admission (election) date", selection: $model.admissionDate, displayedComponents: .date)
            Picker("Level of care", selection: $model.levelOfCare) {
                ForEach(LevelOfCare.allCases) { level in
                    Text(level.label).tag(level)
                }
            }
            .disabled(model.mode == .update)
            if model.mode == .readmission && !model.isTransfer {
                Stepper("Starting benefit period: \(model.startingBenefitPeriod)",
                        value: $model.startingBenefitPeriod, in: 1...100)
            }
        } footer: {
            Text("The admission date is day 1 of the election.")
        }
        Section {
            Toggle("Transferring from another hospice", isOn: $model.isTransfer)
            if model.isTransfer {
                Stepper("Current benefit period: \(model.startingBenefitPeriod)",
                        value: $model.startingBenefitPeriod, in: 1...100)
                DatePicker("Period started", selection: $model.benefitPeriodStart, in: ...model.admissionDate,
                           displayedComponents: .date)
            }
        } header: {
            Text("Transfer")
        } footer: {
            if model.isTransfer {
                Text("Benefit period \(model.startingBenefitPeriod) is \(AdmitWizardViewModel.periodLength(model.startingBenefitPeriod)) days. Recertification dates continue from when it started at the prior hospice.")
            }
        }
    }

    @ViewBuilder
    private var careTeamStep: some View {
        @Bindable var model = model
        if model.mode == .update {
            Section("Care team") {
                Text(model.careTeam.map { org.name(for: $0) }.sorted().joined(separator: ", "))
            }
        } else {
            if !teams.isEmpty {
                Section {
                    ForEach(teams) { team in
                        Button {
                            model.chooseTeam(team, activeUids: activeUids)
                        } label: {
                            HStack {
                                Text(team.displayName).foregroundStyle(Color.primary)
                                Spacer()
                                if model.teamId != nil && model.teamId == team.id {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Team")
                } footer: {
                    Text("Choosing a team fills the care team with its active members. Adjust below.")
                }
            }
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
            Section {
                Toggle("Add me to the care team channel", isOn: $model.joinChannel)
            }
        }
    }

    @ViewBuilder
    private var frequenciesStep: some View {
        @Bindable var model = model
        Section {
            if model.frequencies.isEmpty {
                Button("Use a typical plan") { model.useTypicalFrequencies() }
            }
            ForEach(model.frequencies.indices, id: \.self) { index in
                let frequency = elementBinding($model.frequencies, index, default: VisitFrequency())
                VStack(alignment: .leading, spacing: 6) {
                    Picker("Discipline", selection: frequency.discipline) {
                        ForEach(Discipline.allCases) { discipline in
                            Text(discipline.label).tag(discipline)
                        }
                    }
                    Stepper("\(frequency.wrappedValue.summary)", value: frequency.perWeek, in: 0.5...28, step: 0.5)
                    TextField("Notes", text: frequency.notes.orEmpty)
                        .font(.footnote)
                }
            }
            .onDelete { model.frequencies.remove(atOffsets: $0) }
            if model.frequencies.count < Discipline.allCases.count {
                Button {
                    model.addFrequency()
                } label: {
                    Label("Add discipline", systemImage: "plus")
                }
            }
        } header: {
            Text("Visits per week")
        } footer: {
            Text("Planned visits per discipline (0.5 = every other week). Used to generate the visit schedule. Swipe to remove.")
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
            LabeledContent("Benefit period", value: "\(model.isTransfer || model.mode != .new ? model.startingBenefitPeriod : 1)")
            if let start = model.benefitPeriodStartString {
                LabeledContent("Transfer: period started", value: ISODate.display(start))
            }
            if model.mode == .readmission {
                LabeledContent("Readmission", value: "Yes")
            }
        }
        Section("Care team") {
            Text(model.careTeam.map { org.name(for: $0) }.sorted().joined(separator: ", "))
            if model.mode != .update {
                LabeledContent("Add me to the channel", value: model.joinChannel ? "Yes" : "No")
            }
        }
        Section("Visit frequencies") {
            if model.frequencies.isEmpty {
                Text("None").foregroundStyle(.secondary)
            } else {
                ForEach(model.frequencies, id: \.self) { f in
                    LabeledContent(f.discipline.label, value: f.summary)
                }
            }
        }
        Section {
            Text("Admitting computes NOE, recertification, face-to-face and HOPE deadlines, and creates the care team channel.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
