import Foundation

indirect enum JSONValue: Codable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode([String: JSONValue].self) { self = .object(decoded) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .bool(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }
    subscript(_ key: String) -> JSONValue? { if case .object(let item) = self { return item[key] }; return nil }
    var string: String? { if case .string(let item) = self { return item }; return nil }
    var int: Int? { if case .number(let item) = self, item.isFinite, item.rounded() == item, item >= Double(Int.min), item < Double(Int.max) { return Int(item) }; return nil }
    var bool: Bool? { if case .bool(let item) = self { return item }; return nil }
    var object: [String: JSONValue]? { if case .object(let item) = self { return item }; return nil }
    var array: [JSONValue]? { if case .array(let item) = self { return item }; return nil }
}

struct Timing: Codable, Equatable {
    var state: String
    var medianMs: Double?
    var amberAfterMs: Double?
    var samples: Int
    var commandDeadlineAt: String?
}
struct Kill: Codable, Equatable { var allowed: Bool; var reason: String? }
struct Operation: Codable, Equatable, Identifiable {
    var id: String
    var kind: String
    var repo: String
    var commitId: String
    var submittedBy: String
    var status: String
    var stage: String
    var submittedAt: String
    var lastSeq: Int
    var changeId: String?
    var environment: String?
    var stageStartedAt: String?
    var finishedAt: String?
    var result: JSONValue?
    var timing: Timing?
    var kill: Kill?
    var position: Int?
    var waitingFor: String?
    var promotion: JSONValue?
}
struct Held: Codable, Equatable { var repo: String; var commitId: String; var since: String; var reason: String; var retries: Int }
struct Pause: Codable, Equatable { var by: String; var at: String }
struct Lanes: Codable, Equatable { var serial: [Operation]; var deploy: [Operation] }
struct Snapshot: Codable, Equatable {
    var version: Int
    var runner: String
    var seq: Int
    var observedAt: String
    var lanes: Lanes
    var paused: Pause?
    var held: [Held]
    var recentReleases: [Operation]
    var lastStagingDeploys: [Operation]
    var recentProductionDeploys: [Operation]?
    var lastSuite: JSONValue
    var operations: [Operation] { lanes.serial + lanes.deploy + recentReleases + lastStagingDeploys + (recentProductionDeploys ?? []) }
}
struct StoredEvent: Codable, Equatable {
    var seq: Int
    var operationId: String
    var at: String
    var event: JSONValue
    var type: String { event["type"]?.string ?? "unknown" }
}
enum WatchEnvelope: Codable, Equatable {
    case snapshot(Snapshot), event(StoredEvent), heartbeat(at: String, seq: Int), connection(state: String, cursor: Int), unknown(String)
    private enum Keys: String, CodingKey { case version, type, snapshot, event, at, seq, state, cursor }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        let version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Unsupported watch protocol version") }
        let type = try values.decode(String.self, forKey: .type)
        switch type {
        case "snapshot": self = .snapshot(try values.decode(Snapshot.self, forKey: .snapshot))
        case "event": self = .event(try values.decode(StoredEvent.self, forKey: .event))
        case "heartbeat": self = .heartbeat(at: try values.decode(String.self, forKey: .at), seq: try values.decode(Int.self, forKey: .seq))
        case "connection": self = .connection(state: try values.decode(String.self, forKey: .state), cursor: try values.decode(Int.self, forKey: .cursor))
        default: self = .unknown(type)
        }
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: Keys.self)
        try values.encode(1, forKey: .version)
        switch self {
        case .snapshot(let value): try values.encode("snapshot", forKey: .type); try values.encode(value, forKey: .snapshot)
        case .event(let value): try values.encode("event", forKey: .type); try values.encode(value, forKey: .event)
        case .heartbeat(let at, let seq): try values.encode("heartbeat", forKey: .type); try values.encode(at, forKey: .at); try values.encode(seq, forKey: .seq)
        case .connection(let state, let cursor): try values.encode("connection", forKey: .type); try values.encode(state, forKey: .state); try values.encode(cursor, forKey: .cursor)
        case .unknown(let type): try values.encode(type, forKey: .type)
        }
    }
}

struct RunnerState {
    var startedAt: Date
    init(now: Date = Date(), lastContact: Date? = nil, startedAt: Date? = nil, cursor: Int? = nil) {
        self.startedAt = startedAt ?? now; self.lastContact = lastContact; self.cursor = cursor ?? 0
    }
    var snapshot: Snapshot?
    var operations: [String: Operation] = [:]
    var connection = "connecting"
    var lastContact: Date?
    var lastEvent: StoredEvent?
    var cursor = 0

    mutating func consume(line: String, receivedAt: Date) throws {
        try consume(JSONDecoder().decode(WatchEnvelope.self, from: Data(line.utf8)), receivedAt: receivedAt)
    }
    mutating func consume(_ envelope: WatchEnvelope, receivedAt: Date) {
        lastEvent = nil
        switch envelope {
        case .snapshot(let value):
            snapshot = value
            for operation in value.operations { operations[operation.id] = operation }
            lastContact = receivedAt
        case .event(let value):
            lastContact = receivedAt
            guard value.seq > cursor else { return }
            cursor = value.seq
            lastEvent = value
            if value.type == "submitted", let repo = value.event["repo"]?.string, let commit = value.event["commitId"]?.string {
                operations[value.operationId] = Operation(id: value.operationId, kind: value.event["kind"]?.string ?? "landing", repo: repo, commitId: commit, submittedBy: value.event["submittedBy"]?.string ?? "unknown", status: "queued", stage: "queued", submittedAt: value.at, lastSeq: value.seq, changeId: value.event["changeId"]?.string, environment: value.event["environment"]?.string, promotion: value.event["promotion"])
            } else if var operation = operations[value.operationId] {
                operation.lastSeq = value.seq
                if value.type == "stage", let stage = value.event["stage"]?.string { operation.stage = stage }
                if ["landed", "released", "deployed", "reset", "failed", "declined", "superseded", "cancelled"].contains(value.type) {
                    operation.status = value.type; operation.result = value.event; operation.finishedAt = value.at
                }
                operations[value.operationId] = operation
            }
        case .heartbeat: lastContact = receivedAt
        case .connection(let state, let baseline):
            connection = state
            if state == "connected" { cursor = baseline }
        case .unknown: break
        }
        let protected = Set(snapshot?.operations.map(\.id) ?? [])
        let retained = Set(operations.values.filter { !protected.contains($0.id) }.sorted { $0.lastSeq > $1.lastSeq }.prefix(256).map(\.id))
        operations = operations.filter { protected.contains($0.key) || retained.contains($0.key) }
    }
}
