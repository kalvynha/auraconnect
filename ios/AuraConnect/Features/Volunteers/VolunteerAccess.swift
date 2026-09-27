import Foundation
import FirebaseFirestore

/// v3 minimum-necessary access for volunteers (docs/PERSONA_REVIEW.md C2, firestore.rules
/// `isVolunteer`): a non-admin member whose discipline is Volunteer may read only the patients
/// whose `volunteerUids` contains them, and never visits, tasks, triage calls, IDG meetings or
/// bereavement plans. Screens use these helpers so they never subscribe to denied collections.
extension OrgStore {
    /// A non-admin member with the Volunteer discipline (false until the member doc loads).
    var isVolunteerMember: Bool {
        me?.discipline == .volunteer && role != .admin
    }

    /// True once the member doc is known and the caller is staff (not a volunteer), i.e.
    /// visits, tasks, triage, IDG and bereavement may be queried. False while members load,
    /// so a volunteer never starts a denied listener.
    var canReadStaffCollections: Bool {
        membersLoaded && me != nil && !isVolunteerMember
    }

    /// Which patient query the Patients tab may run: `unknown` until the member doc loads.
    var patientAudienceKey: String {
        guard membersLoaded, me != nil else { return "unknown" }
        return isVolunteerMember ? "volunteer" : "staff"
    }
}

extension PatientRepository {
    /// Patients a volunteer is assigned to (`volunteerUids` array-contains). The only patient
    /// list query the rules allow for volunteers. Array-contains only; callers sort.
    func patients(volunteerMember uid: String, limit: Int = 200) -> AsyncThrowingStream<[Patient], Error> {
        FirebaseService.orgRef(orgId).collection("patients")
            .whereField("volunteerUids", arrayContains: uid)
            .limit(to: limit)
            .decodedStream(Patient.self)
    }
}
