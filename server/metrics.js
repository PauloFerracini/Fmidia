// Gera histórico diário de métricas para um perfil recém-conectado.
// Em produção estes números viriam das APIs de insights de cada rede.
function seedMetrics(db, profile, days = 90) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO metrics (profile_id, day, followers, impressions, reach, engagement, clicks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let rand = profile.id * 9301 + 49297; // pseudo-aleatório determinístico por perfil
  const rnd = () => ((rand = (rand * 9301 + 49297) % 233280) / 233280);

  let followers = Math.max(100, Math.round(profile.followers * 0.85));
  const growth = (profile.followers - followers) / days;
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    followers = Math.round(followers + growth * (0.5 + rnd()));
    const weekend = [0, 6].includes(new Date(day).getUTCDay()) ? 0.7 : 1;
    const impressions = Math.round(followers * (0.3 + rnd() * 0.5) * weekend);
    const reach = Math.round(impressions * (0.6 + rnd() * 0.2));
    const engagement = Math.round(reach * (0.02 + rnd() * 0.05));
    const clicks = Math.round(engagement * (0.1 + rnd() * 0.3));
    insert.run(profile.id, day, followers, impressions, reach, engagement, clicks);
  }
}

module.exports = { seedMetrics };
