// A separate viewing mode for real tea rooms. Drawings are original plates
// made from published descriptions (tatami count, window type, designation).
// They are not copies of photographs. The golden room does not survive; its
// plate says so and follows the written record only.

const r1 = (n) => Math.round(n * 10) / 10;

function mud(id, base, straw) {
  const fleck = straw
    ? `<path d="M1 2h2M5 6h1.5M3 4h1" stroke="#d9c7a2" stroke-width=".35" opacity=".45"/>`
    : "";
  return `<pattern id="${id}" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="${base}"/>${fleck}<circle cx="2" cy="3" r=".55" fill="#000" opacity=".08"/><circle cx="7" cy="6" r=".4" fill="#fff" opacity=".06"/></pattern>`;
}

function defs(prefix) {
  return `<defs>
    ${mud(prefix + "mud", "#6d5648", true)}
    ${mud(prefix + "muddark", "#4a3b32", true)}
    ${mud(prefix + "plaster", "#d9d1c3", false)}
    ${mud(prefix + "soot", "#2a2622", false)}
    <pattern id="${prefix}tatami" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#c4b07a"/><path d="M0 3h6" stroke="#a89060" stroke-width=".35" opacity=".7"/></pattern>
    <pattern id="${prefix}tatami2" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#b7a56e"/><path d="M3 0v6" stroke="#8f784c" stroke-width=".35" opacity=".65"/></pattern>
    <pattern id="${prefix}reed" width="4" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="8" fill="#cbb892"/><path d="M1 0v8M3 0v8" stroke="#8d734c" stroke-width=".4"/></pattern>
    <pattern id="${prefix}wood" width="14" height="8" patternUnits="userSpaceOnUse"><rect width="14" height="8" fill="#6b4a30"/><path d="M0 2c4 1 8-1 14 0M0 5c5-1 9 1 14 0" fill="none" stroke="#3d2918" stroke-width=".4" opacity=".45"/></pattern>
    <pattern id="${prefix}gold" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#e2c56a"/><path d="M0 0l12 12M12 0L0 12" stroke="#f4e2a4" stroke-width=".3" opacity=".35"/></pattern>
    <pattern id="${prefix}check" width="28" height="28" patternUnits="userSpaceOnUse"><rect width="28" height="28" fill="#f3efe4"/><rect width="14" height="14" fill="#1d3f72"/><rect x="14" y="14" width="14" height="14" fill="#1d3f72"/></pattern>
    <linearGradient id="${prefix}day" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4efe4"/><stop offset="1" stop-color="#c4b49a"/></linearGradient>
    <radialGradient id="${prefix}glow" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#fff6e4" stop-opacity=".55"/><stop offset="1" stop-color="#fff6e4" stop-opacity="0"/></radialGradient>
  </defs>`;
}

function poly(points, attrs) {
  return `<polygon points="${points.map((n) => r1(n)).join(" ")}" ${attrs}/>`;
}

