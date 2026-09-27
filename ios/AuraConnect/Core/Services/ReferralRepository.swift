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
    /// `fileName` must be a single path segment; it is sanitized to letters, digits, `.`, `_` and `-`.
    func createAndUpload(pdfData: Data, source: ReferralSource, uploadedBy uid: String,
                         fileName requestedName: String = "referral.pdf") async throws -> String {
        let ref = collection.document()
        let fileName = Self.safeFileName(requestedName)
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

    /// Mirrors the web's `safeFileName`: storage path segment safe, keeps a `.pdf` extension.
    static func safeFileName(_ name: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let underscore: Unicode.Scalar = "_"
        var cleaned = ""
        for scalar in name.unicodeScalars {
            cleaned.unicodeScalars.append(allowed.contains(scalar) ? scalar : underscore)
        }
        while cleaned.hasPrefix("_") || cleaned.hasPrefix(".") { cleaned.removeFirst() }
        cleaned = String(cleaned.suffix(120))
        if cleaned.isEmpty { cleaned = "referral" }
        if !cleaned.lowercased().hasSuffix(".pdf") { cleaned += ".pdf" }
        return cleaned
    }
}
