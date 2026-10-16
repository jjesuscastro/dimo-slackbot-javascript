'use strict';

const { File } = require('node:buffer');

function timestampSuffix(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function appendTimestamp(filename, stamp) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}_${stamp}${filename.slice(dot)}` : `${filename}_${stamp}`;
}

async function uploadDefault(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('No validated HTML files to upload.');
  const uploadUrl = process.env.PLEC_UPLOAD_URL;
  const originUrl = process.env.PLEC_ORIGIN_URL;
  if (!uploadUrl || !originUrl) throw new Error('PLEC_UPLOAD_URL and PLEC_ORIGIN_URL must be configured.');

  const form = new FormData();
  const stamp = timestampSuffix();
  files.forEach((file, index) => {
    const number = index + 1;
    const stampedName = appendTimestamp(file.name, stamp);
    form.append(`fileUpload_${number}`, new File([file.bytes], stampedName, { type: 'text/html' }));
    form.append(`iterationNameUpload_${number}`, encodeURIComponent(file.iteration));
  });

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    headers: {
      Origin: originUrl,
      Referer: `${originUrl}/`,
      'User-Agent': 'Mozilla/5.0 (Dimo-PLEC-Slack-Bot)',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: '*/*',
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`PLEC returned HTTP ${response.status}: ${text.slice(0, 500)}`);

  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error(`PLEC returned a non-JSON response: ${text.slice(0, 300)}`); }

  const link = result.preview || result.previewURL;
  if (typeof link !== 'string' || !link) throw new Error('PLEC did not return a preview link.');
  return link;
}

module.exports = { uploadDefault };
