import SwiftUI

/// Searchable list of org and personal templates grouped by category. Templates with `fields`
/// open a form; others insert immediately. The filled text is handed to `onInsert`.
struct TemplatePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let templates: [MessageTemplate]
    let context: TemplateContext
    /// Admins with no org templates can load the defaults.
    var canSeedDefaults: Bool = false
    var onSeedDefaults: (() async -> Void)? = nil
    var onDeletePersonal: ((MessageTemplate) async -> Void)? = nil
    let onInsert: (MessageTemplate, String) -> Void

    @State private var search = ""
    @State private var isSeeding = false

    /// Patient-context templates show only in patient channels; quick replies are chips, not composer templates.
    private var available: [MessageTemplate] {
        TemplateRepository.sorted(templates).filter { template in
            (context.isPatientChannel || !template.patientContext) && template.category != .quickReply
        }
    }

    private var filtered: [MessageTemplate] {
        guard let query = search.nilIfBlank else { return available }
        return available.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.body.localizedCaseInsensitiveContains(query)
                || $0.category.label.localizedCaseInsensitiveContains(query)
        }
    }

    private struct CategorySection: Identifiable {
        let category: TemplateCategory
        let items: [MessageTemplate]
        var id: String { category.rawValue }
    }

    private var sections: [CategorySection] {
        let groups = Dictionary(grouping: filtered, by: { $0.category })
        return groups.keys
            .sorted { $0.sortIndex < $1.sortIndex }
            .map { CategorySection(category: $0, items: groups[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            List {
                if canSeedDefaults && !templates.contains(where: { !$0.isPersonal }) {
                    Section {
                        Button {
                            Task {
                                isSeeding = true
                                await onSeedDefaults?()
                                isSeeding = false
                            }
                        } label: {
                            if isSeeding {
                                ProgressView()
                            } else {
                                Label("Add the default templates", systemImage: "square.and.arrow.down")
                            }
                        }
                        .disabled(isSeeding)
                    } footer: {
                        Text("SBAR escalation, fall report, symptom crisis, death notification and more.")
                    }
                }
                ForEach(sections) { section in
                    Section(section.category.label) {
                        ForEach(section.items) { template in
                            row(template)
                        }
                    }
                }
            }
            .overlay {
                if filtered.isEmpty {
                    if search.nilIfBlank != nil {
                        ContentUnavailableView.search(text: search)
                    } else {
                        ContentUnavailableView("No templates",
                                               systemImage: "text.badge.plus",
                                               description: Text("Save a draft as a personal template from the composer."))
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search templates")
            .navigationTitle("Templates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ template: MessageTemplate) -> some View {
        if template.fields.isEmpty {
            Button {
                insert(template, text: TemplateFiller.fill(template.body, context: context))
            } label: {
                TemplateRowLabel(template: template)
            }
            .foregroundStyle(Color.primary)
            .swipeActions { deleteAction(template) }
        } else {
            NavigationLink {
                TemplateFormView(template: template, context: context) { text in
                    insert(template, text: text)
                }
            } label: {
                TemplateRowLabel(template: template)
            }
            .swipeActions { deleteAction(template) }
        }
    }

    @ViewBuilder
    private func deleteAction(_ template: MessageTemplate) -> some View {
        if template.isPersonal, let onDeletePersonal {
            Button(role: .destructive) {
                Task { await onDeletePersonal(template) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func insert(_ template: MessageTemplate, text: String) {
        onInsert(template, text)
        dismiss()
    }
}

private struct TemplateRowLabel: View {
    let template: MessageTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if template.isPersonal {
                    Image(systemName: "person.crop.circle")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Personal template")
                }
                Text(template.title)
                    .font(.body.weight(.medium))
                if !template.fields.isEmpty {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Has a form")
                }
                Spacer(minLength: 0)
                PriorityBadge(priority: template.defaultPriority)
            }
            Text(template.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}

/// Form for a template with `fields` (e.g. SBAR: S, B, A, R) with a live preview.
struct TemplateFormView: View {
    let template: MessageTemplate
    let context: TemplateContext
    let onInsert: (String) -> Void

    @State private var values: [String: String] = [:]

    private var filled: String {
        TemplateFiller.fill(template.body, fieldValues: values, context: context)
    }

    private var missing: [TemplateField] {
        TemplateFiller.missingRequired(template, values: values)
    }

    var body: some View {
        Form {
            Section {
                ForEach(template.fields) { field in
                    fieldInput(field)
                }
            } footer: {
                if !missing.isEmpty {
                    Text("Required: " + missing.map { $0.label }.joined(separator: ", "))
                }
            }
            Section("Preview") {
                Text(filled)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(template.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Insert") { onInsert(filled) }
                    .disabled(!missing.isEmpty)
            }
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(
            get: { values[key] ?? "" },
            set: { values[key] = $0 }
        )
    }

    @ViewBuilder
    private func fieldInput(_ field: TemplateField) -> some View {
        let title = field.required ? "\(field.label) *" : field.label
        switch field.kind {
        case .text:
            TextField(title, text: binding(field.key))
        case .multiline:
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                TextField(field.label, text: binding(field.key), axis: .vertical)
                    .lineLimit(2...6)
            }
        case .number:
            TextField(title, text: binding(field.key))
                .keyboardType(.decimalPad)
        case .choice:
            Picker(title, selection: binding(field.key)) {
                Text("Choose").tag("")
                ForEach(field.options ?? [], id: \.self) { option in
                    Text(option).tag(option)
                }
            }
        }
    }
}

/// Saves the composer draft as a personal template (`saveTemplate`, scope `personal`).
struct SaveTemplateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let initialBody: String
    let initialPriority: Priority
    let onSave: (MessageTemplate) async throws -> Void

    @State private var title = ""
    @State private var category: TemplateCategory = .clinical
    @State private var priority: Priority = .normal
    @State private var bodyText = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isValid: Bool {
        guard let title = title.nilIfBlank, bodyText.nilIfBlank != nil else { return false }
        // saveTemplate limits: title ≤ 100, body ≤ 4000; unknown {{placeholders}} are rejected server-side.
        return title.count <= 100 && bodyText.trimmed.count <= 4000
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    TextField("Title", text: $title)
                    Picker("Category", selection: $category) {
                        ForEach(TemplateCategory.allCases) { category in
                            Text(category.label).tag(category)
                        }
                    }
                    Picker("Default priority", selection: $priority) {
                        ForEach(Priority.allCases) { priority in
                            Text(priority.label).tag(priority)
                        }
                    }
                }
                Section {
                    TextField("Text", text: $bodyText, axis: .vertical)
                        .lineLimit(3...10)
                } header: {
                    Text("Text")
                } footer: {
                    Text("Placeholders such as {{patient}}, {{codeStatus}}, {{caregiver}}, {{me}}, {{time}} and {{date}} are filled in when you use the template.")
                }
            }
            .navigationTitle("Save as template")
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
                if bodyText.isEmpty { bodyText = initialBody }
                priority = initialPriority
            }
        }
    }

    private func save() {
        guard isValid, !isSaving else { return }
        let template = MessageTemplate(
            title: title.trimmed,
            category: category,
            body: bodyText.trimmed,
            defaultPriority: priority
        )
        isSaving = true
        Task {
            do {
                try await onSave(template)
                isSaving = false
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.userMessage
            }
        }
    }
}
