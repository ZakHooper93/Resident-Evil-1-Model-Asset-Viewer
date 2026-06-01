"use strict";

const canvas = document.querySelector("#viewer");
const gl = canvas.getContext("webgl", { antialias: false });
const modelStats = document.querySelector("#modelStats");
const fileList = document.querySelector("#fileList");
const parserNotes = document.querySelector("#parserNotes");
const dropZone = document.querySelector("#dropZone");
const filePicker = document.querySelector("#filePicker");
const resetCamera = document.querySelector("#resetCamera");
const wireframeToggle = document.querySelector("#wireframe");
const animateToggle = document.querySelector("#animate");
const textureToggle = document.querySelector("#textureToggle");

if (!gl) {
  throw new Error("WebGL is not available in this browser.");
}

const state = {
  yaw: -0.45,
  pitch: 0.25,
  distance: 5.5,
  baseDistance: 5.5,
  target: [0, 0.65, 0],
  modelRadius: 2,
  dragging: false,
  lastX: 0,
  lastY: 0,
  wireframe: false,
  animate: false,
  texture: true,
  files: []
};

const vertexShaderSource = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  attribute vec2 aTexCoord;
  uniform mat4 uMatrix;
  varying vec3 vColor;
  varying vec2 vTexCoord;
  void main() {
    gl_Position = uMatrix * vec4(aPosition, 1.0);
    vColor = aColor;
    vTexCoord = aTexCoord;
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  varying vec3 vColor;
  varying vec2 vTexCoord;
  uniform sampler2D uTexture;
  uniform float uUseTexture;
  void main() {
    vec4 texel = texture2D(uTexture, vTexCoord);
    vec3 litTexture = texel.rgb * mix(vec3(0.82), vColor, 0.22);
    vec3 color = mix(vColor, litTexture, uUseTexture);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const lineVertexShaderSource = `
  attribute vec3 aPosition;
  uniform mat4 uMatrix;
  void main() {
    gl_Position = uMatrix * vec4(aPosition, 1.0);
  }
`;

const lineFragmentShaderSource = `
  precision mediump float;
  void main() {
    gl_FragColor = vec4(0.05, 0.06, 0.07, 1.0);
  }
`;

const solidProgram = createProgram(vertexShaderSource, fragmentShaderSource);
const lineProgram = createProgram(lineVertexShaderSource, lineFragmentShaderSource);
let currentModel = createDemoModel();
let buffers = createBuffers(currentModel);

updateStats(currentModel);
setNotes([
  "This first build proves the viewer: camera, low-poly mesh drawing, wire overlay, and animation.",
  "PS1 models are usually fixed-point vertices plus polygon packets. We convert those into normal GPU triangles.",
  "When you have files ready, we will teach the app to unpack the ISO and decode RE1 `.EMD` model sections."
]);

requestAnimationFrame(draw);

resetCamera.addEventListener("click", () => {
  resetView();
});

wireframeToggle.addEventListener("change", () => {
  state.wireframe = wireframeToggle.checked;
});

animateToggle.addEventListener("change", () => {
  state.animate = animateToggle.checked;
});

textureToggle.addEventListener("change", () => {
  state.texture = textureToggle.checked;
});

canvas.addEventListener("pointerdown", (event) => {
  state.dragging = true;
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const dx = event.clientX - state.lastX;
  const dy = event.clientY - state.lastY;
  state.yaw += dx * 0.008;
  state.pitch = clamp(state.pitch + dy * 0.008, -1.25, 1.25);
  state.lastX = event.clientX;
  state.lastY = event.clientY;
});

canvas.addEventListener("pointerup", () => {
  state.dragging = false;
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  state.distance = clamp(state.distance + event.deltaY * 0.006, 2.5, 10);
}, { passive: false });

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, () => {
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  await inspectFiles([...event.dataTransfer.files]);
});

filePicker.addEventListener("change", async () => {
  await inspectFiles([...filePicker.files]);
});

async function inspectFiles(files) {
  state.files = [];

  for (const file of files) {
    const ext = extensionOf(file.name);
    const entry = {
      name: file.name,
      size: file.size,
      type: ext || "unknown",
      detail: ""
    };

    if (ext === "tim") {
      entry.detail = await inspectTim(file);
    } else if (ext === "emd") {
      const model = parseEmdModel(new Uint8Array(await file.arrayBuffer()), file.name);
      currentModel = model;
      buffers = createBuffers(currentModel);
      fitViewToModel(currentModel);
      updateStats(currentModel);
      entry.detail = `Loaded EMD: ${model.objectCount} objects, ${model.vertices.length / 3} vertices, ${model.indices.length / 3} triangles.`;
    } else if (["bin", "iso", "img"].includes(ext)) {
      entry.detail = await inspectIso(file);
    } else {
      entry.detail = "Queued for later format sniffing.";
    }

    state.files.push(entry);
  }

  renderFileList();
}

async function inspectTim(file) {
  const header = new DataView(await file.slice(0, 32).arrayBuffer());
  if (header.byteLength < 8 || header.getUint32(0, true) !== 0x10) {
    return "Not a standard PSX TIM header.";
  }

  const flags = header.getUint32(4, true);
  const bpp = flags & 0x7;
  const hasClut = (flags & 0x8) !== 0;
  const modes = ["4-bit indexed", "8-bit indexed", "16-bit direct", "24-bit direct"];
  return `PSX TIM detected: ${modes[bpp] || `mode ${bpp}`}${hasClut ? ", with CLUT" : ""}.`;
}

async function inspectIso(file) {
  const layout = await detectIsoLayout(file);
  if (!layout) {
    return "Disc image candidate, but no ISO9660 primary volume descriptor was found yet.";
  }

  const files = await readIsoDirectory(file, layout, layout.root, "");
  const emdFiles = files.filter((item) => item.path.toLowerCase().endsWith(".emd"));
  const timFiles = files.filter((item) => item.path.toLowerCase().endsWith(".tim"));
  const samples = [...emdFiles.slice(0, 3), ...timFiles.slice(0, 3)]
    .map((item) => item.path)
    .join(", ");

  return `ISO9660 detected (${layout.sectorSize}-byte sectors): ${files.length} files, ${emdFiles.length} EMD, ${timFiles.length} TIM${samples ? `. Examples: ${samples}` : ""}.`;
}

async function detectIsoLayout(file) {
  for (const sectorSize of [2048, 2352]) {
    const descriptorOffset = sectorSize === 2048 ? 16 * sectorSize : 16 * sectorSize + 24;
    const descriptor = new Uint8Array(await file.slice(descriptorOffset, descriptorOffset + 2048).arrayBuffer());
    if (descriptor.length >= 190 && textFromBytes(descriptor, 1, 5) === "CD001" && descriptor[0] === 1) {
      const rootRecordOffset = 156;
      return {
        sectorSize,
        dataOffset: sectorSize === 2048 ? 0 : 24,
        root: parseIsoDirectoryRecord(descriptor, rootRecordOffset)
      };
    }
  }
  return null;
}

async function readIsoDirectory(file, layout, directory, prefix, depth = 0) {
  if (depth > 6) return [];

  const start = directory.extent * layout.sectorSize + layout.dataOffset;
  const bytes = new Uint8Array(await file.slice(start, start + directory.size).arrayBuffer());
  const files = [];
  let offset = 0;

  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) {
      offset = Math.ceil((offset + 1) / layout.sectorSize) * layout.sectorSize;
      continue;
    }

    const record = parseIsoDirectoryRecord(bytes, offset);
    offset += length;

    if (!record || record.name === "\u0000" || record.name === "\u0001") continue;

    const cleanName = record.name.replace(/;1$/, "");
    const fullPath = prefix ? `${prefix}/${cleanName}` : cleanName;

    if (record.isDirectory) {
      files.push(...await readIsoDirectory(file, layout, record, fullPath, depth + 1));
    } else {
      files.push({ path: fullPath, size: record.size, extent: record.extent });
    }
  }

  return files;
}

