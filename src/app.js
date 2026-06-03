"use strict";

const canvas = document.querySelector("#viewer");
const gl = canvas.getContext("webgl", {
  antialias: false,
  preserveDrawingBuffer: true,
});
const PERF_LOG = false;
const viewport = document.querySelector(".viewport");
const modelStats = document.querySelector("#modelStats");
const animationInspector = document.querySelector("#animationInspector");
const fileList = document.querySelector("#fileList");
const modelList = document.querySelector("#modelList");
const modelDock = document.querySelector("#modelDock");
const imageList = document.querySelector("#imageList");
const imageViewer = document.querySelector("#imageViewer");
const imagePreview = document.querySelector("#imagePreview");
const imageTitle = document.querySelector("#imageTitle");
const imageMeta = document.querySelector("#imageMeta");
const imageScreens = document.querySelector("#imageScreens");
const imageStage = document.querySelector(".image-stage");
const resetImageView = document.querySelector("#resetImageView");
const busyOverlay = document.querySelector("#busyOverlay");
const busyTitle = document.querySelector("#busyTitle");
const busyMessage = document.querySelector("#busyMessage");
const busyProgress = document.querySelector("#busyProgress");
const preloadPrompt = document.querySelector("#preloadPrompt");
const preloadNow = document.querySelector("#preloadNow");
const preloadSkip = document.querySelector("#preloadSkip");
const parserNotes = document.querySelector("#parserNotes");
const debugOverlay = document.querySelector("#debugOverlay");
const debugToggle = document.querySelector("#debugToggle");
const settingsButton = document.querySelector("#settingsButton");
const settingsPanel = document.querySelector("#settingsPanel");
const soundToggle = document.querySelector("#soundToggle");
const soundVolume = document.querySelector("#soundVolume");
const soundVolumeValue = document.querySelector("#soundVolumeValue");
const dropZone = document.querySelector("#dropZone");
const filePicker = document.querySelector("#filePicker");
const resetCamera = document.querySelector("#resetCamera");
const viewButtons = document.querySelectorAll(".view-button");
const wireframeToggle = document.querySelector("#wireframe");
const animateToggle = document.querySelector("#animate");
const animationSelect = document.querySelector("#animationSelect");
const animationFps = document.querySelector("#animationFps");
const animationFpsValue = document.querySelector("#animationFpsValue");
const textureToggle = document.querySelector("#textureToggle");
const modelTransitionToggle = document.querySelector("#modelTransitionToggle");
const assetSearch = document.querySelector("#assetSearch");
const assetFilter = document.querySelector("#assetFilter");
const imageSearch = document.querySelector("#imageSearch");
const imageFilter = document.querySelector("#imageFilter");
const prevModel = document.querySelector("#prevModel");
const nextModel = document.querySelector("#nextModel");
const prevImage = document.querySelector("#prevImage");
const nextImage = document.querySelector("#nextImage");

const buttonBeep = new Audio("./src/sfx/button-beep.wav");
buttonBeep.preload = "auto";
const soundControlSelector =
  "button, .toggle, select, .drop-zone, .patreon-button, input[type='checkbox'], input[type='range']";
const allowedUploadExtensions = new Set(["bin"]);

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
  dragMode: "rotate",
  lastX: 0,
  lastY: 0,
  wireframe: true,
  animate: true,
  texture: true,
  files: [],
  disc: null,
  assets: [],
  models: [],
  images: [],
  selectedModelPath: "",
  selectedImagePath: "",
  selectedImageScreen: 0,
  currentImage: null,
  currentDecodedImage: null,
  currentImageSize: { width: 0, height: 0 },
  imageFitZoom: 1,
  imageZoom: 1,
  imagePanX: 0,
  imagePanY: 0,
  imageDragging: false,
  imageDragged: false,
  imageLastX: 0,
  imageLastY: 0,
  assetThumbs: {},
  imageThumbs: {},
  imageThumbJobs: new Set(),
  imageThumbQueue: [],
  imageThumbRunning: false,
  modelThumbJobs: new Set(),
  modelCache: new Map(),
  fileBytesCache: new Map(),
  modelLoadRequestId: 0,
  thumbnailJobId: 0,
  thumbnailProgress: { active: false, done: 0, total: 0 },
  busyDepth: 0,
  assetNames: loadAssetNames(),
  selectedClip: 0,
  lastAnimFrameAt: 0,
  animationFps: loadAnimationFps(),
  modelTransitionEnabled: loadModelTransitionEnabled(),
  soundEnabled: loadSoundEnabled(),
  soundVolume: loadSoundVolume(),
  modelTransition: null,
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
  uniform float uAlpha;
  uniform float uDitherFade;
  void main() {
    vec4 texel = texture2D(uTexture, vTexCoord);
    vec3 litTexture = texel.rgb * mix(vec3(0.82), vColor, 0.22);
    vec3 color = mix(vColor, litTexture, uUseTexture);
    if (uDitherFade > 0.5) {
      float threshold = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
      if (uAlpha < threshold) {
        discard;
      }
      gl_FragColor = vec4(color, 1.0);
    } else {
      gl_FragColor = vec4(color, uAlpha);
    }
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
const lineProgram = createProgram(
  lineVertexShaderSource,
  lineFragmentShaderSource,
);
const mirrorModelX = true;
let currentModel = createDemoModel();
let buffers = createBuffers(currentModel);

updateStats(currentModel);
renderModelList();
renderImageList();
populateAnimationSelect(currentModel);
syncAnimationFpsControl();
syncRenderControls();
syncSoundControls();
setupTooltips();
setNotes([
  "This first build proves the viewer: camera, low-poly mesh drawing, wire overlay, and animation.",
  "PS1 models are usually fixed-point vertices plus polygon packets. We convert those into normal GPU triangles.",
  "TIM files decode as normal PS1 images. BSS room backgrounds use an experimental STRv3/MDEC still-frame decoder and may need more tuning.",
]);
setupSettingsButton();

requestAnimationFrame(draw);

function setupSettingsButton() {
  settingsButton.disabled = false;
  settingsButton.removeAttribute("aria-disabled");
  settingsButton.setAttribute("aria-controls", "settingsPanel");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.setAttribute("title", "Viewer settings");
  settingsButton.textContent = "\u2699";
}

function playButtonBeep() {
  if (!state.soundEnabled || state.soundVolume <= 0) return;
  buttonBeep.volume = state.soundVolume;
  buttonBeep.currentTime = 0;
  buttonBeep.play().catch(() => {
    // Browser may ignore audio if it was not triggered by a user action.
  });
}

document.addEventListener("pointerdown", (event) => {
  const control = audibleControlFromEvent(event);
  if (!control) return;

  playButtonBeep();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const control = audibleControlFromEvent(event);
  if (!control) return;

  playButtonBeep();
});

function audibleControlFromEvent(event) {
  const control = event.target.closest(soundControlSelector);
  if (!control) return null;
  if (control.matches("input[type='file']")) return null;
  if (control.disabled || control.getAttribute("aria-disabled") === "true") return null;
  if (state.busyDepth > 0 && !control.closest("#preloadPrompt")) return null;
  return control;
}

resetCamera.addEventListener("click", () => {
  resetView();
});

viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setCameraView(button.dataset.view);
  });
});

wireframeToggle.addEventListener("change", () => {
  state.wireframe = wireframeToggle.checked;
});

animateToggle.addEventListener("change", () => {
  state.animate = animateToggle.checked;
  state.lastAnimFrameAt = 0;
});

animationSelect.addEventListener("change", () => {
  state.selectedClip = Number(animationSelect.value || 0);
  state.lastAnimFrameAt = 0;
  setModelAnimationFrame(0);
});

animationFps.addEventListener("input", () => {
  state.animationFps = clamp(Number(animationFps.value) || 30, 1, 60);
  state.lastAnimFrameAt = 0;
  saveAnimationFps();
  syncAnimationFpsControl();
});

textureToggle.addEventListener("change", () => {
  state.texture = textureToggle.checked;
});

modelTransitionToggle.checked = state.modelTransitionEnabled;
modelTransitionToggle.addEventListener("change", () => {
  state.modelTransitionEnabled = modelTransitionToggle.checked;
  saveModelTransitionEnabled();
  if (!state.modelTransitionEnabled) {
    state.modelTransition = null;
  }
});

assetSearch.addEventListener("input", () => {
  renderModelList({ preserveScroll: false });
});

assetFilter.addEventListener("change", async () => {
  renderModelList({ preserveScroll: false });

  const firstAsset = currentVisibleAssets()[0];
  if (!firstAsset) return;

  if (firstAsset.renderable) {
    await loadDiscModel(firstAsset);
  } else if (firstAsset.image) {
    await loadImageAsset(firstAsset);
  }
});

imageSearch.addEventListener("input", () => {
  renderImageList();
});

imageFilter.addEventListener("change", () => {
  renderImageList();
});

prevModel.addEventListener("click", () => {
  loadAdjacentModel(-1);
});

nextModel.addEventListener("click", () => {
  loadAdjacentModel(1);
});

prevImage.addEventListener("click", () => {
  loadAdjacentImage(-1);
});

nextImage.addEventListener("click", () => {
  loadAdjacentImage(1);
});

debugToggle.addEventListener("click", () => {
  const visible = debugOverlay.classList.toggle("is-visible");
  debugToggle.classList.toggle("is-active", visible);
  debugToggle.setAttribute("aria-expanded", String(visible));
});

settingsButton.addEventListener("click", () => {
  const hidden = settingsPanel.classList.toggle("is-hidden");
  settingsButton.classList.toggle("is-active", !hidden);
  settingsButton.setAttribute("aria-expanded", String(!hidden));
});

soundToggle.addEventListener("change", () => {
  state.soundEnabled = soundToggle.checked;
  if (state.soundEnabled && state.soundVolume <= 0) {
    state.soundVolume = 0.35;
  }
  saveSoundSettings();
  syncSoundControls();
});

soundVolume.addEventListener("input", () => {
  state.soundVolume = clamp(Number(soundVolume.value) / 100, 0, 1);
  saveSoundSettings();
  syncSoundControls();
});

document.addEventListener("pointerdown", (event) => {
  if (settingsPanel.classList.contains("is-hidden")) return;
  if (event.target.closest("#settingsPanel, #settingsButton")) return;
  closeSettingsPanel();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeSettingsPanel();
});

canvas.addEventListener("pointerdown", (event) => {
  if (state.busyDepth > 0) return;
  event.preventDefault();
  state.dragging = true;
  state.dragMode = event.button === 1 || event.shiftKey ? "pan" : "rotate";
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (state.busyDepth > 0) return;
  if (!state.dragging) return;
  const dx = event.clientX - state.lastX;
  const dy = event.clientY - state.lastY;
  if (state.dragMode === "pan") {
    panModelView(dx, dy);
  } else {
    state.yaw += dx * 0.008;
    state.pitch = clamp(state.pitch + dy * 0.008, -1.25, 1.25);
  }
  state.lastX = event.clientX;
  state.lastY = event.clientY;
});

canvas.addEventListener("pointerup", () => {
  state.dragging = false;
  state.dragMode = "rotate";
});

