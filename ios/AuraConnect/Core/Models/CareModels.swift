import Foundation
import FirebaseFirestore

// v2 care-workflow types mirroring `functions/src/shared/types.ts` ("v2 — Tier 1/2/4").
// Every field is optional or defaulted on read so older / partial documents still decode.

extension Role {
    /// "Clinical" roles in docs/DATA_MODEL.md (admin, clinician, intake): lifecycle, visit
    /// and document mutations.
    var canManageCare: Bool { self == .admin || self == .clinician || self == .intake }
}

// MARK: - Enums

enum DischargeReason: String, Codable, CaseIterable, Identifiable, Hashable {
    case revocation
    case transfer
    case noLongerTerminallyIll = "no_longer_terminally_ill"
    case movedOutOfArea = "moved_out_of_area"
    case forCause = "for_cause"
    case other

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .revocation: return "Revocation"
        case .transfer: return "Transfer to another hospice"
        case .noLongerTerminallyIll: return "No longer terminally ill"
        case .movedOutOfArea: return "Moved out of service area"
        case .forCause: return "For cause"
        case .other: return "Other"
        }
    }
}

enum PatientEventType: String, Codable, CaseIterable, Hashable {
    case admission
    case levelOfCareChange = "level_of_care_change"
    case recertification
    case discharge
    case death
    /// Not in the contract: fallback for event types added later.
    case other

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .admission: return "Admission"
        case .levelOfCareChange: return "Level of care change"
        case .recertification: return "Recertification"
        case .discharge: return "Discharge"
        case .death: return "Death"
        case .other: return "Event"
        }
    }
}

enum VisitStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case scheduled, completed, missed, cancelled

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .scheduled)
    }

    var label: String {
        switch self {
        case .scheduled: return "Scheduled"
        case .completed: return "Completed"
        case .missed: return "Missed"
        case .cancelled: return "Cancelled"
        }
    }
}

enum TaskStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case open, done, cancelled

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .open)
    }

    var label: String {
        switch self {
        case .open: return "Open"
        case .done: return "Done"
        case .cancelled: return "Cancelled"
        }
    }
}

enum TaskTemplateEvent: String, Codable, CaseIterable, Identifiable, Hashable {
    case admission, recertification, discharge, death

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .admission)
    }

    var label: String {
        switch self {
        case .admission: return "Admission"
        case .recertification: return "Recertification"
        case .discharge: return "Discharge"
        case .death: return "Death"
        }
    }
}

enum BereavementContactType: String, Codable, CaseIterable, Identifiable, Hashable {
    case call, letter, visit, mailing, assessment

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .call)
    }

    var label: String {
        switch self {
        case .call: return "Call"
        case .letter: return "Letter"
        case .visit: return "Visit"
        case .mailing: return "Mailing"
        case .assessment: return "Risk reassessment"
        }
    }
}

enum BereavementContactStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case pending, done, skipped

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .pending)
    }

    var label: String {
        switch self {
        case .pending: return "Pending"
        case .done: return "Done"
        case .skipped: return "Skipped"
        }
    }
}

enum BereavementRisk: String, Codable, CaseIterable, Identifiable, Hashable {
    case low, moderate, high

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .low)
    }

    var label: String {
        switch self {
        case .low: return "Low risk"
        case .moderate: return "Moderate risk"
        case .high: return "High risk"
        }
    }
}

enum BereavementPlanStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case active, closed

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .active)
    }

    var label: String {
        switch self {
        case .active: return "Active"
        case .closed: return "Closed"
        }
    }
}

enum DocumentCategory: String, Codable, CaseIterable, Identifiable, Hashable {
    case consent
    case polst
    case order
    case referral
    case planOfCare = "plan_of_care"
    case other

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .consent: return "Consent"
        case .polst: return "POLST / DNR"
        case .order: return "Order"
        case .referral: return "Referral"
        case .planOfCare: return "Plan of care"
        case .other: return "Other"
        }
    }
}

