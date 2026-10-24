const crypto = require('node:crypto');
const { NETWORKS } = require('./networks');

// Camada de integração com as redes sociais. Cada rede expõe publish(profile, post).
// Sem credenciais das APIs oficiais (Meta Graph, LinkedIn, TikTok etc.), o modo
// "simulado" gera um ID externo fictício — troque por clientes reais em produção.
function simulatedPublish(profile, post) {
  const net = NETWORKS[profile.network];
  if (!net) throw new Error(`Rede desconhecida: ${profile.network}`);
  if (post.caption.length > net.maxCaption) {
    throw new Error(`Legenda excede ${net.maxCaption} caracteres no ${net.label}`);
  }
  if (!net.formats.includes(post.format)) {
    throw new Error(`${net.label} não aceita o formato "${post.format}"`);
  }
  return { externalId: `${profile.network}_${crypto.randomBytes(6).toString('hex')}` };
}

const providers = Object.fromEntries(Object.keys(NETWORKS).map((n) => [n, { publish: simulatedPublish }]));

module.exports = { providers };
