# Bot VM bootstrap — Phantomresearch Daily podcast

Grok Bot 提供の常時稼働クラウド PC（Debian 系 VM・CPU-only・16GB RAM・root 可）の上で、
`scripts/podcast/daily.mjs` パイプラインを毎日回すための最小セット。

| スクリプト | 役割 | 実行回数 |
|---|---|---|
| `bot/setup.sh` | 依存インストール・VoiceStudio Docker デプロイ・Irodori systemd unit | 一度だけ（冪等・再実行可） |
| `bot/doctor.sh` | 全コンポーネントの生死確認 | setup 直後／障害調査時／Routine 冒頭 |
| `bot/daily.sh` | 生成（--catchup）＋ commit/push を 1 コマンドに | 毎日（Routine から） |

## 0. 前提

- Debian 系 VM（amd64）、root available。ディスク空き **30 GB 以上**推奨
  （OmniVoice GGUF 重み＋ダウンロード後 10 GB の空き確保ルールがあるため）。
- この repo が checkout されていること（`scripts/podcast/daily.mjs` が実行できる場所）。
- ssh でユーザーの Mac から入れること（VoiceStudio の音声プロファイル登録に使う）。

## 1. setup.sh（一度だけ・冪等）

```bash
cd <repo checkout>
bash scripts/podcast/bot/setup.sh
# Irodori を後で常駐させる場合の再実行:
IRODORI_SERVER_DIR=/opt/irodori IRODORI_SERVER_BIN=run.sh bash scripts/podcast/bot/setup.sh
```

やること:

1. `apt` で ffmpeg / git / curl / ca-certificates / python3 / python3-venv / unzip /
   util-linux(flock) / docker.io を導入（インストール済みならスキップ。閉じたネット
   向けに `APT_PROXY=http://proxy:port` env を考慮）。
2. Node.js 20+ が無ければ NodeSource から 22.x を導入。
3. `.venv-edge`（edge-tts）は**作らない**。edge-tts はパイプラインから完全撤去済み
   （setup.sh が残余 `.venv-edge` を確認して削除する）。
4. **VoiceStudio を Docker で常駐化**（`docs/install/docker.md` 準拠・2026-10-18 確認済み）:

   ```
   image   ghcr.io/debpalash/voicestudio:stable   （linux/amd64 専用。ARM では amd64 エミュレーションになるため非推奨）
   port    -p 127.0.0.1:3900:3900   （**loopback 限定**で公開）
   volume  omnivoice-data:/app/omnivoice_data   （モデルキャッシュ・音声プロファイル・設定が persist される）
   env     OMNIVOICE_API_KEY=<生成済みキー>
           OMNIVOICE_TRUSTED_NETWORKS=172.16.0.0/12
           OMNIVOICE_TTS_BACKEND=omnivoice-gguf
           OMNIVOICE_ANALYTICS_DISABLED=1
           --restart unless-stopped
   ```

   - `OMNIVOICE_TRUSTED_NETWORKS=172.16.0.0/12`：API キーを設定した状態では非
     loopback ピアに認証を要求する。ホスト上のアダプタ（synthesize_voicestudio.py）
     は Docker の port mapping 経由なので、コンテナ側からは docker bridge subnet から
     の非 loopback アクセスになる → **consumption API のみ** exempt させるための
     値。admin 系（`/system/*`, `/api/settings/*`）は trusted networks では決して
     exempt されない。bridge subnet が違うなら、その range に合わせて直す。
   - 管理用 API キー（web UI でのプロファイル登録に必要）は
     `~/.config/podcast-bot/omnivoice-api-key`（0600）に保存。**repo にはコミット
     しない**。
   - Docker が使えない環境の代替として docs/install/linux.md（AppImage/.deb）も存在
     するが、headless VM は desktop session 無しで動かせないので **Docker 推奨**。
5. OmniVoice GGUF 重み（Serveurperso/OmniVoice-GGUF、pin 固定 rev。CPU-only では
   Q4_K_M・約 0.7 GB）の事前取得を best-effort で試みる。**失敗しても即 fatal には
   しない**: エンジンが初回生成時に自動で DL する設計（within container、volume に入る）。
6. `IRODORI_SERVER_DIR` を与えた場合に限り、Irodori-TTS-Server 用 systemd unit を
   `/etc/systemd/system/irodori-tts.service` に install + enable。unit テンプレートは
   `setup.sh` 内に内包（生成物のコピーが `~/.config/podcast-bot/irodori-tts.service` にも残る）。