enum VolunteerActivity: String, Codable, CaseIterable, Identifiable, Hashable {
    case companionship, respite, vigil, errands, bereavement, admin, other

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .other)
    }

    var label: String {
        switch self {
        case .companionship: return "Companionship"
        case .respite: return "Respite"
        case .vigil: return "Vigil"
        case .errands: return "Errands"
        case .bereavement: return "Bereavement"
        case .admin: return "Administrative"
        case .other: return "Other"
        }
    }
}

enum VolunteerAssignmentStatus: String, Codable, CaseIterable, Identifiable, Hashable {
    case active, ended

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        self = decodeTolerantEnum(decoder, fallback: .active)
    }
}

// MARK: - Value types embedded in patient documents

/// `patient.milestoneCompletions[key]`, keyed by `{kind}:{dueDate}`.
struct MilestoneCompletion: Codable, Hashable {
    var completedAt: Date?
    var completedBy: String?
    var note: String?
    /// v3 (S5): the actual filing date `YYYY-MM-DD`; on time is judged from it.
    var effectiveDate: String?

    enum CodingKeys: String, CodingKey { case completedAt, completedBy, note, effectiveDate }

    init(completedAt: Date? = nil, completedBy: String? = nil, note: String? = nil, effectiveDate: String? = nil) {
        self.completedAt = completedAt
        self.completedBy = completedBy
        self.note = note
        self.effectiveDate = effectiveDate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        completedAt = c.lenient(.completedAt)
        completedBy = c.lenient(.completedBy)
        note = c.lenient(.note)
        effectiveDate = c.lenient(.effectiveDate)
    }
}

/// v3 (S5): a completion that was reopened (`patient.milestoneHistory`, oldest first).
struct MilestoneHistoryEntry: Codable, Hashable {
    var key: String?
    var completedAt: Date?
    var completedBy: String?
    var note: String?
    var effectiveDate: String?
    var reopenedAt: Date?
    var reopenedBy: String?
    var reopenReason: String?

    enum CodingKeys: String, CodingKey {
        case key, completedAt, completedBy, note, effectiveDate, reopenedAt, reopenedBy, reopenReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(.key)
        completedAt = c.lenient(.completedAt)
        completedBy = c.lenient(.completedBy)
        note = c.lenient(.note)
        effectiveDate = c.lenient(.effectiveDate)
        reopenedAt = c.lenient(.reopenedAt)
        reopenedBy = c.lenient(.reopenedBy)
        reopenReason = c.lenient(.reopenReason)
    }

    /// The milestone kind parsed from `key` (`{kind}:{dueDate}`).
    var kind: MilestoneKind? {
        guard let raw = key?.split(separator: ":").first else { return nil }
        return MilestoneKind(rawValue: String(raw))
    }

    var dueDate: String? {
        guard let key, let idx = key.firstIndex(of: ":") else { return nil }
        return String(key[key.index(after: idx)...])
    }
}

/// `patient.death` (set by `recordDeath`).
struct DeathRecord: Codable, Hashable {
    /// `YYYY-MM-DD`
    var date: String?
    /// Local time `HH:mm` in the org time zone.
    var time: String?
    var pronouncedBy: String?
    var location: String?
    var notes: String?

    enum CodingKeys: String, CodingKey { case date, time, pronouncedBy, location, notes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = c.lenient(.date)
        time = c.lenient(.time)
        pronouncedBy = c.lenient(.pronouncedBy)
        location = c.lenient(.location)
        notes = c.lenient(.notes)
    }
}

/// Planned visit frequency per discipline (`patient.visitFrequencies`).
struct VisitFrequency: Codable, Hashable {
    var discipline: Discipline
    /// Planned visits per week (may be fractional, e.g. 0.5 = every other week).
    var perWeek: Double
    var notes: String?
    // v3 (V2) planning hints, preserved when frequencies are re-saved.
    /// Days of the week, 0 = Sunday … 6 = Saturday.
    var preferredDays: [Int]?
    /// Org-local `HH:mm`.
    var preferredStart: String?
    var durationMinutes: Int?
    var assignedUid: String?

    enum CodingKeys: String, CodingKey { case discipline, perWeek, notes, preferredDays, preferredStart, durationMinutes, assignedUid }

