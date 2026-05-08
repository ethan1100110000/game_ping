import SwiftUI

@main
struct GamePingApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = PingStore()
    @StateObject private var deviceRegistration = DeviceRegistrationManager.shared
    @StateObject private var settings = AppSettings.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(deviceRegistration)
                .environmentObject(settings)
        }
    }
}