function parseIsoDirectoryRecord(bytes, offset) {
  const length = bytes[offset];
  if (!length || offset + length > bytes.length) return null;

  const nameLength = bytes[offset + 32];
  return {
    extent: readUint32LE(bytes, offset + 2),
    size: readUint32LE(bytes, offset + 10),
    isDirectory: (bytes[offset + 25] & 0x02) !== 0,
    name: textFromBytes(bytes, offset + 33, nameLength)
  };
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readInt16LE(bytes, offset) {
  const value = readUint16LE(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function textFromBytes(bytes, offset, length) {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[offset + i]);
  }
  return text;
}

function renderFileList() {
  fileList.innerHTML = "";

  for (const file of state.files) {
    const item = document.createElement("li");
    item.innerHTML = `<code>${escapeHtml(file.name)}</code><br>${formatBytes(file.size)} - ${escapeHtml(file.detail)}`;
    fileList.append(item);
  }
}

function draw(time) {
  resizeCanvasToDisplaySize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.067, 0.075, 0.086, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const aspect = canvas.width / canvas.height;
  const projection = mat4Perspective(Math.PI / 4, aspect, 0.1, 100);
  const view = mat4LookAt(
    [
      state.target[0] + Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance,
      state.target[1] + Math.sin(state.pitch) * state.distance,
      state.target[2] + Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance
    ],
    state.target,
    [0, 1, 0]
  );
  const sway = state.animate ? Math.sin(time * 0.003) * 0.12 : 0;
  const model = mat4RotateY(mat4Identity(), sway);
  const matrix = mat4Multiply(projection, mat4Multiply(view, model));

  gl.useProgram(solidProgram.program);
  setMatrix(solidProgram, matrix);
  bindAttribute(solidProgram, "aPosition", buffers.vertex, 3);
  bindAttribute(solidProgram, "aColor", buffers.color, 3);
  bindAttribute(solidProgram, "aTexCoord", buffers.texCoord, 2);
  setTextureUniforms(solidProgram, currentModel.texture);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
  gl.drawElements(gl.TRIANGLES, currentModel.indices.length, gl.UNSIGNED_SHORT, 0);

  if (state.wireframe) {
    gl.useProgram(lineProgram.program);
    setMatrix(lineProgram, matrix);
    bindAttribute(lineProgram, "aPosition", buffers.vertex, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.lineIndex);
    gl.drawElements(gl.LINES, currentModel.lineIndices.length, gl.UNSIGNED_SHORT, 0);
  }

  requestAnimationFrame(draw);
}

function createDemoModel() {
  const vertices = [];
  const colors = [];
  const texCoords = [];
  const indices = [];

  addBox(vertices, colors, indices, [0, 1.55, 0], [0.42, 0.42, 0.35], [0.74, 0.64, 0.52]);
  addBox(vertices, colors, indices, [0, 0.9, 0], [0.72, 0.8, 0.34], [0.16, 0.28, 0.43]);
  addBox(vertices, colors, indices, [-0.62, 0.94, 0], [0.24, 0.78, 0.24], [0.77, 0.65, 0.48]);
  addBox(vertices, colors, indices, [0.62, 0.94, 0], [0.24, 0.78, 0.24], [0.77, 0.65, 0.48]);
  addBox(vertices, colors, indices, [-0.25, 0.05, 0], [0.28, 0.95, 0.28], [0.21, 0.22, 0.25]);
  addBox(vertices, colors, indices, [0.25, 0.05, 0], [0.28, 0.95, 0.28], [0.21, 0.22, 0.25]);

  return {
    name: "Demo segmented PS1-style survivor",
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    texCoords: new Float32Array(texCoords.length ? texCoords : new Array((vertices.length / 3) * 2).fill(0)),
    indices: new Uint16Array(indices),
    lineIndices: new Uint16Array(buildLineIndices(indices)),
    bounds: measureBounds(vertices)
  };
}

function parseEmdModel(bytes, name) {
  if (bytes.length < 16) {
    throw new Error("EMD file is too small.");
  }

  const modelOffset = readUint32LE(bytes, bytes.length - 8);
  const skeleton = parseEmdSkeleton(bytes, readUint32LE(bytes, bytes.length - 16));
  const sectionLength = readUint32LE(bytes, modelOffset);
  const objectCount = readUint32LE(bytes, modelOffset + 8);
  const objectTable = modelOffset + 12;
  const texture = parseTimTexture(bytes, readUint32LE(bytes, bytes.length - 4));
  const cluts = collectTriangleCluts(bytes, objectTable, objectCount);
  applyModelCluts(texture, cluts);
  const vertices = [];
  const colors = [];
  const texCoords = [];
  const indices = [];
  const rawObjects = [];

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const entry = objectTable + objectIndex * 28;
    const vertexOffset = objectTable + readUint32LE(bytes, entry);
    const vertexCount = readUint32LE(bytes, entry + 4);
    const triangleOffset = objectTable + readUint32LE(bytes, entry + 16);
    const triangleCount = readUint32LE(bytes, entry + 20);
    const bonePosition = skeleton.positions[objectIndex] || [0, 0, 0];
    const objectVertices = [];

    for (let i = 0; i < vertexCount; i++) {
      const offset = vertexOffset + i * 8;
      objectVertices.push([
        (readInt16LE(bytes, offset) + bonePosition[0]) / 180,
        -(readInt16LE(bytes, offset + 2) + bonePosition[1]) / 180,
        (readInt16LE(bytes, offset + 4) + bonePosition[2]) / 180
      ]);
    }

    rawObjects.push({ objectVertices, triangleOffset, triangleCount });
  }

  const flatPositions = rawObjects.flatMap((object) => object.objectVertices.flat());
  const sourceBounds = measureBounds(flatPositions);
  const largest = Math.max(sourceBounds.size[0], sourceBounds.size[1], sourceBounds.size[2]) || 1;
  const scale = 2.8 / largest;

  for (const object of rawObjects) {
    const normalized = object.objectVertices.map((vertex) => [
      (vertex[0] - sourceBounds.center[0]) * scale,
      (vertex[1] - sourceBounds.center[1]) * scale,
      (vertex[2] - sourceBounds.center[2]) * scale
    ]);

    for (let i = 0; i < object.triangleCount; i++) {
      const offset = object.triangleOffset + i * 28;
      const v0 = readUint16LE(bytes, offset + 18);
      const v1 = readUint16LE(bytes, offset + 22);
      const v2 = readUint16LE(bytes, offset + 26);
      if (v0 < normalized.length && v1 < normalized.length && v2 < normalized.length) {
        const baseIndex = vertices.length / 3;
        vertices.push(...normalized[v0], ...normalized[v1], ...normalized[v2]);
        const page = readUint16LE(bytes, offset + 10);
        texCoords.push(
          ...textureCoord(bytes[offset + 4], bytes[offset + 5], page, texture),
          ...textureCoord(bytes[offset + 8], bytes[offset + 9], page, texture),
          ...textureCoord(bytes[offset + 12], bytes[offset + 13], page, texture)
        );
        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
      }
    }
  }

  const bounds = measureBounds(vertices);
  shadeFaces(vertices, colors, indices);

  return {
    name,
    objectCount,
    boneCount: skeleton.positions.length,
    sectionLength,
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices),
    lineIndices: new Uint16Array(buildLineIndices(indices)),
    bounds,
    texture
  };
}

