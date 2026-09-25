import UIKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

/// Push wiring. `FirebaseAppDelegateProxyEnabled` is false, so the APNs token is handed to
/// FCM manually. Notification content is generic by design (no PHI); the app fetches the
/// real content after authentication, so no Notification Service Extension is needed.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        FirebaseService.configure()
        SecureDownload.removeAll()
        UNUserNotificationCenter.current().delegate = self
        if FirebaseService.isConfigured {
            Messaging.messaging().delegate = self
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseService.isConfigured else { return }
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[Push] APNs registration failed: \(error.localizedDescription)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        if FirebaseService.isConfigured {
            _ = Messaging.messaging().appDidReceiveMessage(userInfo)
        }
        completionHandler(.noData)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// Show banners while the app is in the foreground (content is PHI-free).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// Notification tap: deep-link to the chat or alert once the session is ready.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let push = PushData(userInfo: response.notification.request.content.userInfo)
        if let push {
            Task { @MainActor in
                Router.shared.handleNotificationTap(push)
            }
        }
        completionHandler()
    }
}

// MARK: - MessagingDelegate

extension AppDelegate: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in
            PushTokenRegistrar.shared.tokenDidChange(fcmToken)
        }
    }
}
