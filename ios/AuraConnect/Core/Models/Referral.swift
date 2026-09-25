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

    var referralStatus: ReferralStatus { status ?? .uploaded }

    var displayTitle: String {
        if let patient = extracted?.patient, patient.hasRequiredNames || patient.lastName.nilIfBlank != nil {
            return patient.sortName
        }
        return "Referral"
    }
}
