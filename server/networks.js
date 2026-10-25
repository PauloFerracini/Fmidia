// Redes suportadas e os formatos de publicação que cada uma aceita.
// `live` indica as redes que têm integração real (as demais funcionam em modo demonstração).
const NETWORKS = {
  instagram: { label: 'Instagram', color: '#e1306c', formats: ['feed', 'carousel', 'reels', 'stories'], maxCaption: 2200, live: 'meta' },
  facebook: { label: 'Facebook', color: '#1877f2', formats: ['feed', 'carousel', 'reels'], maxCaption: 63206, live: 'meta' },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', formats: ['feed', 'carousel'], maxCaption: 3000 },
  tiktok: { label: 'TikTok', color: '#111111', formats: ['reels', 'feed', 'carousel'], maxCaption: 2200, live: 'tiktok' },
  x: { label: 'X (Twitter)', color: '#14171a', formats: ['feed'], maxCaption: 280 },
  youtube: { label: 'YouTube', color: '#ff0000', formats: ['reels', 'feed'], maxCaption: 5000 },
  pinterest: { label: 'Pinterest', color: '#e60023', formats: ['feed'], maxCaption: 500 },
  google: { label: 'Google Meu Negócio', color: '#34a853', formats: ['feed'], maxCaption: 1500 },
};

const FORMATS = { feed: 'Post no feed', carousel: 'Carrossel', reels: 'Vídeo curto / Reels', stories: 'Stories' };

const isVideo = (url) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(url));

// Regras de mídia por rede e formato. Retorna a mensagem de erro ou null.
function checkMedia(network, format, media) {
  const net = NETWORKS[network];
  const videos = media.filter(isVideo).length;
  const needsMedia = ['instagram', 'tiktok'].includes(network) || ['carousel', 'reels', 'stories'].includes(format);
  if (needsMedia && media.length === 0) return `${net.label} exige uma imagem ou vídeo neste formato`;
  if (format === 'reels' && (media.length !== 1 || videos !== 1)) return `${FORMATS.reels} precisa de exatamente um vídeo (.mp4 ou .mov)`;
  if (format === 'stories' && media.length !== 1) return 'Stories aceitam uma única imagem ou vídeo';
  if (format === 'carousel') {
    const max = network === 'tiktok' ? 35 : 10;
    if (media.length < 2 || media.length > max) return `Carrossel no ${net.label} precisa de 2 a ${max} mídias`;
    if (network !== 'instagram' && videos) return `Carrossel no ${net.label} aceita apenas imagens`;
  }
  if (format === 'feed' && media.length > 1 && network !== 'facebook') return `Para várias mídias no ${net.label}, use o formato Carrossel`;
  if (format === 'feed' && videos && media.length > 1) return 'Não é possível misturar vídeo com várias imagens no feed';
  if (network === 'tiktok' && format !== 'reels' && videos) return 'Para vídeo no TikTok, use o formato Vídeo curto / Reels';
  return null;
}

// Níveis de privacidade do TikTok. As opções de cada conta vêm do creator_info.
const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// Valida e normaliza as escolhas do usuário para um post no TikTok, seguindo as
// diretrizes do Direct Post: privacidade escolhida manualmente e divulgação comercial coerente.
function tiktokOptions(raw, { photo }) {
  const o = raw || {};
  if (!TIKTOK_PRIVACY.includes(o.privacy)) return { error: 'Escolha quem pode ver o post no TikTok' };
  const commercial = Boolean(o.commercial);
  const yourBrand = commercial && Boolean(o.yourBrand);
  const brandedContent = commercial && Boolean(o.brandedContent);
  if (commercial && !yourBrand && !brandedContent) {
    return { error: 'Na divulgação comercial do TikTok, indique se é "Sua marca", "Conteúdo de marca" ou ambos' };
  }
  if (brandedContent && o.privacy === 'SELF_ONLY') {
    return { error: 'Conteúdo de marca no TikTok não pode ser privado ("Somente eu")' };
  }
  return {
    options: {
      privacy: o.privacy,
      allowComment: Boolean(o.allowComment),
      allowDuet: !photo && Boolean(o.allowDuet),
      allowStitch: !photo && Boolean(o.allowStitch),
      commercial, yourBrand, brandedContent,
    },
  };
}

module.exports = { NETWORKS, FORMATS, TIKTOK_PRIVACY, isVideo, checkMedia, tiktokOptions };
