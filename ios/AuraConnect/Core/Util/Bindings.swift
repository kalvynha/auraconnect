import SwiftUI

extension Binding where Value == String? {
    /// Edits an optional string as a plain string; empty text is stored as `nil`.
    var orEmpty: Binding<String> {
        Binding<String>(
            get: { self.wrappedValue ?? "" },
            set: { self.wrappedValue = $0.isEmpty ? nil : $0 }
        )
    }
}

extension Binding {
    /// Edits an optional value through a non-optional binding, using `defaultValue` when nil.
    func withDefault<T>(_ defaultValue: T) -> Binding<T> where Value == T? {
        Binding<T>(
            get: { self.wrappedValue ?? defaultValue },
            set: { self.wrappedValue = $0 }
        )
    }
}

/// A bounds-checked binding to `array[index]` that tolerates the element being removed.
func elementBinding<T>(_ array: Binding<[T]>, _ index: Int, default defaultValue: T) -> Binding<T> {
    Binding<T>(
        get: { index < array.wrappedValue.count ? array.wrappedValue[index] : defaultValue },
        set: { newValue in
            if index < array.wrappedValue.count { array.wrappedValue[index] = newValue }
        }
    )
}

/// Binds a `YYYY-MM-DD` string to a `Date` for `DatePicker`.
func isoDateBinding(_ string: Binding<String?>, default defaultDate: Date = Date()) -> Binding<Date> {
    Binding<Date>(
        get: { ISODate.parse(string.wrappedValue) ?? defaultDate },
        set: { string.wrappedValue = ISODate.string(from: $0) }
    )
}
