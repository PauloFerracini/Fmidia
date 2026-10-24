const express = require('express');
const { requireBrand } = require('../auth');

const SUM_COLS = 'SUM(m.impressions) AS impressions, SUM(m.reach) AS reach, SUM(m.engagement) AS engagement, SUM(m.clicks) AS clicks';

module.exports = function analyticsRoutes(db) {
  const r = express.Router({ mergeParams: true });

  // Visão consolidada da marca no período (?days=7|30|90, opcional ?profileId=).
  r.get('/', requireBrand(db), (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const prevSince = new Date(Date.now() - (2 * days - 1) * 864e5).toISOString().slice(0, 10);
    const profileFilter = req.query.profileId ? 'AND p.id = ?' : '';
    const args = (from, to) => [req.brandId, from, to, ...(req.query.profileId ? [Number(req.query.profileId)] : [])];
    const today = new Date().toISOString().slice(0, 10);

    const totals = (from, to) => db.prepare(
      `SELECT ${SUM_COLS} FROM metrics m JOIN profiles p ON p.id = m.profile_id
       WHERE p.brand_id = ? AND m.day >= ? AND m.day <= ? ${profileFilter}`
    ).get(...args(from, to));

    const followersAt = (day) => db.prepare(
      `SELECT COALESCE(SUM(m.followers), 0) AS f FROM metrics m JOIN profiles p ON p.id = m.profile_id
       WHERE p.brand_id = ? AND m.day = ? ${profileFilter}`
    ).get(req.brandId, day, ...(req.query.profileId ? [Number(req.query.profileId)] : [])).f;

    const prevEnd = new Date(Date.parse(since) - 864e5).toISOString().slice(0, 10);
    const current = totals(since, today);
    const previous = totals(prevSince, prevEnd);

    const series = db.prepare(
      `SELECT m.day, SUM(m.followers) AS followers, ${SUM_COLS} FROM metrics m JOIN profiles p ON p.id = m.profile_id
       WHERE p.brand_id = ? AND m.day >= ? AND m.day <= ? ${profileFilter} GROUP BY m.day ORDER BY m.day`
    ).all(...args(since, today));

    const byProfile = db.prepare(
      `SELECT p.id, p.network, p.handle, MAX(m.followers) AS followers, ${SUM_COLS}
       FROM profiles p LEFT JOIN metrics m ON m.profile_id = p.id AND m.day >= ? AND m.day <= ?
       WHERE p.brand_id = ? GROUP BY p.id ORDER BY engagement DESC`
    ).all(since, today, req.brandId);

    const posts = db.prepare(
      `SELECT status, COUNT(*) AS n FROM posts WHERE brand_id = ? AND COALESCE(published_at, scheduled_at, created_at) >= ? GROUP BY status`
    ).all(req.brandId, since);

    const followers = followersAt(today);
    const followersStart = series.length ? series[0].followers : followers;

    res.json({
      days, since, until: today,
      totals: { ...current, followers, followersGrowth: followers - followersStart,
        engagementRate: current.reach ? current.engagement / current.reach : 0 },
      previous,
      series, byProfile,
      posts: Object.fromEntries(posts.map((p) => [p.status, p.n])),
    });
  });

  return r;
};
