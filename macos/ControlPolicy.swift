import Foundation

/// The native UI owns this confirmation state; commands remain existing CLI actions.
struct ControlPolicy {
    private(set) var pendingCancellation: Operation?
    private(set) var pendingKill: Operation?
    /// Why the last confirmation sent no command, for the menu to show in its place.
    private(set) var refusal: String?

    @discardableResult
    mutating func requestCancellation(_ operation: Operation) -> Bool {
        guard operation.status == "queued" else { return false }
        pendingCancellation = operation
        refusal = nil
        return true
    }

    mutating func dismissCancellation() { pendingCancellation = nil }

    /// Confirmation cannot authorise a different operation or one that has started.
    mutating func confirmCancellation(current: Operation?) -> [String]? {
        defer { pendingCancellation = nil }
        guard let pending = pendingCancellation, let current, current.id == pending.id else { return nil }
        guard current.status == "queued" else {
            refusal = Self.alreadyStarted(current.kind)
            return nil
        }
        return ["cancel", current.id]
    }

    @discardableResult
    mutating func requestKill(_ operation: Operation) -> Bool {
        guard Self.killCommand(for: operation) != nil else { return false }
        pendingKill = operation
        refusal = nil
        return true
    }

    mutating func dismissKill() { pendingKill = nil }

    /// A kill names the operation it was confirmed for, and only while that one is still killable.
    mutating func confirmKill(current: Operation?) -> [String]? {
        defer { pendingKill = nil }
        guard let pending = pendingKill, let current, current.id == pending.id else { return nil }
        guard let command = Self.killCommand(for: current) else {
            refusal = "\(current.kind) can no longer be killed: \(current.kill?.reason ?? current.status)"
            return nil
        }
        return command
    }

    /// What stops when this operation is killed, for its confirmation.
    static func killConsequence(_ operation: Operation) -> String {
        operation.kind == "release"
            ? "Verification of the release stops; nothing is published."
            : "Its \(operation.stage) stops and it ends cancelled; nothing is integrated."
    }

    static func killCommand(for operation: Operation?) -> [String]? {
        guard let operation, operation.status == "running", operation.kill?.allowed == true else { return nil }
        return ["runner", "kill", operation.id]
    }

    /// The error to show for a failed command: a cancel that lost the race to the runner says so.
    static func commandError(arguments: [String], output: String) -> String {
        if arguments.first == "cancel",
           let body = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any],
           let operation = body["operation"] as? [String: Any], let status = operation["status"] as? String, status != "queued" {
            return status == "running" ? alreadyStarted(operation["kind"] as? String ?? "operation") : "Not cancelled: it is already \(status)."
        }
        return output.isEmpty ? "SlipJay refused or failed this action; inspect the CLI runner log." : output
    }

    private static func alreadyStarted(_ kind: String) -> String { "Not cancelled: the \(kind) already started. Kill it instead while it verifies." }

    static func logCommand(operationId: String?) -> [String]? {
        guard let id = operationId, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id != "runner" else { return nil }
        return ["runner", "log", id]
    }
}
