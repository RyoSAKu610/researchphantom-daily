# ResearchPhantom Daily 🎙️

毎日 06:30 (JST) に arXiv の最新論文から 6 言語（日本語 / 中文 / Deutsch / Español / Русский / Italiano）のリサーチ・ブリーフ・ポッドキャストを自動生成するパイプラインです。

**ライブサイト**: https://ryosaku610.github.io/researchphantom-daily/

RSS: [ja](https://ryosaku610.github.io/researchphantom-daily/feed-ja.xml) · [zh](https://ryosaku610.github.io/researchphantom-daily/feed-zh.xml) · [de](https://ryosaku610.github.io/researchphantom-daily/feed-de.xml) · [es](https://ryosaku610.github.io/researchphantom-daily/feed-es.xml) · [ru](https://ryosaku610.github.io/researchphantom-daily/feed-ru.xml) · [it](https://ryosaku610.github.io/researchphantom-daily/feed-it.xml)

## How it works

1. arXiv から新着論文を取得し、日別トピックを選定（topics.json ＋投稿履歴ベース・重複なし）
2. 各言語 1 本のブリーフ台本を生成
3. TTS で各言語音声（48kbps mono MP3 ＋品質ゲート）を合成
4. `scripts/podcast/site.mjs` が index / RSS / episodes.json を再構築し、GitHub Pages へデプロイ

### TTS engines

| language | engine | note |
|---|---|---|
| ja | Irodori-TTS-Server（OpenAI 互換ローカル API） | v4.1-Small（MeanFlow） |
| zh / de / es / ru / it | VoiceStudio — OmniVoice GGUF | 固定 voice profile（clone）で毎回同一ナレーター |

**edge-tts 等の第三者クラウド音声は使用しません**（パイプラインから完全摘出済み）。
音声は全て self-hosted エンジン（Irodori / VoiceStudio・bot VM のローカル tts-hub 経由）で
生成する。音声が欠けた日付は bot が同じ self-hosted エンジンで 1 回だけ自動再試行
（self-repair）します。

さらに毎日 06:30 / 06:37 JST の GitHub Actions（`daily-catchup.yml`）が、直近日付の**監査（report のみ・音声生成なし）**を行い、欠日・欠言語・尺異常があれば red X で知らせます（idempotent・bot 生成物には触れません）。

## Repo layout

```
scripts/podcast/       生成パイプライン（node --test 兼同梱テスト）
scripts/podcast/bot/   常時稼働PC（Grok Bot cloud PC）用 setup / daily / doctor
podcast/episodes/      生成済みエピソード（script-*.txt + *.mp3 + episode.json）
.github/workflows/     push → Pages deploy ＋ 毎日 catchup（edge-tts 保険）
```

## License notes

- 同梱スクリプトは自由に参照・再利用できます。
- zh/de/es/ru/it の音声は OmniVoice（重みは CC-BY-NC・非商用利用）で生成しています。
- 音声／台本は非商用の研究発信として公開しています。
