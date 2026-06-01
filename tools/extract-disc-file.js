"use strict";

const fs = require("fs");
const path = require("path");

const [imagePath, wantedPath, outputPath] = process.argv.slice(2);
if (!imagePath || !wantedPath || !outputPath) {
  console.error("Usage: node tools/extract-disc-file.js <disc.bin|disc.iso> <disc/path/file.ext> <output>");
  process.exit(1);
}

const file = fs.openSync(imagePath, "r");

try {
  const layout = detectIsoLayout(file);
  if (!layout) {
    console.error("No ISO9660 primary volume descriptor found.");
    process.exit(2);
  }

  const files = readDirectory(file, layout, layout.root, "");
  const normalizedWanted = normalizeDiscPath(wantedPath);
  const match = files.find((entry) => normalizeDiscPath(entry.path) === normalizedWanted);
  if (!match) {
    console.error(`Could not find ${wantedPath}`);
    process.exit(3);
  }

  const bytes = readExtentData(file, layout, match.extent, match.size);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
  console.log(`Extracted ${match.path} to ${outputPath} (${formatBytes(bytes.length)})`);
} finally {
  fs.closeSync(file);
}

function detectIsoLayout(fileDescriptor) {
  for (const sectorSize of [2048, 2352]) {
    const dataOffset = sectorSize === 2048 ? 0 : 24;
    const descriptor = readSector(fileDescriptor, sectorSize, dataOffset, 16);
    if (descriptor[0] === 1 && textFromBytes(descriptor, 1, 5) === "CD001") {
      return {
        sectorSize,
        dataOffset,
        root: parseDirectoryRecord(descriptor, 156)
      };
    }
  }
  return null;
}

function readDirectory(fileDescriptor, layout, directory, prefix, depth = 0) {
  if (depth > 8) return [];

  const bytes = readExtentData(fileDescriptor, layout, directory.extent, directory.size);
  const files = [];
  let offset = 0;

  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) {
      offset = Math.ceil((offset + 1) / 2048) * 2048;
      continue;
    }

    const record = parseDirectoryRecord(bytes, offset);
    offset += length;

    if (!record || record.name === "\u0000" || record.name === "\u0001") continue;
    const cleanName = record.name.replace(/;1$/, "");
    const fullPath = prefix ? `${prefix}/${cleanName}` : cleanName;

    if (record.isDirectory) {
      files.push(...readDirectory(fileDescriptor, layout, record, fullPath, depth + 1));
    } else {
      files.push({ path: fullPath, size: record.size, extent: record.extent });
    }
  }

  return files;
}

function parseDirectoryRecord(bytes, offset) {
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

function readSector(fileDescriptor, sectorSize, dataOffset, sectorNumber) {
  const bytes = Buffer.alloc(2048);
  fs.readSync(fileDescriptor, bytes, 0, bytes.length, sectorNumber * sectorSize + dataOffset);
  return bytes;
}

function readExtentData(fileDescriptor, layout, firstSector, byteLength) {
  const bytes = Buffer.alloc(byteLength);
  let written = 0;
  let sector = firstSector;

  while (written < byteLength) {
    const chunk = Math.min(2048, byteLength - written);
    fs.readSync(fileDescriptor, bytes, written, chunk, sector * layout.sectorSize + layout.dataOffset);
    written += chunk;
    sector++;
  }

  return bytes;
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function textFromBytes(bytes, offset, length) {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[offset + i]);
  }
  return text;
}

function normalizeDiscPath(value) {
  return value.replace(/\\/g, "/").replace(/;1$/, "").toUpperCase();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