function parseEmdSkeleton(bytes, offset) {
  const boneOffset = readUint16LE(bytes, offset);
  const count = readUint16LE(bytes, offset + 4);
  const relpos = [];
  const children = Array.from({ length: count }, () => []);

  for (let i = 0; i < count; i++) {
    const entry = offset + 8 + i * 6;
    relpos.push([
      readInt16LE(bytes, entry),
      readInt16LE(bytes, entry + 2),
      readInt16LE(bytes, entry + 4)
    ]);
  }

  for (let i = 0; i < count; i++) {
    const entry = offset + boneOffset + i * 4;
    const childCount = readUint16LE(bytes, entry);
    const childListOffset = readUint16LE(bytes, entry + 2);
    for (let child = 0; child < childCount; child++) {
      const childIndex = bytes[offset + boneOffset + childListOffset + child];
      if (childIndex < count) {
        children[i].push(childIndex);
      }
    }
  }

  const positions = Array.from({ length: count }, () => [0, 0, 0]);
  const visited = new Set();

  function visit(index, parentPosition) {
    if (visited.has(index)) return;
    visited.add(index);
    positions[index] = [
      parentPosition[0] + relpos[index][0],
      parentPosition[1] + relpos[index][1],
      parentPosition[2] + relpos[index][2]
    ];

    for (const child of children[index]) {
      visit(child, positions[index]);
    }
  }

  visit(0, [0, 0, 0]);

  for (let i = 0; i < count; i++) {
    if (!visited.has(i)) {
      visit(i, [0, 0, 0]);
    }
  }

  return { positions, relpos, children };
}

