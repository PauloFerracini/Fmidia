// Redes suportadas e os formatos de publicação que cada uma aceita.
const NETWORKS = {
  instagram: { label: 'Instagram', color: '#e1306c', formats: ['feed', 'carousel', 'reels', 'stories'], maxCaption: 2200 },
  facebook: { label: 'Facebook', color: '#1877f2', formats: ['feed', 'reels', 'stories'], maxCaption: 63206 },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', formats: ['feed', 'carousel'], maxCaption: 3000 },
  tiktok: { label: 'TikTok', color: '#111111', formats: ['reels'], maxCaption: 2200 },
  x: { label: 'X (Twitter)', color: '#14171a', formats: ['feed'], maxCaption: 280 },
  youtube: { label: 'YouTube', color: '#ff0000', formats: ['reels', 'feed'], maxCaption: 5000 },
  pinterest: { label: 'Pinterest', color: '#e60023', formats: ['feed'], maxCaption: 500 },
  google: { label: 'Google Meu Negócio', color: '#34a853', formats: ['feed'], maxCaption: 1500 },
};

const FORMATS = { feed: 'Post no feed', carousel: 'Carrossel', reels: 'Vídeo curto / Reels', stories: 'Stories' };

module.exports = { NETWORKS, FORMATS };
