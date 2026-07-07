# Sistema de Logging Estruturado do Bridge

## Visão Geral

Sistema completo de rastreabilidade de requisições com logging estruturado em SQLite, capturando todas as chamadas ao Bridge com detalhes de IP, headers, modelo, tokens, custo e latência.

## Recursos Implementados

### 1. Captura Automática de Requisições

Todas as requests ao Bridge são automaticamente logadas com:

- **Request details**: timestamp, method, endpoint, client IP, user-agent, referer
- **Key info**: ID e nome da API key usada
- **Model & usage**: provider, modelo, tokens (input/output), custo em BRL
- **Response**: status code, success/error, latência em ms, mensagem de erro
- **Payload samples**: primeiros 500 chars do body (apenas para rotas de API)

### 2. Armazenamento em SQLite

- Banco: `/data/bridge-logs.db` (ou `bridge-logs.db` no diretório local)
- Retenção: 7 dias (limpeza automática diária)
- Batching: gravação assíncrona com flush a cada 5s ou 50 logs
- Índices otimizados para queries por timestamp, key_id, model, status

### 3. API de Consulta

#### GET /admin/logs

Query logs com filtros:

```bash
curl "http://localhost:8787/admin/logs?keyId=k1&limit=100&from=2026-07-01" \
  -H "Authorization: Bearer <admin-password>"
```

**Query params**:
- `keyId` ou `key_id`: filtrar por API key
- `model`: filtrar por modelo
- `status`: filtrar por status code
- `success`: `true` ou `false`
- `from` ou `fromDate`: data inicial (ISO 8601)
- `to` ou `toDate`: data final (ISO 8601)
- `limit`: max registros (padrão 100, max 1000)
- `offset`: paginação

**Response**:
```json
{
  "logs": [
    {
      "id": 1,
      "request_id": "abc123...",
      "timestamp": "2026-07-06T10:30:00Z",
      "key_id": "k1",
      "key_name": "Porta do Corretor - PDF Extractor",
      "method": "POST",
      "endpoint": "/v1/chat/completions",
      "client_ip": "192.168.1.100",
      "user_agent": "...",
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "input_tokens": 1500,
      "output_tokens": 300,
      "total_tokens": 1800,
      "cost_brl": 0.05,
      "status_code": 200,
      "success": true,
      "latency_ms": 1234,
      "request_body_sample": "{\"model\":\"claude-sonnet-5\",...}",
      "response_body_sample": "{\"id\":\"msg_...\",..."
    }
  ],
  "count": 1,
  "filters": {...}
}
```

#### GET /admin/logs/summary

Agregações e estatísticas:

```bash
curl "http://localhost:8787/admin/logs/summary?period=24h" \
  -H "Authorization: Bearer <admin-password>"
```

**Query params**:
- `keyId`: filtrar por key
- `from`/`to`: range customizado
- `period`: atalho para range (`24h`, `7d`, `30d`)

**Response**:
```json
{
  "summary": {
    "total_requests": 1523,
    "total_success": 1450,
    "total_errors": 73,
    "total_input_tokens": 2500000,
    "total_output_tokens": 500000,
    "total_tokens": 3000000,
    "total_cost_brl": 8.75,
    "avg_latency_ms": 1234.5,
    "first_request": "2026-07-06T00:00:00Z",
    "last_request": "2026-07-07T00:00:00Z"
  }
}
```

#### GET /admin/logs/:requestId

Detalhes de uma requisição específica:

```bash
curl "http://localhost:8787/admin/logs/abc123..." \
  -H "Authorization: Bearer <admin-password>"
```

#### GET /admin/logs/export/csv

Export para CSV:

```bash
curl "http://localhost:8787/admin/logs/export/csv?keyId=k1&from=2026-07-01&limit=10000" \
  -H "Authorization: Bearer <admin-password>" \
  -o logs.csv
```

## Casos de Uso

### 1. Investigar uso suspeito de uma key

```bash
# Ver todas as chamadas das últimas 24h
curl "http://localhost:8787/admin/logs?keyId=k1&period=24h&limit=100" \
  -H "Authorization: Bearer <admin-password>"

# Summary de uso por key
curl "http://localhost:8787/admin/logs/summary?keyId=k1&period=24h" \
  -H "Authorization: Bearer <admin-password>"
```

### 2. Identificar IPs mais frequentes

```bash
# Exporta CSV e processa localmente
curl "http://localhost:8787/admin/logs/export/csv?keyId=k1&from=2026-07-01" \
  -H "Authorization: Bearer <admin-password>" | \
  cut -d',' -f6 | sort | uniq -c | sort -rn | head -10
```

