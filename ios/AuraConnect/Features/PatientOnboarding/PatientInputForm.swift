import SwiftUI

/// Editable `PatientInput` form sections. Used by the admit wizard and referral review.
/// When `confidence` is provided (from `ReferralExtraction.fieldConfidence`), fields below
/// `AppConfig.lowConfidenceThreshold` are highlighted.
struct PatientInputSections: View {
    @Binding var input: PatientInput
    var confidence: [String: Double]? = nil

    private func conf(_ path: String) -> Double? {
        guard let confidence else { return nil }
        return ConfidenceLookup.confidence(for: "patient.\(path)", in: confidence)
    }

    var body: some View {
        Section("Patient") {
            FormTextField(title: "First name", text: $input.firstName, confidence: conf("firstName"))
            FormTextField(title: "Last name", text: $input.lastName, confidence: conf("lastName"))
            OptionalDateRow(title: "Date of birth", date: $input.dob, confidence: conf("dob"))
            Picker("Sex", selection: $input.sex) {
                ForEach(Sex.allCases) { sex in
                    Text(sex.label).tag(sex)
                }
            }
            .lowConfidenceHighlight(conf("sex"))
            FormTextField(title: "Phone", text: $input.phone.orEmpty, confidence: conf("phone"), keyboard: .phonePad)
            FormTextField(title: "MRN", text: $input.mrn.orEmpty, confidence: conf("mrn"), capitalization: .characters)
            FormTextField(title: "Medicare MBI", text: $input.medicareMbi.orEmpty, confidence: conf("medicareMbi"), capitalization: .characters)
        }

        Section("Address") {
            FormTextField(title: "Street", text: $input.address.line1.orEmpty, confidence: conf("address.line1") ?? conf("address"))
            FormTextField(title: "Apt / unit", text: $input.address.line2.orEmpty, confidence: conf("address.line2"))
            FormTextField(title: "City", text: $input.address.city.orEmpty, confidence: conf("address.city"))
            FormTextField(title: "State", text: $input.address.state.orEmpty, confidence: conf("address.state"), capitalization: .characters)
            FormTextField(title: "ZIP", text: $input.address.zip.orEmpty, confidence: conf("address.zip"), keyboard: .numbersAndPunctuation)
        }

        Section("Diagnoses") {
            let primary = $input.primaryDiagnosis.withDefault(Diagnosis())
            FormTextField(title: "Primary diagnosis", text: primary[dynamicMember: \Diagnosis.description], confidence: conf("primaryDiagnosis"), capitalization: .sentences)
            FormTextField(title: "ICD-10 code", text: primary.code.orEmpty, confidence: conf("primaryDiagnosis.code"), capitalization: .characters)
            ForEach(input.secondaryDiagnoses.indices, id: \.self) { index in
                let diagnosis = elementBinding($input.secondaryDiagnoses, index, default: Diagnosis())
                HStack {
                    TextField("Secondary diagnosis", text: diagnosis[dynamicMember: \Diagnosis.description])
                    TextField("ICD-10", text: diagnosis.code.orEmpty)
                        .frame(maxWidth: 90)
                        .textInputAutocapitalization(.characters)
                }
                .lowConfidenceHighlight(conf("secondaryDiagnoses"))
            }
            .onDelete { input.secondaryDiagnoses.remove(atOffsets: $0) }
            Button {
                input.secondaryDiagnoses.append(Diagnosis())
            } label: {
                Label("Add secondary diagnosis", systemImage: "plus")
            }
        }

        Section("Code status") {
            Picker("Code status", selection: $input.codeStatus) {
                ForEach(CodeStatus.allCases) { status in
                    Text(status.label).tag(status)
                }
            }
            .lowConfidenceHighlight(conf("codeStatus"))
        }

        Section("Allergies") {
            ForEach(input.allergies.indices, id: \.self) { index in
                TextField("Allergy", text: elementBinding($input.allergies, index, default: ""))
                    .lowConfidenceHighlight(conf("allergies"))
            }
            .onDelete { input.allergies.remove(atOffsets: $0) }
            Button {
                input.allergies.append("")
            } label: {
                Label("Add allergy", systemImage: "plus")
            }
        }

        Section("Medications") {
            ForEach(input.medications.indices, id: \.self) { index in
                let medication = elementBinding($input.medications, index, default: Medication())
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Medication", text: medication.name)
                    HStack {
                        TextField("Dose", text: medication.dose.orEmpty)
                        TextField("Route", text: medication.route.orEmpty)
                        TextField("Frequency", text: medication.frequency.orEmpty)
                    }
                    .font(.subheadline)
                }
                .lowConfidenceHighlight(conf("medications"))
            }
            .onDelete { input.medications.remove(atOffsets: $0) }
            Button {
                input.medications.append(Medication())
            } label: {
                Label("Add medication", systemImage: "plus")
            }
        }

        Section("Caregiver") {
            let caregiver = $input.caregiver.withDefault(Caregiver())
            FormTextField(title: "Name", text: caregiver.name, confidence: conf("caregiver.name") ?? conf("caregiver"))
            FormTextField(title: "Relationship", text: caregiver.relationship.orEmpty, confidence: conf("caregiver.relationship"))
            FormTextField(title: "Phone", text: caregiver.phone.orEmpty, confidence: conf("caregiver.phone"), keyboard: .phonePad)
        }

        PhysicianSection(title: "Attending physician", physician: $input.attendingPhysician.withDefault(Physician()),
                         confidence: { conf("attendingPhysician" + $0) })
        PhysicianSection(title: "Referring physician", physician: $input.referringPhysician.withDefault(Physician()),
                         confidence: { conf("referringPhysician" + $0) })

        Section("Insurance") {
            FormTextField(title: "Payer", text: $input.insurance.payer.orEmpty, confidence: conf("insurance.payer") ?? conf("insurance"))
            FormTextField(title: "Member ID", text: $input.insurance.memberId.orEmpty, confidence: conf("insurance.memberId"), capitalization: .characters)
        }
    }
}

private struct PhysicianSection: View {
    let title: String
    @Binding var physician: Physician
    /// Called with "" for the whole object or ".name", ".npi", … for a field.
    let confidence: (String) -> Double?

    var body: some View {
        Section(title) {
            FormTextField(title: "Name", text: $physician.name, confidence: confidence(".name") ?? confidence(""))
            FormTextField(title: "NPI", text: $physician.npi.orEmpty, confidence: confidence(".npi"), keyboard: .numberPad)
            FormTextField(title: "Phone", text: $physician.phone.orEmpty, confidence: confidence(".phone"), keyboard: .phonePad)
            FormTextField(title: "Fax", text: $physician.fax.orEmpty, confidence: confidence(".fax"), keyboard: .phonePad)
        }
    }
}

/// A `YYYY-MM-DD` optional date: "Add" button when empty, DatePicker + clear when set.
struct OptionalDateRow: View {
    let title: String
    @Binding var date: String?
    var confidence: Double? = nil

    var body: some View {
        HStack {
            if date == nil {
                Text(title)
                Spacer()
                Button("Add") {
                    date = ISODate.string(from: Date())
                }
            } else {
                DatePicker(title, selection: isoDateBinding($date), in: ...Date(), displayedComponents: .date)
                Button {
                    date = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Clear \(title)")
            }
            if ConfidenceLookup.isLow(confidence) {
                LowConfidenceIcon(confidence: confidence)
            }
        }
        .lowConfidenceHighlight(confidence)
    }
}