function win(prefix, kind, x, y, w, h) {
  if (kind === "shoji") {
    const bars = [];
    for (let i = 1; i < 4; i += 1) bars.push(`<line x1="${r1(x + (w * i) / 4)}" y1="${y}" x2="${r1(x + (w * i) / 4)}" y2="${r1(y + h)}" stroke="#8d7352" stroke-width="1"/>`);
    for (let i = 1; i < 5; i += 1) bars.push(`<line x1="${x}" y1="${r1(y + (h * i) / 5)}" x2="${r1(x + w)}" y2="${r1(y + (h * i) / 5)}" stroke="#8d7352" stroke-width="1"/>`);
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f7f1e4" stroke="#5c4632" stroke-width="3"/>${bars.join("")}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${prefix}glow)" opacity=".35"/></g>`;
  }
  if (kind === "shitaji") {
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#1c1612" stroke="#3a2e26" stroke-width="2"/><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" fill="url(#${prefix}reed)" opacity=".85"/></g>`;
  }
  if (kind === "renji") {
    const bars = [];
    const n = Math.max(3, Math.round(w / 7));
    for (let i = 0; i < n; i += 1) {
      const bx = x + 4 + i * ((w - 8) / n);
      bars.push(`<line x1="${r1(bx)}" y1="${y + 3}" x2="${r1(bx)}" y2="${r1(y + h - 3)}" stroke="#d7c39a" stroke-width="1.4"/>`);
    }
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#14110e" stroke="#4a3b30" stroke-width="2"/>${bars.join("")}</g>`;
  }
  if (kind === "kato") {
    const cx = x + w / 2;
    const d = `M${x} ${y + h} L${x} ${y + h * 0.42} C${x} ${y + h * 0.12} ${x + w * 0.22} ${y + h * 0.08} ${x + w * 0.38} ${y + h * 0.22} C${cx - w * 0.04} ${y} ${cx + w * 0.04} ${y} ${x + w * 0.62} ${y + h * 0.22} C${x + w * 0.78} ${y + h * 0.08} ${x + w} ${y + h * 0.12} ${x + w} ${y + h * 0.42} L${x + w} ${y + h} Z`;
    return `<g><path d="${d}" fill="#f4efe4" stroke="#5c4632" stroke-width="3"/><path d="${d}" fill="url(#${prefix}glow)" opacity=".4"/></g>`;
  }
  if (kind === "round") {
    const rx = w / 2;
    const ry = h / 2;
    return `<g><ellipse cx="${x + rx}" cy="${y + ry}" rx="${rx}" ry="${ry}" fill="#dfe8df" stroke="#3d4a3e" stroke-width="3"/><ellipse cx="${x + rx}" cy="${y + ry}" rx="${rx * 0.92}" ry="${ry * 0.92}" fill="#b7c4b4" opacity=".35"/></g>`;
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#efe6d4" stroke="#5c4632"/>`;
}

function scrollAndFlower(x, y, w, h, ink) {
  return `<g>
    <rect x="${x + w * 0.28}" y="${y + 18}" width="${w * 0.44}" height="${h * 0.46}" fill="#f7f1e6" stroke="#2a241c" stroke-width="1"/>
    <path d="M${x + w * 0.34} ${y + 36} h${w * 0.32} M${x + w * 0.36} ${y + 48} h${w * 0.22}" stroke="${ink ? "#1c1c1c" : "#8a8174"}" stroke-width="1" opacity=".7"/>
    <line x1="${x + w * 0.78}" y1="${y + h * 0.55}" x2="${x + w * 0.78}" y2="${y + h * 0.82}" stroke="#3d6a3a" stroke-width="1.2"/>
    <circle cx="${x + w * 0.78}" cy="${y + h * 0.52}" r="4.5" fill="#f2f2f0" stroke="#9aa394"/>
    <ellipse cx="${x + w * 0.72}" cy="${y + h * 0.78}" rx="10" ry="3" fill="#6d5438"/>
  </g>`;
}

function kettle(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <ellipse cx="0" cy="18" rx="16" ry="5" fill="#1a1a1a" opacity=".35"/>
    <path d="M-12 0 h24 v10 a12 10 0 0 1-24 0z" fill="#2c2c2c"/>
    <path d="M-12 2 h24" stroke="#6a6a6a" stroke-width="1"/>
    <path d="M12 4c8 0 10 6 6 10" fill="none" stroke="#2c2c2c" stroke-width="2"/>
    <rect x="-3" y="-8" width="6" height="8" fill="#3a3a3a"/>
  </g>`;
}

function plan(room) {
  const cells = room.plan;
  const n = cells.length;
  const m = cells[0].length;
  const s = 18;
  const ox = 1188;
  const oy = 36;
  const rects = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < m; x += 1) {
      const c = cells[y][x];
      if (!c) continue;
      const fill = c === "板" ? "#8d6a45" : c === "床" ? "#6b5338" : c === "炉" ? "#2a2420" : c === "点" ? "#d7c4a2" : "#cbb98a";
      rects.push(`<rect x="${ox + x * s}" y="${oy + y * s}" width="${s - 1}" height="${s - 1}" fill="${fill}" stroke="#3a2c20" stroke-width=".6"/>`);
      if (c !== "畳") rects.push(`<text x="${ox + x * s + 3}" y="${oy + y * s + 12}" font-size="8" fill="#1c140c">${c}</text>`);
    }
  }
  return `<g>${rects.join("")}<text x="${ox}" y="${oy + n * s + 14}" font-size="10" fill="#5c5146">${room.size}</text></g>`;
}

function interior(room) {
  const p = room.id;
  const wall = room.gold ? `url(#${p}gold)` : room.shoin ? `url(#${p}plaster)` : `url(#${p}mud)`;
  const dark = room.dim ? 0.28 : 0.08;
  const parts = [];
  parts.push(`<rect width="1400" height="880" fill="#1c1814"/>`);
  parts.push(poly([160, 70, 1240, 70, 1080, 250, 320, 250], `fill="${room.gold ? "#c6a45a" : "#3a3128"}"`));
  for (let i = 1; i <= 7; i += 1) {
    const t = i / 8;
    parts.push(`<line x1="${r1(160 + t * 1080)}" y1="70" x2="${r1(320 + t * 760)}" y2="250" stroke="${room.gold ? "#8a6a32" : "#241c16"}" stroke-width="2" opacity=".7"/>`);
  }
  parts.push(poly([320, 250, 1080, 250, 1080, 560, 320, 560], `fill="${wall}"`));
  parts.push(poly([160, 70, 320, 250, 320, 560, 80, 820], `fill="${room.gold ? "#b8924a" : "#5a4638"}"`));
  parts.push(poly([1240, 70, 1080, 250, 1080, 560, 1320, 820], `fill="${room.gold ? "#a8843e" : "#4e3c30"}"`));
  parts.push(poly([320, 560, 1080, 560, 1320, 820, 80, 820], `fill="url(#${p}tatami)"`));
  for (let i = 1; i < room.mats; i += 1) {
    const t = i / room.mats;
    const y = 560 + t * 180;
    const x1 = 320 - t * 200;
    const x2 = 1080 + t * 200;
    parts.push(`<line x1="${r1(x1)}" y1="${r1(y)}" x2="${r1(x2)}" y2="${r1(y)}" stroke="#6d5434" stroke-width="3"/>`);
  }
  parts.push(`<line x1="700" y1="560" x2="700" y2="820" stroke="#3a2c1c" stroke-width="7" opacity=".85"/>`);
  parts.push(`<line x1="320" y1="560" x2="1080" y2="560" stroke="#3a2c1c" stroke-width="4"/>`);

  const tokoX = room.tokoSide === "left" ? 340 : 760;
  const tokoW = room.tokoWide ? 300 : 250;
  const tokoTop = room.tokoLow ? 300 : 270;
  parts.push(`<rect x="${tokoX}" y="${tokoTop}" width="${tokoW}" height="${560 - tokoTop}" fill="${room.shoin ? "#e7e0d4" : "url(#" + p + "muddark)"}" stroke="#2a211a" stroke-width="2"/>`);
  parts.push(`<rect x="${tokoX}" y="${548}" width="${tokoW}" height="14" fill="${room.blackKamachi ? "#1a1a1a" : "url(#" + p + "wood)"}"/>`);
  parts.push(`<rect x="${tokoX - 8}" y="${tokoTop}" width="10" height="${560 - tokoTop}" fill="${room.gold ? "#7a1c1c" : "#6b4228"}"/>`);
  parts.push(scrollAndFlower(tokoX, tokoTop, tokoW, 560 - tokoTop, room.shoin));

  if (room.secondToko) {
    parts.push(`<rect x="360" y="400" width="160" height="160" fill="#efe8dc" stroke="#2a211a"/>`);
    parts.push(`<text x="372" y="430" font-size="13" fill="#3a342c">密庵</text>`);
    parts.push(`<path d="M378 450 h120 M384 468 h90 M390 486 h70" stroke="#1c1c1c" stroke-width="1"/>`);
  }
  if (room.scaleBoard) {
    parts.push(poly([620, 300, 760, 270, 760, 548, 700, 548], `fill="#7a5a38" stroke="#3a2a1c" stroke-width="2"`));
    parts.push(`<path d="M640 340 l90-20 M650 390 l80-16 M660 450 l70-12" stroke="#c4a074" stroke-width="1" opacity=".6"/>`);
  }
  if (room.katoBoard) {
    parts.push(win(p, "kato", 560, 390, 90, 120));
  }
  if (room.checker) {
    parts.push(`<rect x="1088" y="300" width="150" height="220" fill="url(#${p}check)" stroke="#1d3f72" stroke-width="4"/>`);
    parts.push(`<text x="1096" y="286" font-size="12" fill="#efe6d4">隣室・市松</text>`);
  }
  if (room.hibari) {
    parts.push(`<rect x="690" y="330" width="70" height="8" fill="#c4b08a"/>`);
    parts.push(`<rect x="700" y="360" width="50" height="6" fill="#c4b08a"/>`);
    parts.push(`<line x1="690" y1="330" x2="700" y2="250" stroke="#6b5344" stroke-width="1"/>`);
  }
  if (room.transom) {
    parts.push(`<rect x="760" y="258" width="250" height="22" fill="#1c1c1c"/>`);
    parts.push(`<circle cx="800" cy="269" r="6" fill="none" stroke="#d4c4a4"/><circle cx="830" cy="269" r="6" fill="none" stroke="#d4c4a4"/><path d="M860 263 l8 6 l8-6 l8 6" fill="none" stroke="#d4c4a4"/>`);
  }

  for (const w of room.windows) parts.push(win(p, w.kind, w.x, w.y, w.w, w.h));

  if (room.nijiri) {
    const nx = room.nijiri.x;
    const ny = room.nijiri.y;
    parts.push(`<rect x="${nx}" y="${ny}" width="92" height="78" rx="2" fill="#120e0c" stroke="#5a4636" stroke-width="3"/>`);
    parts.push(`<text x="${nx}" y="${ny - 8}" font-size="11" fill="#efe6d4">躙口</text>`);
  }
  if (room.hearth === "corner") {
    parts.push(`<rect x="430" y="600" width="70" height="54" fill="#1a1612" stroke="#3a3028" stroke-width="3"/>`);
    parts.push(kettle(465, 612, 1));
  } else if (room.hearth === "furo") {
    parts.push(`<rect x="620" y="640" width="54" height="40" fill="#6a3a28" stroke="#2a1810" stroke-width="2"/>`);
    parts.push(kettle(647, 636, 0.8));
  }
  if (room.halfBoard) {
    parts.push(poly([500, 620, 760, 600, 820, 760, 460, 790], `fill="#8d6a45" stroke="#4a3424" stroke-width="2" opacity=".9"`));
    parts.push(`<text x="560" y="700" font-size="13" fill="#f4ead8">半板</text>`);
  }
  if (room.gold) {
    parts.push(`<rect x="500" y="300" width="18" height="260" fill="#7a1c1c"/>`);
    parts.push(`<rect x="900" y="300" width="18" height="260" fill="#7a1c1c"/>`);
    parts.push(`<circle cx="700" cy="120" r="16" fill="#f4e2a4" stroke="#7a1c1c" stroke-width="3"/>`);
  }
  if (room.garden) {
    parts.push(win(p, "shoji", 360, 300, 220, 200));
    parts.push(`<rect x="372" y="312" width="196" height="80" fill="#7fa07a" opacity=".55"/>`);
  }

  parts.push(`<rect x="320" y="250" width="760" height="310" fill="#000" opacity="${dark}"/>`);
  if (room.windows[0]) {
    const w = room.windows[0];
    parts.push(`<ellipse cx="${w.x + w.w / 2}" cy="${w.y + w.h / 2}" rx="${w.w}" ry="${w.h}" fill="url(#${p}glow)" opacity="${room.dim ? 0.45 : 0.75}"/>`);
  }
  parts.push(plan(room));
  return parts.join("");
}

const ROOMS = [
  {
    id: "taian",
    name: "待庵",
    reading: "たいあん",
    place: "妙喜庵、京都府大山崎町",
    maker: "千利休の好み",
    when: "1580年代",
    status: "国宝",
    size: "二畳・隅炉",
    mats: 2,
    dim: true,
    tokoSide: "right",
    tokoLow: true,
    nijiri: { x: 150, y: 640 },
    hearth: "corner",
    windows: [{ kind: "shitaji", x: 400, y: 320, w: 70, h: 48 }],
    note: "現存する草庵茶室で、利休の好みが伝わる唯一の遺構とされる。二畳の隅炉。床は藁すさを散らした荒壁で、床天井は畳から約五尺三寸と低い。",
    look: ["躙口", "下地窓は葭が二、三本", "化粧屋根裏", "床框は節のある丸太"],
    plan: [["床", "畳"], ["炉", "畳"]],
  },
  {
    id: "joan",
    name: "如庵",
    reading: "じょあん",
    place: "有楽苑、愛知県犬山市",
    maker: "織田有楽",
    when: "元和年間頃",
    status: "国宝",
    size: "二畳半台目・下座床",
    mats: 3,
    dim: true,
    tokoSide: "left",
    tokoLow: true,
    scaleBoard: true,
    katoBoard: true,
    nijiri: { x: 150, y: 650 },
    hearth: "furo",
    windows: [
      { kind: "renji", x: 900, y: 340, w: 36, h: 90 },
      { kind: "renji", x: 946, y: 340, w: 36, h: 90 },
    ],
    note: "有楽の草庵。二畳半に台目を足した下座床。炉先の板を火灯形に抜き、床脇の壁は三角の鱗板で斜行させる。点前座脇の竹を詰めた連子は有楽窓と呼ばれる。",
    look: ["火灯形", "鱗板", "有楽窓", "腰に古暦"],
    plan: [["床", "畳", "畳"], ["点", "炉", "畳"]],
  },
  {
    id: "konnichian",
    name: "今日庵",
    reading: "こんにちあん",
    place: "裏千家、京都市上京区",
    maker: "千宗旦",
    when: "1646年頃",
    status: "茶室",
    size: "二畳",
    mats: 2,
    dim: true,
    tokoSide: "right",
    tokoLow: true,
    hearth: "corner",
    windows: [{ kind: "shitaji", x: 420, y: 340, w: 64, h: 40 }],
    note: "宗旦の二畳。裏千家の名はここから出る。利休の聚楽屋敷の席を受け、向板を置いて動きを助けた、ごく小さい席。",
    look: ["二畳", "向板", "聚楽屋敷の系譜"],
    plan: [["床", "畳"], ["畳", "炉"]],
  },
  {
    id: "kankyuan",
    name: "官休庵",
    reading: "かんきゅうあん",
    place: "武者小路千家、京都市上京区",
    maker: "一翁宗守",
    when: "1667年頃",
    status: "茶室",
    size: "一畳台目",
    mats: 2,
    dim: true,
    tokoSide: "right",
    tokoLow: true,
    halfBoard: true,
    nijiri: { x: 160, y: 660 },
    hearth: "furo",
    windows: [{ kind: "renji", x: 430, y: 360, w: 48, h: 70 }],
    note: "一畳に台目を足した最小級の席。客と点前のあいだに半板を置き、主客の緩衝にしている。",
    look: ["一畳台目", "半板", "主客の距離"],
    plan: [["床", "点"], ["畳", "板"]],
  },
  {
    id: "fushinan",
    name: "不審庵",
    reading: "ふしんあん",
    place: "表千家、京都市上京区",
    maker: "千少庵",
    when: "1608年頃",
    status: "茶室",
    size: "平三畳台目",
    mats: 3,
    tokoSide: "right",
    nijiri: { x: 170, y: 630 },
    hearth: "furo",
    windows: [
      { kind: "shitaji", x: 400, y: 330, w: 80, h: 50 },
      { kind: "shoji", x: 560, y: 420, w: 70, h: 90 },
    ],
    note: "少庵の平三畳台目。風炉先に茶道口を取り、点前の出入りを炉の先から回す。表千家の中心の席。",
    look: ["平三畳台目", "風炉先の茶道口"],
    plan: [["畳", "畳", "床"], ["畳", "炉", "点"]],
  },
  {
    id: "mittan",
    name: "密庵席",
    reading: "みったんせき",
    place: "大徳寺龍光院、京都市北区",
    maker: "小堀遠州の好みと伝える",
    when: "江戸前期",
    status: "国宝",
    size: "四畳半台目",
    mats: 4,
    shoin: true,
    tokoSide: "right",
    tokoWide: true,
    blackKamachi: true,
    secondToko: true,
    transom: true,
    hearth: "furo",
    windows: [{ kind: "shoji", x: 360, y: 300, w: 120, h: 160 }],
    note: "書院を基調に、点前座だけ草庵へ落とした四畳半台目。黒漆の真塗框、張付壁、違い棚の松皮菱と七宝つなぎ。墨蹟「密庵」のための浅い床がもう一つある。",
    look: ["密庵墨蹟の床", "真塗框", "落天井の点前座", "釿目の杉丸太"],
    plan: [["床", "畳", "畳", "畳"], ["床", "畳", "点", "炉"]],
  },
  {
    id: "hasso",
    name: "八窓席",
    reading: "はっそうせき",
    place: "南禅寺金地院、京都市左京区",
    maker: "崇伝が小堀遠州に指図させた、と伝える",
    when: "1628年頃",
    status: "重要文化財",
    size: "三畳台目",
    mats: 3,
    tokoSide: "right",
    blackKamachi: true,
    hibari: true,
    nijiri: { x: 480, y: 620 },
    hearth: "furo",
    windows: [
      { kind: "shitaji", x: 360, y: 280, w: 140, h: 36 },
      { kind: "renji", x: 360, y: 330, w: 140, h: 50 },
      { kind: "renji", x: 980, y: 300, w: 70, h: 36 },
      { kind: "renji", x: 980, y: 360, w: 70, h: 70 },
      { kind: "shitaji", x: 700, y: 280, w: 50, h: 36 },
    ],
    note: "三畳台目。躙口を隅ではなく中央寄りに開け、床と点前座を並べる。名は八窓だが、室内で数えると六窓という解説もある。点前の背後は連子窓で明るい。",
    look: ["床と点前を並べる", "雲雀棚", "椿の中柱", "赤松皮付の床柱"],
    plan: [["畳", "床", "点"], ["畳", "畳", "炉"]],
  },
  {
    id: "shokintei",
    name: "松琴亭",
    reading: "しょうきんてい",
    place: "桂離宮、京都市西京区",
    maker: "八条宮智仁親王にはじまり、茶室は遠州の手法とみる解説がある",
    when: "17世紀",
    status: "皇室関連・非公開が原則",
    size: "茶室は三畳台目",
    mats: 3,
    checker: true,
    nijiri: { x: 180, y: 640 },
    hearth: "furo",
    windows: [
      { kind: "shitaji", x: 860, y: 280, w: 80, h: 28 },
      { kind: "renji", x: 860, y: 316, w: 80, h: 36 },
      { kind: "shoji", x: 960, y: 360, w: 70, h: 80 },
      { kind: "round", x: 400, y: 320, w: 90, h: 90 },
    ],
    note: "母屋の一の間と二の間の境に、白と藍の加賀奉書による市松がある。東に接する茶室だけが桂離宮の草庵で、三畳台目。点前座に色紙窓、風炉先、突上窓が集まる。絵は茶室から隣室の市松をのぞいた構図。",
    look: ["三畳台目の草庵", "八つの窓のうち四つが点前", "隣室の市松"],
    plan: [["畳", "畳", "点"], ["畳", "炉", "床"]],
  },
  {
    id: "bosen",
    name: "忘筌",
    reading: "ぼうせん",
    place: "大徳寺孤篷庵、京都市北区",
    maker: "小堀遠州の最晩年の作と伝える",
    when: "江戸前期",
    status: "重要文化財",
    size: "八畳に床・点前・相伴を足して十二畳",
    mats: 4,
    shoin: true,
    tokoSide: "right",
    tokoWide: true,
    blackKamachi: true,
    garden: true,
    windows: [{ kind: "shoji", x: 1000, y: 300, w: 70, h: 180 }],
    note: "八畳に床一畳、点前一畳、相伴三畳を足した広い書院の席。床と点前を並べるのは遠州が繰り返した形。草庵の二畳とは反対の端にある。",
    look: ["十二畳の構成", "床と点前が並ぶ", "書院の光"],
    plan: [["床", "点", "畳", "畳"], ["畳", "畳", "畳", "畳"]],
  },
  {
    id: "golden",
    name: "黄金の茶室",
    reading: "おうごんのちゃしつ",
    place: "現存しない。大坂城と聚楽第の記録",
    maker: "豊臣秀吉",
    when: "天正年間（1585年前後）",
    status: "現存せず・記録にもとづく図",
    size: "三畳と伝える",
    mats: 3,
    gold: true,
    tokoSide: "right",
    tokoLow: false,
    hearth: "furo",
    windows: [{ kind: "shoji", x: 380, y: 300, w: 140, h: 160 }],
    note: "秀吉の持ち運びできる黄金の席。金箔と朱塗だった、と当時の記録が伝える。建物は残っていない。この絵は記録の範囲だけで、どこかの復元展示の模写ではない。",
    look: ["金箔", "朱の柱", "躙口を持たない座敷", "現存しない"],
    plan: [["畳", "畳", "床"], ["畳", "炉", "点"]],
  },
];

function plate(room, index) {
  return `<figure class="tea-room${index === 0 ? " is-on" : ""}" id="tea-${room.id}" data-tea="${room.id}">
    <svg class="tea-plate" viewBox="0 0 1400 880" role="img" aria-labelledby="tea-title-${room.id}">
      <title id="tea-title-${room.id}">${room.name}（${room.reading}）</title>
      ${defs(room.id)}
      ${interior(room)}
    </svg>
    <figcaption>
      <p class="tea-kicker">${room.status}</p>
      <h3>${room.name}<span>${room.reading}</span></h3>
      <p class="tea-meta">${room.place}</p>
      <p class="tea-meta">${room.maker} · ${room.when} · ${room.size}</p>
      <p>${room.note}</p>
      <ul>${room.look.map((item) => `<li>${item}</li>`).join("")}</ul>
    </figcaption>
  </figure>`;
}

export function teaRoomSection() {
  const nav = ROOMS.map((room, index) => `<button type="button" class="tea-jump${index === 0 ? " is-on" : ""}" data-tea-jump="${room.id}"><span>${room.name}</span><small>${room.size}</small></button>`).join("");
  return `<section id="tearoom" class="tearoom" aria-labelledby="tearoom-title">
    <header class="tea-bar">
      <p class="tea-kicker">別モード</p>
      <h2 id="tearoom-title">茶室</h2>
      <p class="tea-lead">実在の席を、解説に残る間取りで描いた。写真の模写ではない。</p>
      <a class="tea-back" href="#top">書架に戻る</a>
    </header>
    <nav class="tea-list" aria-label="茶室">${nav}</nav>
    <div class="tea-stage">${ROOMS.map(plate).join("")}</div>
  </section>`;
}

export const TEA_ROOM_IDS = ROOMS.map((room) => room.id);
