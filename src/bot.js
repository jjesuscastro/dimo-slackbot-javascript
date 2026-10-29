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
const {
  listProjects, addProjectFiles, getProjectFiles, getProjectFileNames,
  getProject, removeProjectFiles, finishProjectZip,
} = require('./projects');

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

function projectModal(action = 'add', addProjectSelection = null) {
  const actionOptions = [
    { text: { type: 'plain_text', text: 'Add files' }, value: 'add' },
    { text: { type: 'plain_text', text: 'View files' }, value: 'view' },
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
    const showProjectName = addProjectSelection?.value === 'new_project';
    const projectPicker = {
      type: 'input', block_id: 'project_add_picker_block', dispatch_action: true,
      label: { type: 'plain_text', text: 'Project' },
      element: { type: 'external_select', action_id: 'project_add_picker', min_query_length: 0,
        ...(addProjectSelection ? { initial_option: addProjectSelection } : {}),
        placeholder: { type: 'plain_text', text: 'Search or choose a project' } },
    };
    blocks.push(
      projectPicker,
      ...(showProjectName ? [{
        type: 'input', block_id: 'project_name_block', optional: true,
        label: { type: 'plain_text', text: 'New project name (only when creating a project)' },
        element: { type: 'plain_text_input', action_id: 'project_name', max_length: 80,
          placeholder: { type: 'plain_text', text: 'For example, Spring Launch' } },
      }] : []),
      {
        type: 'input', block_id: 'project_links_block',
        label: { type: 'plain_text', text: 'Slack file or message links' },
        element: { type: 'plain_text_input', action_id: 'project_links', multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste one or more Slack file or message links' } },
      },
    );
  } else {
    if (!listProjects().length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'There are no projects yet. Switch to *Add files* and create one first.' } });
    }
    const pickerAction = action === 'zip' ? 'project_zip_picker' : 'project_view_picker';
    const pickerBlock = action === 'zip' ? 'project_zip_picker_block' : 'project_view_picker_block';
    blocks.push({
      type: 'input', block_id: pickerBlock, label: { type: 'plain_text', text: 'Project' },
      element: { type: 'external_select', action_id: pickerAction, min_query_length: 0,
        placeholder: { type: 'plain_text', text: action === 'zip' ? 'Search for a project to ZIP' : 'Search for a project to view or remove files' } },
    });
  }
  return {
    type: 'modal', callback_id: 'project_workflow_submit', private_metadata: '',
    title: { type: 'plain_text', text: 'Project files' },
    submit: { type: 'plain_text', text: action === 'add' ? 'Add files' : action === 'view' ? 'View files' : 'Create ZIP' },
    close: { type: 'plain_text', text: 'Cancel' }, blocks,
  };
}

function projectViewFilesModal(projectId, channelId) {
  const project = getProject(projectId);
  const files = getProjectFileNames(projectId);
  const blocks = [{
    type: 'section',
    text: { type: 'plain_text', text: `Files in ${project.name} (${files.length} total):` },
  }];
  const visibleFiles = files.slice(0, 80);
  for (let index = 0; index < visibleFiles.length; index += 10) {
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: visibleFiles.slice(index, index + 10)
        .map(({ filename }) => `- ${filename.replace(/[\r\n]/g, ' ').slice(0, 240)}`).join('\n') },
    });
  }
  if (files.length > visibleFiles.length) {
    blocks.push({ type: 'context', elements: [{
      type: 'plain_text', text: `Showing the first ${visibleFiles.length}; search below to find any file.`,
    }] });
  }
  blocks.push({
    type: 'input', block_id: 'project_view_remove_files_block', optional: true,
    label: { type: 'plain_text', text: 'Select files to remove (optional)' },
    element: { type: 'multi_external_select', action_id: 'project_view_remove_files_picker', min_query_length: 0,
      max_selected_items: 100, placeholder: { type: 'plain_text', text: 'Search and select files to remove' } },
  });
  return {
    type: 'modal', callback_id: 'project_workflow_submit',
    private_metadata: JSON.stringify({ channelId, viewProjectId: projectId }),
    title: { type: 'plain_text', text: 'View project files' },
    submit: { type: 'plain_text', text: 'Done / Remove selected' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
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
  await ack();
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

app.action('project_add_picker', async ({ ack, body, client, logger }) => {
  await ack();
  const view = projectModal('add', body.actions[0].selected_option || null);
  view.private_metadata = body.view.private_metadata;
  try {
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view });
  } catch (error) {
    logger.error('Could not update the Add files form:', error);
  }
});

