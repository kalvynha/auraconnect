import SwiftUI
import UniformTypeIdentifiers

/// Capture a referral (VisionKit scan, or import a PDF / images), build a PDF, create the
/// referral record and upload it. Extraction then runs server-side.
struct ReferralScanView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    let onUploaded: (String) -> Void

    @State private var pages: [UIImage] = []
    @State private var importedPDF: Data? = nil
    @State private var importedPDFName: String? = nil
    @State private var source: ReferralSource = .scan
    @State private var showScanner = false
    @State private var showImporter = false
    @State private var isUploading = false
    @State private var errorMessage: String? = nil

    private var hasContent: Bool { importedPDF != nil || !pages.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if DocumentScannerView.isSupported {
                        Button {
                            showScanner = true
                        } label: {
                            Label("Scan referral document", systemImage: "doc.viewfinder")
                        }
                    }
                    Button {
                        showImporter = true
                    } label: {
                        Label("Import PDF or images", systemImage: "square.and.arrow.down")
                    }
                } footer: {
                    if !DocumentScannerView.isSupported {
                        Text("Document scanning isn't available on this device. Import a PDF or photos instead.")
                    }
                }

                if !pages.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(Array(pages.enumerated()), id: \.offset) { index, image in
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFit()
                                        .frame(height: 140)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                                        .accessibilityLabel("Page \(index + 1)")
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        Button("Discard pages", role: .destructive) {
                            pages = []
                        }
                    } header: {
                        Text(pages.count == 1 ? "1 page" : "\(pages.count) pages")
                    }
                }

                if importedPDF != nil {
                    Section("Selected file") {
                        Label(importedPDFName ?? "referral.pdf", systemImage: "doc.richtext")
                        Button("Remove", role: .destructive) {
                            importedPDF = nil
                            importedPDFName = nil
                        }
                    }
                }

                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }

                Section {
                    Text("After upload, AI extraction reads the referral and pre-fills the patient details for your review. Nothing is admitted until you accept it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New referral")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isUploading)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isUploading {
                        ProgressView()
                    } else {
                        Button("Upload") {
                            Task { await upload() }
                        }
                        .disabled(!hasContent)
                    }
                }
            }
            .fullScreenCover(isPresented: $showScanner) {
                DocumentScannerView(
                    onFinish: { images in
                        pages.append(contentsOf: images)
                        importedPDF = nil
                        importedPDFName = nil
                        source = .scan
                        showScanner = false
                    },
                    onCancel: { showScanner = false },
                    onError: { error in
                        errorMessage = error.localizedDescription
                        showScanner = false
                    }
                )
                .ignoresSafeArea()
            }
            .fileImporter(isPresented: $showImporter,
                          allowedContentTypes: [.pdf, .image],
                          allowsMultipleSelection: true) { result in
                handleImport(result)
            }
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            var newPages: [UIImage] = []
            for url in urls {
                let hasAccess = url.startAccessingSecurityScopedResource()
                defer {
                    if hasAccess { url.stopAccessingSecurityScopedResource() }
                }
                guard let data = try? Data(contentsOf: url) else {
                    errorMessage = "Couldn't read \(url.lastPathComponent)."
                    continue
                }
                let type = UTType(filenameExtension: url.pathExtension)
                if type?.conforms(to: .pdf) == true {
                    // A PDF is uploaded as-is (only one PDF per referral).
                    importedPDF = data
                    importedPDFName = url.lastPathComponent
                    pages = []
                    newPages = []
                    source = .upload
                    break
                } else if let image = UIImage(data: data) {
                    newPages.append(image)
                }
            }
            if !newPages.isEmpty {
                pages.append(contentsOf: newPages)
                importedPDF = nil
                importedPDFName = nil
                source = .upload
            }
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func upload() async {
        guard hasContent else { return }
        isUploading = true
        errorMessage = nil
        defer { isUploading = false }

        let pdfData: Data
        if let importedPDF {
            pdfData = importedPDF
        } else {
            let images = pages
            pdfData = await Task.detached(priority: .userInitiated) {
                PDFBuilder.makePDF(from: images)
            }.value
        }
        guard pdfData.count < AppConfig.maxUploadBytes else {
            errorMessage = "The document is larger than 25 MB. Try scanning fewer pages."
            return
        }
        do {
            let id = try await ReferralRepository(orgId: org.orgId)
                .createAndUpload(pdfData: pdfData, source: source, uploadedBy: org.uid)
            onUploaded(id)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
