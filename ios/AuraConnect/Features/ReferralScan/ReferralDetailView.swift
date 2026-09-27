import SwiftUI
import Observation
import QuickLook

@MainActor
@Observable
final class ReferralDetailViewModel {
    let orgId: String
    let referralId: String
    let uid: String
    private(set) var referral: Referral?
    private(set) var isLoading = true
    private(set) var isWorking = false
    /// Editable copy of `extracted.patient` (or a blank form for manual entry after a failure).
    var draft: PatientInput?
    /// I3: editable referral metadata, seeded from the extraction.
    var referralDate: String?
    var referralSource = ""
    var reasonForReferral = ""
    /// I4: required when the referral has possible duplicates.
    var confirmNotDuplicate = false
    var errorMessage: String?
    var rejectReason = ""
    private(set) var acceptedPatientId: String?
    private(set) var isOpeningDocument = false
    var documentURL: URL?
    /// Refreshed every 30 s so stale/claim states update without a new snapshot.
    private(set) var now = Date()
    private var lastClaimAttempt: Date?

    private let functions = FunctionsClient()
    private static let claimRefreshInterval: TimeInterval = 10 * 60

    init(orgId: String, referralId: String, uid: String) {
        self.orgId = orgId
        self.referralId = referralId
        self.uid = uid
    }

    var status: ReferralStatus { referral?.referralStatus ?? .uploaded }
    private static let openStatuses: [ReferralStatus] = [.uploaded, .extracting, .needsReview, .failed]
    var isOpen: Bool { Self.openStatuses.contains(status) }
    var reviewer: String? { referral?.activeClaimant(now: now) }
    /// Someone else holds a live claim: accept/reject/non-admit are theirs until they finish or it expires.
    var otherReviewer: String? {
        guard let reviewer, reviewer != uid else { return nil }
        return reviewer
    }
    var isStale: Bool { referral?.isStale(now: now) ?? false }
    var needsDuplicateConfirmation: Bool { !(referral?.duplicates.isEmpty ?? true) && !confirmNotDuplicate }

    func run() async {
        do {
            for try await value in ReferralRepository(orgId: orgId).referral(id: referralId) {
                referral = value
                isLoading = false
                if draft == nil, value?.referralStatus == .needsReview, let patient = value?.extracted?.patient {
                    seedDraft(patient)
                }
                if let patientId = value?.patientId {
                    acceptedPatientId = patientId
                }
                await claimIfNeeded()
            }
        } catch {
            isLoading = false
            errorMessage = error.userMessage
        }
    }

    /// Ticks the clock and keeps our review claim alive while the screen is open.
    func tick() async {
        now = Date()
        await claimIfNeeded()
    }

    private func claimIfNeeded() async {
        guard let referral, isOpen else { return }
        let holder = referral.activeClaimant(now: now)
        let mineButAging = holder == uid && (referral.claimedAt.map { now.timeIntervalSince($0) > Self.claimRefreshInterval } ?? true)
        guard holder == nil || mineButAging else { return }
        // Don't hammer the server if a claim attempt just failed.
        if let last = lastClaimAttempt, now.timeIntervalSince(last) < 60 { return }
        lastClaimAttempt = now
        _ = try? await functions.claimReferral(orgId: orgId, referralId: referralId, force: false)
    }

    func takeOver() async {
        await perform {
            try await self.functions.claimReferral(orgId: self.orgId, referralId: self.referralId, force: true)
        }
    }

    /// Releases our claim when leaving the screen so others can pick the referral up.
    func releaseClaim() {
        guard referral?.activeClaimant(now: Date()) == uid, isOpen else { return }
        let functions = functions, orgId = orgId, referralId = referralId
        Task { try? await functions.releaseReferralClaim(orgId: orgId, referralId: referralId) }
    }

    private func seedDraft(_ patient: PatientInput) {
        draft = patient
        referralDate = referral?.extracted?.referralDate
        referralSource = referral?.extracted?.referralSource ?? ""
        reasonForReferral = referral?.extracted?.reasonForReferral ?? ""
    }

    /// Lets a person type the details in when extraction failed (acceptReferral allows `failed`).
    func startManualEntry() {
        seedDraft(referral?.extracted?.patient ?? PatientInput())
    }

    func accept() async {
        guard let draft, draft.hasRequiredNames else {
            errorMessage = "First and last name are required."
            return
        }
        if needsDuplicateConfirmation {
            errorMessage = "Review the possible duplicates and confirm this is not one of them."
            return
        }
        await perform {
            let patientId = try await self.functions.acceptReferral(
                orgId: self.orgId, referralId: self.referralId, patient: draft,
                referralDate: self.referralDate, referralSource: self.referralSource,
                reasonForReferral: self.reasonForReferral, confirmNotDuplicate: self.confirmNotDuplicate
            )
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
        ReferralDetailContent(orgId: org.orgId, uid: org.uid, referralId: referralId)
    }
}

private struct ReferralDetailContent: View {
    @Environment(OrgStore.self) private var org
    @Environment(Router.self) private var router
    @State private var model: ReferralDetailViewModel
    @State private var showReject = false
    @State private var showAdmit = false
    @State private var showNonAdmit = false

