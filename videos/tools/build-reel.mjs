// Gera compositions/photo.html e compositions/captions.html a partir do texto abaixo.
// Uso: node tools/build-reel.mjs   (rode de dentro de videos/)
import { writeFileSync } from "node:fs";

export const TEXT =
  "Ninguém vê o quanto você luta em silêncio. Mas o mesmo mundo que duvidou vai perguntar como você conseguiu. Então continua. Quem desiste no meio nunca descobre o final.";
// Palavras que ganham destaque (zoom na foto + palavra maior)
const EMPHASIS = new Set(["ninguém", "silêncio", "duvidou", "conseguiu", "continua", "desiste", "final"]);
const START = 0.25;

const words = [];
let t = START;
for (const raw of TEXT.split(/\s+/)) {
  const clean = raw.replace(/[.,!?;:]/g, "");
  const key = clean.toLowerCase();
  const endsSentence = /[.!?]$/.test(raw);
  const emph = EMPHASIS.has(key);
  const dur = +(0.36 + clean.length * 0.018 + (emph ? 0.18 : 0)).toFixed(2);
  words.push({ id: `w${words.length}`, text: clean.toUpperCase(), start: +t.toFixed(2), dur, emph });
  t += dur + (endsSentence ? 0.45 : 0);
}
export const CAPTIONS_END = +t.toFixed(2);
const DUR = CAPTIONS_END;

const captions = `<template>
  <style>
    #root { position: absolute; inset: 0; }
    .cap-word {
      position: absolute; left: 0; right: 0; top: var(--cap-top, 1060px);
      text-align: center; overflow: visible;
    }
    .cap-word span {
      display: inline-block;
      font-family: "League Gothic", sans-serif;
      font-size: 132px; line-height: 1; letter-spacing: 0.01em;
      color: var(--cap-color, #ffc72c);
      text-shadow: 0 4px 18px rgba(0,0,0,.55);
    }
    .cap-word.emph span { font-size: 168px; }
  </style>
  <div id="root" data-composition-id="captions" data-width="1080" data-height="1920">
${words
  .map(
    (w) =>
      `    <div id="${w.id}" class="clip cap-word${w.emph ? " emph" : ""}" data-start="${w.start}" data-duration="${w.dur}"><span>${w.text}</span></div>`,
  )
  .join("\n")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${words
  .map(
    (w) =>
      `    tl.fromTo("#${w.id} span", { scale: ${w.emph ? 1.25 : 1.1}, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.09, ease: "power3.out" }, ${w.start});`,
  )
  .join("\n")}
    window.__timelines["captions"] = tl;
  </script>
</template>
`;

const punches = words.filter((w) => w.emph);
const photo = `<template>
  <style>
    #root { position: absolute; inset: 0; overflow: hidden; background: #000; }
    #photo-frame { position: absolute; inset: 0; }
    #photo-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 30%; }
    #photo-shade {
      position: absolute; inset: 0;
      background: linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,.35) 75%, rgba(0,0,0,.7) 100%);
    }
  </style>
  <div id="root" data-composition-id="photo" data-width="1080" data-height="1920">
    <div id="photo-frame">
      <img id="photo-img" src="assets/modelo.jpg" data-var-src="photo" alt="" />
    </div>
    <div id="photo-shade"></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    // Push-in lento durante todo o vídeo
    tl.fromTo("#photo-img", { scale: 1.04, yPercent: 0 }, { scale: 1.16, yPercent: -1.5, duration: ${DUR}, ease: "none" }, 0);
    // Punch-ins nas palavras de destaque
${punches
  .map(
    (w, i) =>
      `    tl.fromTo("#photo-frame", { scale: 1 }, { scale: ${i % 2 ? 1.07 : 1.05}, x: ${i % 2 ? 14 : -14}, duration: 0.12, ease: "power3.out" }, ${w.start});\n    tl.to("#photo-frame", { scale: 1, x: 0, duration: 0.5, ease: "power2.inOut" }, ${+(w.start + w.dur).toFixed(2)});`,
  )
  .join("\n")}
    window.__timelines["photo"] = tl;
  </script>
</template>
`;

writeFileSync("compositions/captions.html", captions);
writeFileSync("compositions/photo.html", photo);
console.log(JSON.stringify({ words: words.length, captionsEnd: CAPTIONS_END }));