canvas.addEventListener("pointercancel", () => {
  state.dragging = false;
  state.dragMode = "rotate";
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

canvas.addEventListener(
  "wheel",
  (event) => {
    if (state.busyDepth > 0) return;
    event.preventDefault();
    state.distance = clamp(state.distance + event.deltaY * 0.006, 2.5, 10);
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (state.busyDepth > 0 || !imageViewer.classList.contains("is-hidden")) return;
  if (event.target?.closest?.("input, select, textarea")) return;
  const panPixels = 42;
  const keys = {
    ArrowLeft: [-panPixels, 0],
    ArrowRight: [panPixels, 0],
    ArrowUp: [0, -panPixels],
    ArrowDown: [0, panPixels],
  };
  const offset = keys[event.key];
  if (!offset) return;
  event.preventDefault();
  panModelView(offset[0], offset[1]);
});

imageStage.addEventListener(
  "wheel",
  (event) => {
    if (imageViewer.classList.contains("is-hidden") || state.busyDepth > 0)
      return;
    event.preventDefault();
    const oldZoom = state.imageZoom;
    const direction = event.deltaY < 0 ? 1 : -1;
    const factor = direction > 0 ? 1.16 : 1 / 1.16;
    const nextZoom = clamp(state.imageZoom * factor, 1, 8);
    if (nextZoom === oldZoom) return;
    const rect = imageStage.getBoundingClientRect();
    const cursorX = event.clientX - (rect.left + rect.width / 2);
    const cursorY = event.clientY - (rect.top + rect.height / 2);
    state.imagePanX = cursorX - (nextZoom / oldZoom) * (cursorX - state.imagePanX);
    state.imagePanY = cursorY - (nextZoom / oldZoom) * (cursorY - state.imagePanY);
    state.imageZoom = nextZoom;
    clampImagePan();
    updateImageTransform();
  },
  { passive: false },
);

imageStage.addEventListener("pointerdown", (event) => {
  if (imageViewer.classList.contains("is-hidden") || state.busyDepth > 0) return;
  if (event.target.closest("button")) return;
  state.imageDragging = true;
  state.imageDragged = false;
  state.imageLastX = event.clientX;
  state.imageLastY = event.clientY;
  imageStage.setPointerCapture(event.pointerId);
  imageStage.classList.add("is-panning");
});

imageStage.addEventListener("pointermove", (event) => {
  if (!state.imageDragging || state.busyDepth > 0) return;
  const dx = event.clientX - state.imageLastX;
  const dy = event.clientY - state.imageLastY;
  if (Math.abs(dx) + Math.abs(dy) > 1) {
    state.imageDragged = true;
  }
  state.imagePanX += dx;
  state.imagePanY += dy;
  state.imageLastX = event.clientX;
  state.imageLastY = event.clientY;
  clampImagePan();
  updateImageTransform();
});

imageStage.addEventListener("pointerup", (event) => {
  state.imageDragging = false;
  imageStage.classList.remove("is-panning");
  if (imageStage.hasPointerCapture(event.pointerId)) {
    imageStage.releasePointerCapture(event.pointerId);
  }
});

imageStage.addEventListener("pointercancel", () => {
  state.imageDragging = false;
  imageStage.classList.remove("is-panning");
});

resetImageView.addEventListener("click", (event) => {
  event.stopPropagation();
  resetImagePanZoom();
});

imagePreview.addEventListener("load", () => {
  updateImageTransform();
});

window.addEventListener("resize", () => {
  if (!imageViewer.classList.contains("is-hidden")) {
    updateImageTransform();
  }
});

imageStage.addEventListener("click", (event) => {
  if (state.imageDragged) {
    state.imageDragged = false;
    return;
  }
  const decoded = state.currentDecodedImage;
  if (!decoded?.screens?.length || state.selectedImageScreen !== 0) return;
  const allScreen = decoded.screens[0];
  if (!allScreen.tileMap) return;

  const rect = imagePreview.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const imageX = ((event.clientX - rect.left) / rect.width) * allScreen.width;
  const imageY = ((event.clientY - rect.top) / rect.height) * allScreen.height;
  const match = allScreen.tileMap.find(
    (tile) =>
      imageX >= tile.x &&
      imageX < tile.x + tile.width &&
      imageY >= tile.y &&
      imageY < tile.y + tile.height,
  );
  if (!match) return;

  setImageScreen(match.screenIndex);
});

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
  if (state.busyDepth > 0) return;
  setBusy(true, "Loading files", "Preparing dropped files...", 0);
  try {
    state.files = [];

    for (const [index, file] of files.entries()) {
      const ext = extensionOf(file.name);
      setBusy(
        true,
        "Loading files",
        `Reading ${file.name}`,
        files.length ? index / files.length : 0,
      );
      const entry = {
        name: file.name,
        size: file.size,
        type: ext || "unknown",
        detail: "",
      };

      if (!allowedUploadExtensions.has(ext)) {
        entry.detail = "Rejected: this hosted viewer only accepts .bin disc images.";
        state.files.push(entry);
        continue;
      }

      try {
        entry.detail = await inspectIso(file);
      } catch (error) {
        entry.detail = `Rejected: ${error.message || "could not read this BIN file."}`;
      }

      state.files.push(entry);
    }

    renderFileList();
  } finally {
    setBusy(false);
  }
}

function loadModelBytes(bytes, name) {
  state.modelTransition = null;
  hideImageViewer();
  viewport.classList.remove("is-image-mode");
  const model = parseModelBytes(bytes, name);
  currentModel = model;
  buffers = createBuffers(currentModel);
  fitViewToModel(currentModel);
  populateAnimationSelect(currentModel);
  updateStats(currentModel);
  return model;
}

function parseModelBytes(bytes, name) {
  const ext = extensionOf(name);
  return ext === "ivm"
    ? parseIvmModel(bytes, name)
    : parseEmdModel(bytes, name);
}

function populateAnimationSelect(model) {
  animationSelect.innerHTML = "";
  const clips = model.animations || [];
  const visibleClips = clips.map((clip, index) => ({ clip, index }));

  if (!clips.length) {
    state.animate = false;
    animateToggle.checked = false;
    animateToggle.disabled = true;
    animationSelect.disabled = true;
    animationFps.disabled = true;
    animationSelect.append(new Option("No clips", ""));
    state.selectedClip = 0;
    return;
  }

  animateToggle.disabled = false;
  if (!state.animate) {
    state.animate = true;
    animateToggle.checked = true;
  }

  if (!visibleClips.length) {
    animationSelect.disabled = true;
    animationFps.disabled = true;
    animationSelect.append(new Option("No matching clips", ""));
    return;
  }

  animationSelect.disabled = false;
  animationFps.disabled = false;
  visibleClips.forEach(({ clip, index }) => {
    const label = clip.motion
      ? `${clip.frames.length}, ${clip.motion.label}`
      : String(clip.frames.length);
    animationSelect.append(
      new Option(`Clip ${index} (${label})`, String(index)),
    );
  });
  if (!visibleClips.some(({ index }) => index === state.selectedClip)) {
    state.selectedClip = visibleClips[0].index;
  }
  animationSelect.value = String(state.selectedClip);
}

function animationClipMatchesFilter(clip, filter) {
  const type = clip.motion?.type || "unknown";
  if (filter === "motion") {
    return type === "moving" || type === "action";
  }
  if (filter === "subtle") {
    return type === "subtle";
  }
  if (filter === "pose") {
    return type === "pose";
  }
  return true;
}

async function inspectTim(file) {
  const header = new DataView(await file.slice(0, 32).arrayBuffer());
  if (header.byteLength < 8 || header.getUint32(0, true) !== 0x10) {
    return "Not a standard PSX TIM header.";
  }

  const flags = header.getUint32(4, true);
  const bpp = flags & 0x7;
  const hasClut = (flags & 0x8) !== 0;
  const modes = [
    "4-bit indexed",
    "8-bit indexed",
    "16-bit direct",
    "24-bit direct",
  ];
  return `PSX TIM detected: ${modes[bpp] || `mode ${bpp}`}${hasClut ? ", with CLUT" : ""}.`;
}

async function inspectIso(file) {
  setBusy(true, "Reading disc image", "Checking ISO9660 layout...", 0.05);
  const layout = await detectIsoLayout(file);
  if (!layout) {
    return "Disc image candidate, but no ISO9660 primary volume descriptor was found yet.";
  }

  setBusy(
    true,
    "Reading disc image",
    "Extracting file directory from BIN/ISO...",
    0.18,
  );
  const files = await readIsoDirectory(file, layout, layout.root, "");
  setBusy(
    true,
    "Reading disc image",
    `Classifying ${files.length} files...`,
    0.5,
  );
  const assets = files.map(classifyAsset);
  const emdFiles = assets.filter((item) => item.ext === "emd");
  const timFiles = assets.filter((item) => item.kind === "texture");
  const bssFiles = assets.filter((item) => item.kind === "background");
  state.disc = { file, layout, files };
  state.assets = assets;
  state.models = assets.filter((item) => item.renderable);
  state.images = assets.filter((item) => item.image);
  state.assetThumbs = {};
  state.imageThumbs = {};
  state.imageThumbJobs.clear();
  state.imageThumbQueue = [];
  state.imageThumbRunning = false;
  state.modelThumbJobs.clear();
  state.modelCache.clear();
  state.fileBytesCache.clear();
  state.selectedImagePath = "";
  renderModelList();
  renderImageList();
  const shouldPreload =
    state.models.length > 0 ? await askPreloadModelThumbnails() : false;

  if (shouldPreload) {
    setBusy(
      true,
      "Building model browser",
      `Found ${state.models.length} models and ${state.images.length} image assets.`,
      0.72,
    );
    await generateAllModelThumbnails();
    await generateAllImageThumbnails();
  }

  const initialAsset = currentVisibleAssets()[0] || state.models[0] || state.images[0];
  if (initialAsset?.renderable) {
    setBusy(
      true,
      "Opening first model",
      `${shouldPreload ? "Opening" : "Skipping previews. Loading"} ${displayAssetName(initialAsset)}...`,
      0.86,
    );
    await loadDiscModel(initialAsset, {
      captureThumbnail: false,
      thumbnailJob: true,
    });
  } else if (initialAsset?.image) {
    setBusy(
      true,
      "Opening first image",
      `Loading ${displayAssetName(initialAsset)}...`,
      0.86,
    );
    await loadImageAsset(initialAsset);
  }

  const samples = [...emdFiles.slice(0, 3), ...timFiles.slice(0, 3)]
    .map((item) => item.path)
    .join(", ");
  const previewNote = state.models.length
    ? shouldPreload
      ? " Asset previews built."
      : " Asset previews skipped; tiles will fill in as assets are opened."
    : "";

  return `ISO9660 detected (${layout.sectorSize}-byte sectors): ${files.length} files, ${state.models.length} renderable assets (${emdFiles.length} EMD, ${state.models.length - emdFiles.length} IVM), ${timFiles.length} TIM, ${bssFiles.length} BSS background containers${samples ? `. Examples: ${samples}` : ""}.${previewNote}`;
}

function renderModelList(options = {}) {
  const preserveScroll = options.preserveScroll !== false;
  const scrollTop = preserveScroll ? modelDock.scrollTop : 0;
  const scrollLeft = preserveScroll ? modelDock.scrollLeft : 0;
  modelList.innerHTML = "";
  modelDock.innerHTML = "";

  if (!state.assets.length) {
    modelList.textContent = "";
    modelDock.classList.add("is-empty");
    prevModel.disabled = true;
    nextModel.disabled = true;
    return;
  }

  const visibleAssets = currentVisibleAssets();

  prevModel.disabled = state.busyDepth > 0 || !visibleAssets.length;
  nextModel.disabled = state.busyDepth > 0 || !visibleAssets.length;

  if (!visibleAssets.length) {
    modelList.textContent = "No matching assets.";
    modelDock.classList.add("is-empty");
    return;
  }

  modelDock.classList.remove("is-empty");
  if (state.thumbnailProgress.active) {
    modelDock.append(createThumbnailProgressTile());
  }
  for (const asset of visibleAssets) {
    if (asset.renderable) {
      modelDock.append(createModelTile(asset));
    } else if (asset.image) {
      modelDock.append(createAssetTile(asset));
    }
  }
  if (preserveScroll) {
    modelDock.scrollTop = scrollTop;
    modelDock.scrollLeft = scrollLeft;
  }
}

function assetMatchesFilter(asset, filter) {
  if (filter === "all") return true;
  return asset.kind === filter;
}

function createThumbnailProgressTile() {
  const item = document.createElement("div");
  item.className = "thumbnail-progress";
  const { done, total } = state.thumbnailProgress;
  const percent = total ? Math.round((done * 100) / total) : 0;
  item.innerHTML = `
    <strong>Building previews</strong>
    <span>${done} / ${total}</span>
    <progress max="${total || 1}" value="${done}"></progress>
    <small>${percent}%</small>
  `;
  return item;
}

function createModelListButton(model) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = model.path;
  button.dataset.assetPath = model.path;
  button.className =
    model.path === state.selectedModelPath ? "is-selected" : "";
  button.disabled = state.busyDepth > 0 || !model.renderable;
  button.innerHTML = `
    <span class="asset-name">${escapeHtml(displayAssetName(model))}</span>
    <small>${formatBytes(model.size)}</small>
    <span class="asset-path">${escapeHtml(model.path)}</span>
    <span class="asset-kind">${escapeHtml(model.label)}</span>
  `;
  bindModelButton(button, model);
  return button;
}

function createModelTile(model) {
  return createAssetTile(model);
}

function createAssetTile(asset) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = `${displayAssetName(asset)}\n${asset.path}`;
  button.dataset.assetPath = asset.path;
  button.className =
    asset.path === state.selectedModelPath || asset.path === state.selectedImagePath
      ? "model-tile is-selected"
      : "model-tile";
  button.disabled = state.busyDepth > 0;
  const thumbnail = asset.renderable
    ? state.assetThumbs[asset.path]
    : state.imageThumbs[asset.path];
  const thumbnailSrc = safeDataImageSrc(thumbnail);
  button.innerHTML = `
    <span class="tile-preview ${thumbnailSrc ? "has-thumb" : ""}">
      ${thumbnailSrc ? `<img src="${escapeHtml(thumbnailSrc)}" alt="">` : `<span>${escapeHtml(tileFallbackText(asset))}</span>`}
    </span>
    <span class="tile-meta">
      <strong>${escapeHtml(displayAssetName(asset))}</strong>
      <small>${escapeHtml(assetTileLabel(asset))} - ${formatBytes(asset.size)}</small>
    </span>
  `;
  if (asset.renderable) {
    bindModelButton(button, asset);
  } else if (asset.image) {
    bindImageButton(button, asset);
  }
  return button;
}

function createImageGroupTile(group) {
  const firstImage = group.items[0];
  const thumbnail = group.items.map((image) => state.imageThumbs[image.path]).find(Boolean);
  const thumbnailSrc = safeDataImageSrc(thumbnail);
  const selected = group.items.some((image) => image.path === state.selectedImagePath);
  const button = document.createElement("button");
  button.type = "button";
  button.title = `${group.name}\n${group.items.length} room background containers`;
  button.className = selected ? "model-tile is-selected" : "model-tile";
  button.disabled = state.busyDepth > 0 || !firstImage;
  button.innerHTML = `
    <span class="tile-preview ${thumbnailSrc ? "has-thumb" : ""}">
      ${thumbnailSrc ? `<img src="${escapeHtml(thumbnailSrc)}" alt="">` : `<span>ROOM</span>`}
    </span>
    <span class="tile-meta">
      <strong>${escapeHtml(group.name)}</strong>
      <small>${group.items.length} rooms</small>
    </span>
  `;
  if (firstImage) {
    bindImageButton(button, firstImage);
  }
  return button;
}

function bindModelButton(button, model) {
  if (!model.renderable) return;
  button.addEventListener("click", async () => {
    await loadDiscModel(model);
  });
  button.addEventListener("dblclick", () => {
    renameAsset(model);
  });
}

function bindImageButton(button, image) {
  button.addEventListener("click", async () => {
    await loadImageAsset(image);
  });
  button.addEventListener("dblclick", () => {
    renameAsset(image);
  });
}

function updateAssetSelectionUi() {
  const selectedPath = state.selectedImagePath || state.selectedModelPath;
  for (const tile of modelDock.querySelectorAll(".model-tile[data-asset-path]")) {
    tile.classList.toggle("is-selected", tile.dataset.assetPath === selectedPath);
  }
  for (const button of modelList.querySelectorAll("button")) {
    button.classList.toggle("is-selected", button.dataset.assetPath === selectedPath);
  }
}

function queueImageThumbnail(image) {
  if (
    !image?.image ||
    state.busyDepth > 0 ||
    hasImageThumbnailResult(image.path) ||
    state.imageThumbJobs.has(image.path)
  ) {
    return;
  }
  if (!state.disc && !image.file) return;

  state.imageThumbJobs.add(image.path);
  state.imageThumbQueue.push(image);
  runNextImageThumbnailJob();
}

function hasImageThumbnailResult(path) {
  return Object.prototype.hasOwnProperty.call(state.imageThumbs, path);
}

function runNextImageThumbnailJob() {
  if (state.imageThumbRunning) return;
  const image = state.imageThumbQueue.shift();
  if (!image) return;

  state.imageThumbRunning = true;
  const run = async () => {
    try {
      const bytes = image.file
        ? new Uint8Array(await image.file.arrayBuffer())
        : await readIsoFile(state.disc.file, state.disc.layout, image);
      const decoded = decodeImageAsset(bytes, image);
      state.imageThumbs[image.path] = decoded.thumbnail || decoded.url || "";
    } catch {
      state.imageThumbs[image.path] = "";
    } finally {
      state.imageThumbJobs.delete(image.path);
      state.imageThumbRunning = false;
      renderModelList();
      runNextImageThumbnailJob();
    }
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    window.setTimeout(run, 0);
  }
}

