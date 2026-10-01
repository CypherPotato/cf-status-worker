CREATE TABLE checks (
    component TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    latency_ms INTEGER NOT NULL,
    status_code INTEGER,
    PRIMARY KEY (component, checked_at)
);
CREATE INDEX checks_retention ON checks (checked_at);

CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component TEXT NOT NULL,
    class TEXT NOT NULL,
    reported_at INTEGER NOT NULL
);
CREATE INDEX reports_component_class_time ON reports (component, class, reported_at);
CREATE INDEX reports_retention ON reports (reported_at);

CREATE TABLE monitor_state (
    component TEXT PRIMARY KEY,
    next_check_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL
);
CREATE INDEX monitor_state_retention ON monitor_state (claimed_at);
