const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function generateRequestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /x-goog-api-key/i,
  /secret/i,
  /master[_-]?key/i,
  /password/i,
  /ciphertext/i,
  /key_tag/i,
  /key_iv/i
];

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return '[MaxDepth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.includes(';base64,')) {
      return `<omitted image data len=${value.length} sha256=${sha256(value).slice(0, 12)}>`;
    }
    if (value.length > 5000) {
      return `<omitted large string len=${value.length} sha256=${sha256(value).slice(0, 12)}>`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        sanitized[k] = '[REDACTED]';
      } else if (k === 'system_instruction' || k === 'systemInstruction') {
        if (typeof v === 'string') {
          sanitized[k] = `<system_instruction len=${v.length} hash=${sha256(v).slice(0, 12)}>`;
        } else {
          sanitized[k] = sanitizeValue(v, depth + 1);
        }
      } else if (k === 'data' && typeof v === 'string' && v.length > 100) {
        sanitized[k] = `<omitted base64 len=${v.length} sha256=${sha256(v).slice(0, 12)}>`;
      } else {
        sanitized[k] = sanitizeValue(v, depth + 1);
      }
    }
    return sanitized;
  }

  return String(value);
}

function createGatewayLogger(customLog = null) {
  function logEvent(level, eventName, payload = {}) {
    const timestamp = new Date().toISOString();
    const cleanPayload = sanitizeValue(payload);
    const logRecord = {
      timestamp,
      level,
      event: eventName,
      ...cleanPayload
    };

    if (typeof customLog === 'function') {
      try {
        customLog(level, `[Gateway] ${eventName}`, cleanPayload);
      } catch {}
    }

    return logRecord;
  }

  return {
    generateRequestId,
    logEvent,
    sanitizeValue,
    sha256
  };
}

module.exports = {
  createGatewayLogger,
  generateRequestId,
  sanitizeValue,
  sha256
};
