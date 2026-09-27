import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Adds a document to a patient's chart: pick a file (camera scan, photo library or Files),
/// name and categorize it, then create the `PatientDocument` record and upload the file.
struct PatientDocumentUploadView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let patientId: String

    private struct PickedFile {
        var data: Data
        var fileName: String
        var contentType: String
    }

    @State private var name = ""
    @State private var category: DocumentCategory = .other
    @State private var picked: PickedFile?
    @State private var photoItem: PhotosPickerItem?
    @State private var showScanner = false
    @State private var showImporter = false
    @State private var isPreparing = false
    @State private var isUploading = false
    @State private var errorMessage: String?

    private var isValid: Bool {
        guard picked != nil else { return false }
        return (name.nilIfBlank?.count ?? 0) <= 200
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                Section {
                    if DocumentScannerView.isSupported {
                        Button {
                            showScanner = true
                        } label: {
                            Label("Scan with camera", systemImage: "doc.viewfinder")
                        }
                    }
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Label("Photo library", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showImporter = true
                    } label: {
                        Label("PDF or image file", systemImage: "folder")
                    }
                } header: {
                    Text("Source")
                } footer: {
                    Text("PDF or image, smaller than 25 MB.")
                }
                .disabled(isUploading || isPreparing)

                if isPreparing {
                    Section { ProgressView("Preparing…") }
                } else if let picked {
                    Section("Selected file") {
                        LabeledContent("File", value: picked.fileName)
                        LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(picked.data.count), countStyle: .file))
                    }
                }

                Section("Details") {
                    TextField("Name (e.g. Signed election statement)", text: $name)
                    Picker("Category", selection: $category) {
                        ForEach(DocumentCategory.allCases) { category in
                            Label(category.label, systemImage: category.symbol).tag(category)
                        }
                    }
                }
                .disabled(isUploading)
            }
            .navigationTitle("Upload document")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isUploading)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    CareSubmitButton(title: "Upload", isWorking: isUploading, isEnabled: isValid && !isPreparing) {
                        Task { await upload() }
                    }
                }
            }
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                photoItem = nil
                Task { await loadPhoto(item) }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.pdf, .image]) { result in
                handleImport(result)
            }
            .fullScreenCover(isPresented: $showScanner) {
                DocumentScannerView(
                    onFinish: { images in
                        showScanner = false
                        Task { await buildScan(images) }
                    },
                    onCancel: { showScanner = false },
                    onError: { error in
                        errorMessage = error.localizedDescription
                        showScanner = false
                    }
                )
                .ignoresSafeArea()
            }
        }
    }

    // MARK: Sources

    private func setPicked(data: Data, fileName: String, contentType: String) {
        guard data.count < AppConfig.maxUploadBytes else {
            errorMessage = "Documents must be smaller than 25 MB."
            return
        }
        guard contentType == "application/pdf" || contentType.hasPrefix("image/") else {
            errorMessage = "Only PDF and image files can be uploaded."
            return
        }
        errorMessage = nil
        picked = PickedFile(data: data, fileName: fileName, contentType: contentType)
        if name.nilIfBlank == nil {
            name = URL(fileURLWithPath: fileName).deletingPathExtension().lastPathComponent
        }
    }

    private func buildScan(_ images: [UIImage]) async {
        guard !images.isEmpty else { return }
        isPreparing = true
        defer { isPreparing = false }
        let pdf = await Task.detached(priority: .userInitiated) {
            PDFBuilder.makePDF(from: images)
        }.value
        setPicked(data: pdf, fileName: "scan-\(Int(Date().timeIntervalSince1970)).pdf", contentType: "application/pdf")
    }

    private func loadPhoto(_ item: PhotosPickerItem) async {
        isPreparing = true
        defer { isPreparing = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.8) ?? data
            setPicked(data: jpeg, fileName: "photo-\(Int(Date().timeIntervalSince1970)).jpg", contentType: "image/jpeg")
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            let hasAccess = url.startAccessingSecurityScopedResource()
            defer {
                if hasAccess { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url)
                let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                setPicked(data: data, fileName: url.lastPathComponent, contentType: contentType)
            } catch {
                errorMessage = error.userMessage
            }
        case .failure(let error):
            errorMessage = error.userMessage
        }
    }

    // MARK: Upload

    private func upload() async {
        guard let picked, !isUploading else { return }
        isUploading = true
        errorMessage = nil
        defer { isUploading = false }
        do {
            _ = try await PatientDocumentRepository(orgId: org.orgId).createAndUpload(
                patientId: patientId,
                data: picked.data,
                fileName: picked.fileName,
                contentType: picked.contentType,
                name: name,
                category: category,
                uploadedBy: org.uid
            )
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