function parseTimTexture(bytes, offset) {
  if (offset <= 0 || offset + 20 > bytes.length || readUint32LE(bytes, offset) !== 0x10) {
    return createFallbackTexture();
  }

  const flags = readUint32LE(bytes, offset + 4);
  const bpp = flags & 0x7;
  const hasClut = (flags & 0x8) !== 0;
  let cursor = offset + 8;
  let palette = [];
  let clutX = 0;
  let clutY = 0;
  let clutWidth = 0;
  let clutHeight = 0;
  let indexedPixels = null;

  if (hasClut) {
    const clutLength = readUint32LE(bytes, cursor);
    clutX = readUint16LE(bytes, cursor + 4);
    clutY = readUint16LE(bytes, cursor + 6);
    clutWidth = readUint16LE(bytes, cursor + 8);
    clutHeight = readUint16LE(bytes, cursor + 10);
    const colorCount = clutWidth * clutHeight;
    const colorOffset = cursor + 12;
    palette = new Array(colorCount);

    for (let i = 0; i < colorCount; i++) {
      palette[i] = decodePsxColor(readUint16LE(bytes, colorOffset + i * 2));
    }

    cursor += clutLength;
  }

  const imageLength = readUint32LE(bytes, cursor);
  const imageX = readUint16LE(bytes, cursor + 4);
  const imageY = readUint16LE(bytes, cursor + 6);
  const wordWidth = readUint16LE(bytes, cursor + 8);
  const height = readUint16LE(bytes, cursor + 10);
  const dataOffset = cursor + 12;
  const width = bpp === 0 ? wordWidth * 4 : bpp === 1 ? wordWidth * 2 : wordWidth;
  const rgba = new Uint8Array(width * height * 4);

  if (bpp === 0) {
    indexedPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let word = 0; word < wordWidth; word++) {
        const value = readUint16LE(bytes, dataOffset + (y * wordWidth + word) * 2);
        for (let nibble = 0; nibble < 4; nibble++) {
          const index = (value >> (nibble * 4)) & 0xf;
          indexedPixels[y * width + word * 4 + nibble] = index;
          writeRgba(rgba, (y * width + word * 4 + nibble) * 4, palette[index] || [0, 0, 0, 255]);
        }
      }
    }
  } else if (bpp === 1) {
    indexedPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let word = 0; word < wordWidth; word++) {
        const value = readUint16LE(bytes, dataOffset + (y * wordWidth + word) * 2);
        const left = value & 0xff;
        const right = (value >> 8) & 0xff;
        indexedPixels[y * width + word * 2] = left;
        indexedPixels[y * width + word * 2 + 1] = right;
        writeRgba(rgba, (y * width + word * 2) * 4, palette[left] || [0, 0, 0, 255]);
        writeRgba(rgba, (y * width + word * 2 + 1) * 4, palette[right] || [0, 0, 0, 255]);
      }
    }
  } else if (bpp === 2) {
    for (let i = 0; i < width * height; i++) {
      writeRgba(rgba, i * 4, decodePsxColor(readUint16LE(bytes, dataOffset + i * 2)));
    }
  } else {
    return createFallbackTexture();
  }

  return { width, height, rgba, bpp, hasClut, imageLength, imageX, imageY, clutX, clutY, clutWidth, clutHeight, palette, indexedPixels };
}

