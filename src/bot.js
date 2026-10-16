'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const path = require('node:path');
const { unzipSync } = require('fflate');
const SevenZip = require('7z-wasm');
const { createExtractorFromData } = require('node-unrar-js');
const { validateFilename } = require('./filename-validator');
const { uploadDefault } = require('./plec');

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env before starting the bot.');
}

const allowedChannels = new Set((process.env.ALLOWED_CHANNEL_IDS || '').split(',').map((v) => v.trim()).filter(Boolean));
const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const MAX_HTML_FILE_BYTES = 5 * 1024 * 1024;

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

function extractHtmlFiles(zipBytes) {
  let limitError = '';
  const extracted = unzipSync(zipBytes, {
    filter: ({ name, originalSize }) => {
      if (!/\.html?$/i.test(name)) return false;
      if (originalSize > MAX_HTML_FILE_BYTES) limitError = 'An HTML file in the ZIP exceeds the 5 MB limit.';
      return !limitError;
    },
  });
  if (limitError) throw new Error(limitError);

  return Object.entries(extracted).map(([entryName, bytes]) => ({
    filename: path.posix.basename(entryName.replaceAll('\\', '/')),
    bytes: Buffer.from(bytes),
  }));
}

function collectHtmlFilesFromMemoryFs(fs, directory) {
  const files = [];
  for (const entry of fs.readdir(directory)) {
    if (entry === '.' || entry === '..') continue;
    const entryPath = path.posix.join(directory, entry);
    const stat = fs.stat(entryPath);
    if (fs.isDir(stat.mode)) {
      files.push(...collectHtmlFilesFromMemoryFs(fs, entryPath));
    } else if (/\.html?$/i.test(entry)) {
      if (stat.size > MAX_HTML_FILE_BYTES) {
        throw new Error('An HTML file in the archive exceeds the 5 MB limit.');
      }
      files.push({
        filename: entry,
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
    fs.mkdir('/html-output');
    sevenZip.callMain([
      'x', '-y', '-ssc-', '-r', '-o/html-output', '/archive.7z', '*.html', '*.htm',
    ]);
    return collectHtmlFilesFromMemoryFs(fs, '/html-output');
  } finally {
    if (sevenZip) {
      removeMemoryFsPath(sevenZip.FS, '/html-output');
      removeMemoryFsPath(sevenZip.FS, '/archive.7z');
    }
  }
}

async function extractRarFiles(archiveBytes) {
  const data = Uint8Array.from(archiveBytes).buffer;
  const extractor = await createExtractorFromData({ data });
  const fileHeaders = [...extractor.getFileList().fileHeaders]
    .filter(({ flags, name }) => !flags.directory && /\.html?$/i.test(name));
  const oversizedFile = fileHeaders.find(({ unpSize }) => unpSize > MAX_HTML_FILE_BYTES);
  if (oversizedFile) throw new Error(`HTML file \`${path.posix.basename(oversizedFile.name)}\` in the archive exceeds the 5 MB limit.`);

  const names = new Set(fileHeaders.map(({ name }) => name));
  const extracted = extractor.extract({ files: ({ name }) => names.has(name) });
  return [...extracted.files].map(({ fileHeader, extraction }) => ({
    filename: path.posix.basename(fileHeader.name.replaceAll('\\', '/')),
    bytes: Buffer.from(extraction),
  }));
}

function validateHtmlContent(bytes) {
  const html = bytes.toString('utf8');
  const windowOpenPattern = /\bwindow\s*(?:(?:\?\.|\.)\s*open\b|\[\s*(["'`])open\1\s*\])/;
  const mraidOpenPattern = /\bmraid\s*\.\s*open\b/;
  const errors = [];

  if (windowOpenPattern.test(html)) errors.push('Must not contain `window.open`.');
  if (!mraidOpenPattern.test(html)) errors.push('Must contain `mraid.open`.');
  return errors;
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
  const candidates = message.files.filter((file) => /\.(?:html?|zip|rar|7z)$/i.test(file.name || ''));
  if (!candidates.length) return;
  const htmlFiles = [];

  for (const file of candidates) {
    const filename = file.name || 'unnamed file';
    try {
      if (/\.zip$/i.test(filename)) {
        const zipBytes = await downloadSlackFile(file);
        htmlFiles.push(...extractHtmlFiles(zipBytes));
      } else if (/\.rar$/i.test(filename)) {
        const archiveBytes = await downloadSlackFile(file);
        htmlFiles.push(...await extractRarFiles(archiveBytes));
      } else if (/\.7z$/i.test(filename)) {
        const archiveBytes = await downloadSlackFile(file);
        htmlFiles.push(...await extractSevenZipFiles(archiveBytes));
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
  if (!htmlFiles.length) return;

  const invalidFiles = [];
  const correctlyNamedFiles = [];

  for (const { filename, bytes } of htmlFiles) {
    const check = validateFilename(filename);
    const errors = [...check.errors, ...validateHtmlContent(bytes)];
    if (errors.length) invalidFiles.push({ filename, errors });
    if (check.valid) correctlyNamedFiles.push(filename);
  }
  if (invalidFiles.length) {
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
  try {
    const link = await uploadDefault(validFiles);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: addEditTimestamp(`<${link}|AppLovin>`),
    });
  } catch (error) {
    logger.error('PLEC batch upload failed:', error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: addEditTimestamp(`The ${validFiles.length} validated file${validFiles.length === 1 ? '' : 's'} could not be uploaded to PLEC: ${error.message}`),
    });
  }
});

(async () => {
  await app.start();
  console.log('Dimo PLEC Slack Bot is running in Socket Mode.');
})().catch((error) => {
  console.error('Bot failed to start:', error);
  process.exitCode = 1;
});
