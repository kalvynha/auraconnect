import SwiftUI

// Form sheets for the patient lifecycle actions (clinical roles only):
// change level of care, recertify, discharge, record death.

// MARK: - Level of care

struct ChangeLevelOfCareView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var levelOfCare: LevelOfCare = .routine
    @State private var effectiveDate = Date()
    @State private var reason = ""
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var current: LevelOfCare { patient.levelOfCare ?? .routine }
    private var isValid: Bool { levelOfCare != current && reason.nilIfBlank != nil }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    LabeledContent("Current", value: current.label)
                    Picker("New level", selection: $levelOfCare) {
                        ForEach(LevelOfCare.allCases) { level in
                            Text(level.label).tag(level)
                        }
                    }
                    DatePicker("Effective", selection: $effectiveDate, displayedComponents: .date)
                }
                Section("Reason") {
                    TextField("Reason for the change", text: $reason, axis: .vertical)
                        .lineLimit(2...6)
                }
            }
            .navigationTitle("Level of care")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Save", isWorking: isSubmitting, isEnabled: isValid) {
                        Task { await submit() }
                    }
                }
            }
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                levelOfCare = current
            }
        }
    }

    private func submit() async {
        guard isValid, !isSubmitting, let patientId = patient.id, let reason = reason.nilIfBlank else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().changeLevelOfCare(orgId: org.orgId, patientId: patientId, levelOfCare: levelOfCare,
                                                          effectiveDate: ISODate.string(from: effectiveDate), reason: reason)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Recertification

struct RecertifyView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var periodNumber = 0
    @State private var physician = ""
    @State private var certificationDate = Date()
    @State private var f2fDate = Date()
    @State private var f2fBy = ""
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    /// Periods that can be certified (period 1 is certified at admission).
    private var periods: [BenefitPeriod] {
        (patient.milestones?.benefitPeriods ?? []).filter { $0.number >= 2 }
    }

    private var selectedPeriod: BenefitPeriod? {
        periods.first { $0.number == periodNumber }
    }

    private var isValid: Bool {
        guard selectedPeriod != nil, physician.nilIfBlank != nil else { return false }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if periods.isEmpty {
                    Section {
                        Text("No later benefit periods have been computed for this patient.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        Picker("Benefit period", selection: $periodNumber) {
                            ForEach(periods, id: \.number) { period in
                                Text("Period \(period.number) (\(ISODate.display(period.start)) – \(ISODate.display(period.end)))")
                                    .tag(period.number)
                            }
                        }
                        TextField("Certifying physician", text: $physician)
                            .textInputAutocapitalization(.words)
                        DatePicker("Certification date", selection: $certificationDate, displayedComponents: .date)
                    } footer: {
                        Text("Completes the recertification milestone for the previous period and creates the recertification checklist.")
                    }
                    if let period = selectedPeriod, period.f2fRequired {
                        Section {
                            DatePicker("F2F date", selection: $f2fDate, displayedComponents: .date)
                            TextField("F2F performed by", text: $f2fBy)
                                .textInputAutocapitalization(.words)
                        } header: {
                            Text("Face-to-face encounter")
                        } footer: {
                            if let start = period.f2fWindowStart, let due = period.f2fDueBy {
                                Text("Required for this period. Window \(ISODate.display(start)) – \(ISODate.display(due)).")
                            } else {
                                Text("Required for this period.")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Recertify")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Record", isWorking: isSubmitting, isEnabled: isValid) {
                        Task { await submit() }
                    }
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard !didLoad else { return }
        didLoad = true
        physician = patient.attendingPhysician?.name ?? ""
        let today = ISODate.string(from: Date())
        var next: BenefitPeriod?
        if let milestones = patient.milestones,
           let current = MilestoneLogic.currentBenefitPeriod(in: milestones, today: Date()) {
            next = periods.first { $0.number == current.number + 1 }
        }
        let fallback = next ?? periods.first { $0.start >= today } ?? periods.last
        periodNumber = fallback?.number ?? 0
    }

    private func submit() async {
        guard isValid, !isSubmitting, let patientId = patient.id, let period = selectedPeriod,
              let physicianName = physician.nilIfBlank else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().recordRecertification(
                orgId: org.orgId,
                patientId: patientId,
                periodNumber: period.number,
                certifyingPhysician: physicianName,
                certificationDate: ISODate.string(from: certificationDate),
                f2fDate: period.f2fRequired ? ISODate.string(from: f2fDate) : nil,
                f2fBy: period.f2fRequired ? f2fBy : nil
            )
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Discharge

struct DischargePatientView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var dischargeDate = Date()
    @State private var reason: DischargeReason = .revocation
    @State private var notes = ""
    @State private var confirming = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    DatePicker("Discharge date", selection: $dischargeDate, displayedComponents: .date)
                    Picker("Reason", selection: $reason) {
                        ForEach(DischargeReason.allCases) { reason in
                            Text(reason.label).tag(reason)
                        }
                    }
                }
                Section("Notes") {
                    TextField("Optional notes", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    Label("Discharging archives the care team channel and cancels future visits and open tasks.",
                          systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            .navigationTitle("Discharge")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Discharge", isWorking: isSubmitting, isEnabled: patient.id != nil) {
                        confirming = true
                    }
                }
            }
            .confirmationDialog("Discharge \(patient.sortName)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Discharge", role: .destructive) {
                    Task { await submit() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func submit() async {
        guard !isSubmitting, let patientId = patient.id else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().dischargePatient(orgId: org.orgId, patientId: patientId,
                                                         dischargeDate: ISODate.string(from: dischargeDate),
                                                         reason: reason, notes: notes)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Death

struct RecordDeathView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var date = Date()
    @State private var includeTime = true
    @State private var time = Date()
    @State private var pronouncedBy = ""
    @State private var location = ""
    @State private var notes = ""
    @State private var risk: BereavementRisk = .low
    @State private var bereavementAssigneeUid: String?
    @State private var confirming = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    /// `HH:mm` from the time picker (local time).
    private var timeString: String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: time)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    DatePicker("Date of death", selection: $date, in: ...Date(), displayedComponents: .date)
                    Toggle("Time known", isOn: $includeTime)
                    if includeTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                    TextField("Pronounced by", text: $pronouncedBy)
                        .textInputAutocapitalization(.words)
                    TextField("Location", text: $location)
                }
                Section("Notes") {
                    TextField("Optional notes", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    Picker("Bereavement risk", selection: $risk) {
                        ForEach(BereavementRisk.allCases) { risk in
                            Text(risk.label).tag(risk)
                        }
                    }
                    CareMemberPicker(title: "Bereavement coordinator", selection: $bereavementAssigneeUid,
                                     members: org.activeMembers)
                } header: {
                    Text("Bereavement")
                } footer: {
                    Text("Creates a 13-month bereavement plan for the family. The care team channel is archived and future visits and open tasks are cancelled.")
                }
            }
            .navigationTitle("Record death")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Record", isWorking: isSubmitting, isEnabled: patient.id != nil) {
                        confirming = true
                    }
                }
            }
            .confirmationDialog("Record the death of \(patient.sortName)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Record death", role: .destructive) {
                    Task { await submit() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func submit() async {
        guard !isSubmitting, let patientId = patient.id else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().recordDeath(
                orgId: org.orgId,
                patientId: patientId,
                date: ISODate.string(from: date),
                time: includeTime ? timeString : nil,
                pronouncedBy: pronouncedBy,
                location: location,
                notes: notes,
                bereavementRisk: risk,
                bereavementAssigneeUid: bereavementAssigneeUid
            )
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
