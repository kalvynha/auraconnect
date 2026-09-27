import Foundation
import FirebaseFirestore

/// `orgs/{orgId}/patients/{patientId}/events` — the patient timeline, written only by functions.
struct PatientEventRepository {
    let orgId: String

    private func collection(_ patientId: String) -> CollectionReference {
        FirebaseService.orgRef(orgId).collection("patients").document(patientId).collection("events")
    }

    /// Newest effective date first.
    func events(patientId: String, limit: Int = 200) -> AsyncThrowingStream<[PatientEvent], Error> {
        collection(patientId)
            .order(by: "date", descending: true)
            .limit(to: limit)
            .decodedStream(PatientEvent.self)
    }
}
