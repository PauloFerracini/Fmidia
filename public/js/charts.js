// Gráficos SVG mínimos, sem dependências.
window.Charts = (() => {
  const fmt = (n) => Intl.NumberFormat('pt-BR', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);

  function line(series, { key, color = 'var(--primary)', height = 220 }) {
    const W = 720, H = height, P = { l: 48, r: 12, t: 12, b: 26 };
    if (!series.length) return '<div class="empty">Sem dados no período</div>';
    const vals = series.map((d) => d[key] || 0);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min = 0; max = max || 1; }
    const pad = (max - min) * 0.1; min = Math.max(0, min - pad); max += pad;
    const x = (i) => P.l + (i / Math.max(1, series.length - 1)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (max - min));
    const labelEvery = Math.ceil(series.length / 6);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de ${key}">
      ${ticks.map((t) => `<line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(Math.round(t))}</text>`).join('')}
      ${series.map((d, i) => i % labelEvery === 0 ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.day.slice(8, 10)}/${d.day.slice(5, 7)}</text>` : '').join('')}
      <polygon points="${P.l},${H - P.b} ${pts.join(' ')} ${x(vals.length - 1)},${H - P.b}" fill="${color}" opacity=".12"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="8" fill="transparent"><title>${series[i].day.split('-').reverse().join('/')}: ${v.toLocaleString('pt-BR')}</title></circle>`).join('')}
    </svg>`;
  }

  function bars(items, { labelKey, valueKey, colorKey }) {
    const max = Math.max(1, ...items.map((i) => i[valueKey] || 0));
    return items.map((i) => `<div style="margin:.55em 0">
      <div class="row" style="font-size:.88em"><span>${i[labelKey]}</span><span class="spacer"></span><strong>${(i[valueKey] || 0).toLocaleString('pt-BR')}</strong></div>
      <div style="height:8px;background:var(--surface-2);border-radius:99px;overflow:hidden"><div style="height:100%;width:${((i[valueKey] || 0) / max) * 100}%;background:${i[colorKey] || 'var(--primary)'};border-radius:99px"></div></div>
    </div>`).join('');
  }

  return { line, bars, fmt };
})();
