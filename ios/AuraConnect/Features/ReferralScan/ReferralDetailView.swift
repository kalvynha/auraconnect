import SwiftUI
import Observation
import QuickLook

@MainActor
@Observable
final class ReferralDetailViewModel {
    let orgId: String
    let referralId: String
    private(set) var referral: Referral?
    private(set) var isLoading = true
    private(set) var isWorking = false
    /// Editable copy of `extracted.patient` (or a blank form for manual entry after a failure).
    var draft: PatientInput?
    var errorMessage: String?
    var rejectReason = ""
    private(set) var acceptedPatientId: String?
    private(set) var isOpeningDocument = false
    var documentURL: URL?

    private let functions = FunctionsClient()

    init(orgId: String, referralId: String) {
        self.orgId = orgId
        self.referralId = referralId
    }

    var status: ReferralStatus { referral?.referralStatus ?? .uploaded }

    func run() async {
        do {
            for try await value in ReferralRepository(orgId: orgId).referral(id: referralId) {
                referral = value
                isLoading = false
                if draft == nil, value?.referralStatus == .needsReview, let patient = value?.extracted?.patient {
                    draft = patient
                }
                if let patientId = value?.patientId {
                    acceptedPatientId = patientId
                }
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Lets a person type the details in when extraction failed (acceptReferral allows `failed`).
    func startManualEntry() {
        draft = referral?.extracted?.patient ?? PatientInput()
    }

    func accept() async {
        guard let draft, draft.hasRequiredNames else {
            errorMessage = "First and last name are required."
            return
        }
        await perform {
            let patientId = try await self.functions.acceptReferral(orgId: self.orgId, referralId: self.referralId, patient: draft)
            self.acceptedPatientId = patientId
        }
    }

    func reject() async {
        guard let reason = rejectReason.nilIfBlank else { return }
        await perform {
            try await self.functions.rejectReferral(orgId: self.orgId, referralId: self.referralId, reason: reason)
            self.rejectReason = ""
        }
    }

    func retry() async {
        await perform {
            try await self.functions.retryReferralExtraction(orgId: self.orgId, referralId: self.referralId)
            self.draft = nil
        }
    }

    func openDocument() async {
        guard let referral, let path = referral.storagePath, !isOpeningDocument else { return }
        isOpeningDocument = true
        defer { isOpeningDocument = false }
        do {
            documentURL = try await SecureDownload.fetchToTemporaryFile(
                storagePath: path,
                fileName: referral.fileName ?? "referral.pdf",
                contentType: referral.contentType ?? "application/pdf"
            )
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func perform(_ action: () async throws -> Void) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await action()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

struct ReferralDetailView: View {
    @Environment(OrgStore.self) private var org
    let referralId: String

    var body: some View {
        ReferralDetailContent(orgId: org.orgId, referralId: referralId)
    }
}

private struct ReferralDetailContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: ReferralDetailViewModel
    @State private var showReject = false
    @State private var showAdmit = false

    init(orgId: String, referralId: String) {
        _model = State(initialValue: ReferralDetailViewModel(orgId: orgId, referralId: referralId))
    }

    private var draftBinding: Binding<PatientInput> {
        Binding(
            get: { model.draft ?? PatientInput() },
            set: { model.draft = $0 }
        )
    }

    var body: some View {
        @Bindable var model = model
        Form {
            if model.isLoading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if let referral = model.referral {
                content(referral)
            } else {
                Section {
                    ContentUnavailableView("Referral unavailable",
                                           systemImage: "doc.questionmark",
                                           description: Text(model.errorMessage ?? "This referral could not be loaded."))
                }
            }
        }
        .navigationTitle(model.referral?.displayTitle ?? "Referral")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.referral?.storagePath != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.openDocument() }
                    } label: {
                        if model.isOpeningDocument {
                            ProgressView()
                        } else {
                            Label("View document", systemImage: "doc.text.magnifyingglass")
                        }
                    }
                }
            }
        }
        .quickLookPreview($model.documentURL)
        .onChange(of: model.documentURL) { oldValue, newValue in
            if newValue == nil { SecureDownload.remove(oldValue) }
        }
        .alert("Reject referral", isPresented: $showReject) {
            TextField("Reason", text: $model.rejectReason)
            Button("Reject", role: .destructive) {
                Task { await model.reject() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The reason is recorded in the audit log.")
        }
        .sheet(isPresented: $showAdmit) {
            if let patientId = model.acceptedPatientId {
                AdmitWizardView(patientId: patientId, initialInput: model.draft ?? model.referral?.extracted?.patient ?? PatientInput()) { result in
                    showAdmit = false
                    router.push(.patient(result.patientId))
                }
                .environment(org)
            }
        }
        .task { await model.run() }
    }

    @ViewBuilder
    private func content(_ referral: Referral) -> some View {
        Section {
            HStack {
                StatusPill(text: referral.referralStatus.label, color: referral.referralStatus.color)
                Spacer()
                Text(RelativeTime.full(referral.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
        }

        switch referral.referralStatus {
        case .uploaded, .extracting:
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 2) {
                        Text(referral.referralStatus == .uploaded ? "Uploaded, waiting for extraction…" : "Extracting patient details…")
                        Text("This usually takes less than a minute. You can leave this screen.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

        case .failed:
            if model.draft == nil {
                Section {
                    Label(referral.error?.nilIfBlank ?? "Extraction failed.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Button {
                        Task { await model.retry() }
                    } label: {
                        Label("Retry extraction", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isWorking)
                    Button {
                        model.startManualEntry()
                    } label: {
                        Label("Enter details manually", systemImage: "square.and.pencil")
                    }
                    Button("Reject referral", role: .destructive) { showReject = true }
                        .disabled(model.isWorking)
                }
            } else {
                reviewSections(referral)
            }

        case .needsReview:
            reviewSections(referral)

        case .accepted:
            Section {
                Label("Accepted", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                if let patientId = model.acceptedPatientId {
                    NavigationLink(value: Route.patient(patientId)) {
                        Label("Open patient", systemImage: "person.text.rectangle")
                    }
                    Button {
                        showAdmit = true
                    } label: {
                        Label("Admit now", systemImage: "person.badge.plus")
                            .font(.body.weight(.semibold))
                    }
                }
            } footer: {
                Text("The patient was created with status “referral”. Admit to compute hospice deadlines and create the care team channel.")
            }

        case .rejected:
            Section("Rejected") {
                Text(referral.rejectionReason?.nilIfBlank ?? "No reason recorded.")
                InfoRow(label: "Reviewed by", value: referral.reviewedBy.map { org.name(for: $0) })
            }
        }
    }

    @ViewBuilder
    private func reviewSections(_ referral: Referral) -> some View {
        let extraction = referral.extracted
        let lowCount = (extraction?.fieldConfidence.values.filter { $0 < AppConfig.lowConfidenceThreshold }.count) ?? 0

        if let warnings = extraction?.warnings, !warnings.isEmpty {
            Section("Warnings from extraction") {
                ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                    Label(warning, systemImage: "exclamationmark.bubble.fill")
                        .foregroundStyle(.orange)
                }
            }
        }

        Section {
            if lowCount > 0 {
                Label("\(lowCount) field\(lowCount == 1 ? "" : "s") extracted with low confidence are highlighted. Check them against the document.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            InfoRow(label: "Referral date", value: extraction?.referralDate.map { ISODate.display($0) })
            InfoRow(label: "Referral source", value: extraction?.referralSource)
            InfoRow(label: "Reason", value: extraction?.reasonForReferral)
            InfoRow(label: "Model", value: referral.model)
        } header: {
            Text("Review")
        }

        PatientInputSections(input: draftBinding, confidence: extraction?.fieldConfidence)

        Section {
            Button {
                Task { await model.accept() }
            } label: {
                HStack {
                    Spacer()
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Label("Accept referral", systemImage: "checkmark.circle.fill").bold()
                    }
                    Spacer()
                }
            }
            .disabled(model.isWorking || !(model.draft?.hasRequiredNames ?? false))
            Button("Reject referral", role: .destructive) { showReject = true }
                .disabled(model.isWorking)
        } footer: {
            Text("Accepting creates a patient with status “referral”. You can admit them next.")
        }
    }
}
