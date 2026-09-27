import Foundation
import FirebaseFirestore

/// What the model extracts from a referral document (`ReferralExtraction` in types.ts).
struct ReferralExtraction: Codable, Hashable {
    var patient: PatientInput
    var referralDate: String?
    var referralSource: String?
    var reasonForReferral: String?
    /// Per-field confidence 0–1, keyed by dotted path (e.g. `patient.dob`).
    var fieldConfidence: [String: Double]
    /// Free-text notes the model flagged (illegible sections, conflicts).
    var warnings: [String]

    enum CodingKeys: String, CodingKey {
        case patient, referralDate, referralSource, reasonForReferral, fieldConfidence, warnings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        patient = c.lenient(.patient) ?? PatientInput()
        referralDate = c.lenient(.referralDate)
        referralSource = c.lenient(.referralSource)
        reasonForReferral = c.lenient(.reasonForReferral)
        fieldConfidence = c.lenient(.fieldConfidence) ?? [:]
        warnings = c.lenient(.warnings) ?? []
    }

    /// Lowest confidence recorded for `path` or any nested key under it
    /// (so `patient.address` also covers `patient.address.city`).
    func confidence(for path: String) -> Double? {
        ConfidenceLookup.confidence(for: path, in: fieldConfidence)
    }
}

enum ConfidenceLookup {
    static func confidence(for path: String, in map: [String: Double]) -> Double? {
        let prefix = path + "."
        let values = map.compactMap { key, value -> Double? in
            (key == path || key.hasPrefix(prefix)) ? value : nil
        }
        return values.min()
    }

    static func isLow(_ confidence: Double?, threshold: Double = AppConfig.lowConfidenceThreshold) -> Bool {
        guard let confidence else { return false }
        return confidence < threshold
    }
}

/// `orgs/{orgId}/referrals/{referralId}`.
struct Referral: Codable, Identifiable {
    @DocumentID var id: String?
    var fileName: String?
    var contentType: String?
    var storagePath: String?
    var source: ReferralSource?
    var status: ReferralStatus?
    var extracted: ReferralExtraction?
    var error: String?
    var model: String?
    var patientId: String?
    var uploadedBy: String?
    var reviewedBy: String?
    var rejectionReason: String?
    var createdAt: Date?
    var updatedAt: Date?
    // v3 intake (optional on read; written only by functions)
    /// When the current extraction attempt started.
    var extractionStartedAt: Date?
    var retryRequestedAt: Date?
    /// I2: who is reviewing; a claim expires after `ReferralRules.claimMinutes` (see `activeClaimant`).
    var claimedBy: String?
    var claimedAt: Date?
    /// I4: possible duplicates found after extraction.
    var possibleDuplicates: [DuplicateMatch]?
    /// I5: set by `closeReferralNonAdmit`.
    var nonAdmit: NonAdmitRecord?

    var referralStatus: ReferralStatus { status ?? .uploaded }
    var duplicates: [DuplicateMatch] { possibleDuplicates ?? [] }
    /// Phone referrals (and any referral without a file) have nothing to view or re-extract.
    var hasFile: Bool { storagePath?.nilIfBlank != nil }

    /// Mirrors the server: `uploaded`/`extracting` for more than `ReferralRules.staleMinutes`.
    func isStale(now: Date = Date()) -> Bool {
        let since: Date?
        switch referralStatus {
        case .extracting: since = extractionStartedAt ?? updatedAt ?? createdAt
        case .uploaded: since = updatedAt ?? createdAt
        default: since = nil
        }
        guard let since else { return false }
        return now.timeIntervalSince(since) > ReferralRules.staleMinutes * 60
    }

    /// The uid holding a live review claim, or nil when unclaimed or expired.
    func activeClaimant(now: Date = Date()) -> String? {
        guard let claimedBy = claimedBy?.nilIfBlank else { return nil }
        if let claimedAt, now.timeIntervalSince(claimedAt) > ReferralRules.claimMinutes * 60 { return nil }
        return claimedBy
    }

    var displayTitle: String {
        if let patient = extracted?.patient, patient.hasRequiredNames || patient.lastName.nilIfBlank != nil {
            return patient.sortName
        }
        return "Referral"
    }
}

// MARK: - v3 intake

/// Mirrors the intake constants in `functions/src/shared/types.ts`.
enum ReferralRules {
    static let staleMinutes: Double = 6
    static let claimMinutes: Double = 30
    /// `REFERRAL_MIME_TYPES`: what the extractor (and the rules) accept.
    static let mimeTypes: [String] = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]
}

/// I4: a patient or recent referral that may be the same person.
struct DuplicateMatch: Codable, Hashable {
    var kind: String
    var id: String
    /// `mbi` and/or `name_dob`.
    var matchedOn: [String]
    var displayName: String
    var status: String

    enum CodingKeys: String, CodingKey { case kind, id, matchedOn, displayName, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(.kind) ?? "patient"
        id = c.lenient(.id) ?? ""
        matchedOn = c.lenient(.matchedOn) ?? []
        displayName = c.lenient(.displayName) ?? "Unnamed"
        status = c.lenient(.status) ?? ""
    }

    var isPatient: Bool { kind == "patient" }

    var reason: String {
        matchedOn.map { $0 == "mbi" ? "Medicare MBI" : "last name and DOB" }.joined(separator: " and ")
    }
}

enum NonAdmitReason: String, Codable, CaseIterable, Identifiable, Hashable {
    case diedBeforeAdmission = "died_before_admission"
    case notEligible = "not_eligible"
    case declinedHospice = "declined_hospice"
    case choseOtherProvider = "chose_other_provider"
    case unableToContact = "unable_to_contact"
    case movedOutOfArea = "moved_out_of_area"
    case noPayer = "no_payer"
    case other

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .diedBeforeAdmission: return "Died before admission"
        case .notEligible: return "Not eligible"
        case .declinedHospice: return "Declined hospice"
        case .choseOtherProvider: return "Chose another provider"
        case .unableToContact: return "Unable to contact"
        case .movedOutOfArea: return "Moved out of area"
        case .noPayer: return "No payer / insurance"
        case .other: return "Other"
        }
    }
}

struct NonAdmitRecord: Codable, Hashable {
    var reason: NonAdmitReason
    var note: String?
    var deathDate: String?
    var closedBy: String?
    var closedAt: Date?

    enum CodingKeys: String, CodingKey { case reason, note, deathDate, closedBy, closedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reason = c.lenient(.reason) ?? .other
        note = c.lenient(.note)
        deathDate = c.lenient(.deathDate)
        closedBy = c.lenient(.closedBy)
        closedAt = c.lenient(.closedAt)
    }
}
