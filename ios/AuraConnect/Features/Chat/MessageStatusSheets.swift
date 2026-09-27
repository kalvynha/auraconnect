import SwiftUI

/// "Read by N of M" details for one of my messages (`messageReadStatus`) with "Nudge unread"
/// (`nudgeUnread`, at most once per message per 10 minutes).
struct ReadStatusSheet: View {
    @Environment(\.dismiss) private var dismiss
    let orgId: String
    let channelId: String
    let messageId: String
    var canNudge: Bool = true

    @State private var status: MessageReadStatus?
    @State private var isLoading = false
    @State private var isNudging = false
    @State private var errorMessage: String?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if let notice {
                    Section {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                if let status {
                    Section {
                        if status.unread.isEmpty {
                            Text("Everyone has read it.").foregroundStyle(.secondary)
                        }
                        ForEach(status.unread) { reader in
                            Label(reader.name, systemImage: "circle")
                        }
                    } header: {
                        Text("Not read yet (\(status.unread.count))")
                    } footer: {
                        if canNudge && !status.unread.isEmpty {
                            Text("Nudge sends them a generic \"Reminder: unread message\" notification.")
                        }
                    }
                    Section("Read (\(status.read.count))") {
                        ForEach(status.read) { reader in
                            HStack {
                                Label(reader.name, systemImage: "checkmark.circle.fill")
                                Spacer()
                                if let at = reader.at {
                                    Text(at.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .overlay {
                if isLoading && status == nil { ProgressView() }
            }
            .refreshable { await load() }
            .navigationTitle(status.map { "Read by \($0.read.count) of \($0.total)" } ?? "Read status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if canNudge {
                    ToolbarItem(placement: .confirmationAction) {
                        if isNudging {
                            ProgressView()
                        } else {
                            Button("Nudge unread") {
                                Task { await nudge() }
                            }
                            .disabled((status?.unread.isEmpty ?? true))
                        }
                    }
                }
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await FunctionsClient().messageReadStatus(orgId: orgId, channelId: channelId, messageId: messageId)
            errorMessage = nil
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func nudge() async {
        guard !isNudging else { return }
        isNudging = true
        defer { isNudging = false }
        do {
            let count = try await FunctionsClient().nudgeUnread(orgId: orgId, channelId: channelId, messageId: messageId)
            notice = count == 1 ? "Nudged 1 member." : "Nudged \(count) members."
            errorMessage = nil
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Who has acknowledged an ack-required broadcast (`broadcastAckReport`): the sender, admins
/// and members with the `reports` capability.
struct AckReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let orgId: String
    let channelId: String
    let messageId: String

    @State private var report: BroadcastAckReport?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if let report {
                    Section {
                        ProgressView(value: Double(report.acked.count), total: Double(max(report.total, 1))) {
                            Text("\(report.acked.count) of \(report.total) acknowledged")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    Section("Pending (\(report.pending.count))") {
                        if report.pending.isEmpty {
                            Text("Everyone has acknowledged.").foregroundStyle(.secondary)
                        }
                        ForEach(report.pending) { entry in
                            Label(entry.name, systemImage: "clock")
                        }
                    }
                    Section("Acknowledged (\(report.acked.count))") {
                        ForEach(report.acked) { entry in
                            HStack {
                                Label(entry.name, systemImage: "checkmark.seal.fill")
                                Spacer()
                                if let at = entry.ackedAt {
                                    Text(at.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .overlay {
                if isLoading && report == nil { ProgressView() }
            }
            .refreshable { await load() }
            .navigationTitle("Acknowledgements")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            report = try await FunctionsClient().broadcastAckReport(orgId: orgId, channelId: channelId, messageId: messageId)
            errorMessage = nil
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Edits one of my messages (`editMessage`; sender only, within 15 minutes).
struct EditMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    let originalText: String
    let onSave: (String) async throws -> Void

    @State private var text = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isValid: Bool {
        guard let body = text.nilIfBlank else { return false }
        return body.count <= AppConfig.maxMessageLength && body != originalText.trimmed
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                } footer: {
                    Text("Messages can be edited for 15 minutes after sending. Recipients see \"edited\"; the previous text is kept for audit.")
                }
            }
            .navigationTitle("Edit message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(!isValid)
                    }
                }
            }
            .onAppear {
                if text.isEmpty { text = originalText }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        guard isValid, !isSaving else { return }
        let body = text.trimmed
        isSaving = true
        Task {
            do {
                try await onSave(body)
                isSaving = false
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.userMessage
            }
        }
    }
}
