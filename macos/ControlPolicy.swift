import Foundation

/// The native UI owns this confirmation state; commands remain existing CLI actions.
struct ControlPolicy {
    private(set) var pendingCancellation: Operation?

    @discardableResult
    mutating func requestCancellation(_ operation: Operation) -> Bool {
        guard operation.status == "queued" else { return false }
        pendingCancellation = operation
        return true
    }

    mutating func dismissCancellation() { pendingCancellation = nil }

    /// Confirmation cannot authorise a different operation or one that has started.
    mutating func confirmCancellation(current: Operation?) -> [String]? {
        defer { pendingCancellation = nil }
        guard let pending = pendingCancellation, let current,
              current.id == pending.id, current.status == "queued" else { return nil }
        return ["cancel", current.id]
    }

    static func killCommand(for operation: Operation?) -> [String]? {
        guard let operation, operation.status == "running", operation.kill?.allowed == true else { return nil }
        return ["runner", "kill"]
    }

    static func logCommand(operationId: String?) -> [String]? {
        guard let id = operationId, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id != "runner" else { return nil }
        return ["runner", "log", id]
    }
}
