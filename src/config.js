export class ConfigValidationError extends Error {}

export function duration(value, path = 'duration') {
  const match = typeof value === 'string' && /^(\d+)(sec|min|hour|day)$/.exec(value);
  if (!match) throw new ConfigValidationError(`${path}: use a positive integer followed by sec, min, hour or day (for example, "15min").`);
  const result = Number(match[1]) * { sec: 1000, min: 60000, hour: 3600000, day: 86400000 }[match[2]];
  if (!Number.isSafeInteger(result) || result <= 0) throw new ConfigValidationError(`${path}: duration must be positive and within the supported integer range.`);
  return result;
}

export function parseConfig(raw) {
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigValidationError('config: expected a JSON object.');
  }
  const branding = {};
  if (config.branding !== undefined) {
    if (!config.branding || typeof config.branding !== 'object' || Array.isArray(config.branding)) {
      throw new ConfigValidationError('branding: expected an object.');
    }
    if (config.branding.title !== undefined) {
      if (typeof config.branding.title !== 'string' || !config.branding.title.trim() || config.branding.title.length > 200) {
        throw new ConfigValidationError('branding.title: expected a non-empty string of up to 200 characters.');
      }
      branding.title = config.branding.title;
    }
    const dark = config.branding.dark;
    if (dark !== undefined && (!dark || typeof dark !== 'object' || Array.isArray(dark))) {
      throw new ConfigValidationError('branding.dark: expected an object with dark theme colors.');
    }
    if (dark) branding.dark = {};
    for (const [source, target, path] of [[config.branding, branding, 'branding'], [dark, branding.dark, 'branding.dark']]) {
      if (!source) continue;
      for (const field of ['backgroundColor', 'foregroundColor', 'highlightColor', 'successColor', 'warnColor', 'dangerColor']) {
        const value = field === 'successColor' ? source.successColor ?? source.succcessColor : source[field];
        if (value !== undefined) {
          if (typeof value !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) {
            throw new ConfigValidationError(`${path}.${field}: expected a #RGB or #RRGGBB color.`);
          }
          target[field] = value;
        }
      }
    }
  }
  let telegram = null;
  if (config.telegram !== undefined) {
    if (!config.telegram || typeof config.telegram !== 'object' || Array.isArray(config.telegram)) {
      throw new ConfigValidationError('telegram: expected an object with botToken.');
    }
    const match = typeof config.telegram.botToken === 'string' && /^(\d{1,15}):[\w-]{30,}$/.exec(config.telegram.botToken);
    if (!match) throw new ConfigValidationError('telegram.botToken: expected the token issued by @BotFather (for example, "123456789:AA...").');
    telegram = { botId: Number(match[1]), token: config.telegram.botToken };
  }
  const visualization = config.visualization;
  if (!visualization || typeof visualization !== 'object' || Array.isArray(visualization)) {
    throw new ConfigValidationError('visualization: required object with tickFrequency, maxTimeSpan and clearIssuesAfter.');
  }
  const tickMs = duration(visualization.tickFrequency, 'visualization.tickFrequency');
  const spanMs = duration(visualization.maxTimeSpan, 'visualization.maxTimeSpan');
  const clearMs = duration(visualization.clearIssuesAfter, 'visualization.clearIssuesAfter');
  const elevatedAfter = visualization.elevatedAfter ?? 5;
  if (tickMs < 60000) throw new ConfigValidationError('visualization.tickFrequency: must be at least 1min.');
  if (spanMs < tickMs || spanMs > duration('90day')) {
    throw new ConfigValidationError('visualization.maxTimeSpan: must be at least tickFrequency and at most 90day.');
  }
  if (Math.ceil(spanMs / tickMs) > 366) {
    throw new ConfigValidationError('visualization.tickFrequency: too small for maxTimeSpan; increase it or reduce maxTimeSpan to produce at most 366 ticks.');
  }
  if (clearMs < 60000 || clearMs > spanMs) {
    throw new ConfigValidationError('visualization.clearIssuesAfter: must be at least 1min and no longer than maxTimeSpan.');
  }
  if (!Number.isInteger(elevatedAfter) || elevatedAfter < 2) {
    throw new ConfigValidationError('visualization.elevatedAfter: expected an integer of at least 2.');
  }
  if (!Array.isArray(config.components) || !config.components.length || config.components.length > 10) {
    throw new ConfigValidationError('components: expected an array containing 1–10 components.');
  }
  if (config.groups !== undefined && !Array.isArray(config.groups)) {
    throw new ConfigValidationError('groups: expected an array.');
  }
  const groupNames = new Set();
  const groups = (config.groups ?? []).map((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new ConfigValidationError(`groups[${index}]: expected an object.`);
    }
    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 200) {
      throw new ConfigValidationError(`groups[${index}].name: expected a non-empty string of up to 200 characters.`);
    }
    if (groupNames.has(group.name)) throw new ConfigValidationError(`groups[${index}].name: duplicate group name; names must be unique.`);
    if (typeof group.label !== 'string' || !group.label.trim() || group.label.length > 200) {
      throw new ConfigValidationError(`groups[${index}].label: expected a non-empty string of up to 200 characters.`);
    }
    if (group.description !== undefined && (typeof group.description !== 'string' || group.description.length > 500)) {
      throw new ConfigValidationError(`groups[${index}].description: expected a string of up to 500 characters.`);
    }
    groupNames.add(group.name);
    return { name: group.name, label: group.label, description: group.description ?? '' };
  });
  const names = new Set();
  const components = config.components.map((component, index) => {
    const path = `components[${index}]`;
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw new ConfigValidationError(`${path}: expected an object.`);
    }
    const { label, ping } = component;
    if (!label || typeof label !== 'object' || Array.isArray(label)) {
      throw new ConfigValidationError(`${path}.label: required object with name and title.`);
    }
    if (typeof label.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(label.name)) {
      throw new ConfigValidationError(`${path}.label.name: expected 1–64 ASCII letters (any case), digits, hyphens or underscores, starting with a letter or digit (for example, "service-uptime").`);
    }
    const name = label.name.toLowerCase();
    if (names.has(name)) {
      throw new ConfigValidationError(`${path}.label.name: duplicates components[${config.components.findIndex(item => item.label?.name?.toLowerCase() === name)}].label.name; component names must be unique ignoring case.`);
    }
    names.add(name);
    for (const key of ['title', 'description', 'group']) {
      if (label[key] !== undefined && (typeof label[key] !== 'string' || label[key].length > 200)) {
        throw new ConfigValidationError(`${path}.label.${key}: expected a string of up to 200 characters.`);
      }
    }
    if (!label.title?.trim()) throw new ConfigValidationError(`${path}.label.title: a non-empty title is required.`);
    let monitor = null;
    if (ping) {
      if (typeof ping !== 'object' || Array.isArray(ping)) {
        throw new ConfigValidationError(`${path}.ping: expected an object.`);
      }
      let url;
      try { url = new URL(ping.url); } catch {
        throw new ConfigValidationError(`${path}.ping.url: expected a valid absolute HTTPS URL.`);
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new ConfigValidationError(`${path}.ping.url: must use HTTPS without embedded username or password.`);
      }
      const intervalMs = duration(ping.interval, `${path}.ping.interval`);
      const timeoutMs = duration(ping.timeout ?? '10sec', `${path}.ping.timeout`);
      if (intervalMs < 60000 || intervalMs > spanMs) {
        throw new ConfigValidationError(`${path}.ping.interval: must be at least 1min and no longer than visualization.maxTimeSpan.`);
      }
      if (timeoutMs > 20000) throw new ConfigValidationError(`${path}.ping.timeout: must be at most 20sec.`);
      let headers;
      try { headers = new Headers(ping.headers ?? {}); } catch {
        throw new ConfigValidationError(`${path}.ping.headers: invalid HTTP headers; check names, value types and forbidden newlines.`);
      }
      monitor = { url: url.href, intervalMs, timeoutMs, headers: Object.fromEntries(headers) };
    }
    return {
      label: { name, title: label.title, description: label.description ?? '', group: label.group ?? 'Services' },
      ping: monitor
    };
  });
  return { tickMs, spanMs, clearMs, elevatedAfter, branding, groups, components, telegram };
}
