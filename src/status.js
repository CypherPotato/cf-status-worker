export const incidentQuery = `
WITH report_gaps AS (
  SELECT *, LAG(reported_at) OVER (PARTITION BY component, class ORDER BY reported_at, id) AS previous_at
  FROM reports WHERE reported_at >= ?1
), report_groups AS (
  SELECT *, SUM(CASE WHEN previous_at IS NULL OR reported_at - previous_at >= ?2 THEN 1 ELSE 0 END)
    OVER (PARTITION BY component, class ORDER BY reported_at, id) AS episode
  FROM report_gaps
), report_incidents AS (
  SELECT component, class, 'report' AS source, MIN(reported_at) AS started_at,
    MAX(reported_at) AS last_at, MAX(reported_at) + ?2 AS resolved_at, COUNT(*) AS count
  FROM report_groups GROUP BY component, class, episode
), check_recoveries AS (
  SELECT *, MIN(CASE WHEN ok = 1 THEN checked_at END) OVER (
    PARTITION BY component ORDER BY checked_at ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
  ) AS recovery_at
  FROM checks WHERE checked_at >= ?1
), ping_incidents AS (
  SELECT component, 'Health check' AS class, 'ping' AS source, MIN(checked_at) AS started_at,
    MAX(checked_at) AS last_at, recovery_at AS resolved_at, COUNT(*) AS count
  FROM check_recoveries WHERE ok = 0 GROUP BY component, recovery_at
), incidents AS (
  SELECT * FROM report_incidents UNION ALL SELECT * FROM ping_incidents
)
SELECT * FROM incidents`;

export async function purge(db, cutoff) {
  await db.batch([
    db.prepare('DELETE FROM checks WHERE checked_at < ?').bind(cutoff),
    db.prepare('DELETE FROM reports WHERE reported_at < ?').bind(cutoff),
    db.prepare('DELETE FROM monitor_state WHERE claimed_at < ?').bind(cutoff)
  ]);
}