async function loadDiscModel(model, options = {}) {
  const perf = createPerfTimer(`loadDiscModel ${model.path}`);
  if (!options.thumbnailJob) {
    cancelThumbnailGeneration();
  }
  const requestId = options.thumbnailJob ? state.modelLoadRequestId : ++state.modelLoadRequestId;
  const wasImageVisible = !imageViewer.classList.contains("is-hidden");
  const outgoingCamera = snapshotCamera();
  if (state.modelTransition?.fromBuffers && state.modelTransition.fromBuffers !== buffers) {
    disposeBuffers(state.modelTransition.fromBuffers);
  }
  state.modelTransition = null;
  hideImageViewer();
  const previousSelectedModelPath = state.selectedModelPath;
  state.selectedModelPath = model.path;
  state.selectedImagePath = "";
  updateAssetSelectionUi();
  perf.mark("selection ui");
  const nextModel = await loadModelForDisplay(model);
  perf.mark("load/parse cached model");
  if (!options.thumbnailJob && requestId !== state.modelLoadRequestId) return;
  const nextBuffers = createBuffers(nextModel);
  perf.mark("create buffers");
  const shouldTransition =
    !options.thumbnailJob &&
    options.captureThumbnail !== false &&
    !wasImageVisible &&
    previousSelectedModelPath &&
    state.modelTransitionEnabled &&
    currentModel?.vertices?.length &&
    nextModel.vertices?.length &&
    currentModel.name !== nextModel.name &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const previousModel = currentModel;
  const previousBuffers = buffers;

  currentModel = nextModel;
  buffers = nextBuffers;
  fitViewToModel(currentModel);
  perf.mark("fit view");
  populateAnimationSelect(currentModel);
  perf.mark("animation ui");
  updateStats(currentModel);
  perf.mark("stats");

  state.modelTransition = shouldTransition
    ? {
        startedAt: performance.now(),
        outDuration: 650,
        inDuration: 650,
        fromModel: previousModel,
        fromBuffers: previousBuffers,
        fromCamera: outgoingCamera,
        toModel: currentModel,
        toBuffers: buffers,
        toCamera: snapshotCamera(),
      }
    : null;
  if (!shouldTransition) {
    disposeBuffers(previousBuffers);
  }

  if (options.captureThumbnail !== false && !state.assetThumbs[model.path]) {
    queueModelThumbnail(model.path);
  }
  updateAssetSelectionUi();
  perf.end();
}

async function loadModelForDisplay(model) {
  const baseModel = await getCachedParsedModel(model);
  return cloneParsedModel(baseModel);
}

async function getCachedParsedModel(model) {
  if (state.modelCache.has(model.path)) {
    return state.modelCache.get(model.path);
  }

  const bytes = await readIsoFileCached(model);
  const parsed = parseModelBytes(bytes, model.path);
  state.modelCache.set(model.path, parsed);
  return parsed;
}

function cloneParsedModel(model) {
  return {
    ...model,
    vertices: model.vertices?.slice() || new Float32Array(),
    colors: model.colors?.slice() || new Float32Array(),
    texCoords: model.texCoords?.slice() || new Float32Array(),
    indices: model.indices?.slice() || new Uint16Array(),
    lineIndices: model.lineIndices?.slice() || new Uint16Array(),
    bounds: model.bounds
      ? {
          min: [...model.bounds.min],
          max: [...model.bounds.max],
          center: [...model.bounds.center],
          radius: model.bounds.radius,
        }
      : null,
    animationFrame: 0,
  };
}

async function loadAdjacentModel(direction) {
  const assets = currentVisibleAssets();
  if (!assets.length) return;
  const selectedPath = state.selectedImagePath || state.selectedModelPath;
  const currentIndex = Math.max(
    0,
    assets.findIndex((asset) => asset.path === selectedPath),
  );
  const next =
    assets[(currentIndex + direction + assets.length) % assets.length];
  if (next.renderable) {
    await loadDiscModel(next);
  } else if (next.image) {
    await loadImageAsset(next);
  }
}

function currentVisibleAssets() {
  const query = assetSearch.value.trim().toLowerCase();
  const filter = assetFilter.value;
  const visibleAssets = state.assets.filter((asset) => {
    if (!asset.renderable && !asset.image) return false;
    if (!assetMatchesFilter(asset, filter)) return false;
    if (!query) return true;
    return (
      asset.path.toLowerCase().includes(query) ||
      displayAssetName(asset).toLowerCase().includes(query)
    );
  });

  return [
    ...visibleAssets.filter((asset) => asset.renderable),
    ...visibleAssets.filter((asset) => asset.image),
  ];
}

function renderImageList() {
  imageList.innerHTML = "";

  if (!state.images.length) {
    imageList.textContent = state.assets.length
      ? "No image assets found yet."
      : "Drop a BIN/ISO to list images.";
    prevImage.disabled = true;
    nextImage.disabled = true;
    return;
  }

  const query = imageSearch.value.trim().toLowerCase();
  const filter = imageFilter.value;
  const visibleImages = state.images.filter((asset) => {
    if (filter !== "all" && asset.kind !== filter) return false;
    if (!query) return true;
    return (
      asset.path.toLowerCase().includes(query) ||
      displayAssetName(asset).toLowerCase().includes(query)
    );
  });

  prevImage.disabled = state.busyDepth > 0 || !state.images.length;
  nextImage.disabled = state.busyDepth > 0 || !state.images.length;

  if (!visibleImages.length) {
    imageList.textContent = "No matching images.";
    return;
  }

  const groups = groupImageAssets(visibleImages);
  for (const group of groups) {
    imageList.append(createImageGroup(group));
  }
}

function groupImageAssets(images) {
  const groups = new Map();
  for (const image of images) {
    const groupName =
      image.kind === "background" ? roomGroupName(image) : "Loose TIM images";
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName).push(image);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

function roomGroupName(image) {
  const parts = image.path.split("/");
  const stage = parts.find((part) => /^STAGE/i.test(part));
  return stage ? stage.replace(/^STAGE/i, "Stage ") : "Room backgrounds";
}

function createImageGroup(group) {
  const details = document.createElement("details");
  details.className = "image-group";
  details.open =
    group.items.some((image) => image.path === state.selectedImagePath) ||
    group.items.length <= 12;
  const summary = document.createElement("summary");
  summary.innerHTML = `<span>${escapeHtml(group.name)}</span><small>${group.items.length}</small>`;
  details.append(summary);
  const list = document.createElement("div");
  list.className = "image-group-list";
  for (const image of group.items) {
    list.append(createImageListButton(image));
  }
  details.append(list);
  return details;
}

function createImageListButton(image) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = image.path;
  button.className =
    image.path === state.selectedImagePath ? "is-selected" : "";
  button.disabled = state.busyDepth > 0;
  const thumbnail = state.imageThumbs[image.path];
  const thumbnailSrc = safeDataImageSrc(thumbnail);
  const subLabel = image.kind === "background" ? "Room screens" : image.label;
  button.innerHTML = `
    <span class="asset-name">${escapeHtml(displayAssetName(image))}</span>
    <small>${formatBytes(image.size)}</small>
    <span class="asset-path">${escapeHtml(image.path)}</span>
    <span class="asset-kind">${escapeHtml(subLabel)}</span>
    ${thumbnailSrc ? `<span class="asset-preview"><img src="${escapeHtml(thumbnailSrc)}" alt=""></span>` : ""}
  `;
  bindImageButton(button, image);
  return button;
}

async function loadAdjacentImage(direction) {
  if (!state.images.length) return;
  const currentIndex = Math.max(
    0,
    state.images.findIndex((image) => image.path === state.selectedImagePath),
  );
  const nextIndex =
    (currentIndex + direction + state.images.length) % state.images.length;
  await loadImageAsset(state.images[nextIndex]);
}

async function loadLooseImage(file, image) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  showDecodedImage(image, decodeImageAsset(bytes, image));
}

async function loadImageAsset(image) {
  if (state.thumbnailProgress.active) {
    cancelThumbnailGeneration();
  }
  state.modelTransition = null;
  if (!state.disc && !image.file) return;
  const bytes = image.file
    ? new Uint8Array(await image.file.arrayBuffer())
    : await readIsoFileCached(image);
  showDecodedImage(image, decodeImageAsset(bytes, image));
}

function decodeImageAsset(bytes, image) {
  if (image.ext === "tim") {
    const texture = parseTimTexture(bytes, 0);
    const title = texture.fallback ? "Unsupported TIM" : timModeLabel(texture);
    return {
      url: textureToDataUrl(texture),
      width: texture.width,
      height: texture.height,
      detail: `${title}, ${texture.width} x ${texture.height}`,
    };
  }

  if (image.ext === "bss") {
    return decodeBssPreview(bytes);
  }

  return {
    url: textureToDataUrl(createFallbackTexture()),
    width: 2,
    height: 2,
    detail: "No decoder for this image format yet.",
  };
}

function showDecodedImage(image, decoded) {
  state.selectedImagePath = image.path;
  state.selectedModelPath = "";
  state.selectedImageScreen = 0;
  state.currentImage = image;
  state.currentDecodedImage = decoded;
  resetImagePanZoom(false);
  state.imageThumbs[image.path] = decoded.thumbnail || decoded.url;
  imageTitle.textContent = displayAssetName(image);
  imagePreview.alt = displayAssetName(image);
  imageViewer.classList.remove("is-hidden");
  viewport.classList.add("is-image-mode");
  setImageScreen(0);
  renderImageScreens(image, decoded);
  renderModelList();
  renderImageList();
}

function setImageScreen(index) {
  const image = state.currentImage;
  const decoded = state.currentDecodedImage;
  if (!image || !decoded) return;

  const screens = decoded.screens || [];
  const screen = screens[index] || { url: decoded.url, detail: decoded.detail };
  state.selectedImageScreen = screens[index] ? index : 0;
  state.currentImageSize = {
    width: screen.width || decoded.width || 0,
    height: screen.height || decoded.height || 0,
  };
  state.imageFitZoom = 1;
  resetImagePanZoom(false);
  imagePreview.src = screen.url;
  imageMeta.textContent = `${image.label} - ${screen.detail || decoded.detail} - ${image.path}`;
  updateImageTransform();
  renderImageScreens(image, decoded);
}

function updateImageTransform() {
  const width = state.currentImageSize.width || imagePreview.naturalWidth || 0;
  const height = state.currentImageSize.height || imagePreview.naturalHeight || 0;
  const stageBounds = imageStage.getBoundingClientRect();

  if (width > 0 && height > 0 && stageBounds.width > 0 && stageBounds.height > 0) {
    const fitZoom = Math.min(
      (stageBounds.width * 0.82) / width,
      (stageBounds.height * 0.82) / height,
    );
    state.imageFitZoom = clamp(fitZoom, 0.2, 8);
    imagePreview.style.width = `${Math.max(1, Math.round(width * state.imageFitZoom))}px`;
    imagePreview.style.height = `${Math.max(1, Math.round(height * state.imageFitZoom))}px`;
  } else {
    imagePreview.style.width = "";
    imagePreview.style.height = "";
  }

  clampImagePan();
  imagePreview.style.transform = `translate(${state.imagePanX}px, ${state.imagePanY}px) scale(${state.imageZoom})`;
  imagePreview.classList.toggle("is-zoomed", state.imageZoom > 1.01);
}

function resetImagePanZoom(update = true) {
  state.imageZoom = 1;
  state.imagePanX = 0;
  state.imagePanY = 0;
  state.imageDragging = false;
  state.imageDragged = false;
  if (update) {
    updateImageTransform();
  }
}

function clampImagePan() {
  const stageBounds = imageStage.getBoundingClientRect();
  const imageWidth = parseFloat(imagePreview.style.width) || imagePreview.naturalWidth || 0;
  const imageHeight = parseFloat(imagePreview.style.height) || imagePreview.naturalHeight || 0;
  if (!stageBounds.width || !stageBounds.height || !imageWidth || !imageHeight) {
    state.imagePanX = 0;
    state.imagePanY = 0;
    return;
  }

  const panLimitX = (imageWidth * state.imageZoom) / 2;
  const panLimitY = (imageHeight * state.imageZoom) / 2;
  state.imagePanX = clamp(state.imagePanX, -panLimitX, panLimitX);
  state.imagePanY = clamp(state.imagePanY, -panLimitY, panLimitY);
}

function renderImageScreens(image, decoded) {
  imageScreens.innerHTML = "";
  const screens = decoded.screens || [];
  if (!screens.length) {
    imageScreens.classList.add("is-hidden");
    return;
  }

  imageScreens.classList.remove("is-hidden");
  screens.forEach((screen, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === state.selectedImageScreen ? "is-selected" : "";
    button.textContent = screen.label;
    button.title = screen.title || screen.label;
    button.addEventListener("click", () => {
      setImageScreen(index);
    });
    imageScreens.append(button);
  });
}

function hideImageViewer() {
  imageViewer.classList.add("is-hidden");
  imageScreens.classList.add("is-hidden");
  viewport.classList.remove("is-image-mode");
  state.currentImage = null;
  state.currentDecodedImage = null;
  state.currentImageSize = { width: 0, height: 0 };
  state.imageFitZoom = 1;
  resetImagePanZoom(false);
  updateImageTransform();
}

function classifyAsset(file) {
  const ext = extensionOf(file.path);
  const name = file.path.split("/").pop() || file.path;
  let kind = "unknown";
  let label = ext ? ext.toUpperCase() : "file";
  let renderable = false;
  let image = false;

  if (ext === "emd") {
    kind = name.startsWith("CHAR") ? "character" : "model";
    label = name.startsWith("CHAR") ? "Character" : "Model";
    renderable = true;
  } else if (ext === "ivm") {
    kind = "item";
    label = "Item";
    renderable = true;
  } else if (ext === "tim") {
    kind = "texture";
    label = "TIM Image";
    image = true;
  } else if (ext === "bss") {
    kind = "background";
    label = "BSS Container";
    image = true;
  } else if (["emw", "rdt"].includes(ext)) {
    kind = "unknown";
    label = `${ext.toUpperCase()} unsupported`;
  }

  return { ...file, ext, kind, label, renderable, image };
}

function displayAssetName(asset) {
  return (
    state.assetNames[asset.path] ||
    asset.path.split("/").pop()?.replace(/;1$/, "") ||
    asset.path
  );
}

function tileFallbackText(asset) {
  if (asset.kind === "character") return "CH";
  if (asset.kind === "model") return "EN";
  if (asset.kind === "item") return "IT";
  if (asset.kind === "texture") return "TIM";
  if (asset.kind === "background") return "ROOM";
  return asset.ext?.toUpperCase() || "3D";
}

