export interface WatermarkBackgroundRemovalOptions {
  isLightBackground?: boolean;
}

export interface WatermarkBackgroundRemovalResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  removed: boolean;
}

const colorDistance = (
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number => Math.hypot(r1 - r2, g1 - g2, b1 - b2);

const clampByte = (value: number): number =>
  value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);

/**
 * Automatically detects and removes solid rectangular, rounded-square, or card
 * backgrounds from broker watermark logos (including trapped counters inside
 * letters like O/R/A/B) with anti-aliased edge color decontamination and tight
 * bounding-box cropping so logos float cleanly over the chart without a box.
 *
 * Already-transparent logos (e.g. transparent PNG/SVG brand marks) pass through
 * unmodified.
 */
export const removeSolidBackgroundFromRgba = (
  input: Uint8ClampedArray,
  width: number,
  height: number,
  options: WatermarkBackgroundRemovalOptions = {},
): WatermarkBackgroundRemovalResult => {
  const totalPixels = width * height;
  if (width < 4 || height < 4 || input.length < totalPixels * 4) {
    return { data: input, width, height, removed: false };
  }

  let opaqueCount = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    if (input[p * 4 + 3]! >= 200) opaqueCount += 1;
  }
  const totalOpaqueRatio = opaqueCount / totalPixels;

  // Collect image perimeter coordinates.
  const perimeterCount = width * 2 + Math.max(0, height - 2) * 2;
  const perimeter = new Int32Array(perimeterCount);
  let pIdx = 0;
  for (let x = 0; x < width; x += 1) {
    perimeter[pIdx++] = x;
    perimeter[pIdx++] = (height - 1) * width + x;
  }
  for (let y = 1; y < height - 1; y += 1) {
    perimeter[pIdx++] = y * width;
    perimeter[pIdx++] = y * width + (width - 1);
  }

  const opaquePerimeter: number[] = [];
  for (let i = 0; i < perimeterCount; i += 1) {
    const p = perimeter[i]!;
    if (input[p * 4 + 3]! >= 120) opaquePerimeter.push(p);
  }
  const borderOpaqueRatio = opaquePerimeter.length / Math.max(1, perimeterCount);

  // If the perimeter is mostly transparent AND overall opaque area is low,
  // the logo is already background-less (e.g. transparent PNG/SVG).
  if (borderOpaqueRatio < 0.45 && totalOpaqueRatio < 0.62) {
    return { data: input, width, height, removed: false };
  }

  // Sample pixels to identify the dominant background color.
  // For standard rectangular / rounded-square cards, sample the opaque border.
  // For circular / padded cards surrounded by transparent margins, sample the
  // outer silhouette boundary (opaque pixels next to transparent pixels).
  let samplePixels: number[] = opaquePerimeter;
  const usingSilhouetteMode = borderOpaqueRatio < 0.45;
  if (usingSilhouetteMode) {
    samplePixels = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const p = y * width + x;
        if (input[p * 4 + 3]! < 200) continue;
        if (
          input[(p - 1) * 4 + 3]! < 60
          || input[(p + 1) * 4 + 3]! < 60
          || input[(p - width) * 4 + 3]! < 60
          || input[(p + width) * 4 + 3]! < 60
        ) {
          samplePixels.push(p);
        }
      }
    }
    if (samplePixels.length < 16) {
      return { data: input, width, height, removed: false };
    }
  }

  // Quantize sampled pixels into 4-bit-per-channel buckets to find dominant bg.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < samplePixels.length; i += 1) {
    const off = samplePixels[i]! * 4;
    const r = input[off]!;
    const g = input[off + 1]!;
    const b = input[off + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const entry = buckets.get(key);
    if (entry) {
      entry.count += 1;
      entry.r += r;
      entry.g += g;
      entry.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  let bestBucket: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!bestBucket || bucket.count > bestBucket.count) {
      bestBucket = bucket;
    }
  }
  if (!bestBucket || bestBucket.count === 0) {
    return { data: input, width, height, removed: false };
  }

  const bgR = bestBucket.r / bestBucket.count;
  const bgG = bestBucket.g / bestBucket.count;
  const bgB = bestBucket.b / bestBucket.count;

  // Verify the sampled perimeter/silhouette is sufficiently uniform in color.
  let matchingSamples = 0;
  for (let i = 0; i < samplePixels.length; i += 1) {
    const off = samplePixels[i]! * 4;
    if (colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, bgR, bgG, bgB) <= 38) {
      matchingSamples += 1;
    }
  }
  const uniformity = matchingSamples / Math.max(1, samplePixels.length);
  const requiredUniformity = usingSilhouetteMode ? 0.75 : 0.55;
  if (uniformity < requiredUniformity) {
    return { data: input, width, height, removed: false };
  }

  // Step 1: 4-connected BFS flood-fill from the image border through
  // transparent pixels and pixels within color tolerance of the background.
  const bgThreshold = 38;
  const visited = new Uint8Array(totalPixels);
  const isBg = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0;
  let qTail = 0;

  const tryEnqueueBg = (p: number): void => {
    if (visited[p]) return;
    const off = p * 4;
    const a = input[off + 3]!;
    if (
      a < 120
      || colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, bgR, bgG, bgB) <= bgThreshold
    ) {
      visited[p] = 1;
      isBg[p] = 1;
      queue[qTail++] = p;
    }
  };

  for (let i = 0; i < perimeterCount; i += 1) {
    tryEnqueueBg(perimeter[i]!);
  }
  while (qHead < qTail) {
    const p = queue[qHead++]!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) tryEnqueueBg(p - 1);
    if (x + 1 < width) tryEnqueueBg(p + 1);
    if (y > 0) tryEnqueueBg(p - width);
    if (y + 1 < height) tryEnqueueBg(p + width);
  }

  let removedOpaqueCount = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    if (isBg[p] && input[p * 4 + 3]! >= 120) removedOpaqueCount += 1;
  }

  // Step 2: Remove small trapped interior background pockets (e.g. counters
  // inside letters O, R, A, B, D, P, e, a, o) matching the outer background.
  if (uniformity >= 0.7 && removedOpaqueCount / Math.max(1, opaqueCount) >= 0.1) {
    const holeVisited = new Uint8Array(totalPixels);
    const maxHolePixels = Math.floor(totalPixels * 0.08);
    const holeThreshold = 20;
    const holeQueue = new Int32Array(totalPixels);
    for (let start = 0; start < totalPixels; start += 1) {
      if (isBg[start] || holeVisited[start]) continue;
      const startOff = start * 4;
      if (
        input[startOff + 3]! < 180
        || colorDistance(input[startOff]!, input[startOff + 1]!, input[startOff + 2]!, bgR, bgG, bgB) > holeThreshold
      ) {
        continue;
      }
      let hHead = 0;
      let hTail = 0;
      holeVisited[start] = 1;
      holeQueue[hTail++] = start;
      while (hHead < hTail) {
        const p = holeQueue[hHead++]!;
        const x = p % width;
        const y = (p - x) / width;
        const checkNeighbor = (np: number) => {
          if (isBg[np] || holeVisited[np]) return;
          const off = np * 4;
          if (
            input[off + 3]! >= 180
            && colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, bgR, bgG, bgB) <= holeThreshold
          ) {
            holeVisited[np] = 1;
            holeQueue[hTail++] = np;
          }
        };
        if (x > 0) checkNeighbor(p - 1);
        if (x + 1 < width) checkNeighbor(p + 1);
        if (y > 0) checkNeighbor(p - width);
        if (y + 1 < height) checkNeighbor(p + width);
      }
      if (hTail <= maxHolePixels) {
        for (let i = 0; i < hTail; i += 1) {
          const p = holeQueue[i]!;
          isBg[p] = 1;
          removedOpaqueCount += 1;
        }
      }
    }
  }

  // Safety checks: never wipe out a pure solid-color mark or tiny noisy image.
  const minRemainingRatio = usingSilhouetteMode ? 0.04 : 0.015;
  const remainingOpaque = opaqueCount - removedOpaqueCount;
  if (
    removedOpaqueCount / Math.max(1, opaqueCount) < 0.08
    || remainingOpaque / totalPixels < minRemainingRatio
  ) {
    return { data: input, width, height, removed: false };
  }

  // Step 3: Build output RGBA buffer and perform anti-aliased edge
  // decontamination along the 1px boundary touching removed background.
  const out = new Uint8ClampedArray(input);
  const isEdge = new Uint8Array(totalPixels);
  for (let p = 0; p < totalPixels; p += 1) {
    if (isBg[p]) {
      out[p * 4 + 3] = 0;
      continue;
    }
    if (input[p * 4 + 3]! === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (
      (x > 0 && isBg[p - 1])
      || (x + 1 < width && isBg[p + 1])
      || (y > 0 && isBg[p - width])
      || (y + 1 < height && isBg[p + width])
    ) {
      isEdge[p] = 1;
    }
  }

  for (let p = 0; p < totalPixels; p += 1) {
    if (!isEdge[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    const off = p * 4;
    let fR = 0;
    let fG = 0;
    let fB = 0;
    let fCount = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const np = ny * width + nx;
        if (!isBg[np] && !isEdge[np] && input[np * 4 + 3]! > 200) {
          const nOff = np * 4;
          fR += input[nOff]!;
          fG += input[nOff + 1]!;
          fB += input[nOff + 2]!;
          fCount += 1;
        }
      }
    }

    if (fCount > 0) {
      fR /= fCount;
      fG /= fCount;
      fB /= fCount;
      const vR = fR - bgR;
      const vG = fG - bgG;
      const vB = fB - bgB;
      const vSq = vR * vR + vG * vG + vB * vB;
      if (vSq > 900) {
        const uR = input[off]! - bgR;
        const uG = input[off + 1]! - bgG;
        const uB = input[off + 2]! - bgB;
        const t = Math.max(0, Math.min(1, (uR * vR + uG * vG + uB * vB) / vSq));
        const resR = uR - t * vR;
        const resG = uG - t * vG;
        const resB = uB - t * vB;
        const residual = Math.hypot(resR, resG, resB);
        if (residual < 28) {
          if (t <= 0.04) {
            out[off + 3] = 0;
          } else if (t < 0.96) {
            out[off] = clampByte(fR);
            out[off + 1] = clampByte(fG);
            out[off + 2] = clampByte(fB);
            out[off + 3] = Math.round(input[off + 3]! * t);
          }
        }
      }
    } else {
      const d = colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, bgR, bgG, bgB);
      if (d < 64) {
        const t = Math.max(0, Math.min(1, (d - 22) / 42));
        if (t <= 0.04) {
          out[off + 3] = 0;
        } else {
          out[off] = clampByte((input[off]! - (1 - t) * bgR) / t);
          out[off + 1] = clampByte((input[off + 1]! - (1 - t) * bgG) / t);
          out[off + 2] = clampByte((input[off + 2]! - (1 - t) * bgB) / t);
          out[off + 3] = Math.round(input[off + 3]! * t);
        }
      }
    }
  }

  // Step 4: Ensure monochrome black-on-white or white-on-black logos remain
  // legible after background removal against the active chart theme.
  let fgLumSum = 0;
  let fgChromaSum = 0;
  let fgSamples = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    const off = p * 4;
    const a = out[off + 3]!;
    if (a <= 48) continue;
    const r = out[off]!;
    const g = out[off + 1]!;
    const b = out[off + 2]!;
    fgLumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    fgChromaSum += Math.max(r, g, b) - Math.min(r, g, b);
    fgSamples += 1;
  }

  if (fgSamples > 0) {
    const avgLum = fgLumSum / fgSamples;
    const avgChroma = fgChromaSum / fgSamples;
    const isLightChart = options.isLightBackground === true;
    if (!isLightChart && avgLum < 44 && avgChroma < 26) {
      // Near-black monochrome mark (e.g. black logo stripped from white card)
      // would be invisible on dark charts -> lift cleanly to light silver/white.
      for (let p = 0; p < totalPixels; p += 1) {
        const off = p * 4;
        if (out[off + 3]! === 0) continue;
        out[off] = clampByte(255 - out[off]!);
        out[off + 1] = clampByte(255 - out[off + 1]!);
        out[off + 2] = clampByte(255 - out[off + 2]!);
      }
    } else if (isLightChart && avgLum > 212 && avgChroma < 26) {
      // Near-white monochrome mark (e.g. white logo stripped from dark card)
      // would be invisible on light charts -> invert cleanly to dark slate.
      for (let p = 0; p < totalPixels; p += 1) {
        const off = p * 4;
        if (out[off + 3]! === 0) continue;
        out[off] = clampByte(51 + (255 - out[off]!) * 0.45);
        out[off + 1] = clampByte(65 + (255 - out[off + 1]!) * 0.45);
        out[off + 2] = clampByte(85 + (255 - out[off + 2]!) * 0.45);
      }
    }
  }

  // Step 5: Auto-crop to the tight visible foreground bounding box (+2px pad).
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (out[(y * width + x) * 4 + 3]! > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { data: input, width, height, removed: false };
  }

  const pad = 2;
  const cropMinX = Math.max(0, minX - pad);
  const cropMinY = Math.max(0, minY - pad);
  const cropMaxX = Math.min(width - 1, maxX + pad);
  const cropMaxY = Math.min(height - 1, maxY + pad);
  const cropW = cropMaxX - cropMinX + 1;
  const cropH = cropMaxY - cropMinY + 1;
  const cropped = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const srcStart = ((cropMinY + y) * width + cropMinX) * 4;
    cropped.set(out.subarray(srcStart, srcStart + cropW * 4), y * cropW * 4);
  }

  return { data: cropped, width: cropW, height: cropH, removed: true };
};
