"use strict";

const fs = require("fs");
const path = require("path");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node tools/inspect-emd.js <model.emd>");
  process.exit(1);
}

const bytes = fs.readFileSync(input);
if (bytes.length < 16) {
  console.error("File is too small to be an EMD.");
  process.exit(2);
}

const sections = [
  readUInt32LE(bytes, bytes.length - 16),
  readUInt32LE(bytes, bytes.length - 12),
  readUInt32LE(bytes, bytes.length - 8),
  readUInt32LE(bytes, bytes.length - 4)
];

const modelOffset = sections[2];
const textureOffset = sections[3];
const skeleton = inspectSkeletonSection(bytes, sections[0]);
const model = inspectModelSection(bytes, modelOffset);
const texture = inspectTim(bytes, textureOffset);
const hierarchy = deriveHierarchy(skeleton);

console.log(`EMD: ${path.basename(input)}`);
console.log(`Size: ${formatBytes(bytes.length)}`);
console.log(`Section offsets: ${sections.map((value) => `0x${value.toString(16)}`).join(", ")}`);
console.log(`Model section length: ${formatBytes(model.length)}`);
console.log(`Texture section offset: 0x${textureOffset.toString(16)}`);
console.log(`Texture: ${texture ? `${texture.width} x ${texture.height}, ${texture.mode}${texture.hasClut ? ", CLUT" : ""}` : "not detected"}`);
console.log(`Skeleton bone offset: ${skeleton.boneOffset}`);
console.log(`Skeleton data offset/length: ${skeleton.length}`);
console.log(`Skeleton count: ${skeleton.count}`);
console.log(`Skeleton anim record size: ${skeleton.size}`);
console.log(`Objects: ${model.objects.length}`);
console.log("");
console.log("Skeleton relpos:");
for (const [index, relpos] of skeleton.relpos.entries()) {
  const arm = skeleton.armature[index];
  const mesh = skeleton.meshMap[index];
  console.log(
    `  #${String(index).padStart(2, "0")} ${relpos.join(", ")} ` +
    `mesh=${mesh} children=${arm.meshCount} list=${arm.meshes.join(",")}`
  );
}
console.log("");
console.log("Derived tree:");
printTree(hierarchy, 0, 0, new Set());
console.log("");
console.log("Objects:");
for (const [index, object] of model.objects.entries()) {
  console.log(
    `  #${String(index).padStart(2, "0")} ` +
    `${String(object.vertexCount).padStart(4, " ")} verts, ` +
    `${String(object.normalCount).padStart(4, " ")} normals, ` +
    `${String(object.triangleCount).padStart(4, " ")} tris, ` +
    `first vertex ${object.firstVertex.join(", ")}`
  );
}

function inspectSkeletonSection(fileBytes, offset) {
  const boneOffset = readUInt16LE(fileBytes, offset);
  const length = readUInt16LE(fileBytes, offset + 2);
  const count = readUInt16LE(fileBytes, offset + 4);
  const size = readUInt16LE(fileBytes, offset + 6);
  const relpos = [];
  const armature = [];
  const meshMap = [];

  for (let i = 0; i < count; i++) {
    const entry = offset + 8 + i * 6;
    relpos.push([
      readInt16LE(fileBytes, entry),
      readInt16LE(fileBytes, entry + 2),
      readInt16LE(fileBytes, entry + 4)
    ]);
  }

  for (let i = 0; i < count; i++) {
    const entry = offset + boneOffset + i * 4;
    const meshCount = readUInt16LE(fileBytes, entry);
    const meshListOffset = readUInt16LE(fileBytes, entry + 2);
    const meshes = [];
    for (let mesh = 0; mesh < meshCount; mesh++) {
      meshes.push(fileBytes[offset + boneOffset + meshListOffset + mesh]);
    }
    armature.push({ meshCount, meshListOffset, meshes });
  }

  const meshMapOffset = offset + boneOffset + count * 4;
  for (let i = 0; i < count; i++) {
    meshMap.push(fileBytes[meshMapOffset + i]);
  }

  return { boneOffset, length, count, size, relpos, armature, meshMap };
}

function deriveHierarchy(skeleton) {
  return skeleton.armature.map((armature, bone) => ({
    bone,
    mesh: skeleton.meshMap[bone],
    children: armature.meshes
      .filter((childBone) => childBone < skeleton.meshMap.length && childBone !== bone)
  }));
}

function printTree(tree, bone, depth, visited) {
  if (visited.has(bone)) return;
  visited.add(bone);
  const node = tree[bone];
  console.log(`${"  ".repeat(depth)}bone ${node.bone} -> mesh ${node.mesh}`);
  for (const child of node.children) {
    printTree(tree, child, depth + 1, visited);
  }
}

function inspectTim(fileBytes, offset) {
  if (offset <= 0 || offset + 20 > fileBytes.length || readUInt32LE(fileBytes, offset) !== 0x10) {
    return null;
  }

  const flags = readUInt32LE(fileBytes, offset + 4);
  const bpp = flags & 0x7;
  const hasClut = (flags & 0x8) !== 0;
  let cursor = offset + 8;
  if (hasClut) {
    cursor += readUInt32LE(fileBytes, cursor);
  }

  const wordWidth = readUInt16LE(fileBytes, cursor + 8);
  const height = readUInt16LE(fileBytes, cursor + 10);
  const width = bpp === 0 ? wordWidth * 4 : bpp === 1 ? wordWidth * 2 : wordWidth;
  const modes = ["4-bit indexed", "8-bit indexed", "16-bit direct", "24-bit direct"];
  return { width, height, mode: modes[bpp] || `mode ${bpp}`, hasClut };
}

function inspectModelSection(fileBytes, offset) {
  const length = readUInt32LE(fileBytes, offset);
  const unknown = readUInt32LE(fileBytes, offset + 4);
  const objectCount = readUInt32LE(fileBytes, offset + 8);
  const objectTable = offset + 12;
  const objects = [];

  for (let i = 0; i < objectCount; i++) {
    const entry = objectTable + i * 28;
    const vertexOffset = objectTable + readUInt32LE(fileBytes, entry);
    const vertexCount = readUInt32LE(fileBytes, entry + 4);
    const normalOffset = objectTable + readUInt32LE(fileBytes, entry + 8);
    const normalCount = readUInt32LE(fileBytes, entry + 12);
    const triangleOffset = objectTable + readUInt32LE(fileBytes, entry + 16);
    const triangleCount = readUInt32LE(fileBytes, entry + 20);
    const firstVertex = vertexCount ? readVertex(fileBytes, vertexOffset) : [0, 0, 0];

    objects.push({
      vertexOffset,
      vertexCount,
      normalOffset,
      normalCount,
      triangleOffset,
      triangleCount,
      firstVertex
    });
  }

  return { length, unknown, objectCount, objects };
}

function readVertex(fileBytes, offset) {
  return [
    readInt16LE(fileBytes, offset),
    readInt16LE(fileBytes, offset + 2),
    readInt16LE(fileBytes, offset + 4)
  ];
}

function readUInt32LE(fileBytes, offset) {
  return fileBytes.readUInt32LE(offset);
}

function readUInt16LE(fileBytes, offset) {
  return fileBytes.readUInt16LE(offset);
}

function readInt16LE(fileBytes, offset) {
  return fileBytes.readInt16LE(offset);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