function assetTileLabel(asset) {
  if (asset.kind === "background") return "Room";
  if (asset.kind === "texture") return "TIM";
  return asset.label || asset.kind || "Asset";
}

function queueModelThumbnail(path) {
  if (state.assetThumbs[path] || state.modelThumbJobs.has(path)) return;
  state.modelThumbJobs.add(path);
  const startedAt = performance.now();
  const tryCapture = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        try {
          if (state.selectedModelPath !== path) {
            state.modelThumbJobs.delete(path);
            return;
          }
          if (state.modelTransition && performance.now() - startedAt < 2600) {
            tryCapture();
            return;
          }
          if (state.modelTransition) {
            state.modelThumbJobs.delete(path);
            return;
          }
          state.assetThumbs[path] = await captureCanvasThumbnail();
          state.modelThumbJobs.delete(path);
          renderModelList();
        } catch {
          state.modelThumbJobs.delete(path);
          // Canvas thumbnail capture can fail on some browser/GPU setups; the tile fallback stays usable.
        }
      });
    });
  };
  tryCapture();
}

async function generateAllModelThumbnails() {
  if (!state.disc || !state.models.length) return;

  const jobId = ++state.thumbnailJobId;
  const models = [...state.models];
  state.thumbnailProgress = { active: true, done: 0, total: models.length };
  const wasAnimating = state.animate;
  state.animate = false;
  animateToggle.checked = false;
  renderModelList();

  for (const model of models) {
    if (jobId !== state.thumbnailJobId) return;
    const previewIndex = state.thumbnailProgress.done + 1;
    if (previewIndex === 1 || previewIndex === models.length || previewIndex % 8 === 0) {
      setBusy(
        true,
        "Building previews",
        `Rendering preview ${previewIndex} of ${models.length}: ${displayAssetName(model)}`,
        models.length ? state.thumbnailProgress.done / models.length : 0,
      );
    }

    try {
      const parsedModel = await loadModelForDisplay(model);
      if (jobId !== state.thumbnailJobId) return;
      currentModel = parsedModel;
      buffers = createBuffers(currentModel);
      fitViewToModel(currentModel);
      state.selectedModelPath = model.path;
      await nextFrame();
      if (jobId !== state.thumbnailJobId) return;
      state.assetThumbs[model.path] = await captureCanvasThumbnail();
    } catch {
      state.assetThumbs[model.path] = "";
    }

    state.thumbnailProgress.done++;
  }

  if (jobId !== state.thumbnailJobId) return;
  state.thumbnailProgress = {
    active: false,
    done: models.length,
    total: models.length,
  };
  state.animate = wasAnimating;
  animateToggle.checked = state.animate && !animateToggle.disabled;
  setBusy(true, "Building previews", "Finishing model browser...", 0.98);
  renderModelList();
}

async function generateAllImageThumbnails() {
  if (!state.disc || !state.images.length) return;

  const images = [...state.images];
  for (const [index, image] of images.entries()) {
    if (hasImageThumbnailResult(image.path)) continue;
    if (index === 0 || index === images.length - 1 || index % 8 === 0) {
      setBusy(
        true,
        "Building image previews",
        `Decoding image preview ${index + 1} of ${images.length}: ${displayAssetName(image)}`,
        images.length ? index / images.length : 0,
      );
    }

    try {
      const bytes = image.file
        ? new Uint8Array(await image.file.arrayBuffer())
        : await readIsoFileCached(image);
      const decoded = decodeImageAsset(bytes, image);
      state.imageThumbs[image.path] = decoded.thumbnail || decoded.url || "";
    } catch {
      state.imageThumbs[image.path] = "";
    }
  }

  setBusy(true, "Building image previews", "Finishing image browser...", 0.98);
  renderModelList();
  renderImageList();
}

function cancelThumbnailGeneration() {
  if (!state.thumbnailProgress.active) return;
  state.thumbnailJobId++;
  state.thumbnailProgress = {
    active: false,
    done: state.thumbnailProgress.done,
    total: state.thumbnailProgress.total,
  };
  renderModelList();
}

function setBusy(
  active,
  title = "Loading",
  message = "Please wait...",
  progress = 0,
) {
  const wasBusy = state.busyDepth > 0;
  state.busyDepth = active ? 1 : 0;

  const busy = state.busyDepth > 0;
  busyOverlay.classList.toggle("is-hidden", !busy);
  busyOverlay.classList.toggle("is-previewing", busy && title === "Building previews");
  dropZone.classList.toggle("is-disabled", busy);
  filePicker.disabled = busy;

  if (busy) {
    busyTitle.textContent = title;
    busyMessage.textContent = message;
    busyProgress.value = Math.round(clamp(progress, 0, 1) * 100);
  }

  if (busy !== wasBusy) {
    renderModelList();
    renderImageList();
  }
}

function askPreloadModelThumbnails() {
  return new Promise((resolve) => {
    setBusy(false);
    preloadPrompt.classList.remove("is-hidden");
    document.body.classList.add("is-preload-prompting");
    dropZone.classList.add("is-disabled");
    filePicker.disabled = true;
    preloadNow.focus();

    const finish = (shouldPreload) => {
      preloadPrompt.classList.add("is-hidden");
      document.body.classList.remove("is-preload-prompting");
      preloadNow.removeEventListener("click", onBuild);
      preloadSkip.removeEventListener("click", onSkip);
      dropZone.classList.remove("is-disabled");
      filePicker.disabled = false;
      resolve(shouldPreload);
    };

    const onBuild = () => finish(true);
    const onSkip = () => finish(false);

    preloadNow.addEventListener("click", onBuild);
    preloadSkip.addEventListener("click", onSkip);
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function createPerfTimer(label) {
  if (!PERF_LOG) {
    return { mark() {}, end() {} };
  }
  const start = performance.now();
  let last = start;
  return {
    mark(step) {
      const now = performance.now();
      console.log(`[perf] ${label} ${step}: ${(now - last).toFixed(1)}ms`);
      last = now;
    },
    end() {
      console.log(`[perf] ${label} total: ${(performance.now() - start).toFixed(1)}ms`);
    },
  };
}

function canvasToDataUrl(sourceCanvas, type = "image/webp", quality = 0.72) {
  if (!sourceCanvas.toBlob) {
    return Promise.resolve(sourceCanvas.toDataURL(type, quality));
  }

  return new Promise((resolve) => {
    sourceCanvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(sourceCanvas.toDataURL(type, quality));
          return;
        }

        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result || ""));
        reader.addEventListener("error", () => resolve(""));
        reader.readAsDataURL(blob);
      },
      type,
      quality,
    );
  });
}

function captureCanvasThumbnail() {
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = 160;
  thumbCanvas.height = 112;
  const context = thumbCanvas.getContext("2d");
  context.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return canvasToDataUrl(thumbCanvas, "image/webp", 0.62);
}

function renameAsset(asset) {
  const currentName = state.assetNames[asset.path] || "";
  const nextName = window.prompt(`Name for ${asset.path}`, currentName);
  if (nextName === null) return;

  const trimmed = nextName.trim();
  if (trimmed) {
    state.assetNames[asset.path] = trimmed;
  } else {
    delete state.assetNames[asset.path];
  }

  saveAssetNames();
  renderModelList();
}

function loadAssetNames() {
  try {
    return JSON.parse(
      window.localStorage.getItem("re1-model-viewer.assetNames") || "{}",
    );
  } catch {
    return {};
  }
}

function saveAssetNames() {
  window.localStorage.setItem(
    "re1-model-viewer.assetNames",
    JSON.stringify(state.assetNames),
  );
  renderImageList();
}

function loadAnimationFps() {
  const stored = Number(
    window.localStorage.getItem("re1-model-viewer.animationFps"),
  );
  return clamp(stored || 30, 1, 60);
}

function saveAnimationFps() {
  window.localStorage.setItem(
    "re1-model-viewer.animationFps",
    String(state.animationFps),
  );
}

function loadModelTransitionEnabled() {
  const stored = window.localStorage.getItem("re1-model-viewer.modelTransition");
  if (stored !== null) return stored !== "off";
  return window.localStorage.getItem("re1-model-viewer.itemTransition") !== "off";
}

function saveModelTransitionEnabled() {
  window.localStorage.setItem(
    "re1-model-viewer.modelTransition",
    state.modelTransitionEnabled ? "on" : "off",
  );
}

function loadSoundEnabled() {
  try {
    return window.localStorage.getItem("re1-model-viewer.soundEnabled") !== "off";
  } catch {
    return true;
  }
}

function loadSoundVolume() {
  try {
    const raw = window.localStorage.getItem("re1-model-viewer.soundVolume");
    if (raw === null) return 0.35;
    const stored = Number(raw);
    return clamp(Number.isFinite(stored) ? stored : 0.35, 0, 1);
  } catch {
    return 0.35;
  }
}

function saveSoundSettings() {
  try {
    window.localStorage.setItem(
      "re1-model-viewer.soundEnabled",
      state.soundEnabled ? "on" : "off",
    );
    window.localStorage.setItem(
      "re1-model-viewer.soundVolume",
      String(state.soundVolume),
    );
  } catch {
    // File/browser privacy modes can block storage; sound still works for the session.
  }
}

function syncAnimationFpsControl() {
  animationFps.value = String(state.animationFps);
  animationFpsValue.value = String(state.animationFps);
}

function syncRenderControls() {
  wireframeToggle.checked = state.wireframe;
  textureToggle.checked = state.texture;
  animateToggle.checked = state.animate;
  modelTransitionToggle.checked = state.modelTransitionEnabled;
}

function syncSoundControls() {
  buttonBeep.volume = state.soundVolume;
  soundToggle.checked = state.soundEnabled;
  soundVolume.value = String(Math.round(state.soundVolume * 100));
  soundVolume.disabled = !state.soundEnabled;
  soundVolumeValue.textContent = `${Math.round(state.soundVolume * 100)}%`;
}

function closeSettingsPanel() {
  settingsPanel.classList.add("is-hidden");
  settingsButton.classList.remove("is-active");
  settingsButton.setAttribute("aria-expanded", "false");
}