    init(discipline: Discipline = .rn, perWeek: Double = 1, notes: String? = nil) {
        self.discipline = discipline
        self.perWeek = perWeek
        self.notes = notes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        discipline = c.lenient(.discipline) ?? .other
        perWeek = c.lenient(.perWeek) ?? 0
        notes = c.lenient(.notes)
        preferredDays = c.lenient(.preferredDays)
        preferredStart = c.lenient(.preferredStart)
        durationMinutes = c.lenient(.durationMinutes)
        assignedUid = c.lenient(.assignedUid)
    }

    /// "2×/week", "every other week", …
    var summary: String {
        if perWeek == 0.5 { return "Every other week" }
        let formatted = perWeek.formatted(.number.precision(.fractionLength(0...2)))
        return "\(formatted)×/week"
    }

    /// Callable payload (`notes` is `null` when blank).
    var dictionary: [String: Any] {
        var d: [String: Any] = ["discipline": discipline.rawValue, "perWeek": perWeek, "notes": blankToNull(notes)]
        if let preferredDays { d["preferredDays"] = preferredDays }
        if let preferredStart { d["preferredStart"] = preferredStart }
        if let durationMinutes { d["durationMinutes"] = durationMinutes }
        if let assignedUid { d["assignedUid"] = assignedUid }
        return d
    }
}

// MARK: - Timeline

/// `orgs/{orgId}/patients/{patientId}/events/{eventId}` — written only by functions.
struct PatientEvent: Codable, Identifiable {
    @DocumentID var id: String?
    var type: PatientEventType?
    /// Effective date `YYYY-MM-DD`.
    var date: String?
    var recordedBy: String?
    var createdAt: Date?
    /// Human-readable one-liner, e.g. "Level of care: routine → GIP".
    var summary: String?

    var eventType: PatientEventType { type ?? .other }
    var displaySummary: String { summary?.nilIfBlank ?? eventType.label }
}

// MARK: - Visits

/// `orgs/{orgId}/visits/{visitId}` — written only by functions.
struct Visit: Codable, Identifiable {
    @DocumentID var id: String?
    var patientId: String?
    /// Denormalized "Last, First".
    var patientName: String?
    var discipline: Discipline?
    var assignedUid: String?
    var scheduledStart: Date?
    var scheduledEnd: Date?
    var status: VisitStatus?
    var note: String?
    var completedAt: Date?
    var completedBy: String?
    var cancelledReason: String?
    var createdBy: String?
    var createdAt: Date?
    var updatedAt: Date?
    /// v3 (V4): `routine` (default) | `admission` | `evaluation` | `prn` | `aide_supervision`.
    var type: String?

    var visitStatus: VisitStatus { status ?? .scheduled }
    var displayPatientName: String { patientName?.nilIfBlank ?? "Patient" }

    /// "Sep 26, 2:00 PM – 3:00 PM"
    var timeRange: String {
        guard let start = scheduledStart else { return "—" }
        let startText = start.formatted(date: .abbreviated, time: .shortened)
        guard let end = scheduledEnd else { return startText }
        let sameDay = Calendar.current.isDate(start, inSameDayAs: end)
        let endText = sameDay
            ? end.formatted(date: .omitted, time: .shortened)
            : end.formatted(date: .abbreviated, time: .shortened)
        return "\(startText) – \(endText)"
    }
}

// MARK: - Tasks

/// Flattened `TaskSource` union: `{type:'manual'} | {type:'template', event} | {type:'idg', meetingId} | {type:'triage', callId}`.
struct TaskSource: Codable, Hashable {
    var type: String?
    var event: TaskTemplateEvent?
    var meetingId: String?
    var callId: String?

    var label: String? {
        switch type ?? "" {
        case "template": return event.map { "\($0.label) checklist" } ?? "Checklist"
        case "idg": return "IDG action item"
        case "triage": return "Triage follow-up"
        default: return nil
        }
    }
}

