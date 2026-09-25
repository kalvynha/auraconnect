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

    func patient(id: String) -> AsyncThrowingStream<Patient?, Error> {
        collection.document(id).decodedStream(Patient.self)
    }

    func fetchPatient(id: String) async throws -> Patient? {
        let snapshot = try await collection.document(id).getDocument()
        guard snapshot.exists else { return nil }
        return try snapshot.data(as: Patient.self)
    }
}
