# Model Aliasing

## O que é?

Model Aliasing permite que você **mapeie nomes de modelos** que os clientes solicitam para **modelos diferentes** no upstream.

**Caso de uso**: Seu provedor oferece Kimi (Moonshot) e Claude na mesma API key, mas o Claude Code não reconhece o modelo Kimi. Com aliasing, você mapeia um nome de modelo Claude para o Kimi real.

## Como configurar

Adicione a propriedade `modelAliases` no seu `config.json`:

```json
{
  "upstreams": [
    {
      "name": "Provedor Principal",
      "baseUrl": "https://api.seu-provedor.com",
      "apiKey": "sk-xxx"
    }
  ],
  "modelAliases": {
    "claude-3-5-sonnet-20241022": "moonshot-v1-8k",
    "claude-3-haiku-20240307": "moonshot-v1-32k",
    "claude-opus-4-7": "moonshot-v1-128k"
  }
}
```

## Como funciona

1. **Cliente faz request**: `POST /v1/chat/completions` com `"model": "claude-3-5-sonnet-20241022"`
2. **Bridge aplica alias**: Substitui `claude-3-5-sonnet-20241022` → `moonshot-v1-8k`
3. **Upstream recebe**: Request com `"model": "moonshot-v1-8k"`
4. **Response headers**: Bridge adiciona headers de transparência:
   - `x-bridge-requested-model: claude-3-5-sonnet-20241022` (o que o cliente pediu)
   - `x-bridge-served-model: moonshot-v1-8k` (o que foi enviado ao upstream)

## Exemplo completo

### Configuração do Bridge

```json
{
  "upstreams": [
    {
      "name": "Revenda XYZ",
      "baseUrl": "https://api.revenda-xyz.com",
      "apiKey": "sk-revenda-abc123"
    }
  ],
  "defaultModel": "claude-3-5-sonnet-20241022",
  "modelAliases": {
    "claude-3-5-sonnet-20241022": "moonshot-v1-8k",
    "claude-3-haiku-20240307": "moonshot-v1-32k"
  }
}
```

### Cliente (Claude Code)

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [{"role": "user", "content": "Olá"}]
}
```

### O que o upstream recebe

```json
{
  "model": "moonshot-v1-8k",
  "messages": [{"role": "user", "content": "Olá"}]
}
```

### Response headers

```
x-bridge-requested-model: claude-3-5-sonnet-20241022
x-bridge-served-model: moonshot-v1-8k
x-bridge-provider: Revenda XYZ
```

## Configurando via API

Você também pode configurar via endpoint `/admin/config`:

```bash
curl -X POST "https://bridge.seudominio.com/admin/config" \
  -H "x-dashboard-token: SENHA" \
  -H "content-type: application/json" \
  -d '{
    "modelAliases": {
      "claude-3-5-sonnet-20241022": "moonshot-v1-8k",
      "claude-3-haiku-20240307": "moonshot-v1-32k"
    }
  }'
```

## Verificando a configuração

```bash
curl "https://bridge.seudominio.com/admin/config" \
  -H "x-dashboard-token: SENHA"
```

## Limitações

- **Custo**: O cálculo de custo usa o preço do modelo **solicitado** (Claude), não do modelo **real** (Kimi). Se os preços forem diferentes, o custo mostrado será impreciso.
- **Allowed models**: A validação de `allowedModels` usa o nome **solicitado** (Claude), então os clientes devem estar autorizados a usar os nomes mapeados.

## Desabilitar aliasing

Para desabilitar, remova a propriedade `modelAliases` do config ou defina como `null`:

```json
{
  "modelAliases": null
}
```

Ou deixe vazio:

```json
{
  "modelAliases": {}
}
```