/// `orgs/{orgId}/tasks/{taskId}` — written only by functions. Named `CareTask` to avoid
/// clashing with Swift concurrency's `Task`.
struct CareTask: Codable, Identifiable {
    @DocumentID var id: String?
    var title: String?
    var description: String?
    var patientId: String?
    var patientName: String?
    var assigneeUid: String?
    /// Used when unassigned: anyone on the care team with this discipline may pick it up.
    var discipline: Discipline?
    /// `YYYY-MM-DD`
    var dueDate: String?
    var priority: Priority?
    var status: TaskStatus?
    var source: TaskSource?
    var createdBy: String?
    var createdAt: Date?
    var completedAt: Date?
    var completedBy: String?
    var updatedAt: Date?

    var taskStatus: TaskStatus { status ?? .open }
    var taskPriority: Priority { priority ?? .normal }
    var displayTitle: String { title?.nilIfBlank ?? "Untitled task" }
}

struct TaskTemplateItem: Codable, Hashable {
    var title: String
    var description: String?
    var discipline: Discipline?
    /// Due date = event date + offsetDays.
    var offsetDays: Int
    var priority: Priority

    enum CodingKeys: String, CodingKey { case title, description, discipline, offsetDays, priority }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.lenient(.title) ?? ""
        description = c.lenient(.description)
        discipline = c.lenient(.discipline)
        offsetDays = c.lenient(.offsetDays) ?? 0
        priority = c.lenient(.priority) ?? .normal
    }
}

/// `orgs/{orgId}/taskTemplates/{event}`.
struct TaskTemplate: Codable, Identifiable {
    @DocumentID var id: String?
    var event: TaskTemplateEvent?
    var items: [TaskTemplateItem]?
}

// MARK: - Bereavement

struct BereavementContact: Codable, Hashable, Identifiable {
    var id: String
    var type: BereavementContactType
    var label: String
    /// `YYYY-MM-DD`
    var dueDate: String
    var status: BereavementContactStatus
    var completedAt: Date?
    var completedBy: String?
    var note: String?

    enum CodingKeys: String, CodingKey {
        case id, type, label, dueDate, status, completedAt, completedBy, note
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id) ?? UUID().uuidString
        type = c.lenient(.type) ?? .call
        label = c.lenient(.label) ?? "Contact"
        dueDate = c.lenient(.dueDate) ?? ""
        status = c.lenient(.status) ?? .pending
        completedAt = c.lenient(.completedAt)
        completedBy = c.lenient(.completedBy)
        note = c.lenient(.note)
    }
}

/// `orgs/{orgId}/bereavementPlans/{planId}` — created by `recordDeath`; 13-month follow-up.
struct BereavementPlan: Codable, Identifiable {
    @DocumentID var id: String?
    var patientId: String?
    var patientName: String?
    var deathDate: String?
    var primaryContact: Caregiver?
    var riskLevel: BereavementRisk?
    var assignedUid: String?
    var contacts: [BereavementContact]?
    var status: BereavementPlanStatus?
    /// deathDate + 13 months.
    var closesOn: String?
    var createdAt: Date?
    var updatedAt: Date?
    /// v3 (C1): family members followed by the plan (see Features/Bereavement/BereavementSurvivors.swift).
    var survivors: [BereavementSurvivor]?
    /// v3 (C1): past `closesOn` with contacts still pending.
    var needsReview: Bool?

    var planStatus: BereavementPlanStatus { status ?? .active }
    var risk: BereavementRisk { riskLevel ?? .low }
    var displayPatientName: String { patientName?.nilIfBlank ?? "Patient" }

    /// Contacts sorted by due date.
    var sortedContacts: [BereavementContact] {
        (contacts ?? []).sorted { $0.dueDate < $1.dueDate }
    }

    /// Pending contacts due on or before `today + withinDays`.
    func dueContacts(today: Date, withinDays: Int) -> [BereavementContact] {
        sortedContacts.filter { contact in
            guard contact.status == .pending,
                  let days = ISODate.daysFrom(today, to: contact.dueDate) else { return false }
            return days <= withinDays
        }
    }
}

// MARK: - Documents

