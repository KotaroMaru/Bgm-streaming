# BGM Streaming App

スマホやPCからBGMをリモコン操作して、プロジェクター接続PCで音楽を再生するWebアプリです。

---

## どんなアプリ？

```
┌─────────────────────┐        ┌──────────────────────────┐
│  親デバイス          │        │  子PC（プロジェクター接続）│
│  スマホ / PC         │◄──────►│                          │
│                     │        │  ・音楽を再生             │
│  ・曲をアップロード  │        │  ・黒背景に曲名を大きく   │
│  ・再生・停止操作    │        │    フルスクリーン表示     │
│  ・音量・ループ設定  │        │                          │
└─────────────────────┘        └──────────────────────────┘
         ↑↓ Socket.io でリアルタイム同期（サーバー経由）
```

- **親側URL**: `https://あなたのアプリ.onrender.com/parent.html`
- **子側URL**: `https://あなたのアプリ.onrender.com/child.html`

---

## 事前準備

このアプリを動かすには、以下の2つのアカウントが必要です。
どちらも**無料で作成できます**。

| サービス | 用途 |
|---------|------|
| [Cloudinary](https://cloudinary.com) | 音楽ファイルの保存・ストリーミング（無料枠: 25GB）|
| [Render](https://render.com) | サーバーのホスティング（無料枠あり）|

---

## STEP 1 ── Cloudinary の設定

### 1-1. アカウントを作る

1. [https://cloudinary.com](https://cloudinary.com) にアクセス
2. **「Sign Up For Free」** をクリック
3. メールアドレス・パスワードを入力して登録
4. 届いた確認メールのリンクをクリックして認証

### 1-2. APIキーを確認する

1. ログイン後、左メニューの **「Dashboard」** をクリック
2. 画面上部に表示される以下の3つをメモしておく

```
Cloud Name  : abc123xyz          ← あなた専用の名前
API Key     : 123456789012345    ← 数字15桁
API Secret  : AbCdEfGhIjKlMnO   ← 英数字の長い文字列（目のアイコンで表示）
```

> ⚠️ **API Secret は絶対に公開しないでください。**
> GitHubにアップするときは `.env` ファイルをコミットしないよう注意してください（`.gitignore` 設定済み）。

---

## STEP 2 ── ローカルで動かす（動作確認）

### 2-1. Node.js をインストール

まだ入っていない場合は [https://nodejs.org](https://nodejs.org) から **LTS版** をダウンロードしてインストール。

```bash
# バージョン確認（18以上であればOK）
node -v
```

### 2-2. 環境変数を設定する

プロジェクトフォルダにある `.env` ファイルをテキストエディタで開き、
STEP 1-2 でメモした値を入力する。

```env
CLOUDINARY_CLOUD_NAME=abc123xyz
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=AbCdEfGhIjKlMnO
PORT=3000
```

### 2-3. パッケージをインストールして起動

```bash
# プロジェクトフォルダに移動
cd Bgm-streaming

# 必要なパッケージをインストール（初回のみ）
npm install

# 開発サーバーを起動
npm run dev
```

ターミナルに以下が表示されれば成功です。

```
BGM server running on http://localhost:3000
✓ Loaded 0 track(s) from Cloudinary
```

### 2-4. ブラウザで確認

| 画面 | URL |
|------|-----|
| 親側（コントロール）| http://localhost:3000/parent.html |
| 子側（プロジェクター）| http://localhost:3000/child.html |

**動作確認の手順：**

1. **子側** を別タブで開き、「タップして開始」ボタンをクリック
2. **親側** で音楽ファイル（MP3など）をアップロード
3. プレイリストに追加された曲名をタップすると再生開始
4. 子側の画面に曲名が大きく表示されることを確認

---

## STEP 3 ── Render にデプロイ（インターネット公開）

### 3-1. GitHub にコードをアップロード

まず、このプロジェクトを GitHub リポジトリに push します。

```bash
git init
git add .
git commit -m "first commit"
# GitHub でリポジトリを作成してから↓を実行
git remote add origin https://github.com/あなたのID/リポジトリ名.git
git push -u origin main
```

> ⚠️ `.env` は `.gitignore` に入っているためコミットされません（正しい挙動です）。

### 3-2. Render でサービスを作成

1. [https://render.com](https://render.com) にアクセスしてサインアップ（GitHubアカウントで登録が簡単）

2. ダッシュボードの **「New +」→「Web Service」** をクリック

3. **「Connect a repository」** で先ほど push したリポジトリを選択

4. 以下のように設定する

   | 設定項目 | 入力値 |
   |---------|-------|
   | Name | `bgm-streaming`（任意）|
   | Region | `Singapore` など近い地域 |
   | Branch | `main` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | `Free` |

5. 画面を下にスクロールして **「Environment Variables」** セクションに以下を追加する

   | Key | Value |
   |-----|-------|
   | `CLOUDINARY_CLOUD_NAME` | `abc123xyz` |
   | `CLOUDINARY_API_KEY` | `123456789012345` |
   | `CLOUDINARY_API_SECRET` | `AbCdEfGhIjKlMnO` |

   > `PORT` は Render が自動で設定するため **入力不要**。

6. **「Create Web Service」** ボタンをクリック

7. デプロイログが流れ、最後に `==> Your service is live 🎉` と表示されれば完了

### 3-3. デプロイ後のURL

Render が以下のような URL を発行します。

```
https://bgm-streaming-xxxx.onrender.com
```

| 画面 | URL |
|------|-----|
| 親側 | `https://bgm-streaming-xxxx.onrender.com/parent.html` |
| 子側 | `https://bgm-streaming-xxxx.onrender.com/child.html` |

> **Render 無料プランのスリープについて**
> 15分間アクセスがないとサーバーがスリープします。
> このアプリはページを開いている間、5分ごとに自動で `/ping` を送信するため、
> **使用中はスリープしません**。ただし長時間放置後の初回アクセスは起動に30〜60秒かかります。

---

## 使い方

### 親側の操作

| 操作 | 方法 |
|------|------|
| 曲をアップロード | 「ファイルを選択 または ドロップ」エリアをタップ |
| 再生する | プレイリストの曲名をタップ、または ▶ ボタン |
| 一時停止 | ⏸ ボタン |
| 次の曲 / 前の曲 | ⏭ / ⏮ ボタン |
| シャッフル | 🔀 ボタン（点灯でON）|
| ループ | 🔁 ボタンを押すたびに「なし → 全曲 → 1曲」と切り替え |
| 音量調整 | 音量スライダーを左右にスライド |
| 曲の並び替え | ☰ アイコンをドラッグ＆ドロップ（スマホはドラッグハンドルを長押し）|
| 曲の削除 | ✕ ボタンをタップ → 確認ダイアログで「OK」|
| 子PCの接続確認 | 画面右上のバッジで「接続中」か確認 |

### 子側の操作

| 操作 | 方法 |
|------|------|
| 起動 | ページを開いたら「タップして開始」を1回クリック（**これだけでOK**）|
| 以降 | 親側の操作に自動で追従。操作不要 |
| 再接続 | 切断されても3秒後に自動で再接続 |

---

## ファイル構成

```
Bgm-streaming/
├── server.js          # サーバー本体（Express + Socket.io + Cloudinary）
├── package.json       # Node.js パッケージ設定
├── .env               # 環境変数（ローカル用・Gitにコミットしない）
├── .gitignore
├── README.md
└── public/            # ブラウザに配信されるファイル
    ├── parent.html    # 親側 画面
    ├── parent.js      # 親側 スクリプト
    ├── child.html     # 子側 画面
    ├── child.js       # 子側 スクリプト
    └── style.css      # デザイン（共通）
```

---

## トラブルシューティング

### 曲が再生されない（子側）

- 子側で「タップして開始」ボタンを押しましたか？（必須）
- 親側で子PCが「接続中」になっていますか？
- ブラウザのタブを更新してもう一度「タップして開始」を押してみてください。

### アップロードが失敗する

- ファイルサイズが **50MB を超えていない**か確認してください。
- `.env` の Cloudinary 認証情報が正しいか確認してください（スペースや改行が混入していないか）。

### Render でデプロイ後にエラーが出る

- Render の **「Environment Variables」** に3つの環境変数が正しく設定されているか確認してください。
- **「Logs」** タブでエラー内容を確認できます。

### ローカルで `npm run dev` がエラーになる

```bash
# nodemon が入っていない場合
npm install -g nodemon

# または直接起動
npm start
```

---

## 機能一覧

| 機能 | 詳細 |
|------|------|
| ファイルアップロード | MP3 / AAC / FLAC / WAV（最大50MB）|
| クラウド保存 | Cloudinary に永続保存。サーバー再起動後も復元 |
| プレイリスト管理 | 追加・削除・ドラッグ並び替え |
| 再生コントロール | 再生・一時停止・次曲・前曲・シーク |
| シャッフル | ランダム再生 |
| ループ | なし / 全曲ループ / 1曲ループ |
| 音量調整 | 0〜100% スライダー |
| 子PC表示 | 黒背景・曲名フルスクリーン（プロジェクター対応）|
| リアルタイム同期 | Socket.io による即時反映 |
| 自動再接続 | 切断後3秒で自動再接続・状態復元 |
| Keep-Alive | 5分ごとの自動 ping でRenderスリープを防止 |
| レスポンシブ | スマホ・タブレット・PC どこからでも操作可能 |
