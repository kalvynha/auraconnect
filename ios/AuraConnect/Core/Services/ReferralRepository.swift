import Foundation
import FirebaseFirestore
import FirebaseStorage

struct ReferralRepository {
    let orgId: String

    private var collection: CollectionReference {
        FirebaseService.orgRef(orgId).collection("referrals")
    }

    func referrals() -> AsyncThrowingStream<[Referral], Error> {
        collection.order(by: "createdAt", descending: true).limit(to: 200).decodedStream(Referral.self)
    }

    func referral(id: String) -> AsyncThrowingStream<Referral?, Error> {
        collection.document(id).decodedStream(Referral.self)
    }

    /// Creates the referral record (status `uploaded`, full 14-field shape required by the rules)
    /// and then uploads the PDF, which triggers server-side extraction. Returns the referral id.
    func createAndUpload(pdfData: Data, source: ReferralSource, uploadedBy uid: String) async throws -> String {
        let ref = collection.document()
        let fileName = "referral.pdf"
        let contentType = "application/pdf"
        let storagePath = "orgs/\(orgId)/referrals/\(ref.documentID)/\(fileName)"
        let data: [String: Any] = [
            "fileName": fileName,
            "contentType": contentType,
            "storagePath": storagePath,
            "source": source.rawValue,
            "status": ReferralStatus.uploaded.rawValue,
            "extracted": NSNull(),
            "error": NSNull(),
            "model": NSNull(),
            "patientId": NSNull(),
            "uploadedBy": uid,
            "reviewedBy": NSNull(),
            "rejectionReason": NSNull(),
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp(),
        ]
        try await ref.setData(data)
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        _ = try await FirebaseService.storage.reference(withPath: storagePath).putDataAsync(pdfData, metadata: metadata)
        return ref.documentID
    }
}
