import Foundation

@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()
    nonisolated static let serverURLKey = "gameping.settings.serverURL"
    nonisolated static let apiTokenKey = "gameping.settings.apiToken"
    nonisolated static let defaultServerURL = "http://127.0.0.1:8787"

    @Published private(set) var serverURLString: String
    @Published private(set) var apiToken: String

    private init() {
        let defaults = UserDefaults.standard
        serverURLString = defaults.string(forKey: Self.serverURLKey) ?? Self.defaultServerURL
        apiToken = defaults.string(forKey: Self.apiTokenKey) ?? ""
    }

    func update(serverURLString: String, apiToken: String) {
        let cleanURL = normalizeServerURL(serverURLString)
        let cleanToken = apiToken.trimmingCharacters(in: .whitespacesAndNewlines)

        self.serverURLString = cleanURL
        self.apiToken = cleanToken

        UserDefaults.standard.set(cleanURL, forKey: Self.serverURLKey)
        UserDefaults.standard.set(cleanToken, forKey: Self.apiTokenKey)
    }

    func resetToLocalhost() {
        update(serverURLString: Self.defaultServerURL, apiToken: apiToken)
    }

    nonisolated static func persistedServerURLString() -> String {
        UserDefaults.standard.string(forKey: serverURLKey) ?? defaultServerURL
    }

    nonisolated static func persistedAPIToken() -> String {
        UserDefaults.standard.string(forKey: apiTokenKey) ?? ""
    }

    private func normalizeServerURL(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = trimmed.isEmpty ? Self.defaultServerURL : trimmed
        return fallback.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
