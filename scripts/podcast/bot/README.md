# Bot VM bootstrap — Phantomresearch Daily podcast

Grok Bot 提供の常時稼働クラウド PC（Debian 系 VM・CPU-only・16GB RAM・root 可）の上で、
`scripts/podcast/daily.mjs` パイプラインを毎日回すための最小セット。

| スクリプト | 役割 | 実行回数 |
|---|---|---|
| `bot/setup.sh` | 依存インストール・VoiceStudio Docker デプロイ・edge venv・Irodori systemd unit | 一度だけ（冪等・再実行可） |
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
3. `.venv-edge` を作成し、`edge-tts==7.3.1` を固定バージョンでインストール。
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

判定内容: `node` ≥20 / `ffmpeg`+`ffprobe` / `.venv-edge` に edge-tts 7.3.1 /
VoiceStudio container が up か・`curl -fsS http://127.0.0.1:3900/.well-known/
voicestudio-speech` が 200 か / GET /v1/audio/voices に **`Phantom-EN`,
`Phantom-ZH`, `Phantom-KO`** が含まれるか（未登録なら「web UI で clone profile を作れ」
という案内を提示） / **Irodori :8088 は TCP connect のみの単純生死判定**。

全 pass なら `doctor: all checks passed`。Irodori が down でも **warning 扱い**で
exit code には反映しない — `daily.mjs` は per-language の失敗を許容する設計で、Irodori
が無くても ja はその日の音声 failure として記録されるだけ（他言語・site 構築は壊れない）。
※ bot VM では edge への自動 fallback は opt-in（`PODCAST_FALLBACK_EDGE=1`）で、既定では
server 系 failure の報告を優先する設計です。

## 3. 音声プロファイル（Phantom-EN / Phantom-ZH / Phantom-KO）の作成

セットアップ直後に一回だけ、Mac 側のブラウザから行う（bot は UI クリック操作不可のため）。
参照音声は `.venv-edge` の edge-tts でテンプレートとして生成する。

```bash
# bot VM 上で once
mkdir -p scripts/podcast/bot/refs          # .gitignore 済み、commit 対象外
.venv-edge/bin/edge-tts --voice en-US-AndrewNeural \
  --text "A different research topic every day, briefly, in four languages. \
Today's topic: ..." \
  --write-media scripts/podcast/bot/refs/en.mp3

.venv-edge/bin/edge-tts --voice zh-CN-XiaoxiaoNeural \
  --text "每天换一个研究主题，用四种语言，只占一小段。今天的主题：..." \
  --write-media scripts/podcast/bot/refs/zh.mp3

.venv-edge/bin/edge-tts --voice ko-KR-SunHiNeural \
  --text "매일 바뀌는 연구 주제를, 네 언어로 조금씩. 오늘의 주제: ..." \
  --write-media scripts/podcast/bot/refs/ko.mp3
```

Mac 側（トンネル）:

```bash
ssh -L 3900:127.0.0.1:3900 <user>@<bot-host>
```

その状態で `http://localhost:3900` を開く。

1. API キー入力を聞かれたら、bot VM 上の `cat ~/.config/podcast-bot/omnivoice-api-key`
   の値を貼る。
2. Voice clone（音声プロファイル）作成で先ほどの `.mp3` を参照 clip として
   アップロードし、**プロファイル名は厳密に `Phantom-EN` / `Phantom-ZH` /
   `Phantom-KO`**（voices.json と doctor がこの名前を期待する）。Person 形式は
   research brief の読み（落ち着いた明瞭なナレーション）。
3. 登録後、bot VM で `bash scripts/podcast/bot/doctor.sh` して all checks passed を確認。

エンジン自体は `OMNIVOICE_TTS_BACKEND=omnivoice-gguf` で選択済み。weights 初回 DL は
コンテナ側で自動。

## 4. daily.sh（毎日 Routine から）

```bash
bash scripts/podcast/bot/daily.sh
# 障害時に指定日分だけ edge で自動リトライしたい場合のみ:
PODCAST_FALLBACK_EDGE=1 bash scripts/podcast/bot/daily.sh
```

Grok Bot に貼る Skill / Routine は、「**`daily.sh` を実行 → exit code と
`doctor.sh` の出力を報告**」という下地にする（UI クリック操作は不可の前提）。

フロー（詳細は各スクリプトのヘッダーコメント）:

1. `flock` による二重起動防止（flock 無い環境は即 exit）。
2. `git pull --ff-only`（失敗は warning のみ。手元を真実として reset --hard 等はしない）。
3. `TZ=Asia/Tokyo PODCAST_TTS_MAP="ja:irodori,en:voicestudio,zh:voicestudio,
   ko:voicestudio" node scripts/podcast/daily.mjs --catchup`。**`--catchup` が常に
   付く**（週末等に漏れた日付欠落は default backfillDays=3 で自動バックフィル）。
4. **exit code に応じた fallback**: `0`=OK / `3`=episode は書けたが音声ゼロ（server 起因
   が多い）/ `1`=pipeline error / `2`=lock・環境欠け。**edge への自動 fallback は既定では
   走らない。** `PODCAST_FALLBACK_EDGE=1` を付けた時のみ、**音声が完全ゼロ・または一部
   言語だけ欠けた日付**を edge まわり（全 4 言語 edge）で `--force` 再生成する
   （bot VM 側は「server 系の failure を報告するのが優先」で、edge は GitHub Actions
   側が main 保険、という方針の opt-in 実装）。
5. `git add -A` → `git commit -m "daily: <date> generated"` → `git push origin HEAD`。
   push 失敗は非 fatal（差分は手元に残り、次回 catchup で re-try）。push 成功で
   `.github/workflows/deploy.yml`（GitHub Pages deploy）が走る。

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
- edge-tts は Microsoft 音声サービスの非公式 wrapper。**1日 1〜数回**程度の微弱な
  負荷に留めること（bot・GitHub Actions とも）。

## 7. repo 名を固定したら

確定 repo 名は **`researchphantom-daily`**（公開中: https://github.com/RyoSAKu610/researchphantom-daily）。
`scripts/podcast/config.json` の `site.baseUrl` は確定済み（https://ryosaku610.github.io/researchphantom-daily）。
