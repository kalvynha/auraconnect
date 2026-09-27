import SwiftUI
import UniformTypeIdentifiers

/// Capture referrals (VisionKit scan, or import PDFs / images), create the referral records
/// and upload them. Extraction then runs server-side.
///
/// Scanned or imported images are combined into ONE PDF referral (PDFBuilder), so every upload
/// is `application/pdf`, one of `ReferralRules.mimeTypes`. Each imported PDF becomes its own
/// referral (previously only the first PDF was kept).
struct ReferralScanView: View {
    @Environment(OrgStore.self) private var org
    @Environment(\.dismiss) private var dismiss
    /// Called with the ids of the referrals created (one per PDF, plus one for scanned pages).
    let onUploaded: ([String]) -> Void

    struct ImportedPDF: Identifiable {
        let id = UUID()
        let name: String
        let data: Data
    }

    @State private var pages: [UIImage] = []
    @State private var importedPDFs: [ImportedPDF] = []
    @State private var source: ReferralSource = .scan
    @State private var showScanner = false
    @State private var showImporter = false
    @State private var isUploading = false
    @State private var uploadedCount = 0
    @State private var errorMessage: String? = nil

    private var hasContent: Bool { !importedPDFs.isEmpty || !pages.isEmpty }
    private var referralCount: Int { importedPDFs.count + (pages.isEmpty ? 0 : 1) }

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

                if !importedPDFs.isEmpty {
                    Section {
                        ForEach(importedPDFs) { pdf in
                            Label(pdf.name, systemImage: "doc.richtext")
                        }
                        .onDelete { importedPDFs.remove(atOffsets: $0) }
                    } header: {
                        Text(importedPDFs.count == 1 ? "1 PDF" : "\(importedPDFs.count) PDFs")
                    } footer: {
                        Text("Each PDF becomes its own referral. Swipe to remove one.")
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
                        HStack(spacing: 6) {
                            ProgressView()
                            if referralCount > 1 { Text("\(uploadedCount)/\(referralCount)").font(.caption) }
                        }
                    } else {
                        Button(referralCount > 1 ? "Upload \(referralCount)" : "Upload") {
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
            var unreadable: [String] = []
            for url in urls {
                let hasAccess = url.startAccessingSecurityScopedResource()
                defer {
                    if hasAccess { url.stopAccessingSecurityScopedResource() }
                }
                guard let data = try? Data(contentsOf: url) else {
                    unreadable.append(url.lastPathComponent)
                    continue
                }
                let type = UTType(filenameExtension: url.pathExtension)
                if type?.conforms(to: .pdf) == true {
                    if data.count >= AppConfig.maxUploadBytes {
                        unreadable.append("\(url.lastPathComponent) (larger than 25 MB)")
                    } else {
                        importedPDFs.append(ImportedPDF(name: url.lastPathComponent, data: data))
                    }
                } else if let image = UIImage(data: data) {
                    newPages.append(image)
                } else {
                    unreadable.append(url.lastPathComponent)
                }
            }
            if !newPages.isEmpty {
                pages.append(contentsOf: newPages)
                if source == .scan && pages.count == newPages.count { source = .upload }
            }
            errorMessage = unreadable.isEmpty ? nil : "Couldn't use: \(unreadable.joined(separator: ", "))."
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func upload() async {
        guard hasContent else { return }
        isUploading = true
        uploadedCount = 0
        errorMessage = nil
        defer { isUploading = false }

        // Build everything first so a too-large scan fails before anything is created.
        var items: [(name: String, data: Data, source: ReferralSource)] = []
        if !pages.isEmpty {
            let images = pages
            let pdfData = await Task.detached(priority: .userInitiated) {
                PDFBuilder.makePDF(from: images)
            }.value
            guard pdfData.count < AppConfig.maxUploadBytes else {
                errorMessage = "The scanned document is larger than 25 MB. Try scanning fewer pages."
                return
            }
            items.append((name: "referral.pdf", data: pdfData, source: source))
        }
        for pdf in importedPDFs {
            items.append((name: pdf.name, data: pdf.data, source: .upload))
        }

        let repository = ReferralRepository(orgId: org.orgId)
        var ids: [String] = []
        for item in items {
            do {
                let id = try await repository.createAndUpload(pdfData: item.data, source: item.source,
                                                              uploadedBy: org.uid, fileName: item.name)
                ids.append(id)
                uploadedCount = ids.count
            } catch {
                errorMessage = ids.isEmpty
                    ? error.userMessage
                    : "\(ids.count) of \(items.count) referrals uploaded. \(error.userMessage)"
                // Drop what was uploaded so a retry doesn't create duplicates.
                if !ids.isEmpty {
                    if !pages.isEmpty { pages = [] }
                    let uploadedPDFs = max(0, ids.count - (items.count - importedPDFs.count))
                    importedPDFs.removeFirst(min(uploadedPDFs, importedPDFs.count))
                }
                return
            }
        }
        onUploaded(ids)
        dismiss()
    }
}
