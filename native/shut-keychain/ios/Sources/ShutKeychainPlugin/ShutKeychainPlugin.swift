import Foundation
import Capacitor
import LocalAuthentication
import Security

/// Хранит ключ сейфа (32 байта AES) в iOS Keychain.
/// Запись доступна ТОЛЬКО после Face ID / Touch ID (.biometryCurrentSet):
///  - если в телефон добавят новое лицо/палец — запись становится недействительной;
///  - без кода-пароля на телефоне запись не создаётся (WhenPasscodeSetThisDeviceOnly);
///  - в резервные копии iCloud / на другие устройства запись не попадает (ThisDeviceOnly).
/// Мастер-пароль сюда не попадает никогда.
@objc(ShutKeychainPlugin)
public class ShutKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShutKeychainPlugin"
    public let jsName = "ShutKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "app.shut.wallet.vaultkey"

    private func baseQuery(_ id: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id
        ]
    }

    /// Есть ли биометрия на устройстве и сохранён ли ключ для профиля (без запроса Face ID).
    @objc func status(_ call: CAPPluginCall) {
        let ctx = LAContext()
        var err: NSError?
        let available = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        var type = "none"
        switch ctx.biometryType {
        case .faceID: type = "faceId"
        case .touchID: type = "touchId"
        default: type = "none"
        }
        var has = false
        if let id = call.getString("id"), !id.isEmpty {
            let probe = LAContext()
            probe.interactionNotAllowed = true
            var q = baseQuery(id)
            q[kSecUseAuthenticationContext as String] = probe
            q[kSecReturnAttributes as String] = true
            let st = SecItemCopyMatching(q as CFDictionary, nil)
            has = (st == errSecSuccess || st == errSecInteractionNotAllowed)
        }
        call.resolve(["available": available, "type": type, "has": has])
    }

    /// Сохраняет ключ (base64) под защитой биометрии. Face ID при сохранении не спрашивается.
    @objc func save(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty,
              let b64 = call.getString("key"), let data = Data(base64Encoded: b64), data.count == 32 else {
            call.reject("bad arguments", "args"); return
        }
        var acErr: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil,
                kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &acErr) else {
            call.reject("access control unavailable (no passcode?)", "nopasscode"); return
        }
        SecItemDelete(baseQuery(id) as CFDictionary)
        var q = baseQuery(id)
        q[kSecValueData as String] = data
        q[kSecAttrAccessControl as String] = access
        let st = SecItemAdd(q as CFDictionary, nil)
        if st == errSecSuccess { call.resolve() } else { call.reject("keychain error \(st)", "keychain") }
    }

    /// Достаёт ключ — iOS сам покажет Face ID / Touch ID.
    @objc func load(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("bad arguments", "args"); return }
        let reason = call.getString("reason") ?? "Открыть сейф"
        DispatchQueue.global(qos: .userInitiated).async {
            let ctx = LAContext()
            ctx.localizedReason = reason
            ctx.localizedFallbackTitle = "" // без кнопки «Ввести код-пароль»: запасной путь — мастер-пароль
            var q = self.baseQuery(id)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            q[kSecUseAuthenticationContext as String] = ctx
            var out: CFTypeRef?
            let st = SecItemCopyMatching(q as CFDictionary, &out)
            switch st {
            case errSecSuccess:
                guard let data = out as? Data else { call.reject("empty", "keychain"); return }
                call.resolve(["key": data.base64EncodedString()])
            case errSecUserCanceled:
                call.reject("cancelled", "cancel")
            case errSecItemNotFound:
                call.reject("not found", "notfound")
            case errSecAuthFailed:
                call.reject("auth failed", "failed")
            default:
                call.reject("keychain error \(st)", "keychain")
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("bad arguments", "args"); return }
        SecItemDelete(baseQuery(id) as CFDictionary)
        call.resolve()
    }
}
