# ⚠️ CORREÇÃO RÁPIDA - Deploy no EasyPanel

## Problema

O container do EasyPanel ainda não tem os novos arquivos (`request-logger.js` e `logging-middleware.js`).

## ✅ Arquivos Confirmados no GitHub

```bash
# Verificado em:
https://github.com/Matheuslinspg3/Bridge/blob/main/request-logger.js
https://github.com/Matheuslinspg3/Bridge/blob/main/logging-middleware.js
```

Commit: `6c4d965` - "feat(logging): add structured request logging system"

## 🔧 Solução: Forçar Redeploy no EasyPanel

### Opção 1: Via Interface do EasyPanel (Recomendado)

1. **Acesse o EasyPanel**
2. **Vá no app Bridge**
3. **Clique em "Settings" ou "Deploy"**
4. **Force um rebuild completo**:
   - Se houver botão "Rebuild", use ele
   - OU delete o container e crie novo
   - OU force pull via "Redeploy"

### Opção 2: Via Webhook (Se Configurado)

Se você configurou webhook do GitHub no EasyPanel:

```bash
# Faça um commit vazio para triggerar o webhook
git commit --allow-empty -m "chore: trigger redeploy"
git push origin main
```

### Opção 3: Via CLI do EasyPanel (Se Disponível)

```bash
# Se você tem acesso SSH/CLI ao EasyPanel
cd /app
git pull origin main
npm restart  # ou pm2 restart, dependendo do setup
```

## 🔍 Verificação Pós-Deploy

Após o redeploy, verifique se o servidor iniciou corretamente:

```bash
# 1. Teste de saúde
curl https://seu-bridge.easypanel.host/health

# Deve retornar: {"ok":true}

# 2. Verifique logs do container no EasyPanel
# Deve aparecer:
# [request-logger] Initialized SQLite database at /data/bridge-logs.db
# Claude Bridge v2.0.0-smart-routing listening on port 8787

# 3. Faça uma request de teste
curl -X POST https://seu-bridge.easypanel.host/v1/chat/completions \
  -H "Authorization: Bearer sk-sua-key-teste" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":10,"messages":[{"role":"user","content":"test"}]}'

# 4. Aguarde 6 segundos (flush automático) e consulte logs
curl "https://seu-bridge.easypanel.host/admin/logs?limit=1" \
  -H "Authorization: Bearer sua-senha-admin"

# Deve retornar JSON com o log da request acima
```

## 📦 Checklist de Deploy

- [ ] Commit `6c4d965` está no GitHub (✅ Confirmado)
- [ ] Arquivos `request-logger.js` e `logging-middleware.js` estão no GitHub (✅ Confirmado)
- [ ] Forcei redeploy no EasyPanel
- [ ] Container iniciou sem erros
- [ ] `/health` retorna `{"ok":true}`
- [ ] Logs do container mostram "[request-logger] Initialized..."
- [ ] Primeira request de teste foi capturada
- [ ] `/admin/logs` retorna dados

## 🆘 Se Ainda Não Funcionar

### Erro: "Cannot find module"

**Causa**: Container não fez pull dos novos arquivos

**Solução**:
1. No EasyPanel, delete o container completamente
2. Recrie o app do zero apontando para o repo GitHub
3. Certifique-se que a branch está em `main`

### Erro: "sql.js not found"

**Causa**: Dependência `sql.js` não está instalada

**Solução**:
```bash
# Adicione sql.js ao package.json
npm install sql.js --save
git add package.json package-lock.json
git commit -m "chore: add sql.js dependency"
git push origin main
```

Depois force redeploy no EasyPanel.

### Banco de dados não é criado

**Causa**: Pasta `/data` não existe ou não tem permissão de escrita

**Solução**: O código já tem fallback para `/app` ou diretório local. Verifique os logs do container para ver onde o banco foi criado.

## 🎯 Resultado Esperado

Após o redeploy bem-sucedido, você verá nos logs do container:

```
[portal/auth] WARN: JWT_SECRET not set — using random in-memory secret. Tokens will not survive restarts.
[request-logger] Initialized SQLite database at /data/bridge-logs.db
Claude Bridge v2.0.0-smart-routing listening on port 8787
Config path: /data/config.json
Configured: true
Upstreams: 2 enabled
Portal DB initialized
```

E poderá começar imediatamente a investigar a key suspeita usando:

```bash
curl "https://seu-bridge.easypanel.host/admin/logs/summary?keyId=<KEY_ID>&period=24h" \
  -H "Authorization: Bearer sua-senha-admin"
```

---

**Status Atual**: ✅ Código pronto | ⏳ Aguardando redeploy no EasyPanel
