// Popula o banco com uma conta de demonstração: demo@fmidia.com / demo123
const { openDb, tx } = require('./db');
const { hashPassword } = require('./auth');
const { seedMetrics } = require('./metrics');

const SAMPLE_VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

function seed(db) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get('demo@fmidia.com')) return false;
  tx(db, () => {
    const userId = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Conta Demo', 'demo@fmidia.com', hashPassword('demo123')).lastInsertRowid;

    const brands = [
      { name: 'Café Aurora', color: '#b45309', profiles: [['instagram', '@cafeaurora', 18400], ['facebook', '@cafeaurora', 9200], ['google', '@cafe-aurora-centro', 1300]] },
      { name: 'Studio Pulse Fitness', color: '#0891b2', profiles: [['instagram', '@studiopulse', 32100], ['tiktok', '@studiopulse', 51200], ['youtube', '@studiopulsefit', 7400]] },
      { name: 'Lumen Tecnologia', color: '#6d28d9', profiles: [['linkedin', '@lumen-tecnologia', 12800], ['x', '@lumentec', 4100], ['instagram', '@lumentec', 6900]] },
    ];

    const captions = [
      'Começando a semana com energia! O que vocês planejam para hoje? ☀️',
      'Bastidores da nossa equipe preparando novidades 👀 #bastidores',
      'Dica rápida: consistência vale mais que intensidade. Salve este post!',
      'Promoção relâmpago só hoje. Link na bio 🔥',
      'Obrigado pelos 10 mil seguidores! Vocês são incríveis 💜',
      'Enquete: qual conteúdo vocês querem ver na próxima semana?',
      'Conheça quem faz tudo acontecer por aqui. #time',
      'Novidade chegando... fiquem ligados! 🚀',
    ];
    const comments = [
      ['comment', 'mariana.souza', 'Amei! Vocês abrem no feriado?'],
      ['message', 'joao_pedro', 'Oi, gostaria de saber o valor do plano mensal.'],
      ['comment', 'carla.dev', 'Conteúdo excelente, parabéns pelo trabalho!'],
      ['mention', 'blogdorafa', 'Recomendo muito o pessoal da @marca, atendimento nota 10'],
      ['message', 'lucas.m', 'Fiz um pedido ontem e ainda não recebi confirmação.'],
      ['comment', 'ana_beatriz', 'Qual o horário de funcionamento?'],
    ];

    brands.forEach((b, bi) => {
      const brandId = db.prepare('INSERT INTO brands (name, color) VALUES (?, ?)').run(b.name, b.color).lastInsertRowid;
      db.prepare("INSERT INTO memberships (user_id, brand_id, role) VALUES (?, ?, 'owner')").run(userId, brandId);
      const profiles = b.profiles.map(([network, handle, followers]) => {
        const id = db.prepare('INSERT INTO profiles (brand_id, network, handle, followers) VALUES (?, ?, ?, ?)')
          .run(brandId, network, handle, followers).lastInsertRowid;
        const p = { id: Number(id), network, handle, followers };
        seedMetrics(db, p);
        return p;
      });

      // Posts espalhados entre -20 e +20 dias, com status coerentes com a data.
      for (let i = 0; i < 14; i++) {
        const offset = -20 + i * 3 + bi;
        const when = new Date(Date.now() + offset * 864e5);
        when.setUTCHours(12 + (i % 8), 0, 0, 0);
        const statuses = offset < 0 ? ['published'] : ['scheduled', 'draft', 'pending_approval', 'approved'];
        const status = statuses[i % statuses.length];
        const target = profiles.filter((p) => !['tiktok', 'youtube'].includes(p.network) || i % 2 === 0);
        const format = target.some((p) => ['tiktok'].includes(p.network)) ? 'reels' : 'feed';
        const finalTargets = format === 'reels' ? profiles.filter((p) => ['instagram', 'tiktok', 'youtube', 'facebook'].includes(p.network)) : target.filter((p) => p.network !== 'tiktok');
        const media = format === 'reels' ? SAMPLE_VIDEO : `https://picsum.photos/seed/fmidia${bi}${i}/800/800.jpg`;
        const postId = db.prepare(
          `INSERT INTO posts (brand_id, author_id, caption, media_url, media_urls, format, status, scheduled_at, published_at, approval_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(brandId, userId, captions[(i + bi) % captions.length],
          media, JSON.stringify([media]), format, status, when.toISOString(),
          status === 'published' ? when.toISOString() : null,
          status === 'pending_approval' ? `demo${bi}${i}` : null).lastInsertRowid;
        for (const p of finalTargets) {
          db.prepare('INSERT INTO post_targets (post_id, profile_id, external_id) VALUES (?, ?, ?)')
            .run(postId, p.id, status === 'published' ? `${p.network}_demo${postId}` : null);
        }
      }

      comments.forEach(([kind, author, body], ci) => {
        const p = profiles[ci % profiles.length];
        const at = new Date(Date.now() - (ci * 5 + bi) * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare('INSERT INTO inbox (profile_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(p.id, kind, author, body.replace('@marca', p.handle), at);
      });
    });
  });
  return true;
}

if (require.main === module) {
  const created = seed(openDb());
  console.log(created ? 'Dados de demonstração criados. Login: demo@fmidia.com / demo123' : 'Conta demo já existe.');
}

module.exports = { seed };
