// ============================================================
// AI文字起こし - Netlify Functions バックエンド
// netlify/functions/transcribe.js
//
// 役割：
//   フロントエンドから音声ファイル（Base64）を受け取り、
//   OpenAI Transcriptions APIへ転送して結果を返す。
//   APIキーはここでのみ参照し、フロントには絶対に渡さない。
//
// 重要：
//   どんなエラーが起きても必ず JSON を返す。
//   空レスポンスは禁止。
//
// タイムスタンプについて：
//   - whisper-1 → verbose_json で segments にタイムスタンプが取れる（最も正確）
//   - gpt-4o系 → json のみ。フロント側で均等分割の疑似タイムコードを付与
// ============================================================

exports.handler = async (event, context) => {

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'POSTメソッドのみ対応しています。' }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'OpenAI APIキーが設定されていません。Netlifyの環境変数 OPENAI_API_KEY を確認してください。',
      }),
    };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'リクエストの形式が正しくありません。' }),
      };
    }

    const { audioBase64, mimeType, fileName, model } = body;

    if (!audioBase64 || !mimeType || !fileName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '音声データが正しく送信されていません。ファイルを再選択してください。' }),
      };
    }

    const allowedModels = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
    const selectedModel = allowedModels.includes(model) ? model : 'gpt-4o-mini-transcribe';

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, 'base64');
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '音声データの変換に失敗しました。ファイルが壊れている可能性があります。' }),
      };
    }

    // 25MB上限チェック
    const MAX_SIZE = 25 * 1024 * 1024;
    if (audioBuffer.length > MAX_SIZE) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: `ファイルサイズが大きすぎます（${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB）。上限は25MBです。自動分割モードをご利用ください。`,
        }),
      };
    }

    // MIMEタイプ検証
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
          success: false,
          error: `対応していないファイル形式です（${mimeType}）。m4a / mp3 / wav / mp4 をお使いください。`,
        }),
      };
    }

    // multipart/form-data を手動構築
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

    const isWhisper = selectedModel === 'whisper-1';
    const fields = {
      model: selectedModel,
      language: 'ja',
      ...(isWhisper ? { response_format: 'verbose_json' } : { response_format: 'json' }),
    };

    const multipartBody = buildMultipart(boundary, fields, audioBuffer, mimeType, fileName);

    // OpenAI API 呼び出し
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      });
    } catch (fetchErr) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'OpenAI APIへの接続に失敗しました。インターネット接続を確認してください。',
          details: fetchErr.message,
        }),
      };
    }

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errJson = await response.json();
        errorDetail = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        try { errorDetail = await response.text(); } catch {}
      }

      const errorMessages = {
        400: `リクエストが不正です。ファイル形式やサイズを確認してください。\n詳細: ${errorDetail}`,
        401: 'OpenAI APIキーが無効です。Netlifyの環境変数 OPENAI_API_KEY を確認してください。',
        403: 'OpenAI APIへのアクセスが拒否されました。APIキーの権限を確認してください。',
        413: 'ファイルサイズが大きすぎます。Netlify Functionsの制限に当たった可能性があります。分割単位を短くして再試行してください。',
        429: 'APIの利用制限に達しました。しばらく待ってから再試行してください。',
        500: `OpenAI APIでエラーが発生しました。しばらく待ってから再試行してください。\n詳細: ${errorDetail}`,
        503: 'OpenAI APIが一時的に利用できません。しばらく待ってから再試行してください。',
      };

      const message = errorMessages[response.status]
        || `APIエラーが発生しました（ステータス: ${response.status}）。\n詳細: ${errorDetail}`;

      return {
        statusCode: response.status >= 500 ? 502 : response.status,
        headers,
        body: JSON.stringify({ success: false, error: message }),
      };
    }

    let result;
    try {
      result = await response.json();
    } catch (e) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'APIからの応答を解析できませんでした。Netlify Functionsの制限により失敗した可能性があります。',
        }),
      };
    }

    if (!result || (!result.text && !result.segments)) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: '文字起こし結果が空でした。音声ファイルに音声が含まれているか確認してください。',
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        model: selectedModel,
        text: result.text || '',
        hasTimestamps: isWhisper && Array.isArray(result.segments) && result.segments.length > 0,
        segments: isWhisper ? (result.segments || []) : [],
        estimatedDuration: isWhisper && result.segments?.length > 0
          ? result.segments[result.segments.length - 1].end
          : null,
      }),
    };

  } catch (err) {
    console.error('Transcription error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: `予期しないエラーが発生しました。Netlify Functionsの制限により失敗した可能性があります。`,
        details: err.message,
      }),
    };
  }
};