/// `orgs/{orgId}/patients/{patientId}/documents/{documentId}`. Created by clinical clients,
/// then uploaded to `storagePath`.
struct PatientDocument: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String?
    var category: DocumentCategory?
    var fileName: String?
    var storagePath: String?
    var contentType: String?
    var size: Int?
    var uploadedBy: String?
    var createdAt: Date?

    var documentCategory: DocumentCategory { category ?? .other }
    var displayName: String { name?.nilIfBlank ?? fileName?.nilIfBlank ?? "Document" }
    var mimeType: String { contentType?.nilIfBlank ?? "application/octet-stream" }
    var isImage: Bool { mimeType.hasPrefix("image/") }
    var isPDF: Bool { mimeType == "application/pdf" }
}

// MARK: - Volunteers

/// `orgs/{orgId}/volunteerAssignments/{id}` — admin-managed.
struct VolunteerAssignment: Codable, Identifiable {
    @DocumentID var id: String?
    var volunteerUid: String?
    var patientId: String?
    var patientName: String?
    var activity: VolunteerActivity?
    var status: VolunteerAssignmentStatus?
    var startDate: String?
    var endDate: String?
    var notes: String?
    var createdBy: String?
    var createdAt: Date?

    var assignmentStatus: VolunteerAssignmentStatus { status ?? .active }
    var displayPatientName: String { patientName?.nilIfBlank ?? "Patient" }
}

/// `orgs/{orgId}/volunteerLogs/{id}` — a volunteer logs their own time.
struct VolunteerLog: Codable, Identifiable {
    @DocumentID var id: String?
    var volunteerUid: String?
    var patientId: String?
    /// `YYYY-MM-DD`
    var date: String?
    var minutes: Int?
    var activity: VolunteerActivity?
    var note: String?
    var createdAt: Date?
}

// MARK: - Milestone keys

extension MilestoneItem {
    /// Server milestone key `{kind}:{dueDate}` (recert uses the period end, F2F its due-by
    /// date), as used by `milestoneCompletions`, `completeMilestone` and `reopenMilestone`.
    var completionKey: String { "\(kind.rawValue):\(dueDate)" }
}

enum MilestoneCompletionLogic {
    /// "On time" means the filing date (`effectiveDate`, S5) is on or before the due date. Older
    /// completions without it use the completion's calendar day in the org time zone.
    static func isOnTime(_ completion: MilestoneCompletion, dueDate: String, timeZoneId: String?) -> Bool {
        if let effective = completion.effectiveDate?.nilIfBlank { return effective <= dueDate }
        guard let completedAt = completion.completedAt else { return true }
        var calendar = Calendar(identifier: .gregorian)
        if let id = timeZoneId?.nilIfBlank, let zone = TimeZone(identifier: id) {
            calendar.timeZone = zone
        }
        return ISODate.string(from: completedAt, calendar: calendar) <= dueDate
    }
}

// MARK: - Due-date grouping (tasks, bereavement contacts)

enum DueBucket: Int, CaseIterable, Identifiable, Hashable {
    case overdue, today, tomorrow, thisWeek, later, noDate

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .overdue: return "Overdue"
        case .today: return "Today"
        case .tomorrow: return "Tomorrow"
        case .thisWeek: return "Next 7 days"
        case .later: return "Later"
        case .noDate: return "No due date"
        }
    }

    static func bucket(for dueDate: String?, today: Date, calendar: Calendar = .current) -> DueBucket {
        guard let dueDate, let days = ISODate.daysFrom(today, to: dueDate, calendar: calendar) else { return .noDate }
        if days < 0 { return .overdue }
        if days == 0 { return .today }
        if days == 1 { return .tomorrow }
        if days <= 7 { return .thisWeek }
        return .later
    }
}

/// Items grouped under one due-date bucket (for sectioned lists).
struct DueGroup<Item>: Identifiable {
    let bucket: DueBucket
    let items: [Item]
    var id: DueBucket { bucket }
}

/// Formats an instant for callables that take ISO 8601 instants (`scheduleVisit`, `updateVisit`).
enum ISOInstant {
    static func string(from date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
