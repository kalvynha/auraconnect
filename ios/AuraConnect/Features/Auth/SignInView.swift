import SwiftUI

struct SignInView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppLockManager.self) private var lock

    private enum Mode: String, CaseIterable, Identifiable {
        case signIn = "Sign in"
        case create = "Create account"
        var id: String { rawValue }
    }

    private enum Field: Hashable {
        case name, email, password
    }

    @State private var mode: Mode = .signIn
    @State private var displayName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var errorMessage: String? = nil
    @State private var infoMessage: String? = nil
    @FocusState private var focus: Field?

    init() {}

    private var canSubmit: Bool {
        guard email.nilIfBlank != nil, password.count >= 6, !isWorking else { return false }
        if mode == .create { return displayName.nilIfBlank != nil && password.count >= 8 }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "cross.case.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                        Text("AuraConnect")
                            .font(.largeTitle.weight(.bold))
                        Text("Secure hospice care team messaging")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section {
                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section {
                    if mode == .create {
                        TextField("Full name", text: $displayName)
                            .textContentType(.name)
                            .focused($focus, equals: .name)
                            .submitLabel(.next)
                            .onSubmit { focus = .email }
                    }
                    TextField("Work email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                    SecureField("Password", text: $password)
                        .textContentType(mode == .create ? UITextContentType.newPassword : UITextContentType.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                } footer: {
                    if mode == .create {
                        Text("Use at least 8 characters. Your administrator may require multi-factor authentication.")
                    }
                }

                if let errorMessage {
                    Section { ErrorBanner(message: errorMessage) }
                }
                if let infoMessage {
                    Section { Text(infoMessage).font(.footnote).foregroundStyle(.secondary) }
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking {
                                ProgressView()
                            } else {
                                Text(mode.rawValue).bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)

                    if mode == .signIn {
                        Button("Forgot password?") {
                            resetPassword()
                        }
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .disabled(email.nilIfBlank == nil || isWorking)
                    }
                }

                if FirebaseService.usingEmulators {
                    Section {
                        Label("Connected to local Firebase emulators", systemImage: "hammer")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: mode) { _, _ in
                errorMessage = nil
                infoMessage = nil
            }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        // Unlock before the auth state changes so the lock screen never flashes up
        // (and prompts for Face ID) right after a password sign-in.
        lock.didAuthenticateWithPassword()
        Task {
            do {
                switch mode {
                case .signIn:
                    try await session.signIn(email: email, password: password)
                case .create:
                    try await session.createAccount(email: email, password: password, displayName: displayName)
                }
            } catch {
                errorMessage = error.userMessage
            }
            isWorking = false
        }
    }

    private func resetPassword() {
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await session.sendPasswordReset(email: email)
                infoMessage = "If an account exists for \(email.trimmed), a reset link is on its way."
            } catch {
                errorMessage = error.userMessage
            }
            isWorking = false
        }
    }
}