app.options('project_add_picker', async ({ ack, body }) => {
  await ack({ options: projectPickerOptions(body.value, true) });
});

app.options('project_zip_picker', async ({ ack, body }) => {
  await ack({ options: projectPickerOptions(body.value) });
});

app.options('project_view_picker', async ({ ack, body }) => {
  await ack({ options: projectPickerOptions(body.value) });
});

app.options('project_view_remove_files_picker', async ({ ack, body }) => {
  let projectId;
  try { projectId = JSON.parse(body.view.private_metadata || '{}').viewProjectId; } catch { projectId = null; }
  if (!projectId || !getProject(projectId)) {
    await ack({ options: [] });
    return;
  }
  const query = String(body.value || '').trim().toLocaleLowerCase();
  const options = getProjectFileNames(projectId)
    .filter(({ filename }) => filename.toLocaleLowerCase().includes(query))
    .slice(0, 100)
    .map(({ id, filename }) => ({ text: { type: 'plain_text', text: filename.slice(0, 75) }, value: String(id) }));
  await ack({ options });
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

function parseProjectLinks(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>|]+/gi) || [];
  const links = [];
  const seen = new Set();
  for (const rawUrl of urls) {
    const url = rawUrl.replace(/[.,;!)]*$/, '');
    const messageMatch = url.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d{10,})(?:\/|$|[?#])/i);
    if (messageMatch && messageMatch[2].length > 6) {
      const digits = messageMatch[2];
      let threadTs = null;
      try {
        const queryThreadTs = new URL(url).searchParams.get('thread_ts');
        if (queryThreadTs && /^\d+\.\d+$/.test(queryThreadTs)) threadTs = queryThreadTs;
      } catch {
        // The channel and message timestamp still identify the message without query metadata.
      }
      const link = { type: 'message', channelId: messageMatch[1].toUpperCase(),
        timestamp: `${digits.slice(0, -6)}.${digits.slice(-6)}`, threadTs };
      const key = `${link.type}:${link.channelId}:${link.timestamp}`;
      if (!seen.has(key)) links.push(link);
      seen.add(key);
      continue;
    }
    const match = url.match(/(?:^|[\/-])(F[A-Z0-9]{8,})(?=$|[\/?&#.,)-])/i);
    if (match) {
      const link = { type: 'file', fileId: match[1].toUpperCase() };
      const key = `${link.type}:${link.fileId}`;
      if (!seen.has(key)) links.push(link);
      seen.add(key);
    }
  }
  return links;
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
  const metadata = (() => {
    try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; }
  })();
  const action = values.project_action_block?.project_action?.selected_option?.value
    || (metadata.viewProjectId ? 'view' : undefined);
  const channelId = metadata.channelId;
  const userId = body.user.id;
  let projectName = '';
  let projectId = null;
  let links = [];
  let removalIds = [];

  if (action === 'add') {
    const selection = values.project_add_picker_block?.project_add_picker?.selected_option?.value;
    const newName = values.project_name_block?.project_name?.value?.trim() || '';
    links = parseProjectLinks(values.project_links_block?.project_links?.value);
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
      await ack({ response_action: 'errors', errors: { project_links_block: 'Paste at least one Slack file link or message link.' } });
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
  } else if (action === 'view') {
    if (metadata.viewProjectId) {
      projectId = Number(metadata.viewProjectId);
      const selected = values.project_view_remove_files_block?.project_view_remove_files_picker?.selected_options || [];
      removalIds = selected.map(({ value }) => Number(value));
      if (!Number.isInteger(projectId) || !getProject(projectId)) {
        await ack({ response_action: 'errors', errors: { project_view_remove_files_block: 'That project is no longer available.' } });
        return;
      }
      if (removalIds.some((id) => !Number.isInteger(id))) {
        await ack({ response_action: 'errors', errors: { project_view_remove_files_block: 'Choose files from the project list.' } });
        return;
      }
      if (!removalIds.length) {
        await ack({ response_action: 'clear' });
        return;
      }
      const existingIds = new Set(getProjectFileNames(projectId).map(({ id }) => id));
      if (removalIds.some((id) => !existingIds.has(id))) {
        await ack({ response_action: 'errors', errors: { project_view_remove_files_block: 'Some selected files are no longer in this project. Reopen the picker and try again.' } });
        return;
      }
    } else {
      const selection = values.project_view_picker_block?.project_view_picker?.selected_option?.value;
      projectId = Number(selection);
      if (!selection || !Number.isInteger(projectId) || !getProject(projectId)) {
        await ack({ response_action: 'errors', errors: { project_view_picker_block: 'Choose an existing project.' } });
        return;
      }
      if (!getProjectFileNames(projectId).length) {
        await ack({ response_action: 'clear' });
        await postProjectPrivateMessage(client, channelId, userId, `Project "${getProject(projectId).name}" has no files.`);
        return;
      }
      await ack({ response_action: 'update', view: projectViewFilesModal(projectId, channelId) });
      return;
    }
  } else {
    await ack({ response_action: 'errors', errors: { project_action_block: 'Choose Add files or Create ZIP.' } });
    return;
  }

  await ack({ response_action: 'clear' });
  try {
    if (action === 'view' && removalIds.length) {
      removeProjectFiles(projectId, removalIds);
      return;
    }

    if (action === 'add') {
      const collected = [];
      const errors = [];
      for (const link of links) {
        try {
          let fileIds;
          if (link.type === 'file') {
            fileIds = [link.fileId];
          } else {
            let message;
            let historyError;
            try {
              const result = await client.conversations.history({
                channel: link.channelId, oldest: link.timestamp, latest: link.timestamp,
                inclusive: true, limit: 1,
              });
              message = result.messages?.find(({ ts }) => ts === link.timestamp);
            } catch (error) {
              historyError = error;
            }
            if (!message) {
              try {
                const thread = await client.conversations.replies({
                  channel: link.channelId, ts: link.threadTs || link.timestamp,
                  oldest: link.timestamp, latest: link.timestamp, inclusive: true, limit: 1,
                });
                message = thread.messages?.find(({ ts }) => ts === link.timestamp);
              } catch (threadError) {
                const detail = threadError.data?.error || threadError.message;
                throw new Error(`The exact message could not be read from channel history${historyError ? ` (${historyError.data?.error || historyError.message})` : ''} or its thread (${detail}).`);
              }
            }
            if (!message) throw new Error('The linked message was not found or is not accessible to the bot. Check the conversation history scope and thread access.');
            const attachedFiles = [
              ...(message.files || []),
              ...(message.attachments || []).filter((attachment) => attachment.file_id || attachment.id),
            ];
            fileIds = [...new Set(attachedFiles.map((file) => file.id || file.file_id).filter(Boolean))];
            if (!fileIds.length) throw new Error('The linked message has no attached files.');
          }

          for (const fileId of fileIds) {
            try {
              const result = await client.files.info({ file: fileId });
              const slackFile = result.file;
              if (!slackFile?.name) throw new Error('Slack did not return a filename for that file.');
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
        } catch (error) {
          const label = link.type === 'message' ? `${link.channelId}/${link.timestamp}` : link.fileId;
          errors.push(`${label}: ${error.message}`);
          logger.warn(`Could not process project source ${label}:`, error);
        }
      }
      if (!collected.length) {
        await postProjectPrivateMessage(client, channelId, userId,
          `I could not add any files. ${errors.join(' ') || 'No supported files were found.'}`);
        return;
      }
      addProjectFiles(projectName || getProject(projectId).name, collected);
      if (errors.length) {
        await postProjectPrivateMessage(client, channelId, userId,
          `${errors.length} file or message source${errors.length === 1 ? '' : 's'} could not be processed: ${errors.join(' ')}`);
      }
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
    });
    finishProjectZip(projectId, files.map(({ id }) => id));
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
