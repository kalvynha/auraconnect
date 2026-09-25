import SwiftUI
import Observation

@MainActor
@Observable
final class PatientDetailViewModel {
    let orgId: String
    let patientId: String
    private(set) var patient: Patient?
    private(set) var isLoading = true
    private(set) var notFound = false
    var errorMessage: String?

    init(orgId: String, patientId: String) {
        self.orgId = orgId
        self.patientId = patientId
    }

    func run() async {
        do {
            for try await value in PatientRepository(orgId: orgId).patient(id: patientId) {
                patient = value
                notFound = value == nil
                isLoading = false
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }
}

struct PatientDetailView: View {
    @Environment(OrgStore.self) private var org
    let patientId: String

    var body: some View {
        PatientDetailContent(orgId: org.orgId, patientId: patientId)
    }
}

private struct PatientDetailContent: View {
    @Environment(OrgStore.self) private var org
    @State private var model: PatientDetailViewModel
    @State private var showAdmit = false

    init(orgId: String, patientId: String) {
        _model = State(initialValue: PatientDetailViewModel(orgId: orgId, patientId: patientId))
    }

    var body: some View {
        Group {
            if let patient = model.patient {
                details(patient)
            } else if model.isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Patient not found",
                                       systemImage: "person.crop.circle.badge.questionmark",
                                       description: Text(model.errorMessage ?? "This patient record is unavailable."))
            }
        }
        .navigationTitle(model.patient?.sortName ?? "Patient")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.run() }
        .sheet(isPresented: $showAdmit) {
            if let patient = model.patient {
                AdmitWizardView(patientId: patient.id, initialInput: patient.input) { _ in
                    showAdmit = false
                }
                .environment(org)
            }
        }
    }

    @ViewBuilder
    private func details(_ patient: Patient) -> some View {
        let input = patient.input
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(input.fullName).font(.title2.weight(.semibold))
                        Spacer()
                        StatusPill(text: patient.patientStatus.label, color: patient.patientStatus.color)
                    }
                    Text(demographicLine(input))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)

                if let channelId = patient.channelId?.nilIfBlank {
                    NavigationLink(value: Route.channel(channelId)) {
                        Label("Open care team channel", systemImage: "bubble.left.and.bubble.right.fill")
                            .font(.body.weight(.semibold))
                    }
                }

                if patient.patientStatus == .referral && org.role.canManageReferrals {
                    Button {
                        showAdmit = true
                    } label: {
                        Label("Admit patient", systemImage: "person.badge.plus")
                            .font(.body.weight(.semibold))
                    }
                }
            }

            Section("Clinical") {
                LabeledContent("Code status") {
                    Text(input.codeStatus.label)
                        .fontWeight(.semibold)
                        .foregroundStyle(input.codeStatus == .fullCode || input.codeStatus == .unknown ? Color.primary : Color.purple)
                }
                if let primary = input.primaryDiagnosis, !primary.isEmpty {
                    LabeledContent("Primary diagnosis", value: primary.formatted)
                }
                ForEach(Array(input.secondaryDiagnoses.enumerated()), id: \.offset) { _, diagnosis in
                    LabeledContent("Secondary", value: diagnosis.formatted)
                }
                if let level = patient.levelOfCare {
                    LabeledContent("Level of care", value: level.label)
                }
                InfoRow(label: "Admitted", value: patient.admissionDate.map { ISODate.display($0) })
                if let period = patient.startingBenefitPeriod, period > 1 {
                    LabeledContent("Starting benefit period", value: "\(period)")
                }
            }

            Section("Allergies") {
                if input.allergies.isEmpty {
                    Text("None recorded").foregroundStyle(.secondary)
                } else {
                    ForEach(input.allergies, id: \.self) { allergy in
                        Label(allergy, systemImage: "allergens")
                            .foregroundStyle(.red)
                    }
                }
            }

            Section("Medications") {
                if input.medications.isEmpty {
                    Text("None recorded").foregroundStyle(.secondary)
                } else {
                    ForEach(Array(input.medications.enumerated()), id: \.offset) { _, medication in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(medication.name)
                            if !medication.detail.isEmpty {
                                Text(medication.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let milestones = patient.milestones {
                MilestonesSection(milestones: milestones, leadDays: org.leadDays)
            }

            Section("Care team") {
                let team = patient.careTeamUids ?? []
                if team.isEmpty {
                    Text("No care team assigned").foregroundStyle(.secondary)
                } else {
                    ForEach(team, id: \.self) { uid in
                        HStack(spacing: 12) {
                            AvatarView(initials: org.members[uid]?.initials ?? "?", size: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(org.name(for: uid))
                                if let subtitle = org.members[uid]?.subtitle, !subtitle.isEmpty {
                                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }

            if let caregiver = input.caregiver, !caregiver.isEmpty {
                Section("Caregiver") {
                    InfoRow(label: "Name", value: caregiver.name)
                    InfoRow(label: "Relationship", value: caregiver.relationship)
                    InfoRow(label: "Phone", value: caregiver.phone)
                }
            }

            Section("Demographics") {
                InfoRow(label: "Date of birth", value: input.dob.map { ISODate.display($0) })
                InfoRow(label: "Sex", value: input.sex == .unknown ? nil : input.sex.label)
                InfoRow(label: "Phone", value: input.phone)
                InfoRow(label: "Address", value: input.address.formatted)
                InfoRow(label: "MRN", value: input.mrn)
                InfoRow(label: "Medicare MBI", value: input.medicareMbi)
                InfoRow(label: "Payer", value: input.insurance.payer)
                InfoRow(label: "Member ID", value: input.insurance.memberId)
            }

            if input.attendingPhysician != nil || input.referringPhysician != nil {
                Section("Physicians") {
                    if let attending = input.attendingPhysician, !attending.isEmpty {
                        PhysicianRow(role: "Attending", physician: attending)
                    }
                    if let referring = input.referringPhysician, !referring.isEmpty {
                        PhysicianRow(role: "Referring", physician: referring)
                    }
                }
            }

            if let consents = patient.consents {
                Section("Consents") {
                    ConsentRow(title: "Election statement", signed: consents.electionStatement)
                    ConsentRow(title: "HIPAA notice", signed: consents.hipaaNotice)
                    ConsentRow(title: "Release of information", signed: consents.releaseOfInformation)
                    ConsentRow(title: "Patient rights", signed: consents.patientRights)
                    ConsentRow(title: "POLST / DNR on file", signed: consents.polstOnFile)
                }
            }
        }
    }

    private func demographicLine(_ input: PatientInput) -> String {
        var parts: [String] = []
        if let age = ISODate.age(fromDOB: input.dob) { parts.append("\(age) years") }
        if input.sex != .unknown { parts.append(input.sex.label) }
        if let dob = input.dob { parts.append("DOB \(ISODate.display(dob))") }
        if let mrn = input.mrn?.nilIfBlank { parts.append("MRN \(mrn)") }
        return parts.isEmpty ? "No demographics recorded" : parts.joined(separator: " · ")
    }
}

struct MilestonesSection: View {
    let milestones: Milestones
    let leadDays: Int

    var body: some View {
        let items = MilestoneLogic.items(for: milestones, today: Date(), leadDays: leadDays)
        Section {
            if items.isEmpty {
                Text("No milestones computed").foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: item.status.symbol)
                        .foregroundStyle(item.status.color)
                        .frame(width: 22)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                        if let start = item.windowStart {
                            Text("Window \(ISODate.display(start)) – \(ISODate.display(item.dueDate))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Due \(ISODate.display(item.dueDate))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    StatusPill(text: item.status.label, color: item.status.color)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Hospice milestones")
        } footer: {
            Text("Computed from CMS hospice rules at admission. Verify with your compliance team.")
        }
    }
}

private struct PhysicianRow: View {
    let role: String
    let physician: Physician

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(role): \(physician.name)")
            let detail = [physician.npi.map { "NPI \($0)" }, physician.phone.map { "Ph \($0)" }, physician.fax.map { "Fax \($0)" }]
                .compactMap { $0 }
                .joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct ConsentRow: View {
    let title: String
    let signed: Bool

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: signed ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(signed ? Color.green : Color.secondary)
        }
        .accessibilityValue(signed ? "Signed" : "Not signed")
    }
}
