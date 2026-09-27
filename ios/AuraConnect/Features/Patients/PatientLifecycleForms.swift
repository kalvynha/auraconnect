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

    /// The F2F must fall within the 30 days before the period start, up to the period start.
    /// Returns a warning when the chosen date is outside that window (the server has the final say).
    private func f2fWindowWarning(for period: BenefitPeriod) -> String? {
        guard let periodStart = ISODate.parse(period.start) else { return nil }
        let calendar = Calendar.current
        guard let windowStart = calendar.date(byAdding: .day, value: -30, to: periodStart) else { return nil }
        let chosen = calendar.startOfDay(for: f2fDate)
        guard chosen < windowStart || chosen > periodStart else { return nil }
        return "The F2F date is outside the window (\(ISODate.display(ISODate.string(from: windowStart))) – \(ISODate.display(period.start))). It must be within 30 days before the period starts."
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
                            if let warning = f2fWindowWarning(for: period) {
                                Label(warning, systemImage: "exclamationmark.triangle.fill")
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
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

/// Where the death occurred; "Other" takes free text.
enum DeathLocation: String, CaseIterable, Identifiable {
    case home = "Home"
    case facility = "Facility"
    case hospital = "Hospital"
    case inpatientUnit = "Inpatient unit"
    case other = "Other"

    var id: String { rawValue }
}

struct RecordDeathView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var date = Date()
    @State private var includeTime = true
    @State private var time = Date()
    @State private var pronouncedBy = ""
    @State private var location: DeathLocation = .home
    @State private var otherLocation = ""
    @State private var notes = ""
    /// No default: the clinician must assess and choose.
    @State private var risk: BereavementRisk?
    @State private var bereavementAssigneeUid: String?
    @State private var didLoad = false
    @State private var confirming = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    /// `HH:mm` from the time picker (local time).
    private var timeString: String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: time)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }

    private var locationText: String? {
        location == .other ? otherLocation.nilIfBlank : location.rawValue
    }

    private var isValid: Bool {
        patient.id != nil && risk != nil && locationText != nil
    }

    /// Social workers, chaplains and members with the `bereavement` capability (plus the
    /// current selection, so an existing choice never disappears).
    private var coordinatorOptions: [Member] {
        let selected = bereavementAssigneeUid
        let disciplines: Set<Discipline> = [.sw, .chaplain]
        return org.activeMembers.filter { member in
            if let discipline = member.discipline, disciplines.contains(discipline) { return true }
            if (member.capabilities ?? []).contains("bereavement") { return true }
            return member.memberUid == selected
        }
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
                    Picker("Location", selection: $location) {
                        ForEach(DeathLocation.allCases) { location in
                            Text(location.rawValue).tag(location)
                        }
                    }
                    if location == .other {
                        TextField("Describe the location", text: $otherLocation)
                            .textInputAutocapitalization(.sentences)
                    }
                }
                Section("Notes") {
                    TextField("Optional notes", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    Picker("Bereavement risk", selection: $risk) {
                        Text("Choose…").tag(BereavementRisk?.none)
                        ForEach(BereavementRisk.allCases) { risk in
                            Text(risk.label).tag(BereavementRisk?.some(risk))
                        }
                    }
                    if risk == nil {
                        Text("Assess and choose a bereavement risk level.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    CareMemberPicker(title: "Bereavement coordinator", selection: $bereavementAssigneeUid,
                                     members: coordinatorOptions, noneLabel: "Unassigned (org default)")
                } header: {
                    Text("Bereavement")
                } footer: {
                    Text("Creates a 13-month bereavement plan for the family. Coordinators are social workers, chaplains and members with bereavement access. The care team channel is archived and future visits and open tasks are cancelled.")
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
                    CareSubmitButton(title: "Record", isWorking: isSubmitting, isEnabled: isValid) {
                        confirming = true
                    }
                }
            }
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                pronouncedBy = org.me?.displayName?.nilIfBlank ?? org.myName
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
        guard !isSubmitting, let patientId = patient.id, let risk else { return }
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
                location: locationText,
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
