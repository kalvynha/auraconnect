import Foundation
import FirebaseFirestore

// MARK: - Value types shared by referrals and patients

struct Address: Codable, Hashable {
    var line1: String?
    var line2: String?
    var city: String?
    var state: String?
    var zip: String?

    init(line1: String? = nil, line2: String? = nil, city: String? = nil, state: String? = nil, zip: String? = nil) {
        self.line1 = line1
        self.line2 = line2
        self.city = city
        self.state = state
        self.zip = zip
    }

    var isEmpty: Bool {
        [line1, line2, city, state, zip].allSatisfy { $0?.nilIfBlank == nil }
    }

    var formatted: String {
        let street = [line1, line2].compactMap { $0?.nilIfBlank }.joined(separator: ", ")
        let cityState = [city?.nilIfBlank, state?.nilIfBlank].compactMap { $0 }.joined(separator: ", ")
        let last = [cityState, zip?.nilIfBlank ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
        return [street, last].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    var dictionary: [String: Any] {
        [
            "line1": blankToNull(line1),
            "line2": blankToNull(line2),
            "city": blankToNull(city),
            "state": blankToNull(state),
            "zip": blankToNull(zip),
        ]
    }
}

struct Diagnosis: Codable, Hashable {
    /// ICD-10-CM code, e.g. `C34.90`.
    var code: String?
    var description: String

    enum CodingKeys: String, CodingKey { case code, description }

    init(code: String? = nil, description: String = "") {
        self.code = code
        self.description = description
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.lenient(.code)
        description = c.lenient(.description) ?? ""
    }

    var isEmpty: Bool { code?.nilIfBlank == nil && description.nilIfBlank == nil }

    var formatted: String {
        if let code = code?.nilIfBlank { return "\(code) — \(description)" }
        return description
    }

    var dictionary: [String: Any] {
        ["code": blankToNull(code), "description": description.trimmed]
    }
}

struct Physician: Codable, Hashable {
    var name: String
    var npi: String?
    var phone: String?
    var fax: String?

    enum CodingKeys: String, CodingKey { case name, npi, phone, fax }

    init(name: String = "", npi: String? = nil, phone: String? = nil, fax: String? = nil) {
        self.name = name
        self.npi = npi
        self.phone = phone
        self.fax = fax
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(.name) ?? ""
        npi = c.lenient(.npi)
        phone = c.lenient(.phone)
        fax = c.lenient(.fax)
    }

    var isEmpty: Bool { name.nilIfBlank == nil && npi?.nilIfBlank == nil && phone?.nilIfBlank == nil && fax?.nilIfBlank == nil }

    var dictionary: [String: Any] {
        ["name": name.trimmed, "npi": blankToNull(npi), "phone": blankToNull(phone), "fax": blankToNull(fax)]
    }
}

struct Medication: Codable, Hashable {
    var name: String
    var dose: String?
    var route: String?
    var frequency: String?

    enum CodingKeys: String, CodingKey { case name, dose, route, frequency }

    init(name: String = "", dose: String? = nil, route: String? = nil, frequency: String? = nil) {
        self.name = name
        self.dose = dose
        self.route = route
        self.frequency = frequency
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(.name) ?? ""
        dose = c.lenient(.dose)
        route = c.lenient(.route)
        frequency = c.lenient(.frequency)
    }

    var detail: String {
        [dose, route, frequency].compactMap { $0?.nilIfBlank }.joined(separator: " · ")
    }

    var dictionary: [String: Any] {
        ["name": name.trimmed, "dose": blankToNull(dose), "route": blankToNull(route), "frequency": blankToNull(frequency)]
    }
}

struct Caregiver: Codable, Hashable {
    var name: String
    var relationship: String?
    var phone: String?

    enum CodingKeys: String, CodingKey { case name, relationship, phone }

    init(name: String = "", relationship: String? = nil, phone: String? = nil) {
        self.name = name
        self.relationship = relationship
        self.phone = phone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(.name) ?? ""
        relationship = c.lenient(.relationship)
        phone = c.lenient(.phone)
    }

    var isEmpty: Bool { name.nilIfBlank == nil && relationship?.nilIfBlank == nil && phone?.nilIfBlank == nil }

    var dictionary: [String: Any] {
        ["name": name.trimmed, "relationship": blankToNull(relationship), "phone": blankToNull(phone)]
    }
}

struct Insurance: Codable, Hashable {
    var payer: String?
    var memberId: String?

    init(payer: String? = nil, memberId: String? = nil) {
        self.payer = payer
        self.memberId = memberId
    }

    var dictionary: [String: Any] {
        ["payer": blankToNull(payer), "memberId": blankToNull(memberId)]
    }
}

// MARK: - PatientInput

/// Clinical/demographic fields shared by referrals and patients (`PatientInput` in types.ts).
/// Non-optional where the contract is non-null so it can be edited directly in forms.
struct PatientInput: Codable, Hashable {
    var firstName: String
    var lastName: String
    /// `YYYY-MM-DD`
    var dob: String?
    var sex: Sex
    var phone: String?
    var address: Address
    var mrn: String?
    var medicareMbi: String?
    var primaryDiagnosis: Diagnosis?
    var secondaryDiagnoses: [Diagnosis]
    var referringPhysician: Physician?
    var attendingPhysician: Physician?
    var codeStatus: CodeStatus
    var allergies: [String]
    var medications: [Medication]
    var caregiver: Caregiver?
    var insurance: Insurance

    enum CodingKeys: String, CodingKey {
        case firstName, lastName, dob, sex, phone, address, mrn, medicareMbi, primaryDiagnosis,
             secondaryDiagnoses, referringPhysician, attendingPhysician, codeStatus, allergies,
             medications, caregiver, insurance
    }

    init() {
        firstName = ""
        lastName = ""
        dob = nil
        sex = .unknown
        phone = nil
        address = Address()
        mrn = nil
        medicareMbi = nil
        primaryDiagnosis = nil
        secondaryDiagnoses = []
        referringPhysician = nil
        attendingPhysician = nil
        codeStatus = .unknown
        allergies = []
        medications = []
        caregiver = nil
        insurance = Insurance()
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        firstName = c.lenient(.firstName) ?? ""
        lastName = c.lenient(.lastName) ?? ""
        dob = c.lenient(.dob)
        sex = c.lenient(.sex) ?? .unknown
        phone = c.lenient(.phone)
        address = c.lenient(.address) ?? Address()
        mrn = c.lenient(.mrn)
        medicareMbi = c.lenient(.medicareMbi)
        primaryDiagnosis = c.lenient(.primaryDiagnosis)
        secondaryDiagnoses = c.lenient(.secondaryDiagnoses) ?? []
        referringPhysician = c.lenient(.referringPhysician)
        attendingPhysician = c.lenient(.attendingPhysician)
        codeStatus = c.lenient(.codeStatus) ?? .unknown
        allergies = c.lenient(.allergies) ?? []
        medications = c.lenient(.medications) ?? []
        caregiver = c.lenient(.caregiver)
        insurance = c.lenient(.insurance) ?? Insurance()
    }

    var fullName: String {
        let name = [firstName.nilIfBlank, lastName.nilIfBlank].compactMap { $0 }.joined(separator: " ")
        return name.isEmpty ? "Unnamed patient" : name
    }

    /// "Last, First"
    var sortName: String {
        switch (lastName.nilIfBlank, firstName.nilIfBlank) {
        case let (last?, first?): return "\(last), \(first)"
        case let (last?, nil): return last
        case let (nil, first?): return first
        case (nil, nil): return "Unnamed patient"
        }
    }

    var hasRequiredNames: Bool { firstName.nilIfBlank != nil && lastName.nilIfBlank != nil }

    /// Payload for callables (`acceptReferral`, `admitPatient`). Empty optional
    /// sub-objects become `null`, blank strings become `null`, list items without a name are dropped.
    var dictionary: [String: Any] {
        [
            "firstName": firstName.trimmed,
            "lastName": lastName.trimmed,
            "dob": blankToNull(dob),
            "sex": sex.rawValue,
            "phone": blankToNull(phone),
            "address": address.dictionary,
            "mrn": blankToNull(mrn),
            "medicareMbi": blankToNull(medicareMbi),
            "primaryDiagnosis": orNull(primaryDiagnosis?.isEmpty == false ? primaryDiagnosis?.dictionary : nil),
            "secondaryDiagnoses": secondaryDiagnoses.filter { !$0.isEmpty }.map { $0.dictionary },
            "referringPhysician": orNull(referringPhysician?.isEmpty == false ? referringPhysician?.dictionary : nil),
            "attendingPhysician": orNull(attendingPhysician?.isEmpty == false ? attendingPhysician?.dictionary : nil),
            "codeStatus": codeStatus.rawValue,
            "allergies": allergies.compactMap { $0.nilIfBlank },
            "medications": medications.filter { $0.name.nilIfBlank != nil }.map { $0.dictionary },
            "caregiver": orNull(caregiver?.isEmpty == false ? caregiver?.dictionary : nil),
            "insurance": insurance.dictionary,
        ]
    }
}

// MARK: - Admission data

struct Consents: Codable, Hashable {
    var electionStatement: Bool
    var hipaaNotice: Bool
    var releaseOfInformation: Bool
    var patientRights: Bool
    /// Present when code status is DNR-type and a POLST/DNR form is on file.
    var polstOnFile: Bool

    enum CodingKeys: String, CodingKey {
        case electionStatement, hipaaNotice, releaseOfInformation, patientRights, polstOnFile
    }

    init(electionStatement: Bool = false, hipaaNotice: Bool = false, releaseOfInformation: Bool = false,
         patientRights: Bool = false, polstOnFile: Bool = false) {
        self.electionStatement = electionStatement
        self.hipaaNotice = hipaaNotice
        self.releaseOfInformation = releaseOfInformation
        self.patientRights = patientRights
        self.polstOnFile = polstOnFile
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        electionStatement = c.lenient(.electionStatement) ?? false
        hipaaNotice = c.lenient(.hipaaNotice) ?? false
        releaseOfInformation = c.lenient(.releaseOfInformation) ?? false
        patientRights = c.lenient(.patientRights) ?? false
        polstOnFile = c.lenient(.polstOnFile) ?? false
    }

    /// Election statement and HIPAA notice are required to admit.
    var requiredComplete: Bool { electionStatement && hipaaNotice }

    var dictionary: [String: Any] {
        [
            "electionStatement": electionStatement,
            "hipaaNotice": hipaaNotice,
            "releaseOfInformation": releaseOfInformation,
            "patientRights": patientRights,
            "polstOnFile": polstOnFile,
        ]
    }
}

struct DateWindow: Codable, Hashable {
    var start: String?
    var end: String?
}

struct BenefitPeriod: Codable, Hashable {
    var number: Int
    var start: String
    var end: String
    var lengthDays: Int
    var f2fRequired: Bool
    var f2fWindowStart: String?
    var f2fDueBy: String?

    enum CodingKeys: String, CodingKey {
        case number, start, end, lengthDays, f2fRequired, f2fWindowStart, f2fDueBy
    }

    init(number: Int, start: String, end: String, lengthDays: Int, f2fRequired: Bool,
         f2fWindowStart: String? = nil, f2fDueBy: String? = nil) {
        self.number = number
        self.start = start
        self.end = end
        self.lengthDays = lengthDays
        self.f2fRequired = f2fRequired
        self.f2fWindowStart = f2fWindowStart
        self.f2fDueBy = f2fDueBy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = c.lenient(.number) ?? 0
        start = c.lenient(.start) ?? ""
        end = c.lenient(.end) ?? ""
        lengthDays = c.lenient(.lengthDays) ?? 0
        f2fRequired = c.lenient(.f2fRequired) ?? false
        f2fWindowStart = c.lenient(.f2fWindowStart)
        f2fDueBy = c.lenient(.f2fDueBy)
    }
}

struct Milestones: Codable, Hashable {
    var noeDueDate: String?
    var benefitPeriods: [BenefitPeriod]
    var hopeAdmissionDue: String?
    var hopeHuv1Window: DateWindow?
    var hopeHuv2Window: DateWindow?
    var computedAt: String?

    enum CodingKeys: String, CodingKey {
        case noeDueDate, benefitPeriods, hopeAdmissionDue, hopeHuv1Window, hopeHuv2Window, computedAt
    }

    init(noeDueDate: String?, benefitPeriods: [BenefitPeriod], hopeAdmissionDue: String?,
         hopeHuv1Window: DateWindow?, hopeHuv2Window: DateWindow?, computedAt: String? = nil) {
        self.noeDueDate = noeDueDate
        self.benefitPeriods = benefitPeriods
        self.hopeAdmissionDue = hopeAdmissionDue
        self.hopeHuv1Window = hopeHuv1Window
        self.hopeHuv2Window = hopeHuv2Window
        self.computedAt = computedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        noeDueDate = c.lenient(.noeDueDate)
        benefitPeriods = c.lenient(.benefitPeriods) ?? []
        hopeAdmissionDue = c.lenient(.hopeAdmissionDue)
        hopeHuv1Window = c.lenient(.hopeHuv1Window)
        hopeHuv2Window = c.lenient(.hopeHuv2Window)
        computedAt = c.lenient(.computedAt)
    }
}

// MARK: - Patient document

/// `orgs/{orgId}/patients/{patientId}` — written by Cloud Functions only.
/// The `PatientInput` fields are flattened into the document; all are optional here
/// so a partially-populated document still decodes. Use `input` for a normalized copy.
struct Patient: Codable, Identifiable {
    @DocumentID var id: String?

    // PatientInput
    var firstName: String?
    var lastName: String?
    var dob: String?
    var sex: Sex?
    var phone: String?
    var address: Address?
    var mrn: String?
    var medicareMbi: String?
    var primaryDiagnosis: Diagnosis?
    var secondaryDiagnoses: [Diagnosis]?
    var referringPhysician: Physician?
    var attendingPhysician: Physician?
    var codeStatus: CodeStatus?
    var allergies: [String]?
    var medications: [Medication]?
    var caregiver: Caregiver?
    var insurance: Insurance?

    // Patient
    var status: PatientStatus?
    var referralId: String?
    var admissionDate: String?
    var startingBenefitPeriod: Int?
    var levelOfCare: LevelOfCare?
    var careTeamUids: [String]?
    var channelId: String?
    var consents: Consents?
    var milestones: Milestones?
    var remindedMilestones: [String]?
    var createdBy: String?
    var createdAt: Date?
    var updatedAt: Date?

    var patientStatus: PatientStatus { status ?? .referral }

    var input: PatientInput {
        var value = PatientInput()
        value.firstName = firstName ?? ""
        value.lastName = lastName ?? ""
        value.dob = dob
        value.sex = sex ?? .unknown
        value.phone = phone
        value.address = address ?? Address()
        value.mrn = mrn
        value.medicareMbi = medicareMbi
        value.primaryDiagnosis = primaryDiagnosis
        value.secondaryDiagnoses = secondaryDiagnoses ?? []
        value.referringPhysician = referringPhysician
        value.attendingPhysician = attendingPhysician
        value.codeStatus = codeStatus ?? .unknown
        value.allergies = allergies ?? []
        value.medications = medications ?? []
        value.caregiver = caregiver
        value.insurance = insurance ?? Insurance()
        return value
    }

    var sortName: String { input.sortName }
}