7. 最後に `doctor.sh` を呼び、その exit code で終了する。

## 2. doctor.sh

```bash
bash scripts/podcast/bot/doctor.sh
```

判定内容: `node` ≥20 / `ffmpeg`+`ffprobe` / VoiceStudio container が up か・
`curl -fsS http://127.0.0.1:3900/.well-known/voicestudio-speech` が 200 か / GET
/v1/audio/voices に **`Phantom-ZH`, `Phantom-DE`, `Phantom-ES`, `Phantom-RU`,
`Phantom-IT`** が含まれるか（未登録なら「web UI で clone profile を作れ」という案内を
提示） / **Irodori :8088 は TCP connect のみの単純生死判定**。残余 `.venv-edge` が
あれば削除を促す warning のみ。

全 pass なら `doctor: all checks passed`。Irodori が down でも **warning 扱い**で
exit code には反映しない — `daily.mjs` は per-language の失敗を許容する設計で、Irodori
が無くても ja はその日の音声 failure として記録されるだけ（他言語・site 構築は壊れない）。
※ **edge への fallback は存在しない**（第三者クラウドで音声は作らない）。ただし
daily.sh は、欠落言語のある日を**同じ self-hosted エンジンで 1 回だけ自動再試行**
（self-repair）する。server が本当に止まっている場合はそれも失敗して報告されるので、
tts-hub / VoiceStudio / Irodori を修復して再実行する。

## 3. 音声プロファイル（Phantom-ZH / Phantom-DE / Phantom-ES / Phantom-RU / Phantom-IT）の作成

セットアップ直後に一回だけ、Mac 側のブラウザから行う（bot は UI クリック操作不可のため）。
**参照音声は edge-tts 等の外部サービスで作らない**（edge は禁止・ja は Irodori なので
profile 不要）。operator が用意する自前の音声素材（録音 or repo 外で準備した明瞭な
ナレーション clip）を参照 clip として `refs/` に置く。lineup は 2026-10 より
**ja / zh / de / es / ru / it の 6 言語**（en・ko は外れた）。

```bash
# bot VM 上で once
mkdir -p scripts/podcast/bot/refs          # .gitignore 済み、commit 対象外
# 各言語の参照 clip（zh/de/es/ru/it）を refs/ に置く
#   例: scripts/podcast/bot/refs/zh.mp3, refs/de.mp3, refs/es.mp3, refs/ru.mp3, refs/it.mp3
```

Mac 側（トンネル）:

```bash
ssh -L 3900:127.0.0.1:3900 <user>@<bot-host>
```

その状態で `http://localhost:3900` を開く。

1. API キー入力を聞かれたら、bot VM 上の `cat ~/.config/podcast-bot/omnivoice-api-key`
   の値を貼る。
2. Voice clone（音声プロファイル）作成で先ほどの `.mp3` を参照 clip として
   アップロードし、**プロファイル名は厳密に `Phantom-ZH` / `Phantom-DE` /
   `Phantom-ES` / `Phantom-RU` / `Phantom-IT`**（voices.json と doctor がこの名前を
   期待する）。Person 形式は
   research brief の読み（落ち着いた明瞭なナレーション）。
3. 登録後、bot VM で `bash scripts/podcast/bot/doctor.sh` して all checks passed を確認。

エンジン自体は `OMNIVOICE_TTS_BACKEND=omnivoice-gguf` で選択済み。weights 初回 DL は
コンテナ側で自動。

## 4. daily.sh（毎日 Routine から）

```bash
bash scripts/podcast/bot/daily.sh
```

Grok Bot に貼る Skill / Routine は、「**`daily.sh` を実行 → exit code と
`doctor.sh` の出力を報告**」という下地にする（UI クリック操作は不可の前提）。

フロー（詳細は各スクリプトのヘッダーコメント）:

1. `flock` による二重起動防止（flock 無い環境は即 exit）。
2. `git pull --ff-only`（失敗は warning のみ。手元を真実として reset --hard 等はしない）。
3. `TZ=Asia/Tokyo PODCAST_TTS_MAP="ja:irodori,zh:voicestudio,de:voicestudio,
   es:voicestudio,ru:voicestudio,it:voicestudio" node scripts/podcast/daily.mjs --catchup`。
   **`--catchup` が常に
   付く**（週末等に漏れた日付欠落は default backfillDays=3 で自動バックフィル）。
