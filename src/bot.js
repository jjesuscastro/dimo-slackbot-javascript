'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const path = require('node:path');
const { unzipSync } = require('fflate');
const SevenZip = require('7z-wasm');
const { createExtractorFromData } = require('node-unrar-js');
const { validateFilename } = require('./filename-validator');
const { createVideoHtml } = require('./video-to-html');
const { uploadDefault } = require('./plec');
const { recordFiles, getStats, getCsvRows, toCsv, periodLabels } = require('./stats');

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env before starting the bot.');
}

const allowedChannels = new Set((process.env.ALLOWED_CHANNEL_IDS || '').split(',').map((v) => v.trim()).filter(Boolean));
const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const MAX_HTML_FILE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_PAIR_BYTES = 3.4 * 1024 * 1024;
const PERIOD_ALIASES = new Map([
  ['today', 'today'], ['day', 'today'], ['current-day', 'today'],
  ['week', 'week'], ['current-week', 'week'],
  ['month', 'month'], ['current-month', 'month'],
  ['yesterday', 'yesterday'],
  ['lastweek', 'lastweek'], ['last-week', 'lastweek'],
  ['lastmonth', 'lastmonth'], ['last-month', 'lastmonth'],
  ['all', 'all'], ['all-time', 'all'],
]);
const uploaderNameCache = new Map();

