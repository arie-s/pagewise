// Render scale for Smart Extract: 2x, except image-only pages (screenshots, small scans) whose image
// has fewer pixels than that; upscaling them adds vision tokens without adding detail. Never above 2x:
// on a 12 MP photo, 4 MP and 9 MP renders read no better than 2x but took 3x and 12x longer on CPU.
// Every page is capped at 4 MP (~5k vision tokens) so oversized pages fit the engine context.
export async function extractScale(page, OPS) {
  const vp = page.getViewport({ scale: 1 }), area = vp.width * vp.height;
  const ops = await page.getOperatorList(), O = OPS;
  let imgPx = 0, hasText = false;
  ops.fnArray.forEach((fn, k) => {
    if (fn === O.showText || fn === O.showSpacedText) hasText = true;
    else if (fn === O.paintImageXObject) imgPx = Math.max(imgPx, ops.argsArray[k][1] * ops.argsArray[k][2]);
  });
  const scale = imgPx && !hasText ? Math.min(2, Math.sqrt(imgPx / area)) : 2;
  return Math.min(scale, Math.sqrt(4e6 / area));
}
