import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/volunteerAssignments` (admin-managed) and `orgs/{orgId}/volunteerLogs`
/// (each volunteer creates their own; readable by admins and the volunteer on the log).
struct VolunteerRepository {
    let orgId: String

    private var assignmentsCollection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("volunteerAssignments")
    }

    private var logsCollection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("volunteerLogs")
    }

    /// Assignments for one volunteer. Equality filter only; callers sort.
    func assignments(volunteerUid: String, limit: Int = 200) -> AsyncThrowingStream<[VolunteerAssignment], Error> {
        assignmentsCollection
            .whereField("volunteerUid", isEqualTo: volunteerUid)
            .limit(to: limit)
            .decodedStream(VolunteerAssignment.self)
    }

    /// One volunteer's logs. The `volunteerUid` filter is required for non-admins by the rules.
    /// Equality filter only; callers sort.
    func logs(volunteerUid: String, limit: Int = 500) -> AsyncThrowingStream<[VolunteerLog], Error> {
        logsCollection
            .whereField("volunteerUid", isEqualTo: volunteerUid)
            .limit(to: limit)
            .decodedStream(VolunteerLog.self, serverTimestamps: .estimate)
    }

    /// Direct create in the exact `VolunteerLog` shape: `volunteerUid == auth.uid`,
    /// `createdAt == request.time`, minutes 1–1440. Returns the new log id.
    @discardableResult
    func logTime(
        volunteerUid: String,
        patientId: String?,
        date: String,
        minutes: Int,
        activity: VolunteerActivity,
        note: String?
    ) async throws -> String {
        let ref = logsCollection.document()
        let data: [String: Any] = [
            "volunteerUid": volunteerUid,
            "patientId": orNull(patientId?.nilIfBlank),
            "date": date,
            "minutes": minutes,
            "activity": activity.rawValue,
            "note": blankToNull(note),
            "createdAt": FieldValue.serverTimestamp(),
        ]
        try await ref.setData(data)
        return ref.documentID
    }
}
