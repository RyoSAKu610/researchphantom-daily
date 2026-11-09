// One hundred study rooms. Each visit opens one. The names follow published
// findings about attention, light, sound, air, and memory. A room is a
// reminder of that finding, not a claim that the pixels themselves teach.
//
// Sources are real papers and reports. The one-line note is a plain
// restatement, not a quotation.

const INK = "#f4f0e8";
const ACCENT_INK = "#1c160b";

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(r, g, b) {
  const channel = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function mix(a, b, t) {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  return rgbToHex(
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  );
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

// Background paintings. Commas are fine inside a custom property; semicolons
// are not, so every scene is a comma-separated background list.
function scene(motif, glow, index) {
  const x = 12 + (index * 17) % 70;
  const y = 8 + (index * 13) % 48;
  const x2 = 80 - (index * 11) % 40;
  const g = glow;
  const soft = `rgba(${g},.20)`;
  const faint = `rgba(${g},.10)`;
  switch (motif) {
    case "canopy":
      return `radial-gradient(460px 240px at ${x}% ${y}%, ${soft}, transparent 70%), radial-gradient(380px 280px at ${x2}% 78%, ${faint}, transparent 72%)`;
    case "mist":
      return `linear-gradient(180deg, transparent 0%, rgba(${g},.16) 42%, transparent 70%), radial-gradient(520px 180px at 50% 78%, ${faint}, transparent 70%)`;
    case "water":
      return `linear-gradient(${100 + (index % 5) * 8}deg, transparent 0 38%, rgba(${g},.14) 49%, transparent 60%), radial-gradient(640px 200px at ${x}% 86%, ${soft}, transparent 70%)`;
    case "rain":
      return `repeating-linear-gradient(${96 + (index % 4) * 3}deg, transparent 0 10px, rgba(${g},.13) 11px, transparent 12px), linear-gradient(180deg, transparent, rgba(${g},.12))`;
    case "paper":
      return `repeating-linear-gradient(0deg, transparent 0 3px, rgba(${g},.05) 4px), repeating-linear-gradient(90deg, transparent 0 5px, rgba(${g},.04) 6px)`;
    case "lamp":
      return `radial-gradient(380px 280px at ${28 + (index % 5) * 8}% ${62 + (index % 3) * 6}%, ${soft}, transparent 68%)`;
    case "moon":
      return `radial-gradient(220px 220px at ${70 + (index % 4) * 4}% ${16 + (index % 3) * 4}%, rgba(${g},.28), transparent 62%), radial-gradient(800px 400px at 50% 120%, ${faint}, transparent 60%)`;
    case "dawn":
      return `linear-gradient(180deg, transparent 0 46%, rgba(${g},.20) 72%, transparent 100%), radial-gradient(700px 180px at 50% 78%, ${soft}, transparent 70%)`;
    case "stone":
      return `radial-gradient(520px 320px at ${x}% ${40 + (index % 4) * 8}%, ${faint}, transparent 74%)`;
    case "shaft":
      return `linear-gradient(${108 + (index % 5) * 6}deg, transparent 0 42%, rgba(${g},.16) 50%, transparent 58%)`;
    case "ink":
      return `radial-gradient(900px 520px at ${x2}% -10%, ${faint}, transparent 60%), radial-gradient(400px 400px at ${x}% 90%, rgba(${g},.12), transparent 70%)`;
    case "snow":
      return `radial-gradient(2px 2px at 12% 22%, rgba(${g},.45), transparent 60%), radial-gradient(2px 2px at 70% 18%, rgba(${g},.35), transparent 60%), radial-gradient(2px 2px at 40% 64%, rgba(${g},.3), transparent 60%), radial-gradient(2px 2px at 84% 72%, rgba(${g},.28), transparent 60%)`;
    case "tea":
      return `radial-gradient(480px 260px at 50% 88%, ${soft}, transparent 70%)`;
    case "glass":
      return `repeating-linear-gradient(90deg, transparent 0 72px, rgba(${g},.08) 73px, transparent 74px), repeating-linear-gradient(0deg, transparent 0 56px, rgba(${g},.06) 57px, transparent 58px)`;
    case "horizon":
      return `linear-gradient(180deg, transparent 0 58%, rgba(${g},.22) 59%, transparent 64%)`;
    case "hearth":
      return `radial-gradient(640px 220px at 50% 110%, ${soft}, transparent 70%)`;
    case "star":
      return `radial-gradient(1.5px 1.5px at 18% 20%, rgba(${g},.7), transparent 70%), radial-gradient(1.5px 1.5px at 46% 14%, rgba(${g},.5), transparent 70%), radial-gradient(1.5px 1.5px at 78% 28%, rgba(${g},.55), transparent 70%), radial-gradient(1.5px 1.5px at 62% 46%, rgba(${g},.4), transparent 70%), radial-gradient(1.5px 1.5px at 28% 58%, rgba(${g},.35), transparent 70%)`;
    case "cloud":
      return `radial-gradient(280px 140px at ${x}% 24%, ${soft}, transparent 70%), radial-gradient(340px 160px at ${x2}% 36%, ${faint}, transparent 72%)`;
    case "grain":
      return `repeating-radial-gradient(circle at 20% 20%, rgba(${g},.08) 0 1px, transparent 2px 7px)`;
    case "ripple":
      return `repeating-radial-gradient(circle at ${x}% 80%, transparent 0 18px, rgba(${g},.13) 19px, transparent 22px 46px)`;
    default:
      return "none";
  }
}

// id, name, note, source, motif, background, accent
const SPECS = [
  ["cedar-hall", "杉の閲覧室", "窓の外の緑は、向けた注意をいったん休ませる。", "Berman, Jonides & Kaplan, 2008", "canopy", "#10150f", "#d7c98a"],
  ["moss-court", "苔の中庭", "短い自然の光景のあと、注意の課題が戻りやすい。", "Berman, Jonides & Kaplan, 2008", "canopy", "#0e1612", "#c9d7b4"],
  ["hinoki-aisle", "檜の並木", "自然は、疲れやすい自発的注意の代わりに、やさしい注意を使う。", "Kaplan, 1995", "canopy", "#12170f", "#e4d2a2"],
  ["fern-corner", "羊歯の隅", "回復しやすい環境は、広がり、距離、魅力、そこにある感じを持つ。", "Kaplan & Kaplan, 1989", "mist", "#101611", "#d5e0c6"],
  ["bamboo-gallery", "竹の回廊", "緑の見える窓は、壁だけの窓より回復が早かった。", "Ulrich, 1984", "shaft", "#0f1612", "#d8e2c4"],
  ["cedar-mist", "杉の薄霧", "森林の中の歩行は、都市より緊張の指標が下がった。", "Park et al., 2010", "mist", "#121814", "#e6d7b0"],
  ["canopy-desk", "梢の机", "木の見える寮の窓は、注意の残りに差が出た。", "Tennessen & Cimprich, 1995", "canopy", "#10140f", "#dcc98a"],
  ["leaf-light", "葉漏れ日", "自然の写真を見る休憩は、建物の写真より注意が戻った。", "Berto, 2005", "shaft", "#14180f", "#e8d59a"],
  ["root-library", "根の図書室", "緑の多い屋外のあと、注意の困難が軽くなった報告がある。", "Kuo & Taylor, 2004", "canopy", "#101610", "#cfe0c0"],
  ["fir-night", "樅の夜", "数日を自然の中で過ごしたあと、創造の課題が上がった。", "Atchley, Strayer & Atchley, 2012", "star", "#0d1210", "#d5d0b8"],
  ["rain-eave", "雨の軒", "自然の音は、騒音のあとよりストレスからの戻りが速い。", "Alvarsson, Wiens & Nilsson, 2010", "rain", "#101418", "#c9d5e4"],
  ["stream-room", "せせらぎの間", "鳥の声は、回復を感じさせる音として繰り返し選ばれる。", "Ratcliffe, Gatersleben & Sowden, 2013", "ripple", "#101614", "#d5e2c8"],
  ["tide-desk", "潮の机", "覚えた場所にいるとき、その記憶は戻りやすい。", "Godden & Baddeley, 1975", "water", "#0e1418", "#c5d6e6"],
  ["lake-window", "湖の窓", "水辺の音は、都市の騒音より回復的だと評される。", "Medvedev, Shepherd & Hautus, 2015", "horizon", "#10161a", "#d4e0ea"],
  ["harbor-lamp", "港の灯", "窓の外が見える席は、仕事の満足と関係した。", "Leather et al., 1998", "lamp", "#12160f", "#e6d2a4"],
  ["reed-study", "葦の書斎", "会話の騒音は、意味のない音より作業を削る。", "Banbury & Berry, 2005", "water", "#101612", "#d7e4d0"],
  ["well-court", "井戸の中庭", "予測できる水音は、突然の会話より侵入が少ない。", "Jahncke et al., 2011", "ripple", "#0f1518", "#c9dae6"],
  ["fog-bay", "霧の湾", "歌詞のある音楽は、大人の読解を下げやすい、というまとめがある。", "Kämpfe, Sedlmeier & Renkewitz, 2011", "mist", "#12161a", "#d5dbe6"],
  ["moon-tide", "月と潮", "景色が変わると、文脈に結び付いた記憶も変わる。", "Smith, 1988", "moon", "#10141c", "#d6d4ea"],
  ["deep-basin", "深い水盆", "青みは発想の課題に、赤みは細部の照合に寄った。", "Mehta & Zhu, 2009", "ink", "#0e1218", "#c5d4ea"],
  ["first-light", "一番の光", "短い波長の光は、覚醒を直接押し上げる。", "Lockley et al., 2006", "dawn", "#14160f", "#f0e2b4"],
  ["clerestory", "高窓", "昼の明るい光は、眠気を下げて課題を支える。", "Phipps-Nelson et al., 2003", "shaft", "#12160f", "#efe0b0"],
  ["paper-dawn", "紙の夜明け", "照度を上げると、主観的な覚醒が上がる。", "Smolders, de Kort & Cluitmans, 2012", "dawn", "#16140f", "#f2e0b8"],
  ["east-desk", "東の机", "青みの強い白い光は、日中の作業場で覚醒に差を出した。", "Viola et al., 2008", "dawn", "#12161a", "#d5e2f0"],
  ["solstice-room", "至点の部屋", "光は、認知に関わる脳の働きを変調する。", "Vandewalle, Maquet & Dijk, 2009", "shaft", "#14120f", "#f0d8b0"],
  ["daylight-stack", "昼光の棚", "窓と昼光は、睡眠や健康の自己評価と関係した。", "Boubekri et al., 2014", "horizon", "#14160f", "#efe4c4"],
  ["amber-hour", "琥珀色の時間", "光はメラトニンと覚醒と、認知の成績に及ぶ。", "Chellappa et al., 2011", "lamp", "#16120e", "#f0c98a"],
  ["high-noon-nook", "正午の隅", "明るい光そのものが、覚醒を上げる。", "Badia et al., 1991", "shaft", "#16160f", "#f3e6c0"],
  ["pale-south", "薄い南窓", "教室の光、個別、刺激の水準は、学習の進捗と関係した。", "Barrett et al., 2015", "glass", "#121614", "#e4ecd4"],
  ["glass-morning", "硝子の朝", "光の覚醒作用は、夜だけでなく日中の認知にも関わる。", "Cajochen, 2007", "dawn", "#141610", "#f2e6c8"],
  ["lamp-pool", "灯の池", "薄暗さは、制約が減った感じとともに発想を広げる。", "Steidle & Werth, 2013", "lamp", "#14110e", "#e8c48a"],
  ["candle-carrel", "蝋の個室", "暖かい照明と冷たい照明で、認知課題の成績は分かれる。", "Baron, Rea & Daniels, 1992", "lamp", "#16120e", "#f0d0a0"],
  ["ink-night", "墨の夜", "室内の照明は、気分と認知の両方に触れる。", "Knez, 1995", "ink", "#101218", "#d0d6ea"],
  ["low-shelf", "低い棚", "天井が低いと細部へ、高いと関係づけへ寄る。", "Meyers-Levy & Zhu, 2007", "stone", "#141310", "#e4d4b4"],
  ["ember-desk", "熾きの机", "ほどよい陽性の感情は、思考の幅を広げる。", "Fredrickson, 2001", "hearth", "#160f0c", "#f0b48a"],
  ["after-hours", "閉館後", "歩くことは、座ったままより発想の点を上げた。", "Oppezzo & Schwartz, 2014", "moon", "#121318", "#d8d4e6"],
  ["quiet-loft", "静かなロフト", "会話は、意味のない騒音より作業記憶を削りやすい。", "Banbury & Berry, 2005", "stone", "#131410", "#ddd4c0"],
  ["single-wick", "一本の芯", "余計な飾りは、学習に要らない負荷を増やす。", "Choi, van Merriënboer & Paas, 2014", "lamp", "#14110e", "#f0d8a8"],
  ["night-margin", "余白の夜", "割り込みは、作業の再開を遅くする。", "Altmann & Trafton, 2002", "ink", "#101014", "#d8d4e0"],
  ["doorless", "扉のない間", "戸口をまたぐと、直前の目的を忘れやすい。", "Radvansky, Krawietz & Tamplin, 2011", "horizon", "#14120f", "#e6d4b4"],
  ["laid-paper", "局紙の机", "手で書いたノートは、キーボードより概念の点が高かった。", "Mueller & Oppenheimer, 2014", "paper", "#16140f", "#f0e2c4"],
  ["margin-notes", "余白の注", "練習で思い出すことは、読み返すより記憶が残る。", "Roediger & Karpicke, 2006", "paper", "#15130f", "#ead9b4"],
  ["index-card", "カード箱", "思い出す練習を重ねるほど、長い保持が残る。", "Karpicke & Roediger, 2008", "grain", "#16140f", "#f2e0b8"],
  ["folio-desk", "折帖の机", "間隔を空けた復習は、一度に詰めるより残る。", "Cepeda et al., 2006", "paper", "#141210", "#e8dcc4"],
  ["sumi-stone", "硯の脇", "勉強法ごとに、証拠の強さははっきり違う。", "Dunlosky et al., 2013", "stone", "#121418", "#d4dcea"],
  ["thread-bound", "糸綴じ", "自分の言葉で説明すると、理解が点検される。", "Chi et al., 1994", "paper", "#16130f", "#f0dcc0"],
  ["press-room", "印刷室", "自分で作った答えは、与えられた文より残ることがある。", "Slamecka & Graf, 1978", "grain", "#14120e", "#e8d4a8"],
  ["gall-ink", "没食子のインク", "テストの効果は、実験室の外でも繰り返し確認されている。", "Roediger & Karpicke, 2006", "ink", "#101216", "#d2d8ea"],
  ["quiet-proof", "校正の灯", "赤みは細部の照合に寄り、青は発想に寄った。", "Mehta & Zhu, 2009", "lamp", "#1a1212", "#f0c2b4"],
  ["colophon", "奥付の席", "学んだ部屋の様子は、思い出すときの手がかりになる。", "Smith, 1988", "paper", "#141310", "#e6d8c0"],
  ["tea-hearth", "茶の炉端", "暑すぎず寒すぎない室温は、作業の成績と結びつく。", "Lan, Wargocki & Lian, 2011", "hearth", "#16110e", "#f0c898"],
  ["kettle-hour", "湯の時間", "換気と温熱は、事務所の成績を左右する中心の問いである。", "Wargocki & Wyon, 2017", "tea", "#14120f", "#f2d8b0"],
  ["clay-cup", "土の茶碗", "二酸化炭素の高い部屋では、認知の得点が下がった。", "Satish et al., 2012", "tea", "#141310", "#e8d0b0"],
  ["green-air", "緑の空気", "換気の良い建物では、認知機能の得点が高かった。", "Allen et al., 2016", "glass", "#101612", "#d5e6c8"],
  ["sun-brick", "日向の煉瓦", "室内環境の質は、健康と生産性の両方に効く。", "Fisk, 2000", "dawn", "#16130f", "#f0d2a4"],
  ["hearth-shadow", "炉の影", "熱と騒音と照明は、同時に認知の成績へ触れる。", "Hygge & Knez, 2001", "hearth", "#140f0c", "#e8b890"],
  ["wool-chair", "毛の椅子", "換気量は、作業の速度と関係する。", "Seppanen, Fisk & Lei, 2006", "tea", "#15120f", "#ead4b4"],
  ["brazier", "火鉢の間", "軽い陽性の気分は、その後の思考を柔らかくする。", "Fredrickson, 2001", "hearth", "#160e0c", "#f0c090"],
  ["steam-window", "湯気の窓", "植物のある部屋は、課題への反応に差が出ることがある。", "Lohr, Pearson-Mims & Goodwin, 1996", "mist", "#101410", "#d8e6cc"],
  ["honey-lamp", "蜜の灯", "暖色の薄暗さは、発想が広がりやすい照明に近い。", "Steidle & Werth, 2013", "lamp", "#16110d", "#f0d090"],
  ["stone-seat", "石の席", "瞑想の訓練は、注意の調節と監視に関わる。", "Lutz et al., 2008", "stone", "#121311", "#ddd6c8"],
  ["raked-gravel", "砂紋", "短いマインドフルネスのあと、認知の得点が上がった実験がある。", "Zeidan et al., 2010", "grain", "#131410", "#e4dcc8"],
  ["empty-eave", "空の軒", "瞑想の訓練は、注意と情動の調節に繰り返し関係する。", "Tang, Hölzel & Posner, 2015", "horizon", "#101214", "#d8dce6"],
  ["bell-interval", "鐘のあいだ", "休息を挟むことは、覚えたことの固定に関わる。", "Diekelmann & Born, 2010", "stone", "#12110f", "#e6d8c0"],
  ["sleep-gate", "眠りの門", "睡眠は、覚えたことを定着させる役割を持つ。", "Rasch & Born, 2013", "moon", "#101218", "#d4d2e6"],
  ["one-cushion", "一畳", "視覚のごたごたを減らすと、要らない認知負荷が下がる。", "Choi, van Merriënboer & Paas, 2014", "stone", "#141310", "#e8e0d0"],
  ["cedar-bath", "檜の湯", "森林の歩行は、都市より生理指標が落ち着きへ寄った。", "Park et al., 2010", "mist", "#12160f", "#e4d8b4"],
  ["still-pond", "止水", "自然の光景は、注意の負荷が低い処理と結びつく。", "Grassini et al., 2019", "ripple", "#0f1516", "#d0e0e4"],
  ["moon-veranda", "月の縁側", "曲線の輪郭は、尖った形より近づきたくなる。", "Vartanian et al., 2013", "moon", "#12131a", "#ddd6ea"],
  ["unpainted-wood", "素木", "生物に似た室内は、生理と認知の両方で差が出始めている。", "Yin et al., 2018", "grain", "#14120e", "#e8d4b0"],
  ["one-ficus", "一鉢のフィカス", "室内の植物は、注意の課題を支える報告がある。", "Raanaas et al., 2011", "glass", "#101610", "#d4e4c4"],
  ["herb-sill", "ハーブの窓辺", "机の上の植物は、創造課題の成績と関係した。", "Shibata & Suzuki, 2004", "canopy", "#10150f", "#d8e6c0"],
  ["moss-tray", "苔の盆", "室内植物の心理的な利益は、総説として積み上がっている。", "Bringslimark, Hartig & Patil, 2009", "mist", "#101612", "#d0e2c8"],
  ["glass-house", "玻璃の温室", "緑は、創造課題で有利に出た色の実験がある。", "Lichtenfeld et al., 2012", "glass", "#101610", "#cfe6c4"],
  ["vine-rail", "蔓の棚", "窓の緑と植物は、ストレス反応を下げる方向に出ることがある。", "Chang & Chen, 2005", "canopy", "#0f160f", "#d6e4bc"],
  ["seedling-row", "苗の列", "植物のある作業空間は、不快や生産性の指標に触れた。", "Lohr, Pearson-Mims & Goodwin, 1996", "glass", "#10140f", "#dce8c8"],
  ["wet-leaves", "濡れた葉", "自然の体験は、注意と感情と生理にまたがって益が報告される。", "Franco, Shanahan & Fuller, 2017", "rain", "#0f1512", "#d4e4cc"],
  ["citrus-pot", "柑橘の鉢", "注意回復の追試をまとめると、効果は小さくても繰り返される。", "Ohly et al., 2016", "tea", "#14160f", "#f0dca8"],
  ["shade-leaf", "日陰の葉", "系統的なレビューでも、自然と注意回復の関係は支持が残る。", "Stevenson, Schilhab & Bentsen, 2018", "canopy", "#101410", "#d8e2c4"],
  ["winter-greenhouse", "冬の温室", "生体親和の型は、室内を自然の性質へ寄せる設計の目録である。", "Browning, Ryan & Clancy, 2014", "glass", "#101614", "#dce8d4"],
  ["high-nave", "高い身廊", "高い天井は関係づけへ、低い天井は細部へ寄る。", "Meyers-Levy & Zhu, 2007", "shaft", "#121318", "#ddd4c0"],
  ["side-aisle", "側廊", "見通しと隠れ場所の両方があると、風景は落ち着く。", "Appleton, 1975", "horizon", "#121410", "#e4d8c0"],
  ["long-table", "長い机", "教室の設計は、学習の進捗のかなりの分散を説明する。", "Barrett et al., 2015", "shaft", "#14160f", "#efe0c0"],
  ["curved-alcove", "曲面の窪み", "曲線は、尖った輪郭より近づきたい判断を集めやすい。", "Vartanian et al., 2013", "stone", "#141310", "#eadcc8"],
  ["north-stack", "北の書庫", "外の見える席は、壁に向かう席より注意が残りやすい。", "Tennessen & Cimprich, 1995", "shaft", "#101418", "#d4dcea"],
  ["mezzanine", "中二階", "建物の好ましさは、輪郭と自然のパターンに触れている。", "Coburn, Vartanian & Chatterjee, 2017", "horizon", "#14120f", "#e8d4b4"],
  ["fractal-screen", "フラクタルの障子", "自然に近い形は、建築が環境心理から学ぶ対象になってきた。", "Joye, 2007", "grain", "#12140f", "#e0e4cc"],
  ["refuge-bay", "隠れ席", "見通しがあって背が守られる席は、室内の見通しと隠れである。", "Appleton, 1975", "lamp", "#14110e", "#f0d4a8"],
  ["clerestory-library", "高窓の館", "学校の昼光は成績との関係が報告された。追試の幅もある。", "Heschong, 1999", "shaft", "#14160f", "#f2e6c4"],
  ["quiet-stack", "静かな排架", "大部屋の会話は、無関係な音より成績を下げる。", "Jahncke et al., 2011", "stone", "#121314", "#ddd8cc"],
  ["soft-rain", "小雨", "中くらいの環境音は創造を上げ、大きすぎると下げる。", "Mehta, Zhu & Cheema, 2012", "rain", "#101418", "#d0d8e6"],
  ["reading-rain", "読書の雨", "校正のような正確さは、静かな方がよい、という同じ実験の半分。", "Mehta, Zhu & Cheema, 2012", "rain", "#101216", "#d4d8e4"],
  ["snow-court", "雪の中庭", "視覚のごたごたを減らすことは、要らない負荷を下げる。", "Choi, van Merriënboer & Paas, 2014", "snow", "#12161a", "#e4e8ee"],
  ["cafe-corner", "カフェの隅", "およそ70デシベルのざわめきは、創造に有利で校正には不利だった。", "Mehta, Zhu & Cheema, 2012", "tea", "#16120e", "#f0c8a0"],
  ["bird-ledge", "鳥の棚", "鳥の声は、回復を感じさせる音として挙げられる。", "Ratcliffe, Gatersleben & Sowden, 2013", "cloud", "#12160f", "#e4ecc8"],
  ["overcast", "曇りの午後", "拡散した昼光は、まぶしさの少ない覚醒の光に近い。", "Smolders, de Kort & Cluitmans, 2012", "cloud", "#121418", "#dde2ea"],
  ["star-loft", "星のロフト", "夜の暗さは発想に、朝の光は覚醒に、照明の知見は分かれる。", "Steidle & Werth, 2013", "star", "#0e1018", "#d8d4ea"],
  ["sea-wind", "潮風の机", "自然の中の数日は、その後の創造課題を上げた。", "Atchley, Strayer & Atchley, 2012", "horizon", "#0e1418", "#d0e0ea"],
  ["mist-bridge", "霧の橋", "風景が心的な距離をつくると、注意は回復しやすい。", "Kaplan, 1995", "mist", "#12161a", "#d8dee8"],
  ["atlas-room", "図譜の間", "毎日すこし取り出して思い出すことが、貯蔵を厚くする。", "Karpicke & Roediger, 2008", "paper", "#14120f", "#f0e0c0"],
];

function build(spec, index) {
  const [id, name, note, source, motif, bg, accent] = spec;
  const glow = hexToRgb(accent).join(", ");
  return {
    id,
    name,
    note,
    source,
    motif,
    bg,
    bg2: mix(bg, "#000000", 0.28),
    panel: mix(bg, INK, 0.055),
    panel2: mix(bg, INK, 0.09),
    ink: INK,
    ink2: mix(INK, bg, 0.26),
    ink3: mix(INK, bg, 0.46),
    accent,
    accent2: mix(accent, "#ffffff", 0.22),
    accentInk: ACCENT_INK,
    soft: `rgba(${glow},.16)`,
    glow,
    glow2: hexToRgb(mix(accent, INK, 0.35)).join(", "),
    gx: `${70 + (index % 5) * 4}%`,
    gy: `${-8 + (index % 4) * 6}%`,
    gx2: `${-6 + (index % 3) * 4}%`,
    gy2: `${12 + (index % 5) * 8}%`,
    scene: scene(motif, glow, index),
  };
}

export const ATMOSPHERES = SPECS.map(build);

const problems = [];
if (ATMOSPHERES.length !== 100) problems.push(`expected 100 rooms, got ${ATMOSPHERES.length}`);
const ids = new Set();
for (const room of ATMOSPHERES) {
  if (ids.has(room.id)) problems.push(`duplicate id ${room.id}`);
  ids.add(room.id);
  if (contrast(room.ink, room.bg) < 7) problems.push(`${room.id} ink contrast ${contrast(room.ink, room.bg).toFixed(2)}`);
  if (contrast(room.accentInk, room.accent) < 4.5) problems.push(`${room.id} accent contrast ${contrast(room.accentInk, room.accent).toFixed(2)}`);
  if (/[;{}<>]/.test(room.scene + room.note + room.name)) problems.push(`${room.id} has a character that would break CSS or HTML`);
}
if (problems.length) throw new Error(`atmospheres: ${problems.join("; ")}`);

export function atmosphereCss(rooms = ATMOSPHERES) {
  return rooms.map((room) => `html[data-air="${room.id}"]{--bg:${room.bg};--bg-2:${room.bg2};--panel:${room.panel};--panel-2:${room.panel2};--ink:${room.ink};--ink-2:${room.ink2};--ink-3:${room.ink3};--accent:${room.accent};--accent-2:${room.accent2};--accent-ink:${room.accentInk};--accent-soft:${room.soft};--glow:${room.glow};--glow2:${room.glow2};--glow-x:${room.gx};--glow-y:${room.gy};--glow2-x:${room.gx2};--glow2-y:${room.gy2};--scene:${room.scene};}`).join("");
}

export function atmosphereCatalog(rooms = ATMOSPHERES) {
  return rooms.map(({ id, name, note, source, bg }) => ({ id, name, note, source, bg }));
}