function setupTooltips() {
  const tooltip = document.createElement("div");
  tooltip.className = "app-tooltip";
  document.body.append(tooltip);
  let tooltipTimer = 0;
  let activeElement = null;

  const convertTitles = (root = document) => {
    root.querySelectorAll?.("[title]").forEach((element) => {
      if (element.dataset.tooltip) return;
      element.dataset.tooltip = element.getAttribute("title");
      element.removeAttribute("title");
    });
  };

  convertTitles();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.hasAttribute?.("title")) {
          node.dataset.tooltip = node.getAttribute("title");
          node.removeAttribute("title");
        }
        convertTitles(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });

  const hideTooltip = () => {
    window.clearTimeout(tooltipTimer);
    activeElement = null;
    tooltip.classList.remove("is-visible");
  };

  const positionTooltip = (element) => {
    const rect = element.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${Math.max(8, rect.top - 8)}px`;
  };

  const showTooltip = (element) => {
    const text = element.dataset.tooltip;
    if (!text) return;
    activeElement = element;
    window.clearTimeout(tooltipTimer);
    tooltipTimer = window.setTimeout(() => {
      if (activeElement !== element) return;
      tooltip.textContent = text;
      positionTooltip(element);
      tooltip.classList.add("is-visible");
    }, 500);
  };

  document.addEventListener("mouseover", (event) => {
    const element = event.target.closest("[data-tooltip]");
    if (!element) return;
    showTooltip(element);
  });

  document.addEventListener("mousemove", () => {
    if (activeElement && tooltip.classList.contains("is-visible")) {
      positionTooltip(activeElement);
    }
  });

  document.addEventListener("mouseout", (event) => {
    if (!event.target.closest("[data-tooltip]")) return;
    hideTooltip();
  });

  document.addEventListener("focusin", (event) => {
    const element = event.target.closest("[data-tooltip]");
    if (element) showTooltip(element);
  });

  document.addEventListener("focusout", hideTooltip);
document.addEventListener("keydown", hideTooltip);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    debugOverlay.classList.remove("is-visible");
    debugToggle.classList.remove("is-active");
    debugToggle.setAttribute("aria-expanded", "false");
  });
}

async function detectIsoLayout(file) {
  for (const sectorSize of [2048, 2352]) {
    const descriptorOffset =
      sectorSize === 2048 ? 16 * sectorSize : 16 * sectorSize + 24;
    const descriptor = new Uint8Array(
      await file.slice(descriptorOffset, descriptorOffset + 2048).arrayBuffer(),
    );
    if (
      descriptor.length >= 190 &&
      textFromBytes(descriptor, 1, 5) === "CD001" &&
      descriptor[0] === 1
    ) {
      const rootRecordOffset = 156;
      return {
        sectorSize,
        dataOffset: sectorSize === 2048 ? 0 : 24,
        root: parseIsoDirectoryRecord(descriptor, rootRecordOffset),
      };
    }
  }
  return null;
}

async function readIsoDirectory(file, layout, directory, prefix, depth = 0) {
  if (depth > 6) return [];

  const bytes = await readIsoExtent(
    file,
    layout,
    directory.extent,
    directory.size,
  );
  const files = [];
  let offset = 0;

  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) {
      offset = Math.ceil((offset + 1) / 2048) * 2048;
      continue;
    }

    const record = parseIsoDirectoryRecord(bytes, offset);
    offset += length;

    if (!record || record.name === "\u0000" || record.name === "\u0001")
      continue;

    const cleanName = record.name.replace(/;1$/, "");
    const fullPath = prefix ? `${prefix}/${cleanName}` : cleanName;

    if (record.isDirectory) {
      files.push(
        ...(await readIsoDirectory(file, layout, record, fullPath, depth + 1)),
      );
    } else {
      files.push({ path: fullPath, size: record.size, extent: record.extent });
    }
  }

  return files;
}

async function readIsoFile(file, layout, entry) {
  return readIsoExtent(file, layout, entry.extent, entry.size);
}

async function readIsoFileCached(entry) {
  if (!state.disc) return new Uint8Array();
  const key = entry.path || `${entry.extent}:${entry.size}`;
  if (state.fileBytesCache.has(key)) {
    return state.fileBytesCache.get(key);
  }
  const bytes = await readIsoFile(state.disc.file, state.disc.layout, entry);
  state.fileBytesCache.set(key, bytes);
  return bytes;
}

async function readIsoExtent(file, layout, firstSector, byteLength) {
  if (layout.sectorSize === 2048) {
    const start = firstSector * layout.sectorSize + layout.dataOffset;
    return new Uint8Array(
      await file.slice(start, start + byteLength).arrayBuffer(),
    );
  }

  const sectorCount = Math.ceil(byteLength / 2048);
  const rawStart = firstSector * layout.sectorSize;
  const rawEnd = (firstSector + sectorCount) * layout.sectorSize;
  const raw = new Uint8Array(await file.slice(rawStart, rawEnd).arrayBuffer());
  const bytes = new Uint8Array(byteLength);

  for (let i = 0, written = 0; written < byteLength; i++) {
    const chunk = Math.min(2048, byteLength - written);
    const sourceOffset = i * layout.sectorSize + layout.dataOffset;
    bytes.set(raw.subarray(sourceOffset, sourceOffset + chunk), written);
    written += chunk;
  }

  return bytes;
}

function parseIsoDirectoryRecord(bytes, offset) {
  const length = bytes[offset];
  if (!length || offset + length > bytes.length) return null;

  const nameLength = bytes[offset + 32];
  return {
    extent: readUint32LE(bytes, offset + 2),
    size: readUint32LE(bytes, offset + 10),
    isDirectory: (bytes[offset + 25] & 0x02) !== 0,
    name: textFromBytes(bytes, offset + 33, nameLength),
  };
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
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
  updateAnimationPlayback(time);
  resizeCanvasToDisplaySize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0.067, 0.075, 0.086, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const aspect = canvas.width / canvas.height;
  const projection = mat4Perspective(Math.PI / 4, aspect, 0.1, 100);
  const view = mat4LookAt(
    [
      state.target[0] +
        Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance,
      state.target[1] + Math.sin(state.pitch) * state.distance,
      state.target[2] +
        Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance,
    ],
    state.target,
    [0, 1, 0],
  );

  drawSceneModels(time, projection, view);

  requestAnimationFrame(draw);
}

function drawSceneModels(time, projection, view) {
  const transition = state.modelTransition;
  const totalDuration = (transition?.outDuration || 0) + (transition?.inDuration || 0);

  if (transition && time - transition.startedAt < totalDuration) {
    const elapsed = time - transition.startedAt;

    if (elapsed < transition.outDuration) {
      const progress = easeInOutCubic(elapsed / transition.outDuration);
      const transitionView = viewFromCameraSnapshot(transition.fromCamera);
      drawModelInstance(
        transition.fromModel,
        transition.fromBuffers,
        projection,
        transitionView,
        modelTransitionMatrix(progress, "out", transition.fromCamera),
        1 - progress,
        false,
        true,
      );
    } else {
      const progress = easeInOutCubic((elapsed - transition.outDuration) / transition.inDuration);
      const transitionView = viewFromCameraSnapshot(transition.toCamera);
      drawModelInstance(
        transition.toModel,
        transition.toBuffers,
        projection,
        transitionView,
        modelTransitionMatrix(progress, "in", transition.toCamera),
        progress,
        false,
        true,
      );
    }

    return;
  }

  if (transition) {
    disposeBuffers(transition.fromBuffers);
    state.modelTransition = null;
  }

  drawModelInstance(
    currentModel,
    buffers,
    projection,
    view,
    mat4Identity(),
    1,
    state.wireframe,
    false,
  );
}

function drawModelInstance(
  model,
  bufferSet,
  projection,
  view,
  modelMatrix,
  alpha,
  includeWireframe,
  ditherFade = false,
) {
  const matrix = mat4Multiply(projection, mat4Multiply(view, modelMatrix));

  gl.useProgram(solidProgram.program);
  setMatrix(solidProgram, matrix);
  bindAttribute(solidProgram, "aPosition", bufferSet.vertex, 3);
  bindAttribute(solidProgram, "aColor", bufferSet.color, 3);
  bindAttribute(solidProgram, "aTexCoord", bufferSet.texCoord, 2);
  setTextureUniforms(solidProgram, model.texture, bufferSet);
  setUniform1f(solidProgram, "uAlpha", alpha);
  setUniform1f(solidProgram, "uDitherFade", ditherFade ? 1 : 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufferSet.index);
  gl.drawElements(gl.TRIANGLES, model.indices.length, gl.UNSIGNED_SHORT, 0);

  if (includeWireframe) {
    gl.useProgram(lineProgram.program);
    setMatrix(lineProgram, matrix);
    bindAttribute(lineProgram, "aPosition", bufferSet.vertex, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufferSet.lineIndex);
    gl.drawElements(gl.LINES, model.lineIndices.length, gl.UNSIGNED_SHORT, 0);
  }
}

function modelTransitionMatrix(progress, direction, camera) {
  const away = direction === "out" ? progress : 1 - progress;
  const spin = direction === "out" ? progress : 1 - progress;
  const scale = direction === "out"
    ? 1 - progress * 0.82
    : 0.18 + progress * 0.82;
  const cameraDirection = normalize([
    Math.sin(camera.yaw) * Math.cos(camera.pitch),
    Math.sin(camera.pitch),
    Math.cos(camera.yaw) * Math.cos(camera.pitch),
  ]);
  const intoScreen = cameraDirection.map((value) => -value * away * 4.8);
  let matrix = mat4Identity();
  matrix = mat4Translate(matrix, intoScreen);
  matrix = mat4RotateX(matrix, spin * Math.PI * 4.2);
  matrix = mat4RotateY(matrix, spin * Math.PI * 5.5);
  matrix = mat4RotateZ(matrix, spin * Math.PI * 3.2);
  return mat4Scale(matrix, [scale, scale, scale]);
}

function easeInOutCubic(value) {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateAnimationPlayback(time) {
  const clip = currentModel.animations?.[state.selectedClip];
  if (!state.animate || !clip?.frames.length) {
    return;
  }

  const frameMs = 1000 / state.animationFps;
  if (!state.lastAnimFrameAt) {
    state.lastAnimFrameAt = time;
    return;
  }

  const elapsedFrames = Math.floor((time - state.lastAnimFrameAt) / frameMs);
  if (elapsedFrames > 0) {
    const nextFrame =
      ((currentModel.animationFrame || 0) + elapsedFrames) % clip.frames.length;
    setModelAnimationFrame(nextFrame);
    state.lastAnimFrameAt += elapsedFrames * frameMs;
  }
}

function createDemoModel() {
  const vertices = [];
  const colors = [];
  const texCoords = [];
  const indices = [];

  addBox(
    vertices,
    colors,
    indices,
    [0, 1.55, 0],
    [0.42, 0.42, 0.35],
    [0.74, 0.64, 0.52],
  );
  addBox(
    vertices,
    colors,
    indices,
    [0, 0.9, 0],
    [0.72, 0.8, 0.34],
    [0.16, 0.28, 0.43],
  );
  addBox(
    vertices,
    colors,
    indices,
    [-0.62, 0.94, 0],
    [0.24, 0.78, 0.24],
    [0.77, 0.65, 0.48],
  );
  addBox(
    vertices,
    colors,
    indices,
    [0.62, 0.94, 0],
    [0.24, 0.78, 0.24],
    [0.77, 0.65, 0.48],
  );
  addBox(
    vertices,
    colors,
    indices,
    [-0.25, 0.05, 0],
    [0.28, 0.95, 0.28],
    [0.21, 0.22, 0.25],
  );
  addBox(
    vertices,
    colors,
    indices,
    [0.25, 0.05, 0],
    [0.28, 0.95, 0.28],
    [0.21, 0.22, 0.25],
  );

  return {
    name: "Demo segmented PS1-style survivor",
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    texCoords: new Float32Array(
      texCoords.length
        ? texCoords
        : new Array((vertices.length / 3) * 2).fill(0),
    ),
    indices: new Uint16Array(indices),
    lineIndices: new Uint16Array(buildLineIndices(indices)),
    bounds: measureBounds(vertices),
  };
}

function parseEmdModel(bytes, name) {
  if (bytes.length < 16) {
    throw new Error("EMD file is too small.");
  }

  const modelOffset = readUint32LE(bytes, bytes.length - 8);
  const skeletonOffset = readUint32LE(bytes, bytes.length - 16);
  const animationOffset = readUint32LE(bytes, bytes.length - 12);
  const skeleton = parseEmdSkeleton(bytes, skeletonOffset, animationOffset);
  const animations = parseEmdAnimations(bytes, animationOffset, modelOffset);
  const animationAnalysis = analyzeAnimationClips(
    animations,
    skeleton,
    animationOffset,
    modelOffset,
  );
  const sectionLength = readUint32LE(bytes, modelOffset);
  const objectCount = readUint32LE(bytes, modelOffset + 8);
  const objectTable = modelOffset + 12;
  const texture = parseTimTexture(bytes, readUint32LE(bytes, bytes.length - 4));
  const cluts = collectTriangleCluts(bytes, objectTable, objectCount);
  applyModelCluts(texture, cluts);
  const rawObjects = [];

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const entry = objectTable + objectIndex * 28;
    const vertexOffset = objectTable + readUint32LE(bytes, entry);
    const vertexCount = readUint32LE(bytes, entry + 4);
    const triangleOffset = objectTable + readUint32LE(bytes, entry + 16);
    const triangleCount = readUint32LE(bytes, entry + 20);
    const objectVertices = [];

    for (let i = 0; i < vertexCount; i++) {
      const offset = vertexOffset + i * 8;
      objectVertices.push([
        readInt16LE(bytes, offset),
        readInt16LE(bytes, offset + 2),
        readInt16LE(bytes, offset + 4),
      ]);
    }

    rawObjects.push({
      objectIndex,
      objectVertices,
      triangleOffset,
      triangleCount,
    });
  }

  const built = buildEmdGeometry(bytes, rawObjects, skeleton, texture, null);

  return {
    name,
    objectCount,
    boneCount: skeleton.positions.length,
    animationCount: animations.length,
    sectionLength,
    vertices: built.vertices,
    colors: built.colors,
    texCoords: built.texCoords,
    uvBounds: built.uvBounds,
    indices: built.indices,
    lineIndices: built.lineIndices,
    bounds: built.bounds,
    texture,
    animations,
    animationAnalysis,
    emdSource: { bytes, rawObjects, skeleton, texture },
  };
}

function buildEmdGeometry(bytes, rawObjects, skeleton, texture, pose) {
  const posedObjects = rawObjects.map((object) => {
    const matrix = pose
      ? emdBoneMatrix(skeleton, pose, object.objectIndex)
      : null;
    const bonePosition = skeleton.positions[object.objectIndex] || [0, 0, 0];
    return {
      ...object,
      objectVertices: object.objectVertices.map((vertex) => {
        const transformed = matrix
          ? transformPoint(matrix, vertex)
          : [
              vertex[0] + bonePosition[0],
              vertex[1] + bonePosition[1],
              vertex[2] + bonePosition[2],
            ];
        return [
          transformed[0] / 180,
          -transformed[1] / 180,
          transformed[2] / 180,
        ];
      }),
    };
  });
  const vertices = [];
  const colors = [];
  const texCoords = [];
  const indices = [];
  const flatPositions = posedObjects.flatMap((object) =>
    object.objectVertices.flat(),
  );
  const sourceBounds = measureBounds(flatPositions);
  const largest =
    Math.max(
      sourceBounds.size[0],
      sourceBounds.size[1],
      sourceBounds.size[2],
    ) || 1;
  const scale = 2.8 / largest;

  for (const object of posedObjects) {
    const normalized = object.objectVertices.map((vertex) => [
      mirrorCoordinateX((vertex[0] - sourceBounds.center[0]) * scale),
      (vertex[1] - sourceBounds.center[1]) * scale,
      (vertex[2] - sourceBounds.center[2]) * scale,
    ]);

    for (let i = 0; i < object.triangleCount; i++) {
      const offset = object.triangleOffset + i * 28;
      const v0 = readUint16LE(bytes, offset + 18);
      const v1 = readUint16LE(bytes, offset + 22);
      const v2 = readUint16LE(bytes, offset + 26);
      if (
        v0 < normalized.length &&
        v1 < normalized.length &&
        v2 < normalized.length
      ) {
        const baseIndex = vertices.length / 3;
        vertices.push(...normalized[v0], ...normalized[v1], ...normalized[v2]);
        const page = readUint16LE(bytes, offset + 10);
        texCoords.push(
          ...textureCoord(bytes[offset + 4], bytes[offset + 5], page, texture),
          ...textureCoord(bytes[offset + 8], bytes[offset + 9], page, texture),
          ...textureCoord(
            bytes[offset + 12],
            bytes[offset + 13],
            page,
            texture,
          ),
        );
        pushTriangleIndices(indices, baseIndex);
      }
    }
  }

  const bounds = measureBounds(vertices);
  shadeFaces(vertices, colors, indices);
  return {
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    texCoords: new Float32Array(texCoords),
    uvBounds: measureUvBounds(texCoords),
    indices: new Uint16Array(indices),
    lineIndices: new Uint16Array(buildLineIndices(indices)),
    bounds,
  };
}

function emdBoneMatrix(skeleton, pose, objectIndex) {
  if (!pose || objectIndex >= skeleton.relpos.length) {
    return null;
  }

  const chain = [];
  let current = objectIndex;
  while (current >= 0) {
    chain.unshift(current);
    current = skeleton.parents[current];
  }

  let matrix = mat4Identity();
  for (const bone of chain) {
    matrix = mat4Multiply(
      matrix,
      mat4Multiply(
        mat4Translate(mat4Identity(), skeleton.relpos[bone]),
        mat4FromEulerPsx(pose.angles[bone] || [0, 0, 0]),
      ),
    );
  }

  return matrix;
}

function setModelAnimationFrame(frameInClip) {
  const clip = currentModel.animations?.[state.selectedClip];
  const source = currentModel.emdSource;
  if (!clip || !source || !clip.frames.length) {
    return;
  }

  const poseIndex = clip.frames[frameInClip % clip.frames.length];
  const pose = source.skeleton.poses[poseIndex];
  if (!pose) {
    return;
  }

  const built = buildEmdGeometry(
    source.bytes,
    source.rawObjects,
    source.skeleton,
    source.texture,
    pose,
  );
  currentModel.vertices = built.vertices;
  currentModel.colors = built.colors;
  currentModel.texCoords = built.texCoords;
  currentModel.uvBounds = built.uvBounds;
  currentModel.indices = built.indices;
  currentModel.lineIndices = built.lineIndices;
  currentModel.bounds = built.bounds;
  currentModel.animationFrame = frameInClip % clip.frames.length;
  updateBuffers(buffers, currentModel);
}

function parseEmdAnimations(bytes, offset, nextOffset) {
  if (!offset || offset >= nextOffset) {
    return [];
  }

  const firstFrameListOffset = readUint16LE(bytes, offset + 2);
  if (!firstFrameListOffset || firstFrameListOffset > nextOffset - offset) {
    return [];
  }

  const headerCount = firstFrameListOffset / 4;
  const clips = [];

  for (let i = 0; i < headerCount; i++) {
    const entry = offset + i * 4;
    const count = readUint16LE(bytes, entry);
    const frameOffset = readUint16LE(bytes, entry + 2);
    const frames = [];

    for (let frame = 0; frame < count; frame++) {
      const value = readUint32LE(bytes, offset + frameOffset + frame * 4);
      frames.push(value & 0xffff);
    }

    if (frames.length) {
      clips.push({ frames, frameOffset });
    }
  }

  return clips;
}

function analyzeAnimationClips(clips, skeleton, animationOffset, modelOffset) {
  const usedPoses = new Set();
  const invalidPoses = new Set();
  let maxFrameDataEnd = animationOffset;

  for (const [index, clip] of clips.entries()) {
    const validFrames = clip.frames.filter(
      (poseIndex) => poseIndex >= 0 && poseIndex < skeleton.poses.length,
    );
    const uniquePoses = new Set(validFrames);
    const scores = [];

    for (let frame = 1; frame < validFrames.length; frame++) {
      scores.push(
        poseMotionScore(
          skeleton.poses[validFrames[frame - 1]],
          skeleton.poses[validFrames[frame]],
        ),
      );
    }

    for (const poseIndex of clip.frames) {
      if (poseIndex >= 0 && poseIndex < skeleton.poses.length) {
        usedPoses.add(poseIndex);
      } else {
        invalidPoses.add(poseIndex);
      }
    }

    maxFrameDataEnd = Math.max(
      maxFrameDataEnd,
      animationOffset + clip.frameOffset + clip.frames.length * 4,
    );
    const avgMotion = scores.length
      ? scores.reduce((sum, score) => sum + score.avg, 0) / scores.length
      : 0;
    const maxMotion = scores.length
      ? Math.max(...scores.map((score) => score.max))
      : 0;
    const changedBones = scores.length
      ? Math.max(...scores.map((score) => score.changedBones))
      : 0;
    clip.motion = classifyClipMotion(
      clip.frames.length,
      uniquePoses.size,
      avgMotion,
      maxMotion,
      changedBones,
    );
    clip.motion.index = index;
    clip.motion.avg = avgMotion;
    clip.motion.max = maxMotion;
    clip.motion.changedBones = changedBones;
    clip.motion.uniquePoses = uniquePoses.size;
    clip.motion.validFrames = validFrames.length;
    clip.motion.invalidFrames = clip.frames.length - validFrames.length;
  }

  const used = [...usedPoses].sort((a, b) => a - b);
  return {
    clipCount: clips.length,
    poseCount: skeleton.poses.length,
    usedPoseCount: usedPoses.size,
    unusedPoseCount: Math.max(0, skeleton.poses.length - usedPoses.size),
    invalidPoseCount: invalidPoses.size,
    referencedPoseMin: used.length ? used[0] : null,
    referencedPoseMax: used.length ? used[used.length - 1] : null,
    extraBytesAfterFrames: Math.max(0, modelOffset - maxFrameDataEnd),
    movingClipCount: clips.filter(
      (clip) =>
        clip.motion?.type === "moving" || clip.motion?.type === "action",
    ).length,
    poseClipCount: clips.filter((clip) => clip.motion?.type === "pose").length,
    subtleClipCount: clips.filter((clip) => clip.motion?.type === "subtle")
      .length,
  };
}

function poseMotionScore(previousPose, nextPose) {
  if (!previousPose || !nextPose) {
    return { avg: 0, max: 0, changedBones: 0 };
  }

  let total = 0;
  let count = 0;
  let max = 0;
  let changedBones = 0;
  const boneCount = Math.min(
    previousPose.angles.length,
    nextPose.angles.length,
  );

  for (let bone = 0; bone < boneCount; bone++) {
    let boneMax = 0;
    for (let axis = 0; axis < 3; axis++) {
      const delta = psxAngleDelta(
        previousPose.angles[bone][axis],
        nextPose.angles[bone][axis],
      );
      total += delta;
      count++;
      max = Math.max(max, delta);
      boneMax = Math.max(boneMax, delta);
    }
    if (boneMax > 12) {
      changedBones++;
    }
  }

  return { avg: count ? total / count : 0, max, changedBones };
}

function psxAngleDelta(a, b) {
  const delta = Math.abs(a - b) % 4096;
  return Math.min(delta, 4096 - delta);
}

function mirrorCoordinateX(x) {
  return mirrorModelX ? -x : x;
}

function pushTriangleIndices(indices, baseIndex) {
  if (mirrorModelX) {
    indices.push(baseIndex, baseIndex + 2, baseIndex + 1);
  } else {
    indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
  }
}

function classifyClipMotion(
  frameCount,
  uniquePoseCount,
  avgMotion,
  maxMotion,
  changedBones,
) {
  if (frameCount <= 1 || uniquePoseCount <= 1 || maxMotion < 8) {
    return { type: "pose", label: "pose" };
  }
  if (avgMotion < 8 && maxMotion < 45 && changedBones <= 3) {
    return { type: "subtle", label: "subtle" };
  }
  if (avgMotion > 28 || maxMotion > 220 || changedBones > 8) {
    return { type: "action", label: "action" };
  }
  return { type: "moving", label: "moving" };
}

function parseIvmModel(bytes, name) {
  const tmdOffset = findTmdOffset(bytes);
  if (tmdOffset < 0) {
    throw new Error("No TMD model found inside IVM.");
  }

  const texture = parseTimTexture(bytes, 0);
  const objectCount = readUint32LE(bytes, tmdOffset + 8);
  const table = tmdOffset + 12;
  const vertices = [];
  const colors = [];
  const texCoords = [];
  const indices = [];
  const rawObjects = [];

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const entry = table + objectIndex * 28;
    const vertexOffset = table + readUint32LE(bytes, entry);
    const vertexCount = readUint32LE(bytes, entry + 4);
    const primitiveOffset = table + readUint32LE(bytes, entry + 16);
    const primitiveCount = readUint32LE(bytes, entry + 20);
    const objectVertices = [];

    for (let i = 0; i < vertexCount; i++) {
      const offset = vertexOffset + i * 8;
      objectVertices.push([
        readInt16LE(bytes, offset) / 180,
        -readInt16LE(bytes, offset + 2) / 180,
        readInt16LE(bytes, offset + 4) / 180,
      ]);
    }

    rawObjects.push({ objectVertices, primitiveOffset, primitiveCount });
  }

  applyIvmClut(texture, collectTmdCluts(bytes, rawObjects)[0]);

  const flatPositions = rawObjects.flatMap((object) =>
    object.objectVertices.flat(),
  );
  const sourceBounds = measureBounds(flatPositions);
  const largest =
    Math.max(
      sourceBounds.size[0],
      sourceBounds.size[1],
      sourceBounds.size[2],
    ) || 1;
  const scale = 2.2 / largest;

  for (const object of rawObjects) {
    const normalized = object.objectVertices.map((vertex) => [
      mirrorCoordinateX((vertex[0] - sourceBounds.center[0]) * scale),
      (vertex[1] - sourceBounds.center[1]) * scale,
      (vertex[2] - sourceBounds.center[2]) * scale,
    ]);
    let offset = object.primitiveOffset;

    for (let i = 0; i < object.primitiveCount; i++) {
      const ilen = bytes[offset + 1];
      const mode = bytes[offset + 3];
      const isTexturedTriangle = (mode & 0x24) === 0x24 && (mode & 0x08) === 0;

      if (isTexturedTriangle && ilen >= 6) {
        const body = offset + 4;
        const v0 = readUint16LE(bytes, body + 14);
        const v1 = readUint16LE(bytes, body + 18);
        const v2 = readUint16LE(bytes, body + 22);
        if (
          v0 < normalized.length &&
          v1 < normalized.length &&
          v2 < normalized.length
        ) {
          const baseIndex = vertices.length / 3;
          const page = readUint16LE(bytes, body + 6);
          vertices.push(
            ...normalized[v0],
            ...normalized[v1],
            ...normalized[v2],
          );
          texCoords.push(
            ...localTextureCoord(bytes[body], bytes[body + 1], texture),
            ...localTextureCoord(bytes[body + 4], bytes[body + 5], texture),
            ...localTextureCoord(bytes[body + 8], bytes[body + 9], texture),
          );
          pushTriangleIndices(indices, baseIndex);
        }
      }

      offset += 4 + ilen * 4;
    }
  }

  const bounds = measureBounds(vertices);
  shadeFaces(vertices, colors, indices);
  for (let i = 0; i < colors.length; i++) {
    colors[i] = 1;
  }

  return {
    name,
    objectCount,
    itemModel: true,
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
    texCoords: new Float32Array(texCoords),
    uvBounds: measureUvBounds(texCoords),
    indices: new Uint16Array(indices),
    lineIndices: new Uint16Array(buildLineIndices(indices)),
    bounds,
    texture,
  };
}

function findTmdOffset(bytes) {
  for (let offset = 0; offset < bytes.length - 12; offset += 4) {
    if (
      readUint32LE(bytes, offset) === 0x41 &&
      readUint32LE(bytes, offset + 8) > 0 &&
      readUint32LE(bytes, offset + 8) < 64
    ) {
      return offset;
    }
  }
  return -1;
}

function collectTmdCluts(bytes, objects) {
  const cluts = new Set();

  for (const object of objects) {
    let offset = object.primitiveOffset;
    for (let i = 0; i < object.primitiveCount; i++) {
      const ilen = bytes[offset + 1];
      const mode = bytes[offset + 3];
      if ((mode & 0x04) !== 0) {
        cluts.add(readUint16LE(bytes, offset + 6));
      }
      offset += 4 + ilen * 4;
    }
  }

  return [...cluts].sort((a, b) => a - b);
}

function parseEmdSkeleton(bytes, offset, nextOffset) {
  const boneOffset = readUint16LE(bytes, offset);
  const animOffset = readUint16LE(bytes, offset + 2);
  const count = readUint16LE(bytes, offset + 4);
  const animSize = readUint16LE(bytes, offset + 6);
  const relpos = [];
  const children = Array.from({ length: count }, () => []);
  const parents = new Array(count).fill(-1);

  for (let i = 0; i < count; i++) {
    const entry = offset + 8 + i * 6;
    relpos.push([
      readInt16LE(bytes, entry),
      readInt16LE(bytes, entry + 2),
      readInt16LE(bytes, entry + 4),
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
        parents[childIndex] = i;
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
      parentPosition[2] + relpos[index][2],
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

  const poseOffset = offset + animOffset;
  const poseCount = animSize
    ? Math.max(0, Math.floor((nextOffset - poseOffset) / animSize))
    : 0;
  const poses = [];

  for (let pose = 0; pose < poseCount; pose++) {
    const entry = poseOffset + pose * animSize;
    const angles = [];
    const angleOffset = entry + 12;
    for (let bone = 0; bone < count; bone++) {
      angles.push([
        readInt16LE(bytes, angleOffset + bone * 6),
        readInt16LE(bytes, angleOffset + bone * 6 + 2),
        readInt16LE(bytes, angleOffset + bone * 6 + 4),
      ]);
    }
    poses.push({
      offset: [
        readInt16LE(bytes, entry),
        readInt16LE(bytes, entry + 2),
        readInt16LE(bytes, entry + 4),
      ],
      speed: [
        readInt16LE(bytes, entry + 6),
        readInt16LE(bytes, entry + 8),
        readInt16LE(bytes, entry + 10),
      ],
      angles,
    });
  }

  return { positions, relpos, children, parents, poses };
}

function parseTimTexture(bytes, offset) {
  if (
    offset < 0 ||
    offset + 20 > bytes.length ||
    readUint32LE(bytes, offset) !== 0x10
  ) {
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
  const width =
    bpp === 0 ? wordWidth * 4 : bpp === 1 ? wordWidth * 2 : wordWidth;
  const rgba = new Uint8Array(width * height * 4);

  if (bpp === 0) {
    indexedPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let word = 0; word < wordWidth; word++) {
        const value = readUint16LE(
          bytes,
          dataOffset + (y * wordWidth + word) * 2,
        );
        for (let nibble = 0; nibble < 4; nibble++) {
          const index = (value >> (nibble * 4)) & 0xf;
          indexedPixels[y * width + word * 4 + nibble] = index;
          writeRgba(
            rgba,
            (y * width + word * 4 + nibble) * 4,
            palette[index] || [0, 0, 0, 255],
          );
        }
      }
    }
  } else if (bpp === 1) {
    indexedPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let word = 0; word < wordWidth; word++) {
        const value = readUint16LE(
          bytes,
          dataOffset + (y * wordWidth + word) * 2,
        );
        const left = value & 0xff;
        const right = (value >> 8) & 0xff;
        indexedPixels[y * width + word * 2] = left;
        indexedPixels[y * width + word * 2 + 1] = right;
        writeRgba(
          rgba,
          (y * width + word * 2) * 4,
          palette[left] || [0, 0, 0, 255],
        );
        writeRgba(
          rgba,
          (y * width + word * 2 + 1) * 4,
          palette[right] || [0, 0, 0, 255],
        );
      }
    }
  } else if (bpp === 2) {
    for (let i = 0; i < width * height; i++) {
      writeRgba(
        rgba,
        i * 4,
        decodePsxColor(readUint16LE(bytes, dataOffset + i * 2)),
      );
    }
  } else {
    return createFallbackTexture();
  }

  return {
    width,
    height,
    rgba,
    bpp,
    hasClut,
    imageLength,
    imageX,
    imageY,
    clutX,
    clutY,
    clutWidth,
    clutHeight,
    palette,
    indexedPixels,
  };
}

function timModeLabel(texture) {
  const modes = [
    "4-bit indexed TIM",
    "8-bit indexed TIM",
    "16-bit direct TIM",
    "24-bit direct TIM",
  ];
  const clut = texture.hasClut ? ", CLUT" : "";
  return `${modes[texture.bpp] || `TIM mode ${texture.bpp}`}${clut}`;
}

function textureToDataUrl(texture) {
  const source = texture || createFallbackTexture();
  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = source.width;
  imageCanvas.height = source.height;
  const context = imageCanvas.getContext("2d");
  const imageData = context.createImageData(source.width, source.height);
  imageData.data.set(source.rgba);
  context.putImageData(imageData, 0, 0);
  return imageCanvas.toDataURL("image/png");
}

function decodeBssPreview(bytes) {
  const decodedFrames = decodeBssMdecFrames(bytes);
  if (decodedFrames.length) {
    return createBssFrameSheet(decodedFrames);
  }

  return {
    url: placeholderImageDataUrl([
      "BSS room container",
      "Packed background data",
      "Decoder needed",
    ]),
    width: 640,
    height: 360,
    detail: `packed room background container, ${formatBytes(bytes.length)}, no decodable STRv3 frames found yet`,
  };
}

const MDEC_WIDTH = 320;
const MDEC_HEIGHT = 240;
const MDEC_MACROBLOCK_WIDTH = MDEC_WIDTH / 16;
const MDEC_MACROBLOCK_HEIGHT = MDEC_HEIGHT / 16;
const MDEC_QUANT = [
  2, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27,
  29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40,
  48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29,
  35, 38, 46, 56, 69, 83,
];
const MDEC_REVERSE_ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];
const MDEC_AC_TABLE =
  "11 0 1|011 1 1|0100 0 2|0101 2 1|00101 0 3|00110 4 1|00111 3 1|000100 7 1|000101 6 1|000110 1 2|000111 5 1|0000100 2 2|0000101 9 1|0000110 0 4|0000111 8 1|00100000 13 1|00100001 0 6|00100010 12 1|00100011 11 1|00100100 3 2|00100101 1 3|00100110 0 5|00100111 10 1|0000001000 16 1|0000001001 5 2|0000001010 0 7|0000001011 2 3|0000001100 1 4|0000001101 15 1|0000001110 14 1|0000001111 4 2|000000010000 0 11|000000010001 8 2|000000010010 4 3|000000010011 0 10|000000010100 2 4|000000010101 7 2|000000010110 21 1|000000010111 20 1|000000011000 0 9|000000011001 19 1|000000011010 18 1|000000011011 1 5|000000011100 3 3|000000011101 0 8|000000011110 6 2|000000011111 17 1|0000000010000 10 2|0000000010001 9 2|0000000010010 5 3|0000000010011 3 4|0000000010100 2 5|0000000010101 1 7|0000000010110 1 6|0000000010111 0 15|0000000011000 0 14|0000000011001 0 13|0000000011010 0 12|0000000011011 26 1|0000000011100 25 1|0000000011101 24 1|0000000011110 23 1|0000000011111 22 1|00000000010000 0 31|00000000010001 0 30|00000000010010 0 29|00000000010011 0 28|00000000010100 0 27|00000000010101 0 26|00000000010110 0 25|00000000010111 0 24|00000000011000 0 23|00000000011001 0 22|00000000011010 0 21|00000000011011 0 20|00000000011100 0 19|00000000011101 0 18|00000000011110 0 17|00000000011111 0 16|000000000010000 0 40|000000000010001 0 39|000000000010010 0 38|000000000010011 0 37|000000000010100 0 36|000000000010101 0 35|000000000010110 0 34|000000000010111 0 33|000000000011000 0 32|000000000011001 1 14|000000000011010 1 13|000000000011011 1 12|000000000011100 1 11|000000000011101 1 10|000000000011110 1 9|000000000011111 1 8|0000000000010000 1 18|0000000000010001 1 17|0000000000010010 1 16|0000000000010011 1 15|0000000000010100 6 3|0000000000010101 16 2|0000000000010110 15 2|0000000000010111 14 2|0000000000011000 13 2|0000000000011001 12 2|0000000000011010 11 2|0000000000011011 31 1|0000000000011100 30 1|0000000000011101 29 1|0000000000011110 28 1|0000000000011111 27 1"
    .split("|")
    .map((entry) => {
      const [bits, run, level] = entry.split(" ");
      return {
        bits,
        code: parseInt(bits, 2),
        run: Number(run),
        level: Number(level),
        length: bits.length + 1,
      };
    });
const MDEC_IDCT_COS = Array.from({ length: 64 }, (_, index) => {
  const x = index & 7;
  const u = index >> 3;
  return (
    Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1)
  );
});

function decodeBssMdecFrames(bytes) {
  const frames = [];
  const chunkSize = 32768;
  const chunks = Math.floor(bytes.length / chunkSize);

  for (let chunk = 0; chunk < chunks; chunk++) {
    const offset = chunk * chunkSize;
    const magic = readUint16LE(bytes, offset + 2);
    const qscale = readUint16LE(bytes, offset + 4);
    const version = readUint16LE(bytes, offset + 6);
    if (magic !== 0x3800 || qscale < 1 || qscale > 63 || version !== 3) {
      continue;
    }

    try {
      frames.push(
        decodeStrV3Frame(
          bytes,
          offset,
          Math.min(offset + chunkSize, bytes.length),
          chunk,
          qscale,
        ),
      );
    } catch {
      // Keep scanning later chunks; some room containers may include padding or unknown payloads.
    }
  }

  return frames;
}

function decodeStrV3Frame(bytes, chunkOffset, chunkEnd, frameIndex, qscale) {
  const reader = new MdecBitReader(bytes, chunkOffset + 8, chunkEnd);
  const luma = new Int16Array(MDEC_WIDTH * MDEC_HEIGHT);
  const chromaWidth = MDEC_WIDTH / 2;
  const chromaHeight = MDEC_HEIGHT / 2;
  const cb = new Int16Array(chromaWidth * chromaHeight);
  const cr = new Int16Array(chromaWidth * chromaHeight);
  const block = new Int16Array(64);
  let previousCr = 0;
  let previousCb = 0;
  let previousY = 0;

  for (
    let macro = 0;
    macro < MDEC_MACROBLOCK_WIDTH * MDEC_MACROBLOCK_HEIGHT;
    macro++
  ) {
    const macroX = Math.floor(macro / MDEC_MACROBLOCK_HEIGHT);
    const macroY = macro % MDEC_MACROBLOCK_HEIGHT;

    for (let subBlock = 0; subBlock < 6; subBlock++) {
      block.fill(0);
      if (subBlock === 0) {
        previousCr = readStrV3Dc(reader, previousCr, true);
        block[0] = previousCr * MDEC_QUANT[0];
      } else if (subBlock === 1) {
        previousCb = readStrV3Dc(reader, previousCb, true);
        block[0] = previousCb * MDEC_QUANT[0];
      } else {
        previousY = readStrV3Dc(reader, previousY, false);
        block[0] = previousY * MDEC_QUANT[0];
      }

      let vectorPos = 0;
      while (true) {
        const code = readMdecAcCode(reader);
        if (code.eob) break;
        vectorPos += code.run + 1;
        if (vectorPos >= 64) throw new Error("MDEC run length out of bounds");
        const matrixPos = MDEC_REVERSE_ZIGZAG[vectorPos];
        block[matrixPos] = Math.round(
          (code.ac * MDEC_QUANT[matrixPos] * qscale) / 8,
        );
      }

      const pixels = inverseDct8(block);
      if (subBlock === 0) {
        writeBlock8(cr, chromaWidth, macroX * 8, macroY * 8, pixels);
      } else if (subBlock === 1) {
        writeBlock8(cb, chromaWidth, macroX * 8, macroY * 8, pixels);
      } else {
        const local = subBlock - 2;
        const x = macroX * 16 + (local % 2) * 8;
        const y = macroY * 16 + Math.floor(local / 2) * 8;
        writeBlock8(luma, MDEC_WIDTH, x, y, pixels);
      }
    }
  }

  const rgba = new Uint8Array(MDEC_WIDTH * MDEC_HEIGHT * 4);
  for (let y = 0; y < MDEC_HEIGHT; y++) {
    for (let x = 0; x < MDEC_WIDTH; x++) {
      const yValue = luma[y * MDEC_WIDTH + x] + 128;
      const cIndex = Math.floor(y / 2) * chromaWidth + Math.floor(x / 2);
      const cbValue = cb[cIndex];
      const crValue = cr[cIndex];
      const out = (y * MDEC_WIDTH + x) * 4;
      rgba[out] = clampByte(yValue + Math.round(1.402 * crValue));
      rgba[out + 1] = clampByte(
        yValue - Math.round(0.3437 * cbValue) - Math.round(0.7143 * crValue),
      );
      rgba[out + 2] = clampByte(yValue + Math.round(1.772 * cbValue));
      rgba[out + 3] = 255;
    }
  }

  return { index: frameIndex, width: MDEC_WIDTH, height: MDEC_HEIGHT, rgba };
}

class MdecBitReader {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.start = start;
    this.end = end & ~1;
    this.offset = 0;
    this.bitsLeft = 0;
    this.current = 0;
  }

  readShort(byteIndex) {
    const first = this.start + (byteIndex ^ 1);
    const second = this.start + ((byteIndex + 1) ^ 1);
    if (first >= this.end || second >= this.end) {
      throw new Error("End of MDEC bitstream");
    }
    return (this.bytes[first] << 8) | this.bytes[second];
  }

  readUnsignedBits(count) {
    if (count === 0) return 0;
    if (this.bitsLeft === 0) {
      this.current = this.readShort(this.offset);
      this.offset += 2;
      this.bitsLeft = 16;
    }

    if (count <= this.bitsLeft) {
      const value =
        (this.current >>> (this.bitsLeft - count)) & ((1 << count) - 1);
      this.bitsLeft -= count;
      return value;
    }

    let value = this.current & ((1 << this.bitsLeft) - 1);
    count -= this.bitsLeft;
    this.bitsLeft = 0;
    while (count >= 16) {
      value = (value << 16) | this.readShort(this.offset);
      this.offset += 2;
      count -= 16;
    }
    if (count > 0) {
      this.current = this.readShort(this.offset);
      this.offset += 2;
      this.bitsLeft = 16 - count;
      value = (value << count) | ((this.current & 0xffff) >>> this.bitsLeft);
    }
    return value;
  }

  peekUnsignedBits(count) {
    const offset = this.offset;
    const bitsLeft = this.bitsLeft;
    const current = this.current;
    try {
      return this.readUnsignedBits(count);
    } finally {
      this.offset = offset;
      this.bitsLeft = bitsLeft;
      this.current = current;
    }
  }

  skipBits(count) {
    this.readUnsignedBits(count);
  }
}

function readStrV3Dc(reader, previous, chroma) {
  const table = chroma
    ? [
        ["00", 0, 0],
        ["01", 1, 1],
        ["10", 2, 2, 3],
        ["110", 3, 4, 7],
        ["1110", 4, 8, 15],
        ["11110", 5, 16, 31],
        ["111110", 6, 32, 63],
        ["1111110", 7, 64, 127],
        ["11111110", 8, 128, 255],
      ]
    : [
        ["00", 1, 1],
        ["01", 2, 2, 3],
        ["100", 0, 0],
        ["101", 3, 4, 7],
        ["110", 4, 8, 15],
        ["1110", 5, 16, 31],
        ["11110", 6, 32, 63],
        ["111110", 7, 64, 127],
        ["1111110", 8, 128, 255],
      ];

  for (const [
    bits,
    valueBits,
    positiveMin,
    positiveMax = positiveMin,
  ] of table) {
    if (reader.peekUnsignedBits(bits.length) !== parseInt(bits, 2)) continue;
    reader.skipBits(bits.length);
    if (valueBits === 0) return previous;
    const value = reader.readUnsignedBits(valueBits);
    const topBit = 1 << (valueBits - 1);
    const delta = (value & topBit) === 0 ? value - positiveMax : value;
    return previous + delta * 4;
  }

  throw new Error("Unknown STRv3 DC code");
}

function readMdecAcCode(reader) {
  const prefix = reader.peekUnsignedBits(17);
  if (prefix >>> 15 === 0b10) {
    reader.skipBits(2);
    return { eob: true };
  }
  if (prefix >>> 11 === 0b000001) {
    reader.skipBits(6);
    const packed = reader.readUnsignedBits(16);
    return { run: packed >>> 10, ac: signExtend(packed & 0x03ff, 10) };
  }

  for (const entry of MDEC_AC_TABLE) {
    const value = prefix >>> (17 - entry.length);
    if (value >> 1 !== entry.code) continue;
    reader.skipBits(entry.length);
    return { run: entry.run, ac: value & 1 ? -entry.level : entry.level };
  }

  throw new Error("Unknown MDEC AC code");
}

function inverseDct8(coefficients) {
  const output = new Int16Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let total = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          total +=
            coefficients[v * 8 + u] *
            MDEC_IDCT_COS[u * 8 + x] *
            MDEC_IDCT_COS[v * 8 + y];
        }
      }
      output[y * 8 + x] = clamp(Math.round(total / 4), -512, 511);
    }
  }
  return output;
}

function writeBlock8(target, stride, x, y, block) {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      target[(y + row) * stride + x + col] = block[row * 8 + col];
    }
  }
}

function createBssFrameSheet(frames) {
  const columns = Math.min(2, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const width = columns * MDEC_WIDTH;
  const height = rows * MDEC_HEIGHT;
  const rgba = new Uint8Array(width * height * 4);

  for (const frame of frames) {
    const column = frame.index % columns;
    const row = Math.floor(frame.index / columns);
    const targetX = column * MDEC_WIDTH;
    const targetY = row * MDEC_HEIGHT;
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const source = (y * frame.width + x) * 4;
        const target = ((targetY + y) * width + targetX + x) * 4;
        rgba[target] = frame.rgba[source];
        rgba[target + 1] = frame.rgba[source + 1];
        rgba[target + 2] = frame.rgba[source + 2];
        rgba[target + 3] = 255;
      }
    }
  }

  const sheetUrl = textureToDataUrl({ width, height, rgba });
  const frameScreens = frames.map((frame, index) => ({
    label: `Screen ${index + 1}`,
    title: `Camera screen ${index + 1}`,
    url: textureToDataUrl(frame),
    width: frame.width,
    height: frame.height,
    detail: `decoded STRv3/MDEC background screen ${index + 1} at 320 x 240`,
  }));
  const tileMap = frames.map((frame, index) => ({
    screenIndex: index + 1,
    x: (index % columns) * MDEC_WIDTH,
    y: Math.floor(index / columns) * MDEC_HEIGHT,
    width: frame.width,
    height: frame.height,
  }));

  return {
    url: sheetUrl,
    thumbnail: frameScreens[0]?.url || sheetUrl,
    width,
    height,
    detail: `decoded ${frames.length} STRv3/MDEC background screen${frames.length === 1 ? "" : "s"} at 320 x 240`,
    screens: [
      {
        label: "All",
        title: "All camera screens in this room",
        url: sheetUrl,
        width,
        height,
        tileMap,
        detail: `contact sheet of ${frames.length} room screens`,
      },
      ...frameScreens,
    ],
  };
}

function signExtend(value, bits) {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function placeholderImageDataUrl(lines) {
  const width = 640;
  const height = 360;
  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = width;
  imageCanvas.height = height;
  const context = imageCanvas.getContext("2d");
  context.fillStyle = "#101419";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#3a434d";
  context.strokeRect(28, 28, width - 56, height - 56);
  context.fillStyle = "#d8b35a";
  context.font = "700 30px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(lines[0] || "Image container", width / 2, 142);
  context.fillStyle = "#aeb6bd";
  context.font = "18px system-ui, sans-serif";
  context.fillText(lines[1] || "Decoder needed", width / 2, 188);
  context.fillText(lines[2] || "", width / 2, 220);
  return imageCanvas.toDataURL("image/png");
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
        writeRgba(
          texture.rgba,
          pixel * 4,
          texture.palette[paletteOffset + index] || [0, 0, 0, 255],
        );
      }
    }
  }
}

function applyIvmClut(texture, clut) {
  if (
    !texture ||
    texture.fallback ||
    !texture.indexedPixels ||
    clut === undefined
  ) {
    return;
  }

  const paletteRow = Math.max(0, (clut >> 6) - texture.clutY);
  const paletteOffset = paletteRow * texture.clutWidth;

  for (let pixel = 0; pixel < texture.indexedPixels.length; pixel++) {
    const index = texture.indexedPixels[pixel];
    writeRgba(
      texture.rgba,
      pixel * 4,
      texture.palette[paletteOffset + index] || [0, 0, 0, 255],
    );
  }
}

function createFallbackTexture() {
  return {
    width: 2,
    height: 2,
    rgba: new Uint8Array([
      210, 210, 210, 255, 120, 120, 120, 255, 120, 120, 120, 255, 210, 210, 210,
      255,
    ]),
    fallback: true,
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
    clamp((pageY + v + 0.5) / texture.height, 0, 1),
  ];
}

function localTextureCoord(u, v, texture) {
  if (!texture || texture.fallback) {
    return [0, 0];
  }

  return [
    clamp((u + 0.5) / texture.width, 0, 1),
    clamp((v + 0.5) / texture.height, 0, 1),
  ];
}

function decodePsxColor(value) {
  const r = ((value & 0x1f) * 255) / 31;
  const g = (((value >> 5) & 0x1f) * 255) / 31;
  const b = (((value >> 10) & 0x1f) * 255) / 31;
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
    (min[2] + max[2]) / 2,
  ];

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let radius = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    radius = Math.max(
      radius,
      Math.hypot(
        vertices[i] - center[0],
        vertices[i + 1] - center[1],
        vertices[i + 2] - center[2],
      ),
    );
  }

  return { min, max, center, size, radius };
}

function measureUvBounds(texCoords) {
  if (!texCoords.length) {
    return null;
  }

  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];

  for (let i = 0; i < texCoords.length; i += 2) {
    min[0] = Math.min(min[0], texCoords[i]);
    min[1] = Math.min(min[1], texCoords[i + 1]);
    max[0] = Math.max(max[0], texCoords[i]);
    max[1] = Math.max(max[1], texCoords[i + 1]);
  }

  return { min, max };
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
    const normal = normalize(
      cross(
        [
          vertices[b] - vertices[a],
          vertices[b + 1] - vertices[a + 1],
          vertices[b + 2] - vertices[a + 2],
        ],
        [
          vertices[c] - vertices[a],
          vertices[c + 1] - vertices[a + 1],
          vertices[c + 2] - vertices[a + 2],
        ],
      ),
    );
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
  resetView(model);
}

function snapshotCamera() {
  return {
    yaw: state.yaw,
    pitch: state.pitch,
    distance: state.distance,
    target: [...state.target],
  };
}

function viewFromCameraSnapshot(camera) {
  return mat4LookAt(
    [
      camera.target[0] +
        Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
      camera.target[1] + Math.sin(camera.pitch) * camera.distance,
      camera.target[2] +
        Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
    ],
    camera.target,
    [0, 1, 0],
  );
}

function resetView(model = currentModel) {
  state.target = [0, 0, 0];
  setCameraView("front", model);
}

function setCameraView(view, model = currentModel) {
  const views = {
    front: { yaw: -Math.PI / 2, pitch: 0.18 },
    back: { yaw: Math.PI / 2, pitch: 0.12 },
    left: { yaw: Math.PI, pitch: 0.12 },
    right: { yaw: 0, pitch: 0.12 },
    top: { yaw: -Math.PI / 2, pitch: 1.48 },
    bottom: { yaw: -Math.PI / 2, pitch: -1.48 },
  };
  if (views[view] === undefined) return;
  state.yaw = views[view].yaw;
  state.pitch = views[view].pitch;
  state.distance = state.baseDistance;
}

function panModelView(deltaX, deltaY) {
  const forward = normalize([
    -Math.sin(state.yaw) * Math.cos(state.pitch),
    -Math.sin(state.pitch),
    -Math.cos(state.yaw) * Math.cos(state.pitch),
  ]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const scale = Math.max(0.0025, state.distance * 0.0018);
  const targetLimit = Math.max(1.5, state.modelRadius * 1.25);

  state.target[0] += right[0] * -deltaX * scale + up[0] * deltaY * scale;
  state.target[1] += right[1] * -deltaX * scale + up[1] * deltaY * scale;
  state.target[2] += right[2] * -deltaX * scale + up[2] * deltaY * scale;

  state.target[0] = clamp(state.target[0], -targetLimit, targetLimit);
  state.target[1] = clamp(state.target[1], -targetLimit, targetLimit);
  state.target[2] = clamp(state.target[2], -targetLimit, targetLimit);
}

function addBox(vertices, colors, indices, center, size, color) {
  const start = vertices.length / 3;
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size.map((value) => value / 2);
  const points = [
    [cx - sx, cy - sy, cz - sz],
    [cx + sx, cy - sy, cz - sz],
    [cx + sx, cy + sy, cz - sz],
    [cx - sx, cy + sy, cz - sz],
    [cx - sx, cy - sy, cz + sz],
    [cx + sx, cy - sy, cz + sz],
    [cx + sx, cy + sy, cz + sz],
    [cx - sx, cy + sy, cz + sz],
  ];
  const faces = [
    0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3,
    2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
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
    texture: createGlTexture(model.texture),
  };
}

function createBuffer(type, data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(type, buffer);
  gl.bufferData(type, data, gl.STATIC_DRAW);
  return buffer;
}

function updateBuffers(bufferSet, model) {
  updateBuffer(gl.ARRAY_BUFFER, bufferSet.vertex, model.vertices);
  updateBuffer(gl.ARRAY_BUFFER, bufferSet.color, model.colors);
  updateBuffer(gl.ARRAY_BUFFER, bufferSet.texCoord, model.texCoords);
  updateBuffer(gl.ELEMENT_ARRAY_BUFFER, bufferSet.index, model.indices);
  updateBuffer(gl.ELEMENT_ARRAY_BUFFER, bufferSet.lineIndex, model.lineIndices);
}

function updateBuffer(type, buffer, data) {
  gl.bindBuffer(type, buffer);
  gl.bufferData(type, data, gl.DYNAMIC_DRAW);
}

function disposeBuffers(bufferSet) {
  if (!bufferSet) return;
  gl.deleteBuffer(bufferSet.vertex);
  gl.deleteBuffer(bufferSet.color);
  gl.deleteBuffer(bufferSet.texCoord);
  gl.deleteBuffer(bufferSet.index);
  gl.deleteBuffer(bufferSet.lineIndex);
  gl.deleteTexture(bufferSet.texture);
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
    source.rgba,
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

function setTextureUniforms(programInfo, texture, bufferSet = buffers) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, bufferSet.texture);
  setUniform1i(programInfo, "uTexture", 0);
  setUniform1f(
    programInfo,
    "uUseTexture",
    state.texture && texture && !texture.fallback ? 1 : 0,
  );
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
  const uvSummary = model.uvBounds
    ? `${model.uvBounds.min[0].toFixed(2)},${model.uvBounds.min[1].toFixed(2)} - ${model.uvBounds.max[0].toFixed(2)},${model.uvBounds.max[1].toFixed(2)}`
    : "";
  modelStats.innerHTML = `
    ${statRow("Name", model.name, "Loaded asset name or disc path.")}
    ${statRow("Vertices", vertexCount, "Number of GPU vertices after PS1 polygons are expanded for drawing.")}
    ${statRow("Triangles", triangleCount, "Number of visible triangle faces currently sent to WebGL.")}
    ${model.boneCount ? statRow("Bones", model.boneCount, "Skeleton/object slots used to place EMD character or enemy body parts.") : ""}
    ${model.animationCount ? statRow("Clips", model.animationCount, "Detected animation clip entries. This may not be every in-game animation.") : ""}
    ${model.itemModel ? statRow("Type", "Item", "IVM item or examine model, usually without skeleton animation.") : ""}
    ${model.texture && !model.texture.fallback ? statRow("Texture", `${model.texture.width} x ${model.texture.height}`, "Decoded TIM texture size used by this model.") : ""}
    ${uvSummary ? statRow("UV", uvSummary, "Observed texture coordinate range after conversion. Useful when debugging mapping issues.") : ""}
    ${statRow("Renderer", "WebGL 1", "Browser graphics backend used by this prototype.")}
  `;
  renderAnimationInspector(model);
}

function statRow(label, value, tooltip) {
  return `<dt title="${escapeHtml(tooltip)}">${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
}

function renderAnimationInspector(model) {
  const analysis = model.animationAnalysis;
  const clips = model.animations || [];

  if (!analysis || !clips.length) {
    animationInspector.textContent = model.itemModel
      ? "Items do not use EMD skeleton animation clips."
      : "No detected EMD animation clips for this model.";
    return;
  }

  const poseRange =
    analysis.referencedPoseMin === null
      ? "none"
      : `${analysis.referencedPoseMin}-${analysis.referencedPoseMax}`;
  const visibleClips = clips.map((clip, index) => ({ clip, index }));
  const clipRows =
    visibleClips
      .map(({ clip, index }) => {
        const motion = clip.motion || {};
        const score =
          motion.max === undefined
            ? ""
            : `max ${motion.max.toFixed(0)}, avg ${motion.avg.toFixed(1)}`;
        return `
      <li>
        <span class="clip-name">Clip ${index}</span>
        <span class="clip-tag clip-${escapeHtml(motion.type || "unknown")}">${escapeHtml(motion.label || "unknown")}</span>
        <small>${clip.frames.length} frames, ${motion.uniquePoses || 0} poses${score ? `, ${score}` : ""}</small>
      </li>
    `;
      })
      .join("") ||
    `<li><span class="clip-name">No clips</span><small>No animation records were detected.</small></li>`;

  animationInspector.innerHTML = `
    <dl class="animation-summary">
      ${statRow("Detected clips", analysis.clipCount, "Animation entries found in the EMD table we currently understand.")}
      ${statRow("Pose records", analysis.poseCount, "Raw skeleton poses stored near the animation data.")}
      ${statRow("Referenced poses", `${analysis.usedPoseCount} (${poseRange})`, "Pose records actually used by detected clips.")}
      ${statRow("Unused poses", analysis.unusedPoseCount, "Pose records not referenced by detected clips. These may hint at data we do not parse yet.")}
      ${statRow("Movement estimate", `${analysis.movingClipCount} moving/action, ${analysis.subtleClipCount} subtle, ${analysis.poseClipCount} pose`, "Rough classification based on how much bone angles change between frames.")}
      ${statRow("Unmapped bytes", formatBytes(analysis.extraBytesAfterFrames), "Bytes between detected frame lists and the model section. A clue, not automatically a bug.")}
    </dl>
    <p class="inspector-note">These are detected clips, not guaranteed to be every in-game animation.</p>
    <ul class="clip-list">${clipRows}</ul>
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
  const width = Math.max(
    1,
    Math.floor(canvas.clientWidth * window.devicePixelRatio),
  );
  const height = Math.max(
    1,
    Math.floor(canvas.clientHeight * window.devicePixelRatio),
  );
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
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

function mat4LookAt(eye, center, up) {
  const z = normalize(subtract(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);

  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}

function mat4RotateY(matrix, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rotation = new Float32Array([
    c,
    0,
    -s,
    0,
    0,
    1,
    0,
    0,
    s,
    0,
    c,
    0,
    0,
    0,
    0,
    1,
  ]);
  return mat4Multiply(matrix, rotation);
}

function mat4RotateX(matrix, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rotation = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    c,
    s,
    0,
    0,
    -s,
    c,
    0,
    0,
    0,
    0,
    1,
  ]);
  return mat4Multiply(matrix, rotation);
}

function mat4RotateZ(matrix, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rotation = new Float32Array([
    c,
    s,
    0,
    0,
    -s,
    c,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
  return mat4Multiply(matrix, rotation);
}

function mat4Translate(matrix, value) {
  const translation = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    value[0],
    value[1],
    value[2],
    1,
  ]);
  return mat4Multiply(matrix, translation);
}

function mat4Scale(matrix, value) {
  const scale = new Float32Array([
    value[0],
    0,
    0,
    0,
    0,
    value[1],
    0,
    0,
    0,
    0,
    value[2],
    0,
    0,
    0,
    0,
    1,
  ]);
  return mat4Multiply(matrix, scale);
}

function mat4FromEulerPsx(angles) {
  const [x, y, z] = angles.map((angle) => (angle * Math.PI * 2) / 4096);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const rx = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    cx,
    sx,
    0,
    0,
    -sx,
    cx,
    0,
    0,
    0,
    0,
    1,
  ]);
  const ry = new Float32Array([
    cy,
    0,
    -sy,
    0,
    0,
    1,
    0,
    0,
    sy,
    0,
    cy,
    0,
    0,
    0,
    0,
    1,
  ]);
  const rz = new Float32Array([
    cz,
    sz,
    0,
    0,
    -sz,
    cz,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
  return mat4Multiply(mat4Multiply(rz, ry), rx);
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] +
      matrix[4] * point[1] +
      matrix[8] * point[2] +
      matrix[12],
    matrix[1] * point[0] +
      matrix[5] * point[1] +
      matrix[9] * point[2] +
      matrix[13],
    matrix[2] * point[0] +
      matrix[6] * point[1] +
      matrix[10] * point[2] +
      matrix[14],
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
    a[0] * b[1] - a[1] * b[0],
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
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function safeDataImageSrc(value) {
  const src = String(value || "");
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(src) ? src : "";
}
