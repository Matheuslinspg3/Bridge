// ============================================================
// LOGGING MIDDLEWARE — Captura completa de requisições
// ============================================================
// Integra com request-logger.js para gravar todas as requests
// no Bridge com detalhes de IP, headers, modelo, tokens, etc.
// ============================================================

import { logRequest, sanitizeBodySample } from './request-logger.js';
import { randomBytes } from 'crypto';

// ============================================================
// 1. MIDDLEWARE PRINCIPAL
// ============================================================

export function requestLoggingMiddleware(req, res, next) {
  const startTime = Date.now();
  const requestId = generateRequestId();

  // Anexa requestId à request para uso posterior
  req.requestId = requestId;
  req.requestStartTime = startTime;

  // Extrai metadados da request
  const metadata = {
    requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    endpoint: req.originalUrl || req.url,
    clientIp: extractClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    referer: req.headers['referer'] || req.headers['referrer'] || null,
  };

  // Captura key info se disponível
  if (req.apiKeyObj) {
    metadata.keyId = req.apiKeyObj.id || null;
    metadata.keyName = req.apiKeyObj.name || null;
  } else if (req.apiKeyName) {
    metadata.keyName = req.apiKeyName;
  }

  // Anexa metadata à request para acesso posterior
  req.logMetadata = metadata;

  // Hook no método res.json e res.send para capturar resposta
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  let responseBody = null;
  let responseCaptured = false;

  res.json = function(body) {
    if (!responseCaptured) {
      responseBody = body;
      responseCaptured = true;
    }
    return originalJson(body);
  };

  res.send = function(body) {
    if (!responseCaptured) {
      responseBody = body;
      responseCaptured = true;
    }
    return originalSend(body);
  };

  // Hook no evento finish para gravar log completo
  res.on('finish', () => {
    const latencyMs = Date.now() - startTime;

    // Monta log entry completo
    const logEntry = {
      ...metadata,
      statusCode: res.statusCode,
      success: res.statusCode >= 200 && res.statusCode < 400,
      latencyMs,
    };

    // Adiciona info de modelo/tokens/custo se disponível
    if (req.logUsage) {
      logEntry.provider = req.logUsage.provider || null;
      logEntry.model = req.logUsage.model || null;
      logEntry.inputTokens = req.logUsage.inputTokens || 0;
      logEntry.outputTokens = req.logUsage.outputTokens || 0;
      logEntry.totalTokens = (req.logUsage.inputTokens || 0) + (req.logUsage.outputTokens || 0);
      logEntry.costBrl = req.logUsage.costBrl || 0;
    }

    // Captura erro se houver
    if (!logEntry.success && responseBody) {
      try {
        const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
        if (parsed.error) {
          logEntry.errorMessage = typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error.message || JSON.stringify(parsed.error));
        }
      } catch {
        // Ignora se não conseguir parsear
      }
    }

    // Captura samples de payload (apenas para rotas de API)
    if (shouldCaptureSamples(req.originalUrl || req.url)) {
      if (req.body && Object.keys(req.body).length > 0) {
        logEntry.requestBodySample = sanitizeBodySample(req.body);
      }

      if (responseBody) {
        logEntry.responseBodySample = sanitizeBodySample(responseBody);
      }
    }

    // Grava log assincronamente
    logRequest(logEntry);
  });

  next();
}

// ============================================================
// 2. HELPER PARA ENRIQUECER LOGS COM USAGE
// ============================================================

export function attachUsageToRequest(req, usage) {
  if (!req) return;

  req.logUsage = {
    provider: usage.provider || usage.upstream || null,
    model: usage.model || usage.servedModel || null,
    inputTokens: usage.inputTokens || usage.tokensIn || 0,
    outputTokens: usage.outputTokens || usage.tokensOut || 0,
    costBrl: usage.costBrl || 0,
  };
}

// ============================================================
// 3. EXTRAÇÃO DE CLIENT IP
// ============================================================

function extractClientIp(req) {
  // Tenta várias fontes de IP
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for pode ter múltiplos IPs separados por vírgula
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0];
  }

  return req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || req.socket?.remoteAddress
    || req.ip
    || null;
}

// ============================================================
// 4. FILTRO DE ROTAS PARA SAMPLES
// ============================================================

function shouldCaptureSamples(url) {
  if (!url) return false;

  // Captura samples apenas para rotas de API
  const apiRoutes = [
    '/v1/chat/completions',
    '/chat/completions',
    '/v1/messages',
    '/messages',
  ];

  return apiRoutes.some(route => url.startsWith(route));
}

// ============================================================
// 5. GERAÇÃO DE REQUEST ID
// ============================================================

function generateRequestId() {
  return randomBytes(16).toString('hex');
}
