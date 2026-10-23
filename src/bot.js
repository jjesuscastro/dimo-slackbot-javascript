'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const path = require('node:path');
const { unzipSync, zipSync } = require('fflate');
const SevenZip = require('7z-wasm');
const { createExtractorFromData } = require('node-unrar-js');
const { validateFilename } = require('./filename-validator');
const { uploadDefault } = require('./plec');
const { recordFiles, getStats, getCsvRows, toCsv, periodLabels } = require('./stats');
const { listProjects, addProjectFiles, getProjectFiles, getProject, clearProjectFiles } = require('./projects');

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env before starting the bot.');
}

const allowedChannels = new Set((process.env.ALLOWED_CHANNEL_IDS || '').split(',').map((v) => v.trim()).filter(Boolean));
const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const MAX_HTML_FILE_BYTES = 5 * 1024 * 1024;
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

function projectModal(action = 'add') {
  const actionOptions = [
    { text: { type: 'plain_text', text: 'Add files' }, value: 'add' },
    { text: { type: 'plain_text', text: 'Create ZIP' }, value: 'zip' },
  ];
  const blocks = [
    {
      type: 'input', block_id: 'project_action_block', label: { type: 'plain_text', text: 'What would you like to do?' },
      dispatch_action: true,
      element: { type: 'static_select', action_id: 'project_action', options: actionOptions,
        initial_option: actionOptions.find((option) => option.value === action) },
    },
  ];
  if (action === 'add') {
    blocks.push(
      {
        type: 'input', block_id: 'project_add_picker_block', label: { type: 'plain_text', text: 'Project' },
        element: { type: 'external_select', action_id: 'project_add_picker', min_query_length: 0,
          placeholder: { type: 'plain_text', text: 'Search or choose a project' } },
      },
      {
        type: 'input', block_id: 'project_name_block', optional: true,
        label: { type: 'plain_text', text: 'New project name (only when creating a project)' },
        element: { type: 'plain_text_input', action_id: 'project_name', max_length: 80,
          placeholder: { type: 'plain_text', text: 'For example, Spring Launch' } },
      },
      {
        type: 'input', block_id: 'project_links_block',
        label: { type: 'plain_text', text: 'Slack file links' },
        element: { type: 'plain_text_input', action_id: 'project_links', multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste one or more Slack file links' } },
      },
    );
  } else {
    if (!listProjects().length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'There are no projects yet. Switch to *Add files* and create one first.' } });
    }
    blocks.push({
      type: 'input', block_id: 'project_zip_picker_block', label: { type: 'plain_text', text: 'Project' },
      element: { type: 'external_select', action_id: 'project_zip_picker', min_query_length: 0,
        placeholder: { type: 'plain_text', text: 'Search for a project to ZIP' } },
    });
  }
  return {
    type: 'modal', callback_id: 'project_workflow_submit', private_metadata: '',
    title: { type: 'plain_text', text: 'Project files' },
    submit: { type: 'plain_text', text: action === 'add' ? 'Add files' : 'Create ZIP' },
    close: { type: 'plain_text', text: 'Cancel' }, blocks,
  };
}

function projectPickerOptions(query, includeCreate = false) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  const projects = listProjects().filter(({ name }) => name.toLocaleLowerCase().includes(normalizedQuery));
  const options = projects.slice(0, 99).map(({ id, name, file_count }) => ({
    text: { type: 'plain_text', text: `${name} (${file_count} files)`.slice(0, 75) },
    value: String(id),
  }));
  if (includeCreate) options.unshift({
    text: { type: 'plain_text', text: 'Create new project' }, value: 'new_project',
  });
  return options.slice(0, 100);
}

app.command('/project', async ({ command, ack, client, respond, logger }) => {
  await ack({ response_type: 'ephemeral', text: 'Opening your private project manager.' });
  const view = projectModal();
  view.private_metadata = JSON.stringify({ channelId: command.channel_id });
  try {
    await client.views.open({ trigger_id: command.trigger_id, view });
  } catch (error) {
    logger.error('Could not open project manager:', error);
    await respond({ response_type: 'ephemeral', text: 'I could not open the project manager. Please try again.' });
  }
});

app.action('project_action', async ({ ack, body, client, logger }) => {
  await ack();
  const action = body.actions[0].selected_option.value;
  const view = projectModal(action);
  view.private_metadata = body.view.private_metadata;
  try {
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view });
  } catch (error) {
    logger.error('Could not update project manager:', error);
  }
});

