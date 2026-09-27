import SwiftUI

/// I5: "New phone referral" — the essentials taken on a call, with no document. The referral is
/// created in `needs_review` (claimed by the caller) and opened for review, where the rest of the
/// patient details can be completed before accepting.
struct PhoneReferralView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let onCreated: (String) -> Void

    @State private var input = PatientInput()
    @State private var diagnosis = ""
    @State private var caregiverName = ""
    @State private var caregiverPhone = ""
    @State private var referralDate: String? = ISODate.string(from: Date())
    @State private var referralSource = ""
    @State private var reason = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Patient") {
                    FormTextField(title: "First name", text: $input.firstName)
                    FormTextField(title: "Last name", text: $input.lastName)
                    OptionalDateRow(title: "Date of birth", date: $input.dob)
                    Picker("Sex", selection: $input.sex) {
                        ForEach(Sex.allCases) { sex in
                            Text(sex.label).tag(sex)
                        }
                    }
                    FormTextField(title: "Phone", text: $input.phone.orEmpty, keyboard: .phonePad)
                    FormTextField(title: "Medicare MBI", text: $input.medicareMbi.orEmpty, capitalization: .characters)
                    FormTextField(title: "Primary diagnosis", text: $diagnosis, capitalization: .sentences)
                }
                Section("Caregiver") {
                    FormTextField(title: "Name", text: $caregiverName)
                    FormTextField(title: "Phone", text: $caregiverPhone, keyboard: .phonePad)
                }
                Section {
                    OptionalDateRow(title: "Referral date", date: $referralDate)
                    FormTextField(title: "Referral source", text: $referralSource)
                    FormTextField(title: "Reason for referral", text: $reason, capitalization: .sentences)
                } header: {
                    Text("Referral")
                } footer: {
                    Text("The Medicare MBI, last name and date of birth are used to check for duplicates.")
                }
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
            }
            .navigationTitle("Phone referral")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await save() } }
                            .disabled(!input.hasRequiredNames)
                    }
                }
            }
        }
    }

    private func save() async {
        guard input.hasRequiredNames else {
            errorMessage = "First and last name are required."
            return
        }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        var patient = input
        if let text = diagnosis.nilIfBlank { patient.primaryDiagnosis = Diagnosis(code: nil, description: text) }
        if let name = caregiverName.nilIfBlank { patient.caregiver = Caregiver(name: name, relationship: nil, phone: caregiverPhone.nilIfBlank) }
        do {
            let id = try await FunctionsClient().createManualReferral(
                orgId: org.orgId, patient: patient, referralDate: referralDate,
                referralSource: referralSource, reasonForReferral: reason
            )
            onCreated(id)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// I5: close a referral without admission.
struct NonAdmitSheet: View {
    @Environment(\.dismiss) private var dismiss
    let orgId: String
    let referralId: String
    let onDone: () -> Void

    @State private var reason: NonAdmitReason = .declinedHospice
    @State private var note = ""
    @State private var deathDate = Date()
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isValid: Bool { reason != .other || note.nilIfBlank != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Reason", selection: $reason) {
                        ForEach(NonAdmitReason.allCases) { r in
                            Text(r.label).tag(r)
                        }
                    }
                    if reason == .diedBeforeAdmission {
                        DatePicker("Date of death", selection: $deathDate, in: ...Date(), displayedComponents: .date)
                    }
                } footer: {
                    if reason == .diedBeforeAdmission {
                        Text("The death is recorded on the referral patient. No bereavement plan is created because the patient was never admitted.")
                    }
                }
                Section(reason == .other ? "Note (required)" : "Note") {
                    TextField("Note", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                }
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
            }
            .navigationTitle("Non-admit")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Close referral") { Task { await save() } }
                            .disabled(!isValid)
                    }
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await FunctionsClient().closeReferralNonAdmit(
                orgId: orgId, referralId: referralId, reason: reason, note: note,
                deathDate: reason == .diedBeforeAdmission ? ISODate.string(from: deathDate) : nil
            )
            onDone()
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
