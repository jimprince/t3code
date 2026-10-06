import AppKit
import Darwin
import Foundation

private let sampleIntervalSeconds = 5.0
private let sustainedSampleCount = 3
private let notificationCooldownSeconds = 10.0 * 60.0
private let processCapacity = 4096

private struct Configuration {
  let settingsPath: String
  let statePath: String
  let recoveryURL: URL

  static func parse() -> Configuration? {
    var values: [String: String] = [:]
    var index = 1
    while index + 1 < CommandLine.arguments.count {
      values[CommandLine.arguments[index]] = CommandLine.arguments[index + 1]
      index += 2
    }
    guard
      let settingsPath = values["--settings-path"],
      let statePath = values["--state-path"],
      let rawRecoveryURL = values["--recovery-url"],
      let recoveryURL = URL(string: rawRecoveryURL)
    else {
      return nil
    }
    return Configuration(
      settingsPath: settingsPath,
      statePath: statePath,
      recoveryURL: recoveryURL
    )
  }
}

private struct ProcessSnapshot: Codable {
  let pid: Int32
  let uid: UInt32
  let name: String
  let cpuPercent: Double
  let recoverable: Bool
}

private struct IncidentSnapshot: Codable {
  let version: Int
  let incidentId: String
  let detectedAt: String
  let hostCpuPercent: Double
  let reason: String
  let processes: [ProcessSnapshot]
  let recoveryURL: String
}

private final class NotificationDelegate: NSObject, NSUserNotificationCenterDelegate {
  private let recoveryURL: URL

  init(recoveryURL: URL) {
    self.recoveryURL = recoveryURL
  }

  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    shouldPresent notification: NSUserNotification
  ) -> Bool {
    return true
  }

  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    didActivate notification: NSUserNotification
  ) {
    if notification.activationType == .actionButtonClicked ||
      notification.activationType == .contentsClicked {
      NSWorkspace.shared.open(recoveryURL)
    }
  }
}

private final class PressureMonitor {
  private let configuration: Configuration
  private let notificationDelegate: NotificationDelegate
  private var previousHost: T3HostCpuSample?
  private var previousProcesses: [Int32: UInt64] = [:]
  private var consecutivePressureSamples = 0
  private var lastNotificationAt: Date?

  init(configuration: Configuration) {
    self.configuration = configuration
    self.notificationDelegate = NotificationDelegate(recoveryURL: configuration.recoveryURL)
    NSUserNotificationCenter.default.delegate = notificationDelegate
  }

  func start() {
    sample()
    Timer.scheduledTimer(withTimeInterval: sampleIntervalSeconds, repeats: true) {
      [weak self] _ in self?.sample()
    }
    RunLoop.main.run()
  }

  private func notificationsEnabled() -> Bool {
    guard
      let data = FileManager.default.contents(atPath: configuration.settingsPath),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let configured = object["systemPressureNotificationsEnabled"] as? Bool
    else {
      return true
    }
    return configured
  }

  private func sample() {
    guard notificationsEnabled() else {
      consecutivePressureSamples = 0
      return
    }

    var host = T3HostCpuSample()
    guard t3_sample_host_cpu(&host) == 1 else {
      return
    }

    var rawProcesses = Array(
      repeating: T3ProcessSample(),
      count: processCapacity
    )
    let processCount = rawProcesses.withUnsafeMutableBufferPointer { buffer in
      t3_sample_processes(buffer.baseAddress, Int32(buffer.count))
    }
    let now = Date()
    defer {
      previousHost = host
      previousProcesses = Dictionary(
        uniqueKeysWithValues: rawProcesses.prefix(Int(processCount)).map {
          ($0.pid, $0.cpu_nanos)
        }
      )
    }

    guard let priorHost = previousHost else {
      return
    }

    let busyDelta =
      delta(host.user, priorHost.user) +
      delta(host.system, priorHost.system) +
      delta(host.nice, priorHost.nice)
    let idleDelta = delta(host.idle, priorHost.idle)
    let totalDelta = busyDelta + idleDelta
    let hostCpuPercent = totalDelta == 0
      ? 0
      : Double(busyDelta) / Double(totalDelta) * 100.0

    let currentUID = UInt32(getuid())
    let processSnapshots = rawProcesses.prefix(Int(processCount)).compactMap { process
      -> ProcessSnapshot? in
      guard let previousCpu = previousProcesses[process.pid] else {
        return nil
      }
      let cpuDelta = delta(process.cpu_nanos, previousCpu)
      let cpuPercent = Double(cpuDelta) /
        (sampleIntervalSeconds * 1_000_000_000.0) * 100.0
      guard cpuPercent >= 1 else {
        return nil
      }
      return ProcessSnapshot(
        pid: process.pid,
        uid: process.uid,
        name: withUnsafePointer(to: process.name) {
          $0.withMemoryRebound(to: CChar.self, capacity: 256) {
            String(cString: $0)
          }
        },
        cpuPercent: cpuPercent,
        recoverable: process.uid == currentUID
      )
    }
    .sorted { $0.cpuPercent > $1.cpuPercent }

    let securityCpuPercent = processSnapshots
      .filter { $0.name == "syspolicyd" || $0.name == "trustd" }
      .reduce(0) { $0 + $1.cpuPercent }
    let isUnderPressure = hostCpuPercent >= 85 || securityCpuPercent >= 75
    consecutivePressureSamples = isUnderPressure ? consecutivePressureSamples + 1 : 0

    guard consecutivePressureSamples >= sustainedSampleCount else {
      return
    }
    if let last = lastNotificationAt,
       now.timeIntervalSince(last) < notificationCooldownSeconds {
      return
    }

    let reason = securityCpuPercent >= 75
      ? "macOS security validation is consuming sustained CPU"
      : "system CPU usage has remained critically high"
    let incident = IncidentSnapshot(
      version: 1,
      incidentId: UUID().uuidString,
      detectedAt: ISO8601DateFormatter().string(from: now),
      hostCpuPercent: hostCpuPercent,
      reason: reason,
      processes: Array(processSnapshots.prefix(8)),
      recoveryURL: configuration.recoveryURL.absoluteString
    )
    writeIncident(incident)
    postNotification(incident)
    lastNotificationAt = now
  }

  private func writeIncident(_ incident: IncidentSnapshot) {
    let destination = URL(fileURLWithPath: configuration.statePath)
    do {
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      let data = try JSONEncoder().encode(incident)
      try data.write(to: destination, options: .atomic)
    } catch {
      // The monitor is deliberately best-effort and never writes a growing log.
    }
  }

  private func postNotification(_ incident: IncidentSnapshot) {
    let topNames = incident.processes.prefix(3).map {
      "\($0.name) \(Int($0.cpuPercent.rounded()))%"
    }.joined(separator: ", ")
    let notification = NSUserNotification()
    notification.title = "T3 Code detected sustained system pressure"
    notification.informativeText = topNames.isEmpty
      ? incident.reason
      : "\(incident.reason.capitalized). \(topNames)"
    notification.hasActionButton = true
    notification.actionButtonTitle = "Review Recovery"
    notification.otherButtonTitle = "Dismiss"
    notification.soundName = nil
    NSUserNotificationCenter.default.deliver(notification)
  }

  private func delta(_ current: UInt64, _ previous: UInt64) -> UInt64 {
    return current >= previous ? current - previous : 0
  }
}

guard let configuration = Configuration.parse() else {
  FileHandle.standardError.write(
    Data("Missing pressure monitor arguments.\n".utf8)
  )
  exit(64)
}

PressureMonitor(configuration: configuration).start()
