import Foundation

/// v3 intake callables (docs/DATA_MODEL.md "v3 — intake"): referral claims, phone referrals,
/// non-admits, invite revocation, and the extended `acceptReferral` / `admitPatient` payloads.
/// Optional fields typed `field?: T` are omitted when nil; `T | null` fields send `NSNull()`.
extension FunctionsClient {
    private func intakeString(_ key: String, in response: [String: Any], from name: String) throws -> String {
        guard let value = response[key] as? String, !value.isEmpty else {
            throw FunctionsClientError.badResponse(name)
        }
        return value
    }

    // MARK: Referrals

    /// Claims the review (or takes it over with `force`). Returns the claimant uid.
    @discardableResult
    func claimReferral(orgId: String, referralId: String, force: Bool) async throws -> String? {
        let response = try await call("claimReferral", ["orgId": orgId, "referralId": referralId, "force": force])
        return response["claimedBy"] as? String
    }

    func releaseReferralClaim(orgId: String, referralId: String) async throws {
        _ = try await call("claimReferral", ["orgId": orgId, "referralId": referralId, "release": true])
    }

    /// Accept with edited referral metadata (I3) and duplicate confirmation (I4).
    func acceptReferral(orgId: String, referralId: String, patient: PatientInput,
                        referralDate: String?, referralSource: String?, reasonForReferral: String?,
                        confirmNotDuplicate: Bool) async throws -> String {
        let response = try await call("acceptReferral", [
            "orgId": orgId,
            "referralId": referralId,
            "patient": patient.dictionary,
            "referralDate": blankToNull(referralDate),
            "referralSource": blankToNull(referralSource),
            "reasonForReferral": blankToNull(reasonForReferral),
            "confirmNotDuplicate": confirmNotDuplicate,
        ])
        return try intakeString("patientId", in: response, from: "acceptReferral")
    }

    /// Phone referral with no file; goes straight to `needs_review`. Returns the referral id.
    func createManualReferral(orgId: String, patient: PatientInput, referralDate: String?,
                              referralSource: String?, reasonForReferral: String?) async throws -> String {
        let response = try await call("createManualReferral", [
            "orgId": orgId,
            "patient": patient.dictionary,
            "referralDate": blankToNull(referralDate),
            "referralSource": blankToNull(referralSource),
            "reasonForReferral": blankToNull(reasonForReferral),
        ])
        return try intakeString("id", in: response, from: "createManualReferral")
    }

    /// `deathDate` is used only for `died_before_admission`.
    func closeReferralNonAdmit(orgId: String, referralId: String, reason: NonAdmitReason,
                               note: String?, deathDate: String?) async throws {
        var payload: [String: Any] = [
            "orgId": orgId,
            "referralId": referralId,
            "reason": reason.rawValue,
            "note": blankToNull(note),
        ]
        if reason == .diedBeforeAdmission, let deathDate = deathDate?.nilIfBlank { payload["deathDate"] = deathDate }
        _ = try await call("closeReferralNonAdmit", payload)
    }

    // MARK: Admission

    /// v3 admission (H2, I6). `update` changes an admitted patient; `readmission` re-admits
    /// a discharged one; `benefitPeriodStart` is set for transfers.
    func admitPatient(orgId: String, patientId: String?, patient: PatientInput, admissionDate: String,
                      startingBenefitPeriod: Int, benefitPeriodStart: String?, levelOfCare: LevelOfCare,
                      careTeamUids: [String], consents: Consents, joinChannel: Bool,
                      visitFrequencies: [VisitFrequency], update: Bool, readmission: Bool) async throws -> AdmitResult {
        var payload: [String: Any] = [
            "orgId": orgId,
            "patient": patient.dictionary,
            "admissionDate": admissionDate,
            "startingBenefitPeriod": startingBenefitPeriod,
            "levelOfCare": levelOfCare.rawValue,
            "careTeamUids": careTeamUids,
            "consents": consents.dictionary,
            "joinChannel": joinChannel,
            "visitFrequencies": visitFrequencies.map { $0.dictionary },
            "update": update,
            "readmission": readmission,
        ]
        if let patientId { payload["patientId"] = patientId }
        if let benefitPeriodStart = benefitPeriodStart?.nilIfBlank { payload["benefitPeriodStart"] = benefitPeriodStart }
        let response = try await call("admitPatient", payload)
        return AdmitResult(
            patientId: try intakeString("patientId", in: response, from: "admitPatient"),
            channelId: response["channelId"] as? String ?? ""
        )
    }

    // MARK: Invites

    /// Admin only.
    func revokeInvite(orgId: String, inviteId: String) async throws {
        _ = try await call("revokeInvite", ["orgId": orgId, "inviteId": inviteId])
    }

    /// `listMyInvites` including whether the server withheld invites for an unverified email (L2).
    func listMyInvitesChecked() async throws -> (invites: [InviteSummary], verificationRequired: Bool) {
        let response = try await call("listMyInvites", [:])
        let raw = response["invites"] as? [[String: Any]] ?? []
        let invites = raw.compactMap { item -> InviteSummary? in
            guard let orgId = item["orgId"] as? String, let inviteId = item["inviteId"] as? String else { return nil }
            let role = (item["role"] as? String).flatMap { Role(rawValue: $0) } ?? .viewer
            return InviteSummary(orgId: orgId, inviteId: inviteId, orgName: item["orgName"] as? String ?? "Organization", role: role)
        }
        return (invites, response["verificationRequired"] as? Bool ?? false)
    }
}