function collectTriangleCluts(bytes, objectTable, objectCount) {
  const cluts = new Set();

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const entry = objectTable + objectIndex * 28;
    const triangleOffset = objectTable + readUint32LE(bytes, entry + 16);
    const triangleCount = readUint32LE(bytes, entry + 20);

    for (let i = 0; i < triangleCount; i++) {
      cluts.add(readUint16LE(bytes, triangleOffset + i * 28 + 6));
    }
  }

  return [...cluts].sort((a, b) => a - b);
}

function applyModelCluts(texture, cluts) {
  if (!texture || texture.fallback || !texture.indexedPixels || !cluts.length) {
    return;
  }

  const pageWidth = texture.bpp === 0 ? 256 : texture.bpp === 1 ? 128 : 64;

  for (let pageIndex = 0; pageIndex < cluts.length; pageIndex++) {
    const clut = cluts[pageIndex];
    const paletteRow = Math.max(0, (clut >> 6) - texture.clutY);
    const paletteOffset = paletteRow * texture.clutWidth;
    const startX = pageIndex * pageWidth;
    const endX = Math.min(texture.width, startX + pageWidth);

    for (let y = 0; y < texture.height; y++) {
      for (let x = startX; x < endX; x++) {
        const pixel = y * texture.width + x;
        const index = texture.indexedPixels[pixel];
        writeRgba(texture.rgba, pixel * 4, texture.palette[paletteOffset + index] || [0, 0, 0, 255]);
      }
    }
  }
}

