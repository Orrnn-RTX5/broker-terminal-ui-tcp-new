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

interface SampledColorStats {
  r: number;
  g: number;
  b: number;
  chroma: number;
  lum: number;
  uniformity: number;
}

const sampleDominantColor = (
  input: Uint8ClampedArray,
  pixels: readonly number[],
  threshold: number,
): SampledColorStats | null => {
  if (pixels.length === 0) return null;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < pixels.length; i += 1) {
    const off = pixels[i]! * 4;
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

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || best.count === 0) return null;

  const r = best.r / best.count;
  const g = best.g / best.count;
  const b = best.b / best.count;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  let matches = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    const off = pixels[i]! * 4;
    if (colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, r, g, b) <= threshold) {
      matches += 1;
    }
  }
  return { r, g, b, chroma, lum, uniformity: matches / pixels.length };
};

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

  let visibleCount = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    if (input[p * 4 + 3]! >= 120) visibleCount += 1;
  }
  const totalOpaqueRatio = visibleCount / totalPixels;

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
  const translucentPerimeter: number[] = [];
  for (let i = 0; i < perimeterCount; i += 1) {
    const p = perimeter[i]!;
    const a = input[p * 4 + 3]!;
    if (a >= 120) opaquePerimeter.push(p);
    else if (a >= 12) translucentPerimeter.push(p);
  }
  const borderOpaqueRatio = opaquePerimeter.length / Math.max(1, perimeterCount);
  const borderTranslucentRatio = translucentPerimeter.length / Math.max(1, perimeterCount);

  // Sample pixels to identify the dominant background color:
  // 1) Standard opaque border cards,
  // 2) Semi-transparent rectangular matte cards around opaque logos,
  // 3) Silhouette boundary of padded cards / transparent logos.
  let samplePixels: number[] = opaquePerimeter;
  const usingTranslucentBorderMode = borderOpaqueRatio < 0.45 && borderTranslucentRatio >= 0.45;
  const usingSilhouetteMode = borderOpaqueRatio < 0.45 && !usingTranslucentBorderMode;
  if (usingTranslucentBorderMode) {
    samplePixels = translucentPerimeter;
  } else if (usingSilhouetteMode) {
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

  const initialProbe = sampleDominantColor(input, samplePixels, 44);
  if (!initialProbe) {
    return { data: input, width, height, removed: false };
  }

  // When an opaque card floats inside transparent padding (<62% opaque overall),
  // only strip neutral/card backgrounds so background-less colorful marks stay intact.
  if (usingSilhouetteMode && totalOpaqueRatio < 0.62 && initialProbe.chroma > 34) {
    return { data: input, width, height, removed: false };
  }

  const bgThreshold = initialProbe.chroma <= 26 ? 44 : 38;
  const bgStats = bgThreshold === 44
    ? initialProbe
    : sampleDominantColor(input, samplePixels, bgThreshold)!;
  const bgR = bgStats.r;
  const bgG = bgStats.g;
  const bgB = bgStats.b;
  const uniformity = bgStats.uniformity;
  const requiredUniformity = usingSilhouetteMode ? 0.72 : 0.55;
  if (uniformity < requiredUniformity) {
    return { data: input, width, height, removed: false };
  }

  const runFloodAndHoles = (
    seeds: number[],
    targetR: number,
    targetG: number,
    targetB: number,
    threshold: number,
    silhouette: boolean,
    sampleUniformity: number,
    allowSemiAlphaThrough: boolean,
  ) => {
    const visited = new Uint8Array(totalPixels);
    const markedBg = new Uint8Array(totalPixels);
    const queue = new Int32Array(totalPixels);
    let qHead = 0;
    let qTail = 0;

    const tryEnqueueBg = (p: number): void => {
      if (visited[p]) return;
      const off = p * 4;
      const a = input[off + 3]!;
      const dist = colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, targetR, targetG, targetB);
      if (
        a < 12
        || (allowSemiAlphaThrough && a < 120 && (!usingTranslucentBorderMode || dist <= threshold))
        || dist <= threshold
        || (silhouette && a < 210 && dist <= 72)
      ) {
        visited[p] = 1;
        markedBg[p] = 1;
        queue[qTail++] = p;
      }
    };

    for (let i = 0; i < seeds.length; i += 1) {
      tryEnqueueBg(seeds[i]!);
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

    let removedVis = 0;
    for (let p = 0; p < totalPixels; p += 1) {
      if (markedBg[p] && input[p * 4 + 3]! >= 120) removedVis += 1;
    }

    const targetChroma = Math.max(targetR, targetG, targetB) - Math.min(targetR, targetG, targetB);
    if (sampleUniformity >= 0.65 && removedVis / Math.max(1, visibleCount) >= 0.08) {
      const holeVisited = new Uint8Array(totalPixels);
      const maxHolePixels = Math.floor(totalPixels * 0.08);
      const holeThreshold = targetChroma <= 26 ? 40 : 28;
      const holeQueue = new Int32Array(totalPixels);
      for (let start = 0; start < totalPixels; start += 1) {
        if (markedBg[start] || holeVisited[start]) continue;
        const startOff = start * 4;
        if (
          input[startOff + 3]! < 180
          || colorDistance(input[startOff]!, input[startOff + 1]!, input[startOff + 2]!, targetR, targetG, targetB) > holeThreshold
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
            if (markedBg[np] || holeVisited[np]) return;
            const off = np * 4;
            if (
              input[off + 3]! >= 180
              && colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, targetR, targetG, targetB) <= holeThreshold
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
            markedBg[p] = 1;
          }
        }
      }
    }
    return markedBg;
  };

  // Step 1 & 2: Flood-fill outer background + trapped interior counters.
  const perimeterSeeds = Array.from(perimeter);
  let activeBgR = bgR;
  let activeBgG = bgG;
  let activeBgB = bgB;
  const isBg = runFloodAndHoles(perimeterSeeds, activeBgR, activeBgG, activeBgB, bgThreshold, usingSilhouetteMode, uniformity, true);

  let removedVisibleCount = 0;
  let remainingVisibleCount = 0;
  let removedTranslucentCount = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    const a = input[p * 4 + 3]!;
    if (a >= 120) {
      if (isBg[p]) removedVisibleCount += 1;
      else remainingVisibleCount += 1;
    } else if (isBg[p] && a >= 12) {
      removedTranslucentCount += 1;
    }
  }

  // Fallback for bordered/framed cards (e.g. 1-4px grey border or drop shadow around a solid neutral white/black card):
  // If outer peel removed <20% of visible pixels while >=45% of the canvas remains solid, sample an inset ring.
  if (
    removedVisibleCount / Math.max(1, visibleCount) < 0.2
    && remainingVisibleCount / totalPixels >= 0.45
    && Math.min(width, height) >= 16
  ) {
    const inset = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) * 0.06)));
    const ringPixels: number[] = [];
    for (let x = inset; x < width - inset; x += 1) {
      const top = inset * width + x;
      const bot = (height - 1 - inset) * width + x;
      if (!isBg[top] && input[top * 4 + 3]! >= 180) ringPixels.push(top);
      if (!isBg[bot] && input[bot * 4 + 3]! >= 180) ringPixels.push(bot);
    }
    for (let y = inset + 1; y < height - 1 - inset; y += 1) {
      const left = y * width + inset;
      const right = y * width + (width - 1 - inset);
      if (!isBg[left] && input[left * 4 + 3]! >= 180) ringPixels.push(left);
      if (!isBg[right] && input[right * 4 + 3]! >= 180) ringPixels.push(right);
    }
    if (ringPixels.length >= 16) {
      const innerStats = sampleDominantColor(input, ringPixels, 36);
      if (
        innerStats
        && innerStats.chroma <= 20
        && (innerStats.lum >= 218 || innerStats.lum <= 34)
        && innerStats.uniformity >= 0.78
      ) {
        const innerBg = runFloodAndHoles(
          ringPixels,
          innerStats.r,
          innerStats.g,
          innerStats.b,
          36,
          false,
          innerStats.uniformity,
          false,
        );
        let combinedRemovedVis = 0;
        let combinedRemainingVis = 0;
        let distinctIn = 0;
        for (let p = 0; p < totalPixels; p += 1) {
          const marked = isBg[p] || innerBg[p];
          const a = input[p * 4 + 3]!;
          if (a >= 120) {
            if (marked) {
              combinedRemovedVis += 1;
            } else {
              combinedRemainingVis += 1;
              if (distinctIn < 12 && colorDistance(input[p * 4]!, input[p * 4 + 1]!, input[p * 4 + 2]!, innerStats.r, innerStats.g, innerStats.b) > 45) {
                distinctIn += 1;
              }
            }
          }
        }
        if (
          combinedRemovedVis / Math.max(1, visibleCount) >= 0.25
          && combinedRemainingVis >= 16
          && combinedRemainingVis / totalPixels >= 0.001
          && distinctIn >= 12
        ) {
          for (let p = 0; p < totalPixels; p += 1) {
            if (innerBg[p]) isBg[p] = 1;
          }
          activeBgR = innerStats.r;
          activeBgG = innerStats.g;
          activeBgB = innerStats.b;
          removedVisibleCount = combinedRemovedVis;
          remainingVisibleCount = combinedRemainingVis;
        }
      }
    }
  }

  // Safety checks: never wipe out a pure solid-color mark or tiny noisy image,
  // while still stripping large white/dark cards around slim wordmarks (e.g. ORRNN)
  // and semi-transparent rectangular mattes around opaque marks.
  const removedOpaqueShare = removedVisibleCount / Math.max(1, visibleCount);
  const removedTranslucentShare = removedTranslucentCount / totalPixels;
  const isTranslucentMatteRemoval = removedVisibleCount === 0
    && removedTranslucentShare >= 0.15
    && remainingVisibleCount >= 16;
  const minRemovedShare = usingSilhouetteMode && totalOpaqueRatio < 0.62 ? 0.35 : 0.08;
  let distinctForegroundCount = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    if (isBg[p]) continue;
    const off = p * 4;
    if (input[off + 3]! < 120) continue;
    if (colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, activeBgR, activeBgG, activeBgB) > 45) {
      distinctForegroundCount += 1;
      if (distinctForegroundCount >= 12) break;
    }
  }
  if (
    (!isTranslucentMatteRemoval && removedOpaqueShare < minRemovedShare)
    || remainingVisibleCount < 16
    || remainingVisibleCount / totalPixels < 0.001
    || distinctForegroundCount < 12
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
      const vR = fR - activeBgR;
      const vG = fG - activeBgG;
      const vB = fB - activeBgB;
      const vSq = vR * vR + vG * vG + vB * vB;
      if (vSq > 900) {
        const uR = input[off]! - activeBgR;
        const uG = input[off + 1]! - activeBgG;
        const uB = input[off + 2]! - activeBgB;
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
      const d = colorDistance(input[off]!, input[off + 1]!, input[off + 2]!, activeBgR, activeBgG, activeBgB);
      if (d < 64) {
        const t = Math.max(0, Math.min(1, (d - 22) / 42));
        if (t <= 0.04) {
          out[off + 3] = 0;
        } else {
          out[off] = clampByte((input[off]! - (1 - t) * activeBgR) / t);
          out[off + 1] = clampByte((input[off + 1]! - (1 - t) * activeBgG) / t);
          out[off + 2] = clampByte((input[off + 2]! - (1 - t) * activeBgB) / t);
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
    if (!isLightChart && avgLum < 72 && avgChroma < 28) {
      // Near-black monochrome mark (e.g. black/charcoal logo stripped from white card)
      // would be invisible on dark charts -> lift cleanly to light silver/white.
      for (let p = 0; p < totalPixels; p += 1) {
        const off = p * 4;
        if (out[off + 3]! === 0) continue;
        out[off] = clampByte(255 - out[off]!);
        out[off + 1] = clampByte(255 - out[off + 1]!);
        out[off + 2] = clampByte(255 - out[off + 2]!);
      }
    } else if (isLightChart && avgLum > 195 && avgChroma < 28) {
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
