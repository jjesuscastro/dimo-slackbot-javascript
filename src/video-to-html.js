'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// Vendored from HPLToolbox-Extension/media/sip-dynamic-date/index.js.
// The export root marker prevents the builder UI from mounting; the bundle
// exposes the same HplBuildVideoHtml function used by Video to HTML.
const exporterPath = path.join(__dirname, 'vendor', 'hpl-sip-dynamic-date-exporter.js');
let exporterDom;

function getExporter() {
  if (exporterDom) return exporterDom.window.HplBuildVideoHtml;
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div data-sip-export-root hidden></div></body></html>',
    { runScripts: 'outside-only', url: 'https://dimo.invalid/' },
  );
  try {
    dom.window.eval(fs.readFileSync(exporterPath, 'utf8'));
    if (typeof dom.window.HplBuildVideoHtml !== 'function') {
      throw new Error('The Video to HTML exporter did not expose its builder.');
    }
    exporterDom = dom;
    return exporterDom.window.HplBuildVideoHtml;
  } catch (error) {
    dom.window.close();
    throw new Error(`Could not initialize the HPL Video to HTML exporter: ${error.message}`);
  }
}

function createVideoInput(filename, bytes) {
  return {
    name: filename,
    sizeBytes: bytes.length,
    dataUri: `data:video/mp4;base64,${bytes.toString('base64')}`,
  };
}

function createVideoHtml(portrait, landscape) {
  const buildHtml = getExporter();
  return buildHtml({
    portrait: createVideoInput(portrait.filename, portrait.bytes),
    landscape: createVideoInput(landscape.filename, landscape.bytes),
  });
}

module.exports = { createVideoHtml };