function createFallbackTexture() {
  return {
    width: 2,
    height: 2,
    rgba: new Uint8Array([
      210, 210, 210, 255, 120, 120, 120, 255,
      120, 120, 120, 255, 210, 210, 210, 255
    ]),
    fallback: true
  };
}

function textureCoord(u, v, page, texture) {
  if (!texture || texture.fallback) {
    return [0, 0];
  }

  const pixelsPerPageX = texture.bpp === 0 ? 256 : texture.bpp === 1 ? 128 : 64;
  const pageX = (page & 0x0f) * pixelsPerPageX;
  const pageY = ((page >> 4) & 0x01) * 256;
  return [
    clamp((pageX + u + 0.5) / texture.width, 0, 1),
    clamp((pageY + v + 0.5) / texture.height, 0, 1)
  ];
}

function decodePsxColor(value) {
  const r = (value & 0x1f) * 255 / 31;
  const g = ((value >> 5) & 0x1f) * 255 / 31;
  const b = ((value >> 10) & 0x1f) * 255 / 31;
  const transparent = value === 0;
  return [r, g, b, transparent ? 0 : 255];
}

function writeRgba(target, offset, color) {
  target[offset] = color[0];
  target[offset + 1] = color[1];
  target[offset + 2] = color[2];
  target[offset + 3] = color[3];
}

