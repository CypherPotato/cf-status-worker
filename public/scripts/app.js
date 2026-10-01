const tooltip = document.querySelector('#tick-tooltip');
const refreshButton = document.querySelector('#refresh');
const moreButton = document.querySelector('#load-more');
const errorMessage = document.querySelector('#connection-error');
const page = document.querySelector('.page');
const initialLoading = document.querySelector('#initial-loading');
const loadingSpinner = document.querySelector('#loading-spinner');
const initialError = document.querySelector('#initial-error');
const retryButton = document.querySelector('#initial-retry');
const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
let snapshot;
let historyItems = [];
let nextOffset = null;
let loading = false;
let tooltipTarget = null;
const mobileTicks = window.matchMedia('(max-width: 600px)');
const tickResizeObserver = new ResizeObserver(entries => {
  for (const { target: scroll } of entries) {
    const buttons = [...scroll.querySelector('.ticks').children];
    const visibleCount = mobileTicks.matches
      ? Math.max(1, Math.floor((scroll.clientWidth - 6 + 3) / 8))
      : buttons.length;
    const firstVisible = Math.max(0, buttons.length - visibleCount);
    buttons.forEach((button, index) => {
      if (index < firstVisible && document.activeElement === button) buttons.at(-1).focus();
      button.hidden = index < firstVisible;
      button.tabIndex = index === buttons.length - 1 ? 0 : -1;
    });
    if (tooltipTarget?.hidden) hideTooltip();
  }
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function incidentElement(incident) {
  const node = element('article', undefined, 'incident');
  const title = element('h3', undefined, `incident-title text-${incident.severity}`);
  title.append(element('span', '△', 'incident-symbol'), document.createTextNode(
    `${incident.severity === 'elevated' ? 'Elevated' : 'Reported'} issues with ${incident.class}`
  ));
  const component = snapshot.components.find(item => item.name === incident.component);
  const meta = element('div', undefined, 'incident-meta');
  meta.append(element('p', `${component?.title ?? incident.component} · ${incident.count} ${incident.source === 'ping' ? 'failed checks' : 'reports'}`));
  const state = element('p');
  state.append(element('span', incident.resolved_at ? 'Resolved' : 'Ongoing', incident.resolved_at ? 'incident-resolved' : `text-${incident.severity}`));
  meta.append(state);
  node.append(title, meta, element('p', `${timeFormat.format(incident.started_at)}${incident.resolved_at ? ` → ${timeFormat.format(incident.resolved_at)}` : ` · Last seen ${timeFormat.format(incident.last_at)}`}`));
  return node;
}

function hideTooltip() {
  tooltip.hidden = true;
  tooltipTarget?.removeAttribute('aria-describedby');
  tooltipTarget = null;
}

function showTooltip(button, tick) {
  hideTooltip();
  tooltipTarget = button;
  button.setAttribute('aria-describedby', 'tick-tooltip');
  tooltip.replaceChildren(element('h3', `${timeFormat.format(tick.start)} → ${timeFormat.format(tick.end)}`));
  if (tick.checks) {
    tooltip.append(element('p', `${((tick.checks - tick.failed) / tick.checks * 100).toFixed(2)}% check uptime · ${tick.latencyMs} ms average`));
    tooltip.append(element('small', `${tick.checks} checks · ${tick.failed} failed`));
  }
  if (tick.failed) tooltip.append(element('p', 'Elevated issues with Health check', 'text-elevated'));
  for (const issue of tick.issues) {
    tooltip.append(element('p', `${issue.severity === 'elevated' ? 'Elevated' : 'Reported'} issues with ${issue.class}`, `text-${issue.severity}`));
  }
  if (!tick.checks && !tick.issues.length && tick.status === 'unknown') tooltip.append(element('p', 'No observations in this period.'));
  else if (!tick.failed && !tick.issues.length) tooltip.append(element('p', 'No issues reported.', 'text-operational'));
  tooltip.hidden = false;
  const rect = button.getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - size.width / 2, innerWidth - size.width - 12))}px`;
  tooltip.style.top = `${Math.max(12, rect.bottom + size.height + 12 < innerHeight ? rect.bottom + 8 : rect.top - size.height - 8)}px`;
}

function renderHistory() {
  const target = document.querySelector('#history-items');
  target.replaceChildren(...historyItems.map(incidentElement));
  if (!historyItems.length) target.append(element('p', 'No incidents recorded in this period.', 'empty'));
  moreButton.hidden = nextOffset === null;
}

async function refresh() {
  if (loading || moreButton.disabled) return;
  const retryHadFocus = document.activeElement === retryButton;
  loading = true;
  refreshButton.disabled = true;
  retryButton.disabled = true;
  if (page.hidden) {
    initialLoading.setAttribute('aria-busy', 'true');
    loadingSpinner.hidden = false;
    initialError.hidden = true;
    retryButton.hidden = true;
  }
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Unable to retrieve status.');
    snapshot = await response.json();
    const branding = snapshot.branding ?? {};
    const title = branding.title ?? 'Worker Status';
    document.title = title;
    document.querySelectorAll('[data-brand-title]').forEach(node => { node.textContent = title; });
    document.querySelector('.wordmark').setAttribute('aria-label', `${title} home`);
    document.querySelector('meta[name="theme-color"]').content = branding.backgroundColor ?? '#fafbf9';
    const style = document.documentElement.style;
    const colors = {
      backgroundColor: ['--background'], foregroundColor: ['--foreground'],
      highlightColor: ['--highlight'], successColor: ['--green', '--tick-success'],
      warnColor: ['--orange', '--tick-warning'], dangerColor: ['--red', '--tick-danger']
    };
    for (const [field, variables] of Object.entries(colors)) {
      for (const variable of variables) {
        if (branding[field]) style.setProperty(variable, branding[field]);
        else style.removeProperty(variable);
      }
    }
    for (const [variable, value] of Object.entries({
      '--muted': 'color-mix(in srgb, var(--foreground) 65%, var(--background))',
      '--line': 'color-mix(in srgb, var(--foreground) 15%, var(--background))',
      '--surface': 'color-mix(in srgb, var(--foreground) 4%, var(--background))',
      '--unknown': 'color-mix(in srgb, var(--foreground) 18%, var(--background))',
      '--tooltip-background': 'var(--background)'
    })) {
      if (branding.backgroundColor || branding.foregroundColor) style.setProperty(variable, value);
      else style.removeProperty(variable);
    }
    hideTooltip();
    errorMessage.hidden = true;
    const degraded = snapshot.active.length > 0;
    const unknown = snapshot.components.some(component => component.status === 'unknown');
    const severity = snapshot.active.some(incident => incident.severity === 'elevated') ? 'elevated' : degraded ? 'reported' : unknown ? 'unknown' : 'operational';
    document.querySelector('#overall-dot').className = `status-dot ${severity}`;
    document.querySelector('#overview-title').textContent = degraded ? 'Some services are experiencing issues' : unknown ? 'No active incidents reported' : 'All services operational';
    document.querySelector('#overview-description').textContent = degraded
      ? `${snapshot.active.length} active incident${snapshot.active.length === 1 ? '' : 's'}. Details and affected services are listed below.`
      : unknown ? 'Some services have no recent health checks. See individual services for monitoring coverage.'
        : 'No active incidents. Services are stable based on health checks and incident reports.';
    document.querySelector('#updated').textContent = `Updated ${timeFormat.format(snapshot.generatedAt)}`;
    document.querySelector('#time-range').textContent = `${Math.round(snapshot.spanMs / 86400000 * 100) / 100} days · ${snapshot.tickMs / 3600000}h per tick`;
    document.querySelector('#history-range').textContent = `Since ${dateFormat.format(snapshot.windowStart)}`;
    document.querySelector('#active-section').hidden = !degraded;
    document.querySelector('#active-count').textContent = `${snapshot.active.length} ongoing`;
    document.querySelector('#active-incidents').replaceChildren(...snapshot.active.map(incidentElement));
    const groups = document.querySelector('#service-groups');
    tickResizeObserver.disconnect();
    groups.replaceChildren();
    for (const groupName of new Set(snapshot.components.map(component => component.group))) {
      const group = element('div', undefined, 'service-group');
      const metadata = snapshot.groups?.find(item => item.name === groupName);
      const groupHeader = element('div', undefined, 'group-header');
      groupHeader.append(element('h3', metadata?.label ?? groupName, 'group-title'));
      if (metadata?.description) groupHeader.append(element('p', metadata.description, 'group-description'));
      group.append(groupHeader);
      for (const component of snapshot.components.filter(item => item.group === groupName)) {
        const service = element('article', undefined, 'service');
        const heading = element('div', undefined, 'service-heading');
        const labels = { operational: 'Operational', reported: 'Reported issues', elevated: 'Elevated issues', unknown: 'Awaiting checks' };
        heading.append(element('h4', component.title), element('span', labels[component.status], `service-state text-${component.status}`));
        service.append(heading, element('p', component.description, 'service-description'));
        const scroll = element('div', undefined, 'tick-scroll');
        const ticks = element('div', undefined, 'ticks');
        ticks.setAttribute('role', 'group');
        ticks.setAttribute('aria-label', `${component.title} history. Use arrow keys to browse ticks.`);
        component.ticks.forEach((tick, index) => {
          const button = element('button', undefined, `tick ${tick.status}`);
          button.type = 'button';
          button.tabIndex = index === component.ticks.length - 1 ? 0 : -1;
          button.setAttribute('aria-label', `${component.title}, ${timeFormat.format(tick.start)}, ${tick.status === 'unknown' ? 'no data' : tick.status}`);
          button.addEventListener('pointerenter', () => showTooltip(button, tick));
          button.addEventListener('focus', () => showTooltip(button, tick));
          button.addEventListener('click', () => showTooltip(button, tick));
          button.addEventListener('blur', hideTooltip);
          button.addEventListener('keydown', event => {
            const buttons = [...ticks.children].filter(button => !button.hidden);
            const current = buttons.indexOf(button);
            let next;
            if (event.key === 'ArrowRight') next = Math.min(current + 1, buttons.length - 1);
            if (event.key === 'ArrowLeft') next = Math.max(current - 1, 0);
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = buttons.length - 1;
            if (next !== undefined) {
              event.preventDefault();
              for (const item of buttons) item.tabIndex = -1;
              buttons[next].tabIndex = 0;
              buttons[next].focus();
            }
          });
          ticks.append(button);
        });
        scroll.append(ticks);
        tickResizeObserver.observe(scroll);
        const foot = element('div', undefined, 'tick-footer');
        foot.append(element('span', `${dateFormat.format(snapshot.windowStart)} → Today`), element('span', component.uptime === null ? 'No check data' : `${component.uptime.toFixed(2)}% uptime${component.latencyMs === null ? '' : ` · ${component.latencyMs} ms avg`}`, 'metrics'));
        service.append(scroll, foot);
        if (component.stale) service.append(element('p', 'Health checks are overdue or have not started. Current availability is unverified.', 'service-description'));
        group.append(service);
      }
      groups.append(group);
    }
    historyItems = snapshot.history.items;
    nextOffset = snapshot.history.nextOffset;
    renderHistory();
    page.hidden = false;
    initialLoading.hidden = true;
    initialLoading.setAttribute('aria-busy', 'false');
  } catch {
    if (page.hidden) {
      initialLoading.setAttribute('aria-busy', 'false');
      loadingSpinner.hidden = true;
      initialError.hidden = false;
      retryButton.hidden = false;
      document.title = 'Status';
      document.querySelector('meta[name="theme-color"]').content = '#fafafa';
    } else {
      errorMessage.textContent = 'Could not refresh. Displayed data is outdated. Retry or check back shortly.';
      errorMessage.hidden = false;
      document.querySelector('#overall-dot').className = 'status-dot unknown';
      document.querySelector('#overview-title').textContent = 'Status updates interrupted';
      document.querySelector('#overview-description').textContent = 'We cannot confirm current service health while the status feed is unavailable.';
    }
  } finally {
    loading = false;
    refreshButton.disabled = false;
    retryButton.disabled = false;
    if (retryHadFocus) (page.hidden ? retryButton : refreshButton).focus();
  }
}

refreshButton.addEventListener('click', refresh);
retryButton.addEventListener('click', refresh);
moreButton.addEventListener('click', async () => {
  if (nextOffset === null || loading) return;
  moreButton.disabled = true;
  try {
    const response = await fetch(`/api/history?offset=${nextOffset}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('History unavailable.');
    const page = await response.json();
    for (const item of page.items) {
      if (!historyItems.some(existing => existing.component === item.component && existing.class === item.class && existing.source === item.source && existing.started_at === item.started_at)) historyItems.push(item);
    }
    nextOffset = page.nextOffset;
    renderHistory();
    errorMessage.hidden = true;
  } catch {
    errorMessage.textContent = 'Could not load earlier incidents. Please retry.';
    errorMessage.hidden = false;
  } finally {
    moreButton.disabled = false;
  }
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.tick') && !tooltip.contains(event.target)) hideTooltip();
});
document.addEventListener('pointermove', event => {
  if (!tooltip.hidden && !event.target.closest('.tick') && !tooltip.contains(event.target)) {
    const rect = tooltip.getBoundingClientRect();
    if (event.clientY < rect.top - 12 || event.clientY > rect.bottom + 12 || event.clientX < rect.left - 12 || event.clientX > rect.right + 12) hideTooltip();
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
window.addEventListener('resize', hideTooltip);
window.addEventListener('scroll', hideTooltip, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden && !tooltipTarget) refresh(); }, 60000);
refresh();
