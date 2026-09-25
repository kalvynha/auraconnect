import Foundation

// String-backed enums mirroring `functions/src/shared/types.ts`.
// Every enum decodes tolerantly: an unknown or missing raw value falls back to a
// safe default instead of failing the whole document (and therefore the list).

/// Decodes a `String`-backed enum, returning `fallback` for unknown values.
func decodeTolerantEnum<T: RawRepresentable>(_ decoder: Decoder, fallback: T) -> T where T.RawValue == String {
    guard let container = try? decoder.singleValueContainer(),
          let raw = try? container.decode(String.self) else {
        return fallback
    }
    return T(rawValue: raw) ?? fallback
}

enum Role: String, Codable, CaseIterable, Identifiable, Hashable {
    case admin, clinician, intake, viewer

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .viewer)
    }

    var label: String {
        switch self {
        case .admin: return "Admin"
        case .clinician: return "Clinician"
        case .intake: return "Intake"
        case .viewer: return "Viewer"
        }
    }

    /// Viewers are read-only; everyone else can message and raise alerts.
    var canSendMessages: Bool { self != .viewer }

    /// Referral queue and admissions: admin, clinician, intake.
    var canManageReferrals: Bool { self == .admin || self == .clinician || self == .intake }
}

enum Discipline: String, Codable, CaseIterable, Identifiable, Hashable {
    case rn = "RN"
    case lpn = "LPN"
    case md = "MD"
    case np = "NP"
    case sw = "SW"
    case chaplain = "Chaplain"
    case aide = "Aide"
    case volunteer = "Volunteer"
    case admin = "Admin"
    case other = "Other"

    var id: String { rawValue }
    var label: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }
}

enum Priority: String, Codable, CaseIterable, Identifiable, Hashable {
    case normal, urgent, critical

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .normal)
    }

    var label: String {
        switch self {
        case .normal: return "Normal"
        case .urgent: return "Urgent"
        case .critical: return "Critical"
        }
    }

    /// Sort weight, higher is more severe.
    var severity: Int {
        switch self {
        case .normal: return 0
        case .urgent: return 1
        case .critical: return 2
        }
    }
}

enum ChannelType: String, Codable, CaseIterable, Hashable {
    case direct, group, patient, team

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .group)
    }
}

enum PatientStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case referral, admitted, discharged, deceased

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .referral)
    }

    var label: String {
        switch self {
        case .referral: return "Referral"
        case .admitted: return "Admitted"
        case .discharged: return "Discharged"
        case .deceased: return "Deceased"
        }
    }
}

enum LevelOfCare: String, Codable, CaseIterable, Identifiable, Hashable {
    case routine, continuous, respite, gip

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .routine)
    }

    var label: String {
        switch self {
        case .routine: return "Routine Home Care"
        case .continuous: return "Continuous Home Care"
        case .respite: return "Inpatient Respite"
        case .gip: return "General Inpatient (GIP)"
        }
    }
}

enum CodeStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case fullCode = "Full Code"
    case dnr = "DNR"
    case dnrDni = "DNR/DNI"
    case comfortCareOnly = "Comfort Care Only"
    case unknown = "Unknown"

    var id: String { rawValue }
    var label: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .unknown)
    }
}

enum Sex: String, Codable, CaseIterable, Identifiable, Hashable {
    case female, male, other, unknown

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .unknown)
    }
}

enum ReferralStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case uploaded
    case extracting
    case needsReview = "needs_review"
    case accepted
    case rejected
    case failed

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .uploaded)
    }

    var label: String {
        switch self {
        case .uploaded: return "Uploaded"
        case .extracting: return "Extracting"
        case .needsReview: return "Needs review"
        case .accepted: return "Accepted"
        case .rejected: return "Rejected"
        case .failed: return "Failed"
        }
    }

    var isProcessing: Bool { self == .uploaded || self == .extracting }
}

enum ReferralSource: String, Codable, CaseIterable, Hashable {
    case scan, upload, fax

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .upload)
    }
}

enum AlertStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case open, acked, resolved

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .open)
    }

    var label: String {
        switch self {
        case .open: return "Open"
        case .acked: return "Acknowledged"
        case .resolved: return "Resolved"
        }
    }
}

enum MilestoneKind: String, Codable, CaseIterable, Hashable {
    case noe
    case recert
    case f2f
    case hopeAdmission = "hope_admission"
    case hopeHuv1 = "hope_huv1"
    case hopeHuv2 = "hope_huv2"

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .noe)
    }

    var label: String {
        switch self {
        case .noe: return "Notice of Election"
        case .recert: return "Recertification"
        case .f2f: return "Face-to-Face"
        case .hopeAdmission: return "HOPE Admission"
        case .hopeHuv1: return "HOPE Update Visit 1"
        case .hopeHuv2: return "HOPE Update Visit 2"
        }
    }
}
