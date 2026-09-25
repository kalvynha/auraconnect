import Foundation

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `nil` when the string is empty or only whitespace, otherwise the trimmed string.
    var nilIfBlank: String? {
        let value = trimmed
        return value.isEmpty ? nil : value
    }
}

/// Converts an optional into a Firestore / callable value, using `NSNull` for `nil`
/// so documents keep the stable, null-filled shape the contract requires.
func orNull<T>(_ value: T?) -> Any {
    if let value { return value }
    return NSNull()
}

/// Trims an optional string and turns blanks into `NSNull`.
func blankToNull(_ value: String?) -> Any {
    orNull(value?.nilIfBlank)
}

extension KeyedDecodingContainer {
    /// Decodes `key` if present and well-typed; returns `nil` for missing, null or mismatched values.
    func lenient<T: Decodable>(_ key: Key) -> T? {
        guard let value = try? decodeIfPresent(T.self, forKey: key) else { return nil }
        return value
    }
}