### 3. Analisar padrão de chamadas

```bash
# Ver todas as requests de uma key específica
curl "http://localhost:8787/admin/logs?keyId=k1&limit=1000" \
  -H "Authorization: Bearer <admin-password>" | \
  python -c "
import json, sys
from datetime import datetime
logs = json.load(sys.stdin)['logs']
times = [datetime.fromisoformat(l['timestamp'].replace('Z', '+00:00')) for l in logs]
intervals = [(times[i] - times[i+1]).total_seconds() for i in range(len(times)-1)]
print(f'Total requests: {len(logs)}')
print(f'Avg interval: {sum(intervals)/len(intervals):.1f}s')
print(f'Min interval: {min(intervals):.1f}s')
print(f'Max interval: {max(intervals):.1f}s')
"
```

### 4. Verificar custos por período

```bash
# Custo total por key nas últimas 7 dias
curl "http://localhost:8787/admin/logs/summary?keyId=k1&period=7d" \
  -H "Authorization: Bearer <admin-password>"
```

### 5. Gerar relatório mensal

```bash
# Export completo do mês
curl "http://localhost:8787/admin/logs/export/csv?from=2026-07-01&to=2026-07-31&limit=50000" \
  -H "Authorization: Bearer <admin-password>" \
  -o relatorio-julho-2026.csv
```

## Arquitetura Interna

### Arquivos

- **`request-logger.js`**: Módulo SQLite com funções de gravação/consulta
- **`logging-middleware.js`**: Middleware Express para captura de requisições
- **`server.js`**: Integração com o Bridge (imports, middleware, endpoints)

### Fluxo de Logging

1. Request chega ao Bridge
2. Middleware `requestLoggingMiddleware` captura metadados iniciais
3. Request é processada normalmente
4. `recordUsage()` enriquece o log com dados de modelo/tokens/custo via `attachUsageToRequest()`
5. No evento `res.finish`, log completo é gravado no buffer
6. Buffer é flushed para SQLite a cada 5s ou 50 logs
7. Limpeza automática de logs > 7 dias roda diariamente

### Performance

- **Gravação assíncrona**: não bloqueia requisições
- **Batching**: reduce I/O disk
- **Índices**: queries por key/model/date são rápidas (< 10ms)
- **Retenção**: apenas 7 dias mantém o DB pequeno (< 50MB para ~10k reqs/dia)

## Segurança

- **API keys mascaradas**: apenas primeiros 4 e últimos 4 chars nos logs antigos
- **Payload samples limitados**: apenas 500 chars para evitar logar dados sensíveis completos
- **Auth admin**: todos os endpoints de logs exigem `checkDashboardAuth`
- **GDPR/LGPD**: considere anonimizar IPs após N dias se necessário

## Configuração

### Retenção de Logs

Edite `RETENTION_DAYS` em `request-logger.js` (padrão: 7 dias).

### Tamanho do Batch

Edite `BATCH_SIZE` em `request-logger.js` (padrão: 50 logs).

### Intervalo de Flush

Edite `FLUSH_INTERVAL_MS` em `request-logger.js` (padrão: 5000ms).

## Troubleshooting

### Logs não estão sendo capturados

1. Verifique se o banco foi inicializado:
   ```bash
   ls -lh /data/bridge-logs.db  # ou bridge-logs.db no dir local
   ```

2. Veja os logs de inicialização:
   ```
   [request-logger] Initialized SQLite database at /data/bridge-logs.db
   ```

3. Confirme que o middleware está ativo:
   - No `server.js`, deve ter `app.use(requestLoggingMiddleware);` logo após `express.json()`

### Queries lentas

1. Verifique se os índices foram criados:
   ```sql
   SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_logs';
   ```

2. Sempre use filtros por `timestamp`, `key_id` ou `model` para aproveitar índices

### Banco muito grande

1. Ajuste `RETENTION_DAYS` para valor menor
2. Force limpeza manual via Node REPL:
   ```javascript
   import { cleanupOldLogs } from './request-logger.js';
   cleanupOldLogs();
   ```

## Próximos Passos

- [ ] Interface web para visualização de logs (dashboard)
- [ ] Gráficos de uso por hora/dia
- [ ] Alertas para padrões suspeitos (ex: > 100 req/min de um IP)
- [ ] Anonimização automática de IPs após 30 dias
- [ ] Export para Prometheus/Grafana