    init(orgId: String, uid: String, referralId: String) {
        _model = State(initialValue: ReferralDetailViewModel(orgId: orgId, referralId: referralId, uid: uid))
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
            if model.referral?.hasFile == true {
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
            Text("Use Reject for something that isn't a real referral (wrong fax, duplicate upload). The reason is recorded in the audit log.")
        }
        .sheet(isPresented: $showAdmit) {
            if let patientId = model.acceptedPatientId {
                // I6: the wizard loads the reviewed patient document; the draft only fills the form until it arrives.
                AdmitWizardView(patientId: patientId, initialInput: model.draft ?? PatientInput()) { result in
                    showAdmit = false
                    router.push(.patient(result.patientId))
                }
                .environment(org)
            }
        }
        .sheet(isPresented: $showNonAdmit) {
            NonAdmitSheet(orgId: model.orgId, referralId: model.referralId) {
                showNonAdmit = false
            }
        }
        .task { await model.run() }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                if Task.isCancelled { break }
                await model.tick()
            }
        }
        .onDisappear { model.releaseClaim() }
    }

    @ViewBuilder
    private func content(_ referral: Referral) -> some View {
        Section {
            HStack {
                StatusPill(text: referral.referralStatus.label, color: referral.referralStatus.color)
                if referral.source == .phone {
                    StatusPill(text: "Phone", color: .blue)
                }
                Spacer()
                Text(RelativeTime.full(referral.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reviewer = model.otherReviewer, model.isOpen {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(org.name(for: reviewer)) is reviewing this referral", systemImage: "person.fill.checkmark")
                        .foregroundStyle(.orange)
                    Text("Only the reviewer can accept, reject or close it until they finish or their claim expires.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Take over review") {
                        Task { await model.takeOver() }
                    }
                    .disabled(model.isWorking)
                }
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
        }

        switch referral.referralStatus {
        case .uploaded, .extracting:
            if model.isStale {
                Section {
                    Label("Extraction looks stuck (no progress for several minutes).", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Button {
                        Task { await model.retry() }
                    } label: {
                        Label("Retry extraction", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isWorking)
                    Button("Reject referral", role: .destructive) { showReject = true }
                        .disabled(model.isWorking || model.otherReviewer != nil)
                }
            } else {
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
            }

        case .failed:
            if model.draft == nil {
                Section {
                    Label(referral.error?.nilIfBlank ?? "Extraction failed.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    if referral.hasFile {
                        Button {
                            Task { await model.retry() }
                        } label: {
                            Label("Retry extraction", systemImage: "arrow.clockwise")
                        }
                        .disabled(model.isWorking)
                    }
                    Button {
                        model.startManualEntry()
                    } label: {
                        Label("Enter details manually", systemImage: "square.and.pencil")
                    }
                    Button("Non-admit…") { showNonAdmit = true }
                        .disabled(model.isWorking || model.otherReviewer != nil)
                    Button("Reject referral", role: .destructive) { showReject = true }
                        .disabled(model.isWorking || model.otherReviewer != nil)
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
                    Button("Non-admit…") { showNonAdmit = true }
                        .disabled(model.isWorking)
                }
            } footer: {
                Text("The patient was created with status “referral”. Admit to compute hospice deadlines and create the care team channel, or close it as a non-admit.")
            }

        case .rejected:
            Section("Rejected") {
                Text(referral.rejectionReason?.nilIfBlank ?? "No reason recorded.")
                InfoRow(label: "Reviewed by", value: referral.reviewedBy.map { org.name(for: $0) })
            }

        case .nonAdmit:
            Section("Closed as a non-admit") {
                InfoRow(label: "Reason", value: referral.nonAdmit?.reason.label)
                InfoRow(label: "Date of death", value: referral.nonAdmit?.deathDate.map { ISODate.display($0) })
                InfoRow(label: "Note", value: referral.nonAdmit?.note)
                InfoRow(label: "Closed by", value: referral.nonAdmit?.closedBy.map { org.name(for: $0) })
            }
        }
    }

    @ViewBuilder
    private func duplicatesSection(_ referral: Referral) -> some View {
        @Bindable var model = model
        if !referral.duplicates.isEmpty {
            Section {
                ForEach(referral.duplicates, id: \.self) { match in
                    NavigationLink(value: match.isPatient ? Route.patient(match.id) : Route.referral(match.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(match.displayName)
                            Text("\(match.isPatient ? "Patient" : "Referral") · \(match.status.replacingOccurrences(of: "_", with: " ")) · same \(match.reason)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Toggle("Not a duplicate — I checked these records", isOn: $model.confirmNotDuplicate)
            } header: {
                Label("Possible duplicates", systemImage: "person.2.fill")
                    .foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private func reviewSections(_ referral: Referral) -> some View {
        @Bindable var model = model
        let extraction = referral.extracted
        let lowCount = (extraction?.fieldConfidence.values.filter { $0 < AppConfig.lowConfidenceThreshold }.count) ?? 0
        let conf = extraction?.fieldConfidence ?? [:]

        duplicatesSection(referral)

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
            OptionalDateRow(title: "Referral date", date: $model.referralDate, confidence: conf["referralDate"])
            FormTextField(title: "Referral source", text: $model.referralSource, confidence: conf["referralSource"])
            FormTextField(title: "Reason for referral", text: $model.reasonForReferral, confidence: conf["reasonForReferral"], capitalization: .sentences)
            InfoRow(label: "Model", value: referral.model)
        } header: {
            Text("Referral")
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
            .disabled(model.isWorking || !(model.draft?.hasRequiredNames ?? false)
                      || model.otherReviewer != nil || model.needsDuplicateConfirmation)
            Button("Non-admit…") { showNonAdmit = true }
                .disabled(model.isWorking || model.otherReviewer != nil)
            Button("Reject referral", role: .destructive) { showReject = true }
                .disabled(model.isWorking || model.otherReviewer != nil)
        } footer: {
            Text("Accepting creates a patient with status “referral”. You can admit them next.")
        }
    }
}
