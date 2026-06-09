# Claude Bridge — SaaS + Dashboard

Bridge OpenAI ⇄ Anthropic com portal SaaS (cadastro, planos, PIX, assinaturas) e painel visual para monitoramento e teste.

## Funcionalidades

### Bridge
- Rota `/v1/chat/completions` (OpenAI-compatible) — uso no n8n.
- Rota `/v1/messages` (Anthropic-compatible) — uso no OpenClaw.
- Retry automático, throttling, circuit breaker e força non-stream para overload.

### Portal SaaS (`/portal/*`)
- Cadastro e login de usuários com JWT.
- Planos pagos com limite de tokens/mês e RPM.
- Geração de QR Code PIX para pagamento.
- Confirmação manual pelo admin → gera API key.
- Rate limiting por assinatura (diário + mensal + RPM).
- Expiração automática de assinaturas.

### Dashboard (`/`)
- Login por senha, métricas em tempo real.
- Gerenciamento de chaves de API.
- **Aba Pagamentos**: listar/confirmar/rejeitar pedidos PIX.
- Testador embutido para enviar prompts.
- Guardrails configuráveis.

## Estrutura

```
├── Dockerfile
├── package.json
├── package-lock.json
├── server.js
├── .env.example
├── public/          # Dashboard UI
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── portal/          # Portal SaaS
    ├── routes.js
    ├── auth.js
    ├── billing.js
    ├── db.js
    ├── notify.js
    ├── pix.js
    ├── ratelimit.js
    └── public/      # Portal UI (cadastro/login)
```

## Planos

| Plano | Preço | Tokens/mês | RPM | Max tokens/req |
|-------|-------|------------|-----|----------------|
| Pro 5x | R$ 124,99 | 35M | 15 | 4.096 |
| Max 10x | R$ 249,99 | 90M | 25 | 8.192 |
| Max 20x | R$ 499,99 | 225M | 40 | 16.384 |

## Fluxo do Portal

1. Usuário acessa `/portal` → cadastro com email/senha.
2. Login → dashboard do usuário com planos disponíveis.
3. Escolhe plano → gera QR Code PIX com valor exato.
4. Faz o PIX → admin recebe notificação por email.
5. Admin confirma pagamento na aba "Pagamentos" do dashboard.
6. Sistema gera API key com validade de 30 dias.
7. Usuário usa a API key no header `Authorization: Bearer <key>`.
8. Rate limiting automático (RPM + budget diário + mensal).

## Variáveis de ambiente

```env
# ── Bridge ─────────────────────────────────────────────────
PORT=8787
UPSTREAM_BASE_URL=https://api.nuoda.vip
UPSTREAM_API_KEY=SUA_CHAVE_AQUI
DEFAULT_MODEL=claude-opus-4-7
PROXY_API_KEY=SENHA_FORTE_DO_BRIDGE
DASHBOARD_PASSWORD=SENHA_DO_PAINEL

# ── Retry / Concorrência ───────────────────────────────────
UPSTREAM_INFINITE_RETRY=true
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

# ── Guardrails ─────────────────────────────────────────────
GR_PII_ENABLED=true
GR_MAX_TOKENS_ENABLED=true
GR_MAX_TOKENS_LIMIT=8192
GR_BUDGET_ENABLED=true
GR_BUDGET_DAILY_USD=10
GR_MODEL_SWAP_ENABLED=true

# ── Precificação (USD por milhão de tokens) ────────────────
PRICING_INPUT_PER_MILLION=15
PRICING_OUTPUT_PER_MILLION=75

# ── Portal SaaS ───────────────────────────────────────────
JWT_SECRET=GERE_UM_SECRET_LONGO_AQUI
PIX_KEY=13996666432
PIX_NAME=MATHEUS LINS LIMA
PIX_CITY=PRAIA GRANDE
ADMIN_EMAIL=matheuslinspg@gmail.com

# ── SMTP (notificações) ───────────────────────────────────
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

Se `DASHBOARD_PASSWORD` ficar vazio, o painel aceita a `PROXY_API_KEY` como senha.
Se `JWT_SECRET` ficar vazio, um secret aleatório em memória será usado (tokens não sobrevivem restart).

## Rotas

### Bridge

| Rota | Acesso | Descrição |
|------|--------|-----------|
| `GET /` | público | Dashboard (precisa de senha) |
| `GET /health` | público | Health check |
| `POST /admin/login` | público | Verifica senha e devolve token |
| `GET /admin/status` | dashboard token | Métricas e config |
| `POST /admin/reset` | dashboard token | Zera contadores |
| `POST /v1/chat/completions` | `Authorization: Bearer <KEY>` | OpenAI-compatible |
| `POST /v1/messages` | `x-api-key: <KEY>` | Anthropic-compatible |
| `GET /v1/models` | `Authorization: Bearer <KEY>` | Lista de modelos |

### Portal

| Rota | Acesso | Descrição |
|------|--------|-----------|
| `GET /portal` | público | UI do portal |
| `POST /portal/register` | público | Cadastro |
| `POST /portal/login` | público | Login → JWT |
| `POST /portal/logout` | público | Logout |
| `GET /portal/me` | JWT | Dados + assinatura + uso |
| `GET /portal/plans` | público | Planos disponíveis |
| `POST /portal/orders` | JWT | Criar pedido PIX |
| `GET /portal/orders` | JWT | Histórico de pedidos |
| `GET /portal/admin/payments` | dashboard token | Pedidos pendentes + recentes |
| `POST /portal/admin/payments/:id/confirm` | dashboard token | Confirmar pagamento |
| `POST /portal/admin/payments/:id/reject` | dashboard token | Rejeitar pagamento |

## Deploy no EasyPanel

1. Crie um app com builder **Dockerfile**.
2. Proxy Port: **8787**.
3. Configure as variáveis de ambiente.
4. Volume persistente: `/data` (SQLite do portal + config).
5. Adicione um domínio HTTPS.

## Teste rápido

```sh
# Health check
curl -sS https://bridge.seudominio.com/health

# Chat (OpenAI-compatible)
curl -sS https://bridge.seudominio.com/v1/chat/completions \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"ok"}],"max_tokens":32}'
```

## n8n

Credential **OpenAI**: `API Key: SUA_API_KEY`, `Base URL: https://bridge.seudominio.com/v1`

## OpenClaw

```sh
openclaw config set models.providers.bridge '{
  "baseUrl": "https://bridge.seudominio.com",
  "apiKey":  "SUA_API_KEY",
  "api":     "anthropic-messages",
  "models": [{"id": "claude-opus-4-7", "name": "Claude Opus 4.7", "reasoning": true, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 8192}]
}' --strict-json --replace
```
