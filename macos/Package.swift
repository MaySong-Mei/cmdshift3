// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "CmdShift3",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "CmdShift3",
            path: "Sources/CmdShift3",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("Carbon")]
        )
    ]
)