async function getUploaderName(client, userId, message) {
  const snapshot = message.user_profile?.display_name || message.user_profile?.real_name
    || message.user_profile?.name;
  if (snapshot) return snapshot;
  if (!userId) return 'Unknown';
  if (uploaderNameCache.has(userId)) return uploaderNameCache.get(userId);
  try {
    const result = await client.users.info({ user: userId });
    const name = result.user?.profile?.display_name || result.user?.profile?.real_name || result.user?.name || userId;
    uploaderNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

function parseStatsCommand(commandText = '') {
  const words = commandText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const csv = words.includes('csv');
  const periods = words.filter((word) => word !== 'csv');
  if (periods.length > 1) return null;
  const periodWord = periods[0];
  const period = periodWord ? PERIOD_ALIASES.get(periodWord) : 'all';
  if (words.some((word) => word !== 'csv' && !PERIOD_ALIASES.has(word))) return null;
  return { csv, period };
}

function formatStats(stats) {
  const { totals, topUploaders } = stats;
  const lines = [
    `*Dimo statistics — ${stats.label} (Asia/Manila)*`,
    `Files processed: ${totals.processed}`,
    `Uploaded successfully: ${totals.uploaded}`,
    `Naming issues: ${totals.naming_issues}`,
    `Missing mraid.open: ${totals.missing_mraid_open}`,
    `Contains window.open: ${totals.window_open_issues}`,
    `Upload failures: ${totals.failures}`,
  ];
  if (topUploaders.length) {
    lines.push('', '*Top uploaders*', ...topUploaders.map((user) =>
      `• ${user.uploader_display_name} (<@${user.uploader_id}>): ${user.uploaded} uploaded / ${user.processed} processed`));
  }
  lines.push('', '_Issue counts can overlap. Files inside archives are counted individually._');
  return lines.join('\n');
}

app.command('/stats', async ({ command, ack, respond, client, logger }) => {
  await ack();
  const options = parseStatsCommand(command.text);
  if (!options) {
    await respond({ response_type: 'ephemeral', text: 'Usage: `/stats [today|week|month|yesterday|lastweek|lastmonth|all] [csv]`' });
    return;
  }
  try {
    const stats = getStats(options.period);
    if (options.csv) {
      const csv = toCsv(getCsvRows(options.period));
      const date = new Date().toISOString().slice(0, 10);
      const filename = `dimo-stats-${options.period}-${date}.csv`;
      const dm = await client.conversations.open({ users: command.user_id });
      await client.files.uploadV2({
        channel_id: dm.channel.id,
        file: Buffer.from(csv, 'utf8'),
        filename,
        title: `Dimo statistics — ${periodLabels[options.period]}`,
        initial_comment: `Private CSV export for ${stats.label}.`,
      });
    }
    await respond({
      response_type: 'ephemeral',
      text: `${formatStats(stats)}${options.csv ? '\n\nI sent the CSV to you in a private message.' : ''}`,
    });
  } catch (error) {
    logger.error('Could not generate statistics:', error);
    await respond({ response_type: 'ephemeral', text: 'I could not generate the statistics right now.' });
  }
});

async function downloadSlackFile(file, maxBytes = Infinity) {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error('Slack did not provide a private download URL.');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Slack file download failed (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > maxBytes) throw new Error(`The file exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('The uploaded file is empty.');
  if (bytes.length > maxBytes) throw new Error(`The file exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  return bytes;
}

function groupExtractedFiles(files) {
  const htmlFiles = [];
  const videoFiles = [];
  for (const file of files) {
    if (/\.mp4$/i.test(file.filename)) videoFiles.push({ ...file, name: file.filename, size: file.bytes.length });
    else htmlFiles.push(file);
  }
  return { htmlFiles, videoFiles };
}

function extractSupportedZipFiles(zipBytes) {
  let limitError = '';
  const extracted = unzipSync(zipBytes, {
    filter: ({ name, originalSize }) => {
      const isHtml = /\.html?$/i.test(name);
      const isVideo = /\.mp4$/i.test(name);
      if (!isHtml && !isVideo) return false;
      if (isHtml && originalSize > MAX_HTML_FILE_BYTES) limitError = 'An HTML file in the ZIP exceeds the 5 MB limit.';
      if (isVideo && originalSize > MAX_VIDEO_PAIR_BYTES) limitError = 'An MP4 file in the ZIP exceeds the 3.40 MB per-video limit.';
      return !limitError;
    },
  });
  if (limitError) throw new Error(limitError);

  return groupExtractedFiles(Object.entries(extracted).map(([entryName, bytes]) => ({
    filename: path.posix.basename(entryName.replaceAll('\\', '/')),
    entryName: entryName.replaceAll('\\', '/'),
    bytes: Buffer.from(bytes),
  })));
}

function collectSupportedFilesFromMemoryFs(fs, directory, root = directory) {
  const files = [];
  for (const entry of fs.readdir(directory)) {
    if (entry === '.' || entry === '..') continue;
    const entryPath = path.posix.join(directory, entry);
    const stat = fs.stat(entryPath);
    if (fs.isDir(stat.mode)) {
      files.push(...collectSupportedFilesFromMemoryFs(fs, entryPath, root));
    } else if (/\.(?:html?|mp4)$/i.test(entry)) {
      const isVideo = /\.mp4$/i.test(entry);
      const maxBytes = isVideo ? MAX_VIDEO_PAIR_BYTES : MAX_HTML_FILE_BYTES;
      if (stat.size > maxBytes) {
        if (isVideo) throw new Error(`MP4 file \`${entry}\` in the 7z archive exceeds the 3.40 MB per-video limit.`);
        throw new Error('An HTML file in the archive exceeds the 5 MB limit.');
      }
      files.push({
        filename: entry,
        entryName: path.posix.relative(root, entryPath),
        bytes: Buffer.from(fs.readFile(entryPath)),
      });
    }
  }
  return files;
}

function removeMemoryFsPath(fs, targetPath) {
  try {
    if (fs.isDir(fs.stat(targetPath).mode)) {
      for (const entry of fs.readdir(targetPath)) {
        if (entry !== '.' && entry !== '..') removeMemoryFsPath(fs, path.posix.join(targetPath, entry));
      }
      fs.rmdir(targetPath);
    } else fs.unlink(targetPath);
  } catch {
    // The module's in-memory filesystem is discarded after this archive is processed.
  }
}

async function extractSevenZipFiles(archiveBytes) {
  let sevenZip;
  try {
    sevenZip = await SevenZip({ print: () => {}, printErr: () => {} });
    const fs = sevenZip.FS;
    fs.writeFile('/archive.7z', archiveBytes);
    fs.mkdir('/supported-output');
    sevenZip.callMain([
      'x', '-y', '-ssc-', '-r', '-o/supported-output', '/archive.7z', '*.html', '*.htm', '*.mp4',
    ]);
    return groupExtractedFiles(collectSupportedFilesFromMemoryFs(fs, '/supported-output'));
  } finally {
    if (sevenZip) {
      removeMemoryFsPath(sevenZip.FS, '/supported-output');
      removeMemoryFsPath(sevenZip.FS, '/archive.7z');
    }
  }
}

async function extractRarFiles(archiveBytes) {
  const data = Uint8Array.from(archiveBytes).buffer;
  const extractor = await createExtractorFromData({ data });
  const fileHeaders = [...extractor.getFileList().fileHeaders]
    .filter(({ flags, name }) => !flags.directory && /\.(?:html?|mp4)$/i.test(name));
  const oversizedFile = fileHeaders.find(({ unpSize, name }) =>
    unpSize > (/\.mp4$/i.test(name) ? MAX_VIDEO_PAIR_BYTES : MAX_HTML_FILE_BYTES));
  if (oversizedFile) {
    const filename = path.posix.basename(oversizedFile.name);
    if (/\.mp4$/i.test(filename)) throw new Error(`MP4 file \`${filename}\` in the RAR archive exceeds the 3.40 MB per-video limit.`);
    throw new Error(`HTML file \`${filename}\` in the archive exceeds the 5 MB limit.`);
  }

  const names = new Set(fileHeaders.map(({ name }) => name));
  const extracted = extractor.extract({ files: ({ name }) => names.has(name) });
  return groupExtractedFiles([...extracted.files].map(({ fileHeader, extraction }) => ({
    filename: path.posix.basename(fileHeader.name.replaceAll('\\', '/')),
    entryName: fileHeader.name.replaceAll('\\', '/'),
    bytes: Buffer.from(extraction),
  })));
}

function validateHtmlContent(bytes) {
  const html = bytes.toString('utf8');
  const windowOpenPattern = /\bwindow\s*(?:(?:\?\.|\.)\s*open\b|\[\s*(["'`])open\1\s*\])/;
  const mraidOpenPattern = /\bmraid\s*\.\s*open\b/;
  const reservedClickPattern = /(?<![\w$])(?:clickTag1|clickthrough)(?![\w$])/gi;
  const errors = [];

  if (windowOpenPattern.test(html)) errors.push('Must not contain `window.open`.');
  if (!mraidOpenPattern.test(html)) errors.push('Must contain `mraid.open`.');
  const reservedClickNames = [...new Set([...html.matchAll(reservedClickPattern)].map(([name]) => name))];
  if (reservedClickNames.length) {
    errors.push(`Rename reserved click identifier(s) ${reservedClickNames.join(', ')}. For click tracking, use the platform-injected \`window.clickTag\`.`);
  }
  return errors;
}

function collectVideoPairs(files) {
  const groups = new Map();
  const errors = [];

  for (const file of files) {
    const filename = file.name || 'unnamed file';
    const match = filename.match(/^(.*)_(portrait|landscape)\.mp4$/i);
    if (!match || !match[1]) {
      errors.push(`\`${filename}\`: expected a valid HTML filename followed by _portrait.mp4 or _landscape.mp4.`);
      continue;
    }

    const base = match[1];
    const outputFilename = `${base}.html`;
    const nameCheck = validateFilename(outputFilename);
    if (!nameCheck.valid) {
      errors.push(`\`${filename}\`: ${nameCheck.errors.join(' ')}`);
      continue;
    }

    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, { base, outputFilename, portrait: null, landscape: null });
    const group = groups.get(key);
    const orientation = match[2].toLowerCase();
    if (group[orientation]) {
      errors.push(`\`${filename}\`: duplicate ${orientation} video for \`${base}\`.`);
      continue;
    }
    group[orientation] = file;
  }

  for (const group of groups.values()) {
    if (!group.portrait || !group.landscape) {
      const missing = group.portrait ? 'landscape' : 'portrait';
      errors.push(`\`${group.base}\`: missing the ${missing} video; each HTML needs one matching portrait and landscape MP4.`);
      continue;
    }

    const declaredSize = Number(group.portrait.size || 0) + Number(group.landscape.size || 0);
    if (declaredSize > MAX_VIDEO_PAIR_BYTES) {
      errors.push(`\`${group.base}\`: the two videos total ${ (declaredSize / (1024 * 1024)).toFixed(2) } MB; the Video to HTML limit is 3.40 MB per pair.`);
    }
  }

  if (files.length < 2) errors.push('At least two MP4 files are required to form a portrait/landscape pair.');
  return { pairs: [...groups.values()].filter((group) => group.portrait && group.landscape), errors };
}

function addBirthdayMessage(text, date = new Date()) {
  const manilaDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return manilaDate === '2026-10-21' ? `${text}\n\nHappy Birthday Marcus!` : text;
}

app.event('message', async ({ event, client, logger }) => {
  // Slack wraps an edited message in event.message and marks the outer event
  // as message_changed. Use the updated message so edits only reprocess that
  // message's current attachments.
  const message = event.subtype === 'message_changed' ? event.message : event;
  if (!message?.files?.length || !event.channel || message.bot_id) return;
  if (allowedChannels.size && !allowedChannels.has(event.channel)) return;

  const thread_ts = message.thread_ts || message.ts;
  const editedAt = event.subtype === 'message_changed'
    ? Number(message.edited?.ts || event.event_ts)
    : null;
  const addEditTimestamp = (text) => {
    if (!Number.isFinite(editedAt)) return text;
    const fallback = `${new Date(editedAt * 1000).toISOString().replace('T', ' ').replace('Z', '')} UTC`;
    return `${text}\n\nRechecked after edit: <!date^${Math.floor(editedAt)}^{date_num} {time_secs}|${fallback}>`;
  };
  const candidates = message.files.filter((file) => /\.(?:html?|zip|rar|7z|mp4)$/i.test(file.name || ''));
  if (!candidates.length) return;
  const videoFiles = candidates.filter((file) => /\.mp4$/i.test(file.name || ''));
  const uploaderId = message.user || 'unknown';
  const htmlFiles = [];
  const builtHtmlFiles = [];

  for (const file of candidates) {
    const filename = file.name || 'unnamed file';
    try {
      if (/\.mp4$/i.test(filename)) {
        continue;
      } else if (/\.zip$/i.test(filename)) {
        const zipBytes = await downloadSlackFile(file);
        const extracted = extractSupportedZipFiles(zipBytes);
        htmlFiles.push(...extracted.htmlFiles);
        videoFiles.push(...extracted.videoFiles);
      } else if (/\.rar$/i.test(filename)) {
        const archiveBytes = await downloadSlackFile(file);
        const extracted = await extractRarFiles(archiveBytes);
        htmlFiles.push(...extracted.htmlFiles);
        videoFiles.push(...extracted.videoFiles);
      } else if (/\.7z$/i.test(filename)) {
        const archiveBytes = await downloadSlackFile(file);
        const extracted = await extractSevenZipFiles(archiveBytes);
        htmlFiles.push(...extracted.htmlFiles);
        videoFiles.push(...extracted.videoFiles);
      } else {
        htmlFiles.push({ filename, bytes: await downloadSlackFile(file, MAX_HTML_FILE_BYTES) });
      }
    } catch (error) {
      logger.error(`Failed to process ${filename}:`, error);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: addEditTimestamp(`Could not process \`${filename}\`: ${error.message}`),
      });
    }
  }
  let videoPairs = [];
  if (videoFiles.length) {
    const pairing = collectVideoPairs(videoFiles);
    if (pairing.errors.length) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: addEditTimestamp(`Video filename issues:\n${pairing.errors.map((issue) => `- ${issue}`).join('\n')}\n\nFix the video filenames and upload one matching _portrait.mp4 and _landscape.mp4 for each HTML.`),
      });
      return;
    }
    videoPairs = pairing.pairs;
  }
  if (!htmlFiles.length && !videoPairs.length) return;
  const uploaderDisplayName = await getUploaderName(client, uploaderId, message);
  for (const pair of videoPairs) {
    try {
      const portraitBytes = pair.portrait.bytes
        ? Buffer.from(pair.portrait.bytes)
        : await downloadSlackFile(pair.portrait, MAX_VIDEO_PAIR_BYTES);
      const remainingBytes = MAX_VIDEO_PAIR_BYTES - portraitBytes.length;
      if (remainingBytes <= 0) throw new Error('The portrait and landscape videos exceed the 3.40 MB pair limit.');
      const landscapeBytes = pair.landscape.bytes
        ? Buffer.from(pair.landscape.bytes)
        : await downloadSlackFile(pair.landscape, remainingBytes);
      const bytes = portraitBytes.length + landscapeBytes.length;
      if (bytes > MAX_VIDEO_PAIR_BYTES) throw new Error('The portrait and landscape videos exceed the 3.40 MB pair limit.');
      const builtHtml = {
        filename: pair.outputFilename,
        bytes: Buffer.from(createVideoHtml(
          { filename: pair.portrait.name, bytes: portraitBytes },
          { filename: pair.landscape.name, bytes: landscapeBytes },
        ), 'utf8'),
      };
      htmlFiles.push(builtHtml);
      builtHtmlFiles.push(builtHtml);
    } catch (error) {
      logger.error(`Failed to convert ${pair.base}:`, error);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: addEditTimestamp(`Could not convert video pair \`${pair.base}\`: ${error.message}`),
      });
    }
  }
  if (!htmlFiles.length) return;

  const invalidFiles = [];
  const correctlyNamedFiles = [];
  const records = [];

  for (const { filename, bytes } of htmlFiles) {
    const check = validateFilename(filename);
    const contentErrors = validateHtmlContent(bytes);
    const sizeErrors = bytes.length > MAX_HTML_FILE_BYTES
      ? ['The HTML file exceeds the 5 MB limit.']
      : [];
    const errors = [...check.errors, ...contentErrors, ...sizeErrors];
    records.push({
      checked_at: new Date().toISOString(),
      uploader_id: uploaderId,
      uploader_display_name: uploaderDisplayName,
      filename,
      naming_ok: Number(check.valid),
      has_mraid_open: Number(!contentErrors.includes('Must contain `mraid.open`.')),
      has_window_open: Number(contentErrors.includes('Must not contain `window.open`.')),
      uploaded: 0,
      outcome: errors.length ? 'validation_failed' : '',
      issue_details: errors.join('; '),
    });
    if (errors.length) invalidFiles.push({ filename, errors });
    if (check.valid) correctlyNamedFiles.push(filename);
  }
  if (invalidFiles.length) {
    recordFiles(records.filter((row) => row.outcome === 'validation_failed'));
    const issueLines = invalidFiles.map(({ filename, errors }) =>
      `- \`${filename}\`:\n  - ${errors.join('\n  - ')}`,
    );
    const correctLines = correctlyNamedFiles.map((filename) => `- \`${filename}\``);
    const correctSection = correctLines.length
      ? `\n\nCorrectly named files (not uploaded):\n${correctLines.join('\n')}`
      : '';
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: addEditTimestamp(`File validation issues:\n${issueLines.join('\n')}${correctSection}\n\nPlease fix the file(s) and reupload them in this same thread.`),
    });
    return;
  }

  const validFiles = htmlFiles.map(({ filename, bytes }) => ({
    name: filename,
    bytes,
    iteration: filename.replace(/\.html?$/i, ''),
  }));

  if (!validFiles.length) return;
  validFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  let link;
  try {
    link = await uploadDefault(validFiles);
  } catch (error) {
    records.forEach((row) => {
      row.outcome = 'failed';
      row.issue_details = [row.issue_details, `PLEC upload failed: ${error.message}`].filter(Boolean).join('; ');
    });
    recordFiles(records);
    logger.error('PLEC batch upload failed:', error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: addEditTimestamp(`The ${validFiles.length} validated file${validFiles.length === 1 ? '' : 's'} could not be uploaded to PLEC: ${error.message}`),
    });
    return;
  }

  records.forEach((row) => { row.uploaded = 1; row.outcome = 'uploaded'; });
  recordFiles(records);
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts,
    text: addEditTimestamp(addBirthdayMessage(`<${link}|AppLovin>`)),
  });

  for (const file of builtHtmlFiles) {
    try {
      await client.files.uploadV2({
        channel_id: event.channel,
        thread_ts,
        file: file.bytes,
        filename: file.filename,
        title: file.filename,
      });
    } catch (error) {
      logger.error(`Could not attach generated HTML ${file.filename}:`, error);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: addEditTimestamp(`The PLEC upload succeeded, but I could not attach \`${file.filename}\` here: ${error.message}`),
      });
    }
  }
});

(async () => {
  await app.start();
  console.log('Dimo PLEC Slack Bot is running in Socket Mode.');
})().catch((error) => {
  console.error('Bot failed to start:', error);
  process.exitCode = 1;
});
