import Foundation
import UniformTypeIdentifiers
import FirebaseStorage

/// Downloads a Storage object to a temporary file for QuickLook. The copy is written with
/// complete file protection (encrypted while the device is locked) via an ephemeral
/// URLSession (no shared URL cache), and callers delete it when the preview closes.
enum SecureDownload {
    private static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("secure-previews", isDirectory: true)
    }

    static func fetchToTemporaryFile(storagePath: String, fileName: String, contentType: String) async throws -> URL {
        let remote = try await FirebaseService.storage.reference(withPath: storagePath).downloadURL()
        let session = URLSession(configuration: .ephemeral)
        let (data, response) = try await session.data(from: remote)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
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
