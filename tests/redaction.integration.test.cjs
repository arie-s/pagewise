const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFDict, PDFName, PDFNumber, degrees } = require('@cantoo/pdf-lib');
const { createCanvas, DOMMatrix, ImageData, Path2D } = require('@napi-rs/canvas');
const { loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');
const path = require('node:path');
const { root } = require('./helpers.cjs');

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');

test('renderer redaction output masks rotated and cropped content into a fresh searchable image PDF', async () => {
  const { PDFDocument: PdfLib } = require('@cantoo/pdf-lib');
  const source = await PdfLib.create();
  const page = source.addPage([200, 120]);
  page.setCropBox(50, 10, 100, 50);
  page.setRotation(degrees(90));
  page.drawText('ROTATED-CROPPED-SECRET-CANARY', { x: 64, y: 30, size: 9 });

  const sourceImageCanvas = createCanvas(3, 3);
  const sourceImageContext = sourceImageCanvas.getContext('2d');
  sourceImageContext.fillStyle = '#00ff00';
  sourceImageContext.fillRect(0, 0, 3, 3);
  const sourceImage = sourceImageCanvas.toBuffer('image/png');
  const embedded = await source.embedPng(sourceImage);
  page.drawImage(embedded, { x: 130, y: 20, width: 10, height: 10 });
  source.setTitle('SOURCE-METADATA-CANARY');
  source.attach(Buffer.from('SOURCE-ATTACHMENT-CANARY'), 'private.txt');
  const originalData = Buffer.from(await source.save()).toString('base64');

  const { handlers } = loadMainHandlers();
  const pdfjsLib = await pdfjsPromise;
  const noRedaction = await handlers.get('apply-modifications')(null, { originalData, modifications: [] });
  assert.equal(noRedaction.success, true, noRedaction.error);
  const standardFontDataUrl = path.join(root, 'node_modules/pdfjs-dist/standard_fonts') + path.sep;
  const sourcePdf = await pdfjsLib.getDocument({ data: new Uint8Array(Buffer.from(noRedaction.data, 'base64')), standardFontDataUrl }).promise;
  const sourcePage = await sourcePdf.getPage(1);
  const sourceViewport = sourcePage.getViewport({ scale: 2 });
  const sourceCanvas = createCanvas(sourceViewport.width, sourceViewport.height);
  const sourceContext = sourceCanvas.getContext('2d');
  await sourcePage.render({ canvasContext: sourceContext, viewport: sourceViewport, background: 'rgb(255,255,255)' }).promise;
  const findBounds = predicate => {
    const { data, width, height } = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    let left = width, top = height, right = -1, bottom = -1, count = 0, sumX = 0, sumY = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!predicate(data[i], data[i + 1], data[i + 2])) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      count++; sumX += x; sumY += y;
    }
    return count ? { left, top, right, bottom, x: Math.round(sumX / count), y: Math.round(sumY / count), count } : null;
  };
  const textBounds = findBounds((r, g, b) => r < 80 && g < 80 && b < 80);
  const greenBounds = findBounds((r, g, b) => r < 100 && g > 180 && b < 100);
  assert.ok(textBounds, 'the rotated/cropped source page rendered its secret text');
  assert.ok(greenBounds, 'the source image is visible inside the cropped viewport');
  assert.ok(greenBounds.x < textBounds.left || greenBounds.x > textBounds.right || greenBounds.y < textBounds.top || greenBounds.y > textBounds.bottom,
    'the preserved green image lies outside the redaction target');
  await sourcePdf.destroy();

  const margin = 2;
  const redaction = {
    x: Math.max(0, textBounds.left - margin) / sourceViewport.width,
    y: Math.max(0, textBounds.top - margin) / sourceViewport.height,
    width: Math.min(sourceViewport.width, textBounds.right + margin + 1) / sourceViewport.width - Math.max(0, textBounds.left - margin) / sourceViewport.width,
    height: Math.min(sourceViewport.height, textBounds.bottom + margin + 1) / sourceViewport.height - Math.max(0, textBounds.top - margin) / sourceViewport.height
  };
  const state = {
    originalData,
    pdfDoc: { numPages: 1 },
    redactionMarks: { 1: [redaction] },
    annotations: {}
  };
  const { functions } = loadRendererFunctions(['buildDocumentData', 'collectModifications'], {
    state,
    api: {
      applyModifications: request => handlers.get('apply-modifications')(null, request),
      redactPdf: request => handlers.get('redact-pdf')(null, request)
    },
    extra: {
      pdfjsLib: { getDocument: options => pdfjsLib.getDocument({ ...options, standardFontDataUrl }) },
      confirm: () => true,
      standardFontDataUrl,
      document: { createElement: name => name === 'canvas' ? createCanvas(1, 1) : null }
    }
  });

  const outputData = await functions.buildDocumentData();
  const outputBytes = Buffer.from(outputData, 'base64');
  assert.equal(outputBytes.includes(Buffer.from('ROTATED-CROPPED-SECRET-CANARY')), false);
  assert.equal(outputBytes.includes(Buffer.from('SOURCE-METADATA-CANARY')), false);
  assert.equal(outputBytes.includes(Buffer.from('SOURCE-ATTACHMENT-CANARY')), false);

  const output = await pdfjsLib.getDocument({ data: new Uint8Array(outputBytes) }).promise;
  const outputPdf = await PDFDocument.load(outputBytes);
  try {
    const namesKey = PDFName.of('Names');
    if (outputPdf.catalog.has(namesKey)) {
      const names = outputPdf.catalog.lookup(namesKey, PDFDict);
      assert.equal(names.has(PDFName.of('EmbeddedFiles')), false, 'the rebuilt catalog has no embedded files');
    }
    const xobjects = outputPdf.getPages()[0].node.Resources().lookup(PDFName.of('XObject'), PDFDict);
    assert.equal(xobjects.entries().length, 1, 'the source image object is replaced by a single flattened page image');
    const imageRef = xobjects.entries()[0][1];
    const imageStream = outputPdf.context.lookup(imageRef);
    assert.equal(imageStream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(), sourceViewport.width);
    assert.equal(imageStream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(), sourceViewport.height);
    assert.equal(output.numPages, 1);
    const outputPage = await output.getPage(1);
    const size = outputPage.getViewport({ scale: 1 });
    assert.ok(Math.abs(size.width - 50) < 0.01, `expected rotated crop width 50, got ${size.width}`);
    assert.ok(Math.abs(size.height - 100) < 0.01, `expected rotated crop height 100, got ${size.height}`);
    const text = await outputPage.getTextContent();
    assert.equal(text.items.map(item => item.str).join('').includes('SECRET'), false, 'flattened redacted output has no extractable source text');

    const outputViewport = outputPage.getViewport({ scale: 2 });
    const canvas = createCanvas(outputViewport.width, outputViewport.height);
    const context = canvas.getContext('2d');
    await outputPage.render({ canvasContext: context, viewport: outputViewport, background: 'rgb(255,255,255)' }).promise;
    const redactedPixel = context.getImageData(textBounds.x, textBounds.y, 1, 1).data;
    assert.deepEqual([...redactedPixel], [0, 0, 0, 255], 'secret text pixels are opaque black');
    const preservedPixel = context.getImageData(greenBounds.x, greenBounds.y, 1, 1).data;
    assert.ok(preservedPixel[1] > 180 && preservedPixel[0] < 100 && preservedPixel[2] < 100,
      'visible pixels from the source image remain outside the redaction mask');
  } finally {
    await output.destroy();
  }
});