function normalizeVertices(vertices, targetSize) {
  const bounds = measureBounds(vertices);
  const largest = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]) || 1;
  const scale = targetSize / largest;

  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] = (vertices[i] - bounds.center[0]) * scale;
    vertices[i + 1] = (vertices[i + 1] - bounds.center[1]) * scale;
    vertices[i + 2] = (vertices[i + 2] - bounds.center[2]) * scale;
  }

  return measureBounds(vertices);
}

function measureBounds(vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < vertices.length; i += 3) {
    min[0] = Math.min(min[0], vertices[i]);
    min[1] = Math.min(min[1], vertices[i + 1]);
    min[2] = Math.min(min[2], vertices[i + 2]);
    max[0] = Math.max(max[0], vertices[i]);
    max[1] = Math.max(max[1], vertices[i + 1]);
    max[2] = Math.max(max[2], vertices[i + 2]);
  }

  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  ];

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let radius = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    radius = Math.max(radius, Math.hypot(vertices[i] - center[0], vertices[i + 1] - center[1], vertices[i + 2] - center[2]));
  }

  return { min, max, center, size, radius };
}

function shadeFaces(vertices, colors, indices) {
  const light = normalize([-0.35, 0.7, 0.62]);
  const ambient = 0.34;
  const base = [0.54, 0.66, 0.72];
  const warm = [0.86, 0.65, 0.42];

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const normal = normalize(cross(
      [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]],
      [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]]
    ));
    const facing = Math.max(0, dot(normal, light));
    const shade = ambient + facing * 0.72;
    const tint = i % 6 === 0 ? warm : base;

    for (const index of [indices[i], indices[i + 1], indices[i + 2]]) {
      const offset = index * 3;
      colors[offset] = tint[0] * shade;
      colors[offset + 1] = tint[1] * shade;
      colors[offset + 2] = tint[2] * shade;
    }
  }
}

function fitViewToModel(model) {
  state.modelRadius = Math.max(1, model.bounds?.radius || 2);
  state.target = [0, 0, 0];
  state.baseDistance = clamp(state.modelRadius * 2.6, 3.2, 9);
  resetView();
}

function resetView() {
  state.yaw = -0.62;
  state.pitch = 0.18;
  state.distance = state.baseDistance;
}

function addBox(vertices, colors, indices, center, size, color) {
  const start = vertices.length / 3;
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size.map((value) => value / 2);
  const points = [
    [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz],
    [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
    [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz],
    [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz]
  ];
  const faces = [
    0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2,
    5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7,
    3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0
  ];

  for (const point of points) {
    vertices.push(...point);
    colors.push(...color);
  }

  for (const index of faces) {
    indices.push(start + index);
  }
}

function buildLineIndices(indices) {
  const edges = new Set();
  const lines = [];

  for (let i = 0; i < indices.length; i += 3) {
    addEdge(indices[i], indices[i + 1]);
    addEdge(indices[i + 1], indices[i + 2]);
    addEdge(indices[i + 2], indices[i]);
  }

  function addEdge(a, b) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edges.has(key)) return;
    edges.add(key);
    lines.push(a, b);
  }

  return lines;
}

function createBuffers(model) {
  return {
    vertex: createBuffer(gl.ARRAY_BUFFER, model.vertices),
    color: createBuffer(gl.ARRAY_BUFFER, model.colors),
    texCoord: createBuffer(gl.ARRAY_BUFFER, model.texCoords),
    index: createBuffer(gl.ELEMENT_ARRAY_BUFFER, model.indices),
    lineIndex: createBuffer(gl.ELEMENT_ARRAY_BUFFER, model.lineIndices),
    texture: createGlTexture(model.texture)
  };
}

function createBuffer(type, data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(type, buffer);
  gl.bufferData(type, data, gl.STATIC_DRAW);
  return buffer;
}

