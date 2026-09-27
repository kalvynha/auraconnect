import Foundation
import FirebaseFirestore

struct PatientRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("patients")
    }

    func patients() -> AsyncThrowingStream<[Patient], Error> {
        collection.order(by: "lastName").limit(to: 1000).decodedStream(Patient.self)
    }

    /// Patients with one status, by last name. Composite index: patients (status ASC, lastName ASC).
    func patients(status: PatientStatus, limit: Int = 1000) -> AsyncThrowingStream<[Patient], Error> {
        collection
            .whereField("status", isEqualTo: status.rawValue)
            .order(by: "lastName")
            .limit(to: limit)
            .decodedStream(Patient.self)
    }

    /// Patients whose care team includes `uid`. Array-contains only (single-field index); callers sort.
    func patients(careTeamMember uid: String, limit: Int = 500) -> AsyncThrowingStream<[Patient], Error> {
        collection
            .whereField("careTeamUids", arrayContains: uid)
            .limit(to: limit)
            .decodedStream(Patient.self)
    }

    func patient(id: String) -> AsyncThrowingStream<Patient?, Error> {
        collection.document(id).decodedStream(Patient.self)
    }

    func fetchPatient(id: String) async throws -> Patient? {
        let snapshot = try await collection.document(id).getDocument()
        guard snapshot.exists else { return nil }
        return try snapshot.data(as: Patient.self)
    }
}
