# dsh-sound-notifications

DSH（DeepSeek Harness）の挙動に「効果音」と「デスクトップ通知」を付けるプラグインです。エージェントが応答を終えた、承認待ちで止まっている、質問を投げてきた——そんな「見ていない間に起きたこと」を、音とOS通知で知らせます。

追加の依存パッケージは0個、ビルド手順も0ステップです。音は Web Audio で合成し、通知アイコンはその場で canvas に描くので、同梱しているメディアファイルはアイコン1枚だけ。サプライチェーンの心配をする余地を、そもそも作っていません。

## 収録している通知

| 種類 | きっかけ | 既定 |
| --- | --- | --- |
| 応答完了 | `api-session/status` が `running=false` | **ON** |
| 承認待ち | `approval/request`（ツール名と理由を本文に） | **ON** |
| 質問 | `user-questions/request`（質問文を本文に） | **ON** |
| エラー | `api-session/error`（長文は160字で省略） | **ON** |
| 再ログイン | `deepseek-account/session-expired` / `model-sign-in-required` | **ON** |
| ゴール継続 | `goal/activation-changed`（armed / disarmed） | **ON** |
| 処理開始 | `api-session/status` が `running=true` | OFF |
| スケジュール | `schedule/changed` | OFF |

承認と質問は `requireInteraction: true` で出し、**回答が返ってきた瞬間に自動で閉じます**。`tag` を使っているので、同じ種類の通知が積み上がることもありません。

## 収録している効果音

処理開始（短い2音）／応答完了（上がる3音）／承認待ち（明るい和音の2回鳴らし）／質問（問いかける2音）／エラー（低く下がる2音）。すべてオシレータの合成で、音声ファイルは持っていません。

## 動作環境

- DSH `0.2.0-rc.2` の Web UI（プロファイル `web`）で動作確認しています
- 通知には **secure context** が必要です。`http://127.0.0.1:3080` や `https://` は該当しますが、LAN の IP を `http://` で開いた場合は通知そのものが使えません（この場合、行が理由を表示し、効果音だけが鳴ります）
- 効果音は Web Audio API、通知は Notifications API のみ。どちらもブラウザ標準機能で、polyfill は入れていません

## インストール

方法は2つあります。まず Plugin Manager を使う方法が簡単でしょう。

### 1. Plugin Manager から（推奨）

DSH の「設定 → プラグイン」のインストール欄に、次の spec をそのまま入れて実行してください。

```
github:cwd514/dsh-sound-notifications
```

エージェントに任せるなら、`plugin_manager` ツールの `install_bundle` に同じ文字列を `target` として渡してもらう形になります。GitHub リポジトリは pnpm の前に到達確認（`git ls-remote`、既定5秒）が入りますが、公開リポジトリなのでそのまま通ります。

### 2. clone してパスを指定する

```bash
git clone https://github.com/cwd514/dsh-sound-notifications.git
```

そのうえで、絶対パスを spec としてインストールします（相対パスは受け付けられません）。

```
plugin_manager install_bundle target="/absolute/path/dsh-sound-notifications"
```

インストールが通ると、**設定 → 一般** の下のほうに「効果音」と「デスクトップ通知」の2行が現れます。反映されない場合はページを一度再読み込みしてください。

npm には公開していません（`private: true` のままです）。npm から入れたい場合は、`@local` スコープを自分のものに変えて公開する必要があります。

## 設定

### 「効果音」の行

マスタースイッチ、音量スライダー、そして5種類それぞれのスイッチと試聴ボタン。音は種類ごとに独立しているので、開始音だけ切って完了音は残す、といった調整ができます。

### 「デスクトップ通知」の行

マスタースイッチを **ON にした瞬間がユーザー操作**なので、そこでブラウザに通知の許可を求めます。すでに許可済みなら、代わりにテスト通知が1回出ます。

- 未許可 → 「通知を許可する」ボタン
- 許可済み → 「許可済み」表示＋「テスト通知」ボタン
- 拒否済み → サイト設定での許可を案内＋「再確認」ボタン（**ブラウザは一度拒否されたページからの再要求を受け付けません**）
- 通知が使えない環境 → マスタースイッチを無効化して理由を表示

「タブが非アクティブのときだけ通知する」（既定 ON）を切ると、ウィンドウを見ている間も通知が出ます。「OSの通知音も鳴らす」（既定 ON）を切ると通知は無音になり、上の効果音だけが鳴ります。

## 通知が届かないときに疑うこと

1. ブラウザの通知許可（拒否済みならサイト設定から戻す）
2. secure context かどうか（`127.0.0.1` / `localhost` / `https` か）
3. 「タブが非アクティブのときだけ通知する」が ON のまま、タブを前面にしたまま作業していないか
4. OS 側の通知設定・集中モード・おやすみモード
5. 通知の種類ごとのスイッチが切れていないか
6. タブを閉じていないか（下の「制約」を参照）

切り分けには、コンソールで `__dshSound.lastNotified()` を実行するのが早いです。表示を試みた全件が `{kind, at, shown, reason, permission}` として残っていて、`reason` が `off` / `kind-off` / `visible` / `permission` / `unsupported` のどれかを見れば、どのゲートで止まったか分かります。

## 制約（先に知っておいてほしいこと）