4. **exit code の意味**: `0`=OK / `3`=episode は書けたが音声が一部ゼロ（server 起因
   が多い）/ `1`=pipeline error / `2`=lock・環境欠け。**edge への自動 fallback は
   すでに廃止**。代わりに欠落言語のある日付を**同じ self-hosted エンジンで 1 回だけ
   `--force` 再実行（self-repair）**する。server が止まっていればそれも失敗して記録
   に残るので、tts-hub / VoiceStudio / Irodori を修復して daily.sh をもう一度実行する。
5. `git add -A` → `git commit -m "daily: <date> generated"` → `git push origin HEAD`。
   push 失敗は非 fatal（差分は手元に残り、次回 catchup で re-try）。push 成功で
   `.github/workflows/deploy.yml`（GitHub Pages deploy）が走る。

## 4b. 論文の先取り（prefetch）とローカル AI 台本（どちらも env フラグで opt-in）

どちらも**既定は無効**（env 未設定なら従来どおりの動作）。bot VM では
`~/.config/podcast-bot/podcast-llm.env` を `run-daily-hub.sh` が読み込んで有効化する。

### 論文の先取り — `PODCAST_PREFETCH=1`

- `scripts/podcast/prefetch.mjs` が、これから数日分のトピック（`pickTopic` を履歴付きで
  シミュレートして予測）について arXiv のメタデータ＋抄録をローカル cache に保存する。
  cache は repo 外: `$PODCAST_ARXIV_CACHE_DIR`（既定 `~/.cache/researchphantom-daily/arxiv/<topicId>.json`）
  なので `daily.sh` の `git add -A` には入らない。
- `daily.mjs` の論文取得順: **新しい cache（`PODCAST_ARXIV_CACHE_FRESH_HOURS`、既定 12h 以内）→
  arXiv をその場で取得（成功したら cache 更新）→ 古い cache（`PODCAST_ARXIV_CACHE_MAX_AGE_DAYS`、
  既定 14 日以内）→ 従来の curated fallback**。arXiv の 429 や offline でも、cache があれば
  1 本だけの短い fallback 台本にならない。cache を使った日は episode.json の notes に記録。
- 生成後、`daily.mjs` が翌日以降 `PODCAST_PREFETCH_DAYS`（既定 3）日分を先取りする（失敗は無害）。
- arXiv API の作法: 同一プロセス内でリクエスト間隔 **≥3.1 秒**、429/503 は `Retry-After`
  を尊重して 15s→45s で最大 2 回 backoff（上限 90s）。連続 3 トピック失敗で先取りを打ち切る。
- 手動／定期実行（オンラインの時に）:

  ```bash
  node scripts/podcast/prefetch.mjs --days 7          # 今日から 7 日分の予測トピック
  node scripts/podcast/prefetch.mjs --days 7 --all    # ＋全 topics.json（約 29 件、2 分弱）
  node scripts/podcast/prefetch.mjs --status          # cache の状態（JSON）
  ```

  推奨スケジュール例（未設定・提案のみ）: 毎日 05:30 JST に `--days 7`、週 1 回 `--all`。
  05:30 に先取りしておけば 06:30 の本番は cache（12h 以内）を使い、arXiv を叩かない。

### ローカル AI 台本 — `PODCAST_SCRIPT_LLM=1`

- `scripts/podcast/llm.mjs` が llama.cpp の `llama-server`（CPU・127.0.0.1:3911・
  オープンウェイト GGUF）を起動し、各論文について **タイトル＋抄録だけを根拠に**、
  各言語（config.languages）で読み上げ用の解説文を作る。イントロ／トピック概要／
  論文タイトル・著者／定型コメント／アウトロは従来どおり `script.mjs` のテンプレート。
  全言語の台本を作り終えたら LLM を停止し、その後 TTS を始める（CPU/RAM を取り合わない）。
- 検証（不合格なら 1 回だけ再生成、それでも駄目ならその論文は従来の抄録引用）:
  対象言語であること（文字種＋機能語）、長さ、URL/markdown なし、同じ文の繰り返しなし、
  **数字はすべて抄録・タイトルにある値**（`2億3100万` ↔ `231 million` も照合）、
  ラテン文字の固有名・略語（モデル名・データセット名など）は抄録・タイトルにあるもの。