function createGlTexture(texture) {
  const source = texture || createFallbackTexture();
  const handle = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    source.width,
    source.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    source.rgba
  );
  return handle;
}

function createProgram(vertexSource, fragmentSource) {
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }

  return { program, attributes: new Map(), uniforms: new Map() };
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }

  return shader;
}

function bindAttribute(programInfo, name, buffer, size) {
  let location = programInfo.attributes.get(name);
  if (location === undefined) {
    location = gl.getAttribLocation(programInfo.program, name);
    programInfo.attributes.set(name, location);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function setMatrix(programInfo, matrix) {
  let location = programInfo.uniforms.get("uMatrix");
  if (location === undefined) {
    location = gl.getUniformLocation(programInfo.program, "uMatrix");
    programInfo.uniforms.set("uMatrix", location);
  }
  gl.uniformMatrix4fv(location, false, matrix);
}

function setTextureUniforms(programInfo, texture) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, buffers.texture);
  setUniform1i(programInfo, "uTexture", 0);
  setUniform1f(programInfo, "uUseTexture", state.texture && texture && !texture.fallback ? 1 : 0);
}

function setUniform1i(programInfo, name, value) {
  let location = programInfo.uniforms.get(name);
  if (location === undefined) {
    location = gl.getUniformLocation(programInfo.program, name);
    programInfo.uniforms.set(name, location);
  }
  gl.uniform1i(location, value);
}

function setUniform1f(programInfo, name, value) {
  let location = programInfo.uniforms.get(name);
  if (location === undefined) {
    location = gl.getUniformLocation(programInfo.program, name);
    programInfo.uniforms.set(name, location);
  }
  gl.uniform1f(location, value);
}

function updateStats(model) {
  const vertexCount = model.vertices.length / 3;
  const triangleCount = model.indices.length / 3;
  modelStats.innerHTML = `
    <dt>Name</dt><dd>${escapeHtml(model.name)}</dd>
    <dt>Vertices</dt><dd>${vertexCount}</dd>
    <dt>Triangles</dt><dd>${triangleCount}</dd>
    ${model.boneCount ? `<dt>Bones</dt><dd>${model.boneCount}</dd>` : ""}
    ${model.texture && !model.texture.fallback ? `<dt>Texture</dt><dd>${model.texture.width} x ${model.texture.height}</dd>` : ""}
    <dt>Renderer</dt><dd>WebGL 1</dd>
  `;
}

function setNotes(notes) {
  parserNotes.innerHTML = "";
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    parserNotes.append(item);
  }
}

function resizeCanvasToDisplaySize() {
  const width = Math.max(1, Math.floor(canvas.clientWidth * window.devicePixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * window.devicePixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0
  ]);
}

function mat4LookAt(eye, center, up) {
  const z = normalize(subtract(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);

  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}

function mat4RotateY(matrix, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rotation = new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1
  ]);
  return mat4Multiply(matrix, rotation);
}

function mat4Translate(matrix, value) {
  const translation = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    value[0], value[1], value[2], 1
  ]);
  return mat4Multiply(matrix, translation);
}

function mat4FromEulerPsx(angles) {
  const [x, y, z] = angles.map((angle) => angle * Math.PI * 2 / 4096);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const rx = new Float32Array([
    1, 0, 0, 0,
    0, cx, sx, 0,
    0, -sx, cx, 0,
    0, 0, 0, 1
  ]);
  const ry = new Float32Array([
    cy, 0, -sy, 0,
    0, 1, 0, 0,
    sy, 0, cy, 0,
    0, 0, 0, 1
  ]);
  const rz = new Float32Array([
    cz, sz, 0, 0,
    -sz, cz, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
  return mat4Multiply(mat4Multiply(rz, ry), rx);
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14]
  ];
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function extensionOf(name) {
  const match = /\.([^.]+)$/.exec(name.toLowerCase());
  return match ? match[1] : "";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
