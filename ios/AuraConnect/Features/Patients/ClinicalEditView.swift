import SwiftUI

extension OrgStore {
    /// H4/S3: admins and RN/NP/MD members may perform licensed acts (death, discharge, level of
    /// care, recertification, milestone reopen, clinical edits). The server re-checks.
    var isLicensed: Bool {
        if role == .admin { return true }
        guard let discipline = me?.discipline else { return false }
        return discipline == .rn || discipline == .np || discipline == .md
    }
}

/// S2: edit code status, allergies, medications, contacts, physicians and diagnoses after admission
/// (`updatePatientClinical`). Only changed fields are sent; the server merges them into the record.
struct ClinicalEditView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patient: Patient

    @State private var draft = PatientInput()
    @State private var reason = ""
    @State private var didLoad = false
    @State private var isSubmitting = false
    @State private var confirmingCodeStatus = false
    @State private var errorMessage: String?

    private var original: PatientInput { patient.input }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                codeStatusSection
                allergiesSection
                medicationsSection
                contactSections
                physicianSection(title: "Attending physician", binding: $draft.attendingPhysician)
                physicianSection(title: "Referring physician", binding: $draft.referringPhysician)
                diagnosisSections
                Section {
                    TextField("Why is this changing?", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Reason (required)")
                } footer: {
                    Text("Recorded in the patient timeline and the audit log.")
                }
            }
            .navigationTitle("Edit clinical record")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Save", isWorking: isSubmitting, isEnabled: reason.nilIfBlank != nil) {
                        if draft.codeStatus != original.codeStatus {
                            confirmingCodeStatus = true
                        } else {
                            Task { await submit() }
                        }
                    }
                }
            }
            .confirmationDialog("Change code status to \(draft.codeStatus.label)?", isPresented: $confirmingCodeStatus, titleVisibility: .visible) {
                Button("Change code status") {
                    Task { await submit() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The change is posted to the care team channel and the care team is alerted.")
            }
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                draft = patient.input
            }
        }
    }

    // MARK: Sections

    private var codeStatusSection: some View {
        Section {
            Picker("Code status", selection: $draft.codeStatus) {
                ForEach(CodeStatus.allCases) { status in
                    Text(status.label).tag(status)
                }
            }
        } header: {
            Text("Code status")
        }
    }

    private var allergiesSection: some View {
        Section("Allergies") {
            ForEach(draft.allergies.indices, id: \.self) { index in
                TextField("Allergy", text: elementBinding($draft.allergies, index, default: ""))
            }
            .onDelete { draft.allergies.remove(atOffsets: $0) }
            Button {
                draft.allergies.append("")
            } label: {
                Label("Add allergy", systemImage: "plus")
            }
        }
    }

    private var medicationsSection: some View {
        Section("Medications") {
            ForEach(draft.medications.indices, id: \.self) { index in
                let medication = elementBinding($draft.medications, index, default: Medication())
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Name", text: medication.name)
                    HStack {
                        TextField("Dose", text: medication.dose.orEmpty)
                        TextField("Route", text: medication.route.orEmpty)
                        TextField("Frequency", text: medication.frequency.orEmpty)
                    }
                    .font(.subheadline)
                }
            }
            .onDelete { draft.medications.remove(atOffsets: $0) }
            Button {
                draft.medications.append(Medication())
            } label: {
                Label("Add medication", systemImage: "plus")
            }
        }
    }

    @ViewBuilder
    private var contactSections: some View {
        Section("Caregiver") {
            let caregiver = $draft.caregiver.withDefault(Caregiver())
            TextField("Name", text: caregiver.name)
                .textInputAutocapitalization(.words)
            TextField("Relationship", text: caregiver.relationship.orEmpty)
            TextField("Phone", text: caregiver.phone.orEmpty)
                .keyboardType(.phonePad)
        }
        Section("Patient contact") {
            TextField("Phone", text: $draft.phone.orEmpty)
                .keyboardType(.phonePad)
            TextField("Address line 1", text: $draft.address.line1.orEmpty)
            TextField("Address line 2", text: $draft.address.line2.orEmpty)
            TextField("City", text: $draft.address.city.orEmpty)
            TextField("State", text: $draft.address.state.orEmpty)
            TextField("ZIP", text: $draft.address.zip.orEmpty)
                .keyboardType(.numbersAndPunctuation)
        }
    }

    private func physicianSection(title: String, binding: Binding<Physician?>) -> some View {
        let physician = binding.withDefault(Physician())
        return Section(title) {
            TextField("Name", text: physician.name)
                .textInputAutocapitalization(.words)
            TextField("NPI", text: physician.npi.orEmpty)
                .keyboardType(.numberPad)
            TextField("Phone", text: physician.phone.orEmpty)
                .keyboardType(.phonePad)
            TextField("Fax", text: physician.fax.orEmpty)
                .keyboardType(.phonePad)
        }
    }

    /// Explicit bindings for `Diagnosis.description` (avoids any clash with a `description` member).
    private var primaryDescription: Binding<String> {
        Binding<String>(
            get: { draft.primaryDiagnosis?.description ?? "" },
            set: { value in
                var d = draft.primaryDiagnosis ?? Diagnosis()
                d.description = value
                draft.primaryDiagnosis = d
            }
        )
    }

    private var primaryCode: Binding<String> {
        Binding<String>(
            get: { draft.primaryDiagnosis?.code ?? "" },
            set: { value in
                var d = draft.primaryDiagnosis ?? Diagnosis()
                d.code = value.isEmpty ? nil : value
                draft.primaryDiagnosis = d
            }
        )
    }

    private func secondaryDescription(_ index: Int) -> Binding<String> {
        Binding<String>(
            get: { index < draft.secondaryDiagnoses.count ? draft.secondaryDiagnoses[index].description : "" },
            set: { value in
                if index < draft.secondaryDiagnoses.count { draft.secondaryDiagnoses[index].description = value }
            }
        )
    }

    private func secondaryCode(_ index: Int) -> Binding<String> {
        Binding<String>(
            get: { index < draft.secondaryDiagnoses.count ? (draft.secondaryDiagnoses[index].code ?? "") : "" },
            set: { value in
                if index < draft.secondaryDiagnoses.count { draft.secondaryDiagnoses[index].code = value.isEmpty ? nil : value }
            }
        )
    }

    @ViewBuilder
    private var diagnosisSections: some View {
        Section("Primary diagnosis") {
            TextField("Description", text: primaryDescription)
            TextField("ICD-10 code", text: primaryCode)
                .textInputAutocapitalization(.characters)
        }
        Section("Secondary diagnoses") {
            ForEach(draft.secondaryDiagnoses.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Description", text: secondaryDescription(index))
                    TextField("ICD-10 code", text: secondaryCode(index))
                        .font(.subheadline)
                        .textInputAutocapitalization(.characters)
                }
            }
            .onDelete { draft.secondaryDiagnoses.remove(atOffsets: $0) }
            Button {
                draft.secondaryDiagnoses.append(Diagnosis())
            } label: {
                Label("Add diagnosis", systemImage: "plus")
            }
        }
    }

    // MARK: Submit

    private func clean(_ value: String?) -> String? { value?.nilIfBlank }

    private func normalized(_ c: Caregiver?) -> Caregiver? {
        guard let c, !c.isEmpty else { return nil }
        return Caregiver(name: c.name.trimmed, relationship: clean(c.relationship), phone: clean(c.phone))
    }

    private func normalized(_ p: Physician?) -> Physician? {
        guard let p, !p.isEmpty else { return nil }
        return Physician(name: p.name.trimmed, npi: clean(p.npi), phone: clean(p.phone), fax: clean(p.fax))
    }

    private func normalized(_ d: Diagnosis?) -> Diagnosis? {
        guard let d, !d.isEmpty else { return nil }
        return Diagnosis(code: clean(d.code), description: d.description.trimmed)
    }

    private func normalized(_ m: Medication) -> Medication {
        Medication(name: m.name.trimmed, dose: clean(m.dose), route: clean(m.route), frequency: clean(m.frequency))
    }

    private func normalized(_ a: Address) -> Address {
        Address(line1: clean(a.line1), line2: clean(a.line2), city: clean(a.city), state: clean(a.state), zip: clean(a.zip))
    }

    /// The changed fields, encoded for the callable, or an error message.
    private func changedFields() -> (fields: [String: Any], error: String?) {
        var fields: [String: Any] = [:]
        if draft.codeStatus != original.codeStatus { fields["codeStatus"] = draft.codeStatus.rawValue }

        let allergies = draft.allergies.compactMap { $0.nilIfBlank }
        if allergies != original.allergies.compactMap({ $0.nilIfBlank }) { fields["allergies"] = allergies }

        let medications = draft.medications
            .map { normalized($0) }
            .filter { $0.name.nilIfBlank != nil || $0.dose != nil || $0.route != nil || $0.frequency != nil }
        if medications.contains(where: { $0.name.nilIfBlank == nil }) { return ([:], "Every medication needs a name.") }
        if medications != original.medications.map { normalized($0) } { fields["medications"] = medications.map { $0.dictionary } }

        let caregiver = normalized(draft.caregiver)
        if let caregiver, caregiver.name.nilIfBlank == nil { return ([:], "The caregiver needs a name, or clear all caregiver fields.") }
        if caregiver != normalized(original.caregiver) {
            // Only these keys: the server merges them, keeping any caregiver mailing address.
            fields["caregiver"] = caregiver.map { c -> Any in
                ["name": c.name, "relationship": orNull(c.relationship), "phone": orNull(c.phone)] as [String: Any]
            } ?? NSNull()
        }

        for (key, draftValue, originalValue, label) in [
            ("attendingPhysician", draft.attendingPhysician, original.attendingPhysician, "attending"),
            ("referringPhysician", draft.referringPhysician, original.referringPhysician, "referring"),
        ] {
            let value = normalized(draftValue)
            if let value, value.name.nilIfBlank == nil { return ([:], "The \(label) physician needs a name, or clear all of its fields.") }
            if value != normalized(originalValue) { fields[key] = value.map { $0.dictionary as Any } ?? NSNull() }
        }

        if clean(draft.phone) != clean(original.phone) { fields["phone"] = blankToNull(draft.phone) }
        if normalized(draft.address) != normalized(original.address) { fields["address"] = draft.address.dictionary }

        let primary = normalized(draft.primaryDiagnosis)
        if let primary, primary.description.nilIfBlank == nil { return ([:], "The primary diagnosis needs a description.") }
        if primary != normalized(original.primaryDiagnosis) { fields["primaryDiagnosis"] = primary.map { $0.dictionary as Any } ?? NSNull() }

        let secondary = draft.secondaryDiagnoses.compactMap { normalized($0) }
        if secondary.contains(where: { $0.description.nilIfBlank == nil }) { return ([:], "Every secondary diagnosis needs a description.") }
        if secondary != original.secondaryDiagnoses.compactMap({ normalized($0) }) { fields["secondaryDiagnoses"] = secondary.map { $0.dictionary } }

        return (fields, nil)
    }

    private func submit() async {
        guard !isSubmitting, let patientId = patient.id, let reasonText = reason.nilIfBlank else { return }
        let result = changedFields()
        if let error = result.error {
            errorMessage = error
            return
        }
        if result.fields.isEmpty {
            errorMessage = "Nothing has changed."
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await FunctionsClient().updatePatientClinical(orgId: org.orgId, patientId: patientId, reason: reasonText, fields: result.fields)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
