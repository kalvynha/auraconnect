import UIKit
import UniformTypeIdentifiers

/// Copies text that may contain PHI: local-only (no Universal Clipboard / Handoff)
/// and cleared automatically after five minutes.
enum SecurePasteboard {
    static func copy(_ text: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: text]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]
        )
    }
}
