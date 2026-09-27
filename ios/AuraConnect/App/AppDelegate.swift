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
        // v4: lock-screen actions (Acknowledge / Reply / Mark read).
        NotificationCategories.register()
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
    /// v4 lock-screen actions run in the background; the completion handler is called only
    /// after the work finishes. When it can't be done (signed out, missing ids, write failed)
    /// the deep link is queued so the conversation or alert opens with the app.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let request = NotificationActionRequest(response: response) {
            Task { @MainActor in
                let backgroundTask = BackgroundTaskToken()
                backgroundTask.begin(name: "AuraNotificationAction")
                let outcome = await NotificationActionHandler.perform(request)
                if outcome == .openApp {
                    if let push = request.push {
                        Router.shared.handleNotificationTap(push)
                    }
                    await NotificationActionHandler.postFallbackNotice(for: request)
                }
                completionHandler()
                backgroundTask.end()
            }
            return
        }
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