test('canceling or rejecting an invalid redaction keeps the source and pending edit history intact', async t => {
  const makeState = marks => ({
    originalData: 'AQ==', pdfDoc: { numPages: 1 }, annotations: { 1: [{ type: 'text', text: 'pending' }] },
    redactionMarks: { 1: marks }, textEdits: { '1-0': 'pending edit' },
    undoStack: ['prior snapshot'], redoStack: ['prior redo'], hasUnsavedChanges: true
  });
  const snapshot = state => JSON.stringify({
    originalData: state.originalData, annotations: state.annotations, redactionMarks: state.redactionMarks,
    textEdits: state.textEdits, undoStack: state.undoStack, redoStack: state.redoStack,
    hasUnsavedChanges: state.hasUnsavedChanges
  });

  await t.test('user cancels', async () => {
    const state = makeState([{ x: 0.1, y: 0.1, width: 0.3, height: 0.2 }]);
    const before = snapshot(state);
    let applyCalls = 0;
    const { functions } = loadRendererFunctions(['buildDocumentData', 'collectModifications'], {
      state,
      api: { applyModifications: async () => { applyCalls++; return { success: true, data: 'AQ==' }; } },
      extra: { confirm: () => false }
    });
    await assert.rejects(functions.buildDocumentData(), /Redaction canceled/);
    assert.equal(applyCalls, 0);
    assert.equal(snapshot(state), before);
  });

  await t.test('rectangle validation rejects malformed bounds', async () => {
    const state = makeState([{ x: -0.1, y: 0.1, width: 0.3, height: 0.2 }]);
    const before = snapshot(state);
    const canvas = { width: 1, height: 1, getContext: () => ({ fillStyle: '', fillRect() {} }) };
    let redactCalls = 0;
    const { functions } = loadRendererFunctions(['buildDocumentData', 'collectModifications'], {
      state,
      api: {
        applyModifications: async () => ({ success: true, data: 'AQ==' }),
        redactPdf: async () => { redactCalls++; return { success: true, data: 'Ag==' }; }
      },
      extra: {
        confirm: () => true,
        pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: () => ({ width: 100, height: 100 }),
            render: async () => ({ promise: Promise.resolve() })
          }),
          destroy: async () => {}
        }) }) },
        document: { createElement: () => canvas }
      }
    });
    await assert.rejects(functions.buildDocumentData(), /Invalid redaction rectangle/);
    assert.equal(redactCalls, 0);
    assert.equal(snapshot(state), before);
  });
});
