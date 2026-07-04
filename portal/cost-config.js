// ============================================================
// Cost config (upstream ¥/M prices + FX) + BRL estimation
// ------------------------------------------------------------
// Extraído de routes.js para poder ser importado por server.js e
// ratelimit.js sem criar dependência circular com o router Express.
// routes.js re-exporta get/setCostConfig para manter as rotas
// /portal/admin/cost-config funcionando sem mudança de contrato.
// ============================================================
import { getModelCost, findModelCostByName } from './providers.js';

const DEFAULT_COST_CONFIG = {
  inputPriceYuanPerM: 1.50,
  outputPriceYuanPerM: 7.50,
  cacheWritePriceYuanPerM: 1.875,
  cacheReadPriceYuanPerM: 0.15,
  fxCnyToBrl: 0.76,
};

let costConfig = { ...DEFAULT_COST_CONFIG };

export function setCostConfig(cfg) { if (cfg) costConfig = { ...costConfig, ...cfg }; }
export function getCostConfig() { return { ...costConfig }; }

/**
 * Estima o custo em BRL de uma requisição.
 *
 * Usa o custo por-modelo do provider (¥/M em providers[].models[].cost)
 * quando disponível; senão cai para os preços flat do cost-config.
 * Converte ¥ → BRL via fxCnyToBrl. É a mesma fórmula de /admin/profit e
 * calculateScenarios — mantida em um único lugar.
 *
 * @returns {number} custo estimado em BRL (não arredondado)
 */
export function estimateBrl({
  servedProvider = null,
  servedModel = null,
  inputTokens = 0,
  outputTokens = 0,
  cacheWrite = 0,
  cacheRead = 0,
} = {}) {
  const cc = costConfig;

  // Preços em ¥/M: preferir custo por-modelo do provider, senão flat.
  let inYuanPerM = cc.inputPriceYuanPerM;
  let outYuanPerM = cc.outputPriceYuanPerM;
  let cwYuanPerM = cc.cacheWritePriceYuanPerM;
  let crYuanPerM = cc.cacheReadPriceYuanPerM;

  // Custo por-modelo: usa o provider exato quando conhecido; senão procura o
  // modelo por nome em qualquer provider (projeção antes de rotear). Só cai no
  // preço flat do cost-config se o modelo não existir em nenhum provider.
  let mc = null;
  if (servedProvider && servedModel) mc = getModelCost(servedProvider, servedModel);
  if (!mc && servedModel) mc = findModelCostByName(servedModel);
  if (mc) {
    if (typeof mc.input === 'number') inYuanPerM = mc.input;
    if (typeof mc.output === 'number') outYuanPerM = mc.output;
    if (typeof mc.cacheWrite === 'number') cwYuanPerM = mc.cacheWrite;
    if (typeof mc.cacheRead === 'number') crYuanPerM = mc.cacheRead;
  }

  const costYuan =
    (inputTokens * inYuanPerM +
      outputTokens * outYuanPerM +
      cacheWrite * cwYuanPerM +
      cacheRead * crYuanPerM) / 1_000_000;

  return costYuan * (cc.fxCnyToBrl || 0.76);
}
