import Foundation
import UniformTypeIdentifiers
import FirebaseStorage

/// Downloads a Storage object to a temporary file for QuickLook. The copy is written with
/// complete file protection (encrypted while the device is locked), and callers delete it when
/// the preview closes.
///
/// M2: the bytes are fetched with the signed-in user's credentials through the Storage SDK
/// (`StorageReference.data(maxSize:)`), so the Storage security rules apply to every read. No
/// long-lived download URL (a bearer token anyone holding it could use) is ever created for PHI.
enum SecureDownload {
    /// Storage rules cap uploads at 25 MB; allow a little headroom.
    static let maxBytes: Int64 = 26 * 1024 * 1024

    private static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("secure-previews", isDirectory: true)
    }

    static func fetchToTemporaryFile(storagePath: String, fileName: String, contentType: String) async throws -> URL {
        let data = try await FirebaseService.storage.reference(withPath: storagePath).data(maxSize: maxBytes)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var name = MessageRepository.sanitizedFileName(fileName)
        if URL(fileURLWithPath: name).pathExtension.isEmpty,
           let ext = UTType(mimeType: contentType)?.preferredFilenameExtension {
            name += ".\(ext)"
        }
        let url = directory.appendingPathComponent("\(UUID().uuidString)-\(name)")
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    static func remove(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Deletes any previews left behind (e.g. if the app was killed mid-preview).
    static func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}