app.options('project_add_picker', async ({ ack, body }) => {
  await ack({ options: projectPickerOptions(body.value, true) });
});

app.options('project_zip_picker', async ({ ack, body }) => {
  await ack({ options: projectPickerOptions(body.value) });
});

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
    entryName: entryName.replaceAll('\\', '/'),
    bytes: Buffer.from(bytes),
  }));
}

function collectHtmlFilesFromMemoryFs(fs, directory, root = directory) {
  const files = [];
  for (const entry of fs.readdir(directory)) {
    if (entry === '.' || entry === '..') continue;
    const entryPath = path.posix.join(directory, entry);
    const stat = fs.stat(entryPath);
    if (fs.isDir(stat.mode)) {
      files.push(...collectHtmlFilesFromMemoryFs(fs, entryPath, root));
    } else if (/\.html?$/i.test(entry)) {
      if (stat.size > MAX_HTML_FILE_BYTES) {
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
    entryName: fileHeader.name.replaceAll('\\', '/'),
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

function extractSlackFileIds(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>|]+/gi) || [];
  const ids = [];
  for (const url of urls) {
    const match = url.match(/(?:^|[\/-])(F[A-Z0-9]{8,})(?=$|[\/?&#.,)-])/i);
    if (match && !ids.includes(match[1].toUpperCase())) ids.push(match[1].toUpperCase());
  }
  return ids;
}

async function postProjectPrivateMessage(client, channelId, userId, text) {
  if (channelId) {
    try {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text });
      return;
    } catch {
      // A private DM is used as a fallback for conversations that do not support ephemerals.
    }
  }
  const dm = await client.conversations.open({ users: userId });
  await client.chat.postMessage({ channel: dm.channel.id, text });
}

function safeZipFilename(name) {
  const basename = path.posix.basename(String(name || 'file.html').replaceAll('\\', '/'));
  return basename.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 180) || 'file.html';
}

function makeProjectZip(files) {
  const entries = {};
  const used = new Set();
  for (const file of files) {
    const safeName = safeZipFilename(file.filename);
    const ext = path.posix.extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);
    let outputName = safeName;
    let suffix = 2;
    while (used.has(outputName.toLocaleLowerCase())) outputName = `${stem} (${suffix++})${ext}`;
    used.add(outputName.toLocaleLowerCase());
    entries[outputName] = Buffer.from(file.content);
  }
  return zipSync(entries, { level: 6 });
}

app.view('project_workflow_submit', async ({ ack, body, view, client, logger }) => {
  const values = view.state.values;
  const action = values.project_action_block?.project_action?.selected_option?.value;
  const metadata = (() => {
    try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; }
  })();
  const channelId = metadata.channelId;
  const userId = body.user.id;
  let projectName = '';
  let projectId = null;
  let links = [];

  if (action === 'add') {
    const selection = values.project_add_picker_block?.project_add_picker?.selected_option?.value;
    const newName = values.project_name_block?.project_name?.value?.trim() || '';
    links = extractSlackFileIds(values.project_links_block?.project_links?.value);
    if (!selection) {
      await ack({ response_action: 'errors', errors: { project_add_picker_block: 'Choose a project or create a new one.' } });
      return;
    }
    if (selection === 'new_project' && !newName) {
      await ack({ response_action: 'errors', errors: { project_name_block: 'Enter a name for the new project.' } });
      return;
    }
    if (selection === 'new_project' && newName.length > 80) {
      await ack({ response_action: 'errors', errors: { project_name_block: 'Project names can be at most 80 characters.' } });
      return;
    }
    if (!links.length) {
      await ack({ response_action: 'errors', errors: { project_links_block: 'Paste at least one valid Slack file link.' } });
      return;
    }
    projectName = selection === 'new_project' ? newName : '';
    projectId = selection === 'new_project' ? null : Number(selection);
    if (projectId && !getProject(projectId)) {
      await ack({ response_action: 'errors', errors: { project_add_picker_block: 'That project is no longer available. Choose it again.' } });
      return;
    }
  } else if (action === 'zip') {
    const selection = values.project_zip_picker_block?.project_zip_picker?.selected_option?.value;
    projectId = Number(selection);
    if (!selection || !Number.isInteger(projectId) || !getProject(projectId)) {
      await ack({ response_action: 'errors', errors: { project_zip_picker_block: 'Choose an existing project.' } });
      return;
    }
  } else {
    await ack({ response_action: 'errors', errors: { project_action_block: 'Choose Add files or Create ZIP.' } });
    return;
  }

  await ack({ response_action: 'clear' });
  try {
    if (action === 'add') {
      const collected = [];
      const errors = [];
      for (const fileId of links) {
        try {
          const result = await client.files.info({ file: fileId });
          const slackFile = result.file;
          if (!slackFile?.name) throw new Error('Slack did not return a filename for that link.');
          const filename = path.posix.basename(slackFile.name.replaceAll('\\', '/'));
          if (/\.html?$/i.test(filename)) {
            const bytes = await downloadSlackFile(slackFile, MAX_HTML_FILE_BYTES);
            collected.push({ sourceFileId: fileId, entryName: filename, filename, bytes });
          } else if (/\.(?:zip|rar|7z)$/i.test(filename)) {
            const archiveBytes = await downloadSlackFile(slackFile);
            let extracted;
            if (/\.zip$/i.test(filename)) extracted = extractHtmlFiles(archiveBytes);
            else if (/\.rar$/i.test(filename)) extracted = await extractRarFiles(archiveBytes);
            else extracted = await extractSevenZipFiles(archiveBytes);
            if (!extracted.length) throw new Error('The archive contains no HTML or HTM files.');
            for (const item of extracted) {
              collected.push({ sourceFileId: fileId, entryName: item.entryName || item.filename,
                filename: item.filename, bytes: item.bytes });
            }
          } else {
            throw new Error('Only HTML, HTM, ZIP, RAR, or 7z files are supported.');
          }
        } catch (error) {
          errors.push(`${fileId}: ${error.message}`);
          logger.warn(`Could not add Slack file ${fileId} to a project:`, error);
        }
      }
      if (!collected.length) {
        await postProjectPrivateMessage(client, channelId, userId,
          `I could not add any files. ${errors.join(' ') || 'Those files may already be in the project.'}`);
        return;
      }
      const result = addProjectFiles(projectName || getProject(projectId).name, collected);
      const details = [
        result.added
          ? `Added ${result.added} file${result.added === 1 ? '' : 's'} to *${result.project.name}*.`
          : `All files were already in *${result.project.name}*; nothing new was added.`,
        result.added < collected.length ? `${collected.length - result.added} duplicate file${collected.length - result.added === 1 ? '' : 's'} skipped.` : '',
        errors.length ? `${errors.length} link${errors.length === 1 ? '' : 's'} could not be processed: ${errors.join(' ')}` : '',
      ].filter(Boolean).join(' ');
      await postProjectPrivateMessage(client, channelId, userId, details);
      return;
    }

    const project = getProject(projectId);
    const files = getProjectFiles(projectId);
    if (!files.length) {
      await postProjectPrivateMessage(client, channelId, userId,
        `Project *${project.name}* has no files to ZIP.`);
      return;
    }
    const zipBytes = makeProjectZip(files);
    const dm = await client.conversations.open({ users: userId });
    const filename = `${safeZipFilename(project.name).replace(/\.(?:zip|html?)$/i, '')}.zip`;
    await client.files.uploadV2({
      channel_id: dm.channel.id,
      file: Buffer.from(zipBytes),
      filename,
      title: `${project.name} project files`,
      initial_comment: `Private project ZIP: ${project.name} (${files.length} HTML/HTM files).`,
    });
    clearProjectFiles(projectId, files.map(({ id }) => id));
    try {
      await postProjectPrivateMessage(client, channelId, userId,
        `I sent *${filename}* to your private messages and cleared ${files.length} file${files.length === 1 ? '' : 's'} from *${project.name}*.`);
    } catch (notificationError) {
      logger.error('ZIP was delivered, but its private confirmation could not be posted:', notificationError);
    }
  } catch (error) {
    logger.error('Project workflow failed:', error);
    await postProjectPrivateMessage(client, channelId, userId,
      `I could not complete that project action: ${error.message} Your saved project files are available to retry.`);
  }
});

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
  const candidates = message.files.filter((file) => /\.(?:html?|zip|rar|7z)$/i.test(file.name || ''));
  if (!candidates.length) return;
  const uploaderId = message.user || 'unknown';
  const uploaderDisplayName = await getUploaderName(client, uploaderId, message);
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
  const records = [];

  for (const { filename, bytes } of htmlFiles) {
    const check = validateFilename(filename);
    const contentErrors = validateHtmlContent(bytes);
    const errors = [...check.errors, ...contentErrors];
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
});

(async () => {
  await app.start();
  console.log('Dimo PLEC Slack Bot is running in Socket Mode.');
})().catch((error) => {
  console.error('Bot failed to start:', error);
  process.exitCode = 1;
});