export async function readStatus(db, config, now, historyOffset = 0, historyOnly = false) {
  const cutoff = now - config.spanMs;
  const names = config.components.map(component => component.label.name);
  const filter = `component IN (${names.map(() => '?').join(',')})`;
  const historyStatement = db.prepare(`${incidentQuery}
    WHERE ${filter} ORDER BY started_at DESC, component, source, class LIMIT 51 OFFSET ?`)
    .bind(cutoff, config.clearMs, ...names, historyOffset);
  const historyResult = await historyStatement.all();
  const history = historyResult.results.slice(0, 50).map(incident => ({
    ...incident,
    resolved_at: incident.resolved_at !== null && incident.resolved_at <= now ? incident.resolved_at : null,
    severity: incident.source === 'ping' || incident.count >= config.elevatedAfter ? 'elevated' : 'reported'
  }));
  const historyPage = { items: history, nextOffset: historyResult.results.length > 50 ? historyOffset + 50 : null };
  if (historyOnly) return historyPage;

  const start = Math.floor(cutoff / config.tickMs) * config.tickMs;
  const [checkTicks, reportTicks, latestChecks, activeIncidents, reportDurations, latencyDays, telegramBot] = await db.batch([
    db.prepare(`SELECT component, CAST(checked_at / ? AS INTEGER) * ? AS bucket,
      COUNT(*) AS total, SUM(ok) AS successful, AVG(latency_ms) AS latency_ms
      FROM checks WHERE checked_at >= ? GROUP BY component, bucket`)
      .bind(config.tickMs, config.tickMs, cutoff),
    db.prepare(`WITH counts AS (
      SELECT component, CAST(reported_at / ? AS INTEGER) * ? AS bucket, class,
        COUNT(*) AS count, MAX(reported_at) AS last_at
      FROM reports WHERE reported_at >= ? GROUP BY component, bucket, class
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY component, bucket ORDER BY count DESC, last_at DESC, class) AS rank
      FROM counts
    ) SELECT * FROM ranked WHERE rank <= 3`)
      .bind(config.tickMs, config.tickMs, cutoff),
    db.prepare(`SELECT c.* FROM checks c JOIN (
      SELECT component, MAX(checked_at) AS checked_at FROM checks WHERE checked_at >= ? GROUP BY component
    ) latest USING (component, checked_at)`).bind(cutoff),
    db.prepare(`${incidentQuery} WHERE (resolved_at IS NULL OR resolved_at > ?) AND ${filter}
      ORDER BY started_at DESC, component, source, class`).bind(cutoff, config.clearMs, now, ...names),
    db.prepare(`WITH intervals AS (
      SELECT component, reported_at, LEAD(reported_at) OVER (
        PARTITION BY component ORDER BY reported_at, id
      ) AS next_at FROM reports WHERE reported_at >= ?1 AND reported_at <= ?2
    ) SELECT component, SUM(MAX(0, MIN(COALESCE(next_at, ?2), reported_at + ?3, ?2) - reported_at)) AS affected_ms
      FROM intervals GROUP BY component`).bind(cutoff, now, config.clearMs),
    db.prepare(`WITH ranked AS (
      SELECT CAST(checked_at / 86400000 AS INTEGER) * 86400000 AS day, latency_ms,
        ROW_NUMBER() OVER (PARTITION BY CAST(checked_at / 86400000 AS INTEGER) ORDER BY latency_ms) AS position,
        COUNT(*) OVER (PARTITION BY CAST(checked_at / 86400000 AS INTEGER)) AS total
      FROM checks WHERE checked_at >= ? AND ok = 1 AND ${filter}
    ) SELECT day, total AS checks,
      MIN(CASE WHEN position >= total * 0.50 THEN latency_ms END) AS p50,
      MIN(CASE WHEN position >= total * 0.95 THEN latency_ms END) AS p95,
      MIN(CASE WHEN position >= total * 0.99 THEN latency_ms END) AS p99
      FROM ranked GROUP BY day ORDER BY day`).bind(cutoff, ...names),
    ...(config.telegram ? [db.prepare('SELECT username FROM telegram_bots WHERE bot_id = ?').bind(config.telegram.botId)] : [])
  ]);
  const telegramUsername = telegramBot?.results[0]?.username;

  const active = activeIncidents.results.filter(incident => incident.source === 'report' ||
    config.components.some(component => component.label.name === incident.component && component.ping)).map(incident => ({
    ...incident, resolved_at: null,
    severity: incident.source === 'ping' || incident.count >= config.elevatedAfter ? 'elevated' : 'reported'
  }));
  const components = config.components.map(({ label, ping }) => {
    const lastCheck = ping ? latestChecks.results.find(check => check.component === label.name) ?? null : null;
    const current = active.filter(incident => incident.component === label.name && (ping || incident.source === 'report'));
    const affectedMs = reportDurations.results.find(row => row.component === label.name)?.affected_ms ?? 0;
    const stale = Boolean(ping && (!lastCheck || now - lastCheck.checked_at > ping.intervalMs + 120000));
    const ticks = [];
    let successful = 0;
    let total = 0;
    let latency = 0;
    for (let time = start; time <= now; time += config.tickMs) {
      const check = ping ? checkTicks.results.find(row => row.component === label.name && row.bucket === time) : null;
      const issues = reportTicks.results.filter(row => row.component === label.name && row.bucket === time)
        .map(row => ({ class: row.class, count: row.count, severity: row.count >= config.elevatedAfter ? 'elevated' : 'reported' }));
      successful += check?.successful ?? 0;
      total += check?.total ?? 0;
      latency += (check?.latency_ms ?? 0) * (check?.total ?? 0);
      const failed = check ? check.total - check.successful : 0;
      ticks.push({
        start: Math.max(time, cutoff), end: Math.min(time + config.tickMs, now),
        status: failed || issues.some(issue => issue.severity === 'elevated') ? 'elevated' :
          issues.length ? 'reported' : check || !ping ? 'operational' : 'unknown',
        checks: check?.total ?? 0, failed,
        latencyMs: check ? Math.round(check.latency_ms) : null,
        issues
      });
    }
    return {
      ...label, monitoring: ping ? 'ping' : 'reports', stale,
      status: current.some(incident => incident.severity === 'elevated') ? 'elevated' :
        current.length ? 'reported' : stale ? 'unknown' : 'operational',
      uptime: ping ? (total ? successful / total * 100 : null) : (1 - affectedMs / config.spanMs) * 100,
      latencyMs: total ? Math.round(latency / total) : null,
      lastCheck: lastCheck ? { at: lastCheck.checked_at, ok: Boolean(lastCheck.ok), latencyMs: lastCheck.latency_ms, statusCode: lastCheck.status_code } : null,
      ticks
    };
  });
  return {
    generatedAt: now, windowStart: cutoff, tickMs: config.tickMs, spanMs: config.spanMs,
    clearMs: config.clearMs, elevatedAfter: config.elevatedAfter,
    branding: config.branding, groups: config.groups, components, active, history: historyPage,
    latency: latencyDays.results,
    telegram: telegramUsername ? { url: `https://t.me/${telegramUsername}` } : null
  };
}
