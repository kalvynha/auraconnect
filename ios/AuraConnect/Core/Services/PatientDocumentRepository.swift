import Foundation
import FirebaseFirestore
import FirebaseStorage

/// `orgs/{orgId}/patients/{patientId}/documents` plus the matching Storage objects.
/// Clinical roles create the document (exact `PatientDocument` shape), then upload the file to
/// `orgs/{orgId}/patients/{patientId}/documents/{documentId}/{fileName}`. No update or delete.
struct PatientDocumentRepository {
    let orgId: String

    private func collection(_ patientId: String) -> CollectionReference {
        FirebaseService.orgRef(orgId).collection("patients").document(patientId).collection("documents")
    }

    /// Newest first; pending server timestamps are estimated so a just-created document sorts correctly.
    func documents(patientId: String, limit: Int = 200) -> AsyncThrowingStream<[PatientDocument], Error> {
        collection(patientId)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .decodedStream(PatientDocument.self, serverTimestamps: .estimate)
    }

    /// Creates the document record, then uploads the file. Returns the document id.
    func createAndUpload(
        patientId: String,
        data: Data,
        fileName: String,
        contentType: String,
        name: String,
        category: DocumentCategory,
        uploadedBy uid: String
    ) async throws -> String {
        let ref = collection(patientId).document()
        // A single path segment (no "/"), as the rules require.
        let safeName = MessageRepository.sanitizedFileName(fileName)
        let storagePath = "orgs/\(orgId)/patients/\(patientId)/documents/\(ref.documentID)/\(safeName)"
        let displayName = String((name.nilIfBlank ?? safeName).prefix(200))
        let record: [String: Any] = [
            "name": displayName,
            "category": category.rawValue,
            "fileName": safeName,
            "storagePath": storagePath,
            "contentType": contentType,
            "size": data.count,
            "uploadedBy": uid,
            "createdAt": FieldValue.serverTimestamp(),
        ]
        try await ref.setData(record)
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        _ = try await FirebaseService.storage.reference(withPath: storagePath).putDataAsync(data, metadata: metadata)
        return ref.documentID
    }
}