- **タブを閉じると届きません。** Service Worker も Push も使えない構成なので、ページが開いている間だけの通知です
- 通知はブラウザごと・オリジンごとの許可に従います。LAN の IP を `http://` で開いた場合は通知自体が使えません
- 音と通知の設定はブラウザの `localStorage` に保存されます。別のブラウザや別のPCには引き継がれません
- 音が鳴るイベントは DSH が転送する固定のイベント一覧に限られます。ツール実行ごと、サブエージェントの進行、ワークフローの各段階などは対象外です
- 通知はセッションを区別しません。複数のセッションを同時に走らせると、どれの完了かは本文からは分かりません
- 効果音は最初の1回だけ、ブラウザの自動再生ポリシーにより「ユーザー操作後」でないと鳴らないことがあります

## コンソールから試す

ブラウザのコンソールで `__dshSound` が使えます。

| 呼び出し | 内容 |
| --- | --- |
| `__dshSound.play('approval')` | 効果音を強制再生（設定を無視） |
| `__dshSound.lastPlayed()` | 再生履歴（直近20件） |
| `__dshSound.settings()` / `set({...})` | 効果音の設定を読む／書く |
| `__dshSound.notify('error', 'テスト')` | 通知を強制表示（許可は必要） |
| `__dshSound.notifyPermission()` | `granted` / `denied` / `default` / `unsupported` |
| `__dshSound.requestNotifyPermission()` | 許可をリクエスト |
| `__dshSound.notifySettings()` / `setNotify({...})` | 通知の設定を読む／書く |
| `__dshSound.lastNotified()` | 通知の試行履歴（直近20件、`reason` 付き） |
| `__dshSound.closeNotifications()` | 表示中の通知を全部閉じる |
| `__dshSound.state()` | 音声基盤の状態（`supported` / `audioState` / 実効音量） |

## プライバシー

外部への通信は一切ありません。テレメトリも送信しません。通知の本文になる承認理由・質問文・エラーメッセージは、その場で文字列として切り出してOSに渡すだけで、どこにも保存・送信しません。保存されるのは設定（`localStorage` の2キー）だけです。

## 開発

```bash
node --check client.js     # 構文
node test/smoke.mjs        # ブラウザを模したサンドボックスで21項目
```

`test/smoke.mjs` は `client.js` を Node の `vm` 上でブラウザスタブに読み込み、行の登録、9イベントの購読、通知のゲート順（`off` → `kind-off` → `visible` → `permission`）、承認・質問の waterfall の素通しと回答時の自動クローズ、本文の切り詰め、`localStorage` の永続化、両行のレンダリングまでを検証します。同じテストが GitHub Actions でも走ります。

構成は4ファイルです。`index.js` が Host 側（このプラグインは Host に何も足しません）、`client.js` が UI・音・通知の全部、`cordis.patch.yml` が行の挿入、`package.json` が束の宣言です。

## ライセンス

MIT

---

## English

A DSH (DeepSeek Harness) plugin that adds short **synthesized tones** and **desktop notifications** to harness events, so you notice what happened while you were looking elsewhere: a run finished, an approval is waiting, a question was asked, an error occurred, a sign-in expired, a goal continued.

Zero dependencies, zero build steps, and no media files except the icon — the tones are generated with Web Audio and the notification icon is drawn into a canvas at runtime.

### Install

```
github:cwd514/dsh-sound-notifications
```

Paste that spec into the Plugin Manager install field (Settings → Plugins), or pass it as `target` to the `plugin_manager` `install_bundle` tool. Cloning the repository and installing its absolute path works as well. Afterwards, two rows appear in **Settings → General**: “Sounds” and “Desktop notifications”.

### What is covered

Notifications: run finished, approval waiting (tool name and reason in the body), question asked (the question text), error (truncated at 160 characters), sign-in needed, goal continuation — all on by default — plus run started and schedule changed, which are off by default. Approval and question banners are sticky and **close themselves the moment the answer arrives**.

Tones: run started, run finished, approval waiting, question asked, error.

### Settings

The sounds row has a master switch, a volume slider, and a switch plus a preview button for each tone. In the notifications row, turning the master switch on *is* the user gesture that asks the browser for permission (and shows one test banner when it is already granted); the row then reports the permission state, offers a test button when allowed, and points at the site settings when blocked. “Only while the tab is inactive” (default on) and “Also play the OS notification sound” (default on) control when banners appear and whether they make a sound of their own; eight per-kind switches choose what notifies.

### Limitations

- Notifications arrive only while the tab is open: this bundle ships a client half only, so there is no service worker and no push.
- Notifications need a secure context (`https`, `localhost`, or `127.0.0.1`). Opening the UI over plain `http` on a LAN IP disables them; the tones still play.
- A denied permission cannot be requested again from the page — restore it in the browser's site settings.
- Settings live in `localStorage`, so they are per browser and per origin.
- Notifications do not identify which session fired them.
- No network requests and no telemetry. Approval reasons, question text, and error messages are only rendered into the banner and are never stored or sent anywhere.

### Development

```bash
node --check client.js
node test/smoke.mjs
```

`test/smoke.mjs` loads `client.js` into a Node `vm` context with browser stubs and verifies row registration, event subscriptions, the notification gate order (`off` → `kind-off` → `visible` → `permission`), the waterfall pass-through and auto-close for approvals and questions, body truncation, `localStorage` persistence, and rendering of both rows. The same checks run in GitHub Actions.

MIT licensed.