- **自動 fallback（テンプレート台本）**: llama-server／モデルが無い、起動失敗、
  リクエスト失敗、言語ごとの時間切れ（`PODCAST_LLM_LANG_TIMEOUT_SEC`、既定 900s）、
  全体予算切れ（`PODCAST_LLM_BUDGET_SEC`、既定 4500s）、過半の論文が不合格、
  台本が短すぎる（`PODCAST_LLM_MIN_SECONDS`、既定 330s 相当）— いずれもその言語は
  従来の `buildScript` 台本になる。episode.json の notes に `scripts: ...` として言語ごとの結果を記録。
- 長さ: `PODCAST_LLM_TARGET_SECONDS`（既定 450s）を、実測した話速（llm.mjs `LLM_PACE`）で
  文字数に換算し、`PODCAST_LLM_MAX_PAPERS`（既定 5）本に配分。5 分以上の条件を満たす。
- 導入場所（repo 外）: `~/opt/llama.cpp/current/llama-server`（公式 CPU ビルド b11889）、
  `~/opt/llm-models/current.gguf` → `Qwen3.5-9B-Q4_K_M.gguf`（Apache-2.0、unsloth GGUF）。
  変えるときは `PODCAST_LLM_SERVER` / `PODCAST_LLM_MODEL`、既存サーバを使うなら `PODCAST_LLM_URL`。
- その他: `PODCAST_LLM_THREADS`（既定 8）、`PODCAST_LLM_CTX`（8192）、`PODCAST_LLM_PORT`（3911）、
  `PODCAST_LLM_REQUEST_TIMEOUT_SEC`（360）、`PODCAST_LLM_RETRIES`（1）、
  `PODCAST_LLM_DEBUG_FILE`（生成文と判定を追記する検証用ログ）。
- doctor.sh は cache と LLM（バイナリ・モデル・空きメモリ）の状態を **info/warn で表示するだけ**（FAIL にしない）。
- 有料 API・商用機能は使わない。モデルはオープンウェイトのみ。

## 5. トラブルシュート

| 症状 | 対処 |
|---|---|
| `docker pull` で "no matching manifest for linux/arm64" | ARM VM には非対応（amd64 専用）。amd64 VM を使う |
| UI で `403 loopback origin or admin API key required` | API キー入力（`~/.config/podcast-bot/omnivoice-api-key`） |
| アダプタが 401 `API key required` | `OMNIVOICE_TRUSTED_NETWORKS` が実際の bridge subnet をカバーしているか `docker network inspect bridge` で確認。必要なら 172.16.0.0/12 を広げる |
| `/health` が 503 で返ってくる | 起動中（PyTorch 初期化・DB migration）。`GET /startup/progress` か `docker logs -f omnivoice` で経過確認 |
| 初回 TTS が異常に遅い | OmniVoice GGUF 重みの初回 DL（数百 MB〜）。既に volume にあるはず。`docker logs -f omnivoice` で確認 |
| 音声が毎回 pacing gate で reject される | voices.json の各 engine section の charsPerSecond は暫定値。実測に合わせて調整 |
| ffprobe が予期しない version | docs/install/linux.md の「.deb ffprobe conflict」を確認 |
| push が失敗する | 非 fatal という設計。翌日の catchup で再 push が試みられる |

## 6. License・commercial の注意

- **OmniVoice GGUF の重み（Serveurperso/OmniVoice-GGUF）は CC-BY-NC 系で非商用**
  用途の license が付く。公開 podcast の広告収益化・商用配信は不可。公開 repo 側の
  README にも同様の note を足すこと。早期に重み repo の正確な license 名で確認
  し、ここを更新すること。
- VoiceStudio 本体の license と model weights の license は別物。engine バイナリ
  まわりは upstream の license 条項に従う。
- **edge-tts（Microsoft 音声サービスの非公式 wrapper）はこのパイプラインから完全に
  廃止済み**。第三者クラウド経由の音声は生成・利用しない。

## 7. repo 名を固定したら

確定 repo 名は **`researchphantom-daily`**（公開中: https://github.com/RyoSAKu610/researchphantom-daily）。
`scripts/podcast/config.json` の `site.baseUrl` は確定済み（https://ryosaku610.github.io/researchphantom-daily）。
