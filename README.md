# Claude Bridge + Dashboard

Bridge OpenAI ⇄ Anthropic com painel visual para monitoramento e teste, pronto para deploy no EasyPanel.

## Funcionalidades

- Rota `/v1/chat/completions` (OpenAI-compatible) — uso no n8n.
- Rota `/v1/messages` (Anthropic-compatible) — uso no OpenClaw.
- Retry automático, throttling, circuit breaker e força non-stream para overload.
- **Dashboard visual em `/`** com login por senha, métricas em tempo real, teste das rotas e snippets de configuração.

## Estrutura

```
claude-bridge-dashboard/
├── Dockerfile
├── package.json
├── server.js
├── .env.example
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Variáveis de ambiente

```env
PORT=8787
UPSTREAM_BASE_URL=https://s1.claudee.pro
UPSTREAM_API_KEY=SUA_CHAVE_CLAUDEE
DEFAULT_MODEL=claude-opus-4-7
PROXY_API_KEY=SENHA_FORTE_DO_BRIDGE
DASHBOARD_PASSWORD=SENHA_DO_PAINEL

UPSTREAM_RETRY_ATTEMPTS=5
UPSTREAM_RETRY_BASE_DELAY_MS=1000
UPSTREAM_RETRY_MAX_DELAY_MS=20000
UPSTREAM_RETRY_JITTER_MS=750
UPSTREAM_MAX_CONCURRENCY=1
UPSTREAM_MIN_INTERVAL_MS=1500
UPSTREAM_TIMEOUT_MS=180000
UPSTREAM_CIRCUIT_FAILURES=3
UPSTREAM_CIRCUIT_COOLDOWN_MS=60000
OPENCLAW_FORCE_NON_STREAM_RETRY=true
NODE_OPTIONS=--dns-result-order=ipv4first
```

Se `DASHBOARD_PASSWORD` ficar vazio, o painel aceita a `PROXY_API_KEY` como senha.

## Deploy no EasyPanel

1. Crie um app `claude-bridge`.
2. Source: faça upload deste ZIP ou aponte para um repositório com o conteúdo.
3. Builder: **Dockerfile**.
4. Proxy Port: **8787**.
5. Configure as variáveis de ambiente acima.
6. Adicione um domínio HTTPS, ex.: `https://claude-bridge.seudominio.com`.

## Rotas

| Rota | Acesso | Descrição |
|------|--------|-----------|
| `GET /` | público | Dashboard (mas precisa de senha) |
| `GET /health` | público | Health check |
| `POST /admin/login` | público | Verifica senha e devolve token |
| `GET /admin/status` | dashboard token | Métricas e config |
| `POST /admin/reset` | dashboard token | Zera contadores |
| `POST /v1/chat/completions` | `Authorization: Bearer PROXY_API_KEY` | n8n / OpenAI |
| `POST /v1/messages` | `x-api-key: PROXY_API_KEY` | OpenClaw / Anthropic |
| `GET /v1/models` | `Authorization: Bearer PROXY_API_KEY` | Lista de modelos do upstream |

## Teste rápido

```sh
curl -sS https://claude-bridge.seudominio.com/health
# {"ok":true}

curl -sS https://claude-bridge.seudominio.com/v1/chat/completions \
  -H "Authorization: Bearer SUA_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"ok"}],"max_tokens":32}'
```

## n8n

Credential **OpenAI**:

```
API Key:  PROXY_API_KEY
Base URL: https://claude-bridge.seudominio.com/v1
```

Node **OpenAI Chat Model**:

```
Model: By ID
Value: claude-opus-4-7
Use Responses API: desligado
```

## OpenClaw

```sh
openclaw config set models.providers.claudee '{
  "baseUrl": "https://claude-bridge.seudominio.com",
  "apiKey":  "SUA_PROXY_API_KEY",
  "api":     "anthropic-messages",
  "models": [{
    "id": "claude-opus-4-7",
    "name": "Claude Opus 4.7",
    "reasoning": true,
    "input": ["text","image"],
    "contextWindow": 200000,
    "maxTokens": 8192
  }]
}' --strict-json --replace

openclaw config set agents.defaults.model.primary '"claudee/claude-opus-4-7"' --strict-json
openclaw config validate
```

## Dashboard

Acesse `https://claude-bridge.seudominio.com/`, faça login com `DASHBOARD_PASSWORD`. O painel mostra:

- KPIs: total de requisições, sucesso, erros, retries.
- Estado do upstream: chamadas em voo, falhas consecutivas, circuit breaker e cooldown.
- Latência média por rota.
- Atividade recente (últimas 50 requisições).
- Configuração efetiva (sem expor chaves).
- Testador embutido para enviar prompts em qualquer das duas rotas.
