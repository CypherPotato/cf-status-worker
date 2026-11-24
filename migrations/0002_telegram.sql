CREATE TABLE telegram_bots (
    bot_id INTEGER PRIMARY KEY,
    username TEXT,
    update_offset INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE telegram_subscribers (
    bot_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    subscribed_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, chat_id)
);

CREATE TABLE telegram_incidents (
    component TEXT NOT NULL,
    source TEXT NOT NULL,
    class TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (component, source, class)
);
