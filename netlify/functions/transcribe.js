// ============================================================
// AI文字起こし - Netlify Functions バックエンド
// netlify/functions/transcribe.js
//
// 役割：
//   フロントエンドから音声ファイルを受け取り、
//   OpenAI Transcriptions APIへ転送して結果を返す。
//   APIキーはここでのみ参照し、フロントには絶対に渡さない。
//
// タイムスタンプについて（重要）：
//   - whisper-1 → verbose_json 形式で segments にタイムスタンプが取れる（最も正確）
//   - gpt-4o-transcribe / gpt-4o-mini-transcribe → json/text のみ対応。
//     verbose_json は非対応のためセグメント単位タイムスタンプは取得不可。
//     → このAPIからはテキストのみ返し、フロント側で均等分割の疑似タイムコードを付与する。
//
// ファイルサイズ上限：25MB（OpenAI API仕様）
// ============================================================

exports.handler = async (event, context) => {

  // CORS ヘッダー
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // OPTIONSリクエスト（プリフライト）への応答
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POSTのみ受け付ける
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'POSTメソッドのみ対応しています。' }),
    };
  }

  // ── 環境変数チェック ──────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'OpenAI APIキーが設定されていません。Netlifyの環境変数 OPENAI_API_KEY を確認してください。',
      }),
    };
  }

  try {
    // ── リクエストボディのパース ──────────────────────────────
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'リクエストの形式が正しくありません。' }),
      };
    }

    const { audioBase64, mimeType, fileName, model } = body;

    // 必須パラメータのチェック
    if (!audioBase64 || !mimeType || !fileName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '音声データが正しく送信されていません。ファイルを再選択してください。' }),
      };
    }

    // ── 対応モデルの検証 ──────────────────────────────────────
    const allowedModels = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
    const selectedModel = allowedModels.includes(model) ? model : 'gpt-4o-mini-transcribe';

    // ── Base64 → Buffer 変換 ──────────────────────────────────
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // ── ファイルサイズチェック（25MB = 26,214,400 bytes）────────
    const MAX_SIZE = 25 * 1024 * 1024;
    if (audioBuffer.length > MAX_SIZE) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `ファイルサイズが大きすぎます（上限25MB）。音声を短く分割してから再度アップロードしてください。\n現在のサイズ: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`,
        }),
      };
    }

    // ── MIMEタイプの検証 ─────────────────────────────────────
    const allowedMimeTypes = [
      'audio/mp4', 'audio/m4a', 'audio/x-m4a',
      'audio/mpeg', 'audio/mp3',
      'audio/wav', 'audio/wave', 'audio/x-wav',
      'video/mp4',
      'audio/webm', 'audio/ogg',
      'audio/mpga',
    ];
    if (!allowedMimeTypes.includes(mimeType)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `対応していないファイル形式です（${mimeType}）。m4a / mp3 / wav / mp4 をお使いください。`,
        }),
      };
    }

    // ── FormData の構築（手動 multipart/form-data）───────────
    const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;

    const buildMultipart = (boundary, fields, fileBuffer, mimeType, fileName) => {
      const parts = [];

      for (const [name, value] of Object.entries(fields)) {
        parts.push(
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
        );
      }

      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`)
      );
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      return Buffer.concat(parts);
    };

    // ── モデル別APIパラメータの設定 ──────────────────────────────
    // whisper-1 だけが verbose_json（セグメントタイムスタンプ付き）に対応。
    // gpt-4o系は json のみ対応。
    const isWhisper = selectedModel === 'whisper-1';

    const fields = {
      model: selectedModel,
      language: 'ja',
      ...(isWhisper
        ? { response_format: 'verbose_json' }
        : { response_format: 'json' }
      ),
    };

    const multipartBody = buildMultipart(boundary, fields, audioBuffer, mimeType, fileName);

    // ── OpenAI API 呼び出し ───────────────────────────────────
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    // ── エラーレスポンスの処理 ──────────────────────────────────
    if (!response.ok) {
      let errorDetail = '';
      try {
        const errJson = await response.json();
        errorDetail = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        errorDetail = await response.text();
      }

      const errorMessages = {
        400: `リクエストが不正です。ファイル形式やサイズを確認してください。\n詳細: ${errorDetail}`,
        401: 'OpenAI APIキーが無効です。Netlifyの環境変数 OPENAI_API_KEY を確認してください。',
        403: 'OpenAI APIへのアクセスが拒否されました。APIキーの権限を確認してください。',
        413: 'ファイルサイズが大きすぎます。音声を短く分割してから再度アップロードしてください。',
        429: 'APIの利用制限に達しました。しばらく待ってから再試行してください。',
        500: `OpenAI APIでエラーが発生しました。しばらく待ってから再試行してください。\n詳細: ${errorDetail}`,
        503: 'OpenAI APIが一時的に利用できません。しばらく待ってから再試行してください。',
      };

      const message = errorMessages[response.status]
        || `APIエラーが発生しました（ステータス: ${response.status}）。\n詳細: ${errorDetail}`;

      return {
        statusCode: response.status >= 500 ? 502 : response.status,
        headers,
        body: JSON.stringify({ error: message }),
      };
    }

    // ── 成功レスポンスの処理 ──────────────────────────────────
    const result = await response.json();

    if (!result || (!result.text && !result.segments)) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: '文字起こし結果が空でした。音声ファイルに音声が含まれているか確認してください。',
        }),
      };
    }

    const responsePayload = {
      model: selectedModel,
      text: result.text || '',
      hasTimestamps: isWhisper && Array.isArray(result.segments) && result.segments.length > 0,
      segments: isWhisper ? (result.segments || []) : [],
      estimatedDuration: isWhisper && result.segments?.length > 0
        ? result.segments[result.segments.length - 1].end
        : null,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responsePayload),
    };

  } catch (err) {
    console.error('Transcription error:', err);

    const isNetworkError = err.message?.includes('fetch') || err.code === 'ECONNREFUSED';
    const message = isNetworkError
      ? 'OpenAI APIへの接続に失敗しました。インターネット接続を確認してください。'
      : `予期しないエラーが発生しました: ${err.message}`;

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: message }),
    };
  }
};
