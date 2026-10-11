import Carbon.HIToolbox
import Foundation

/// Global hotkey via Carbon RegisterEventHotKey (no Accessibility permission needed).
/// Default: ⌃⇧⌘2 — avoids the system's ⌘⇧3 / ⌘⇧4 screenshot shortcuts.
final class HotKey {
    nonisolated(unsafe) private static var action: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    /// Carbon results, recorded instead of assumed (noErr = registered).
    private(set) var handlerStatus: OSStatus = noErr
    private(set) var registerStatus: OSStatus = noErr
    var isRegistered: Bool { handlerStatus == noErr && registerStatus == noErr && hotKeyRef != nil }

    static let displayString = "⌃⇧⌘2"

    init(keyCode: UInt32 = UInt32(kVK_ANSI_2),
         modifiers: UInt32 = UInt32(controlKey | shiftKey | cmdKey),
         action: @escaping () -> Void) {
        HotKey.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { HotKey.action?() }
            return noErr
        }, 1, &spec, nil, &handlerRef)
        let id = EventHotKeyID(signature: OSType(0x434D_5333), id: 1) // "CMS3"
        registerStatus = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
